---
phase: 06-robustness-resource-safety
reviewed: 2026-07-05T00:00:00Z
depth: standard
files_reviewed: 3
files_reviewed_list:
  - electron/services/arpCollector.ts
  - electron/services/ai.ts
  - electron/services/discovery.ts
findings:
  critical: 2
  warning: 3
  info: 1
  total: 6
status: issues_found
---

# Phase 6: Code Review Report

**Reviewed:** 2026-07-05
**Depth:** standard
**Files Reviewed:** 3
**Status:** issues_found

## Summary

ROBUST-01 try/finally 化整体落地良好：三函数（executeSSH / executeTelnet / executeCommandsOnDevice）均已建立 `settled-flag` + `cleanup()` 统一回收出口（clearTimeout + client.end/destroy + try/catch 幂等保护），timeout 兜底路径的 end→destroy 顺序正确，finally 形态对调用方透明。ROBUST-02 safeLog 切断 line-258 嵌套陷阱成立，enriched Error 仍为 Error 实例且 slice(0,200) 边界安全。

但发现 2 处 Critical 级资源/正确性问题：

1. `ai.ts` `executeCommandsOnDevice` 内部的 `execOne`（line 393-406）**未 listen `stream.on('error')`**——stream 触发 error 时不 emit close，`execOne` 的 promise 永远不 settle，stream 句柄泄漏；这与 ROBUST-01「杜绝句柄泄漏」的 phase goal 直接冲突，CONTEXT line 117 也明示需 researcher 审视其 stream 句柄兜底。
2. `ai.ts` `executeCommandsOnDevice` 的 `client.on('ready')` 回调为 async 函数（line 355），await `execOne` 期间若外层 `overallTimer` fire，client 已被 cleanup end/destroy，但 `execOne` 的 pending promise 与 stream 引用仍悬挂——叠加 CR-01 形成双重泄漏面。

3 处 WARNING 为：finally 内 `connection.end()` 未 await（偏离 D-6-2 决策语义）；discovery 两处 parse catch 内 errorMessage 内联拼接 slice(0,200) 与 enrichParseError 重复（DRY 退化，未来阈值调整易不一致）；`ai.ts` finally 块 `if (!settled) cleanup()` 为通过 grep 字面验收补的死分支（注释自承）。

三函数签名零改、isCommandAllowed 强制校验保留（line 316-320）、5 处 createSystemLog 全部经 safeLog、安全策略拒绝的命令不影响 overallTimeout——这些红线均未回退。

## Critical Issues

### CR-01: execOne 缺 stream.on('error') — stream 句柄永久泄漏

**File:** `electron/services/ai.ts:393-406`
**Issue:** `execOne` 仅 listen `stream.on('data')` 与 `stream.on('close')`，未 listen `stream.on('error')`。对照 `arpCollector.executeSSH`（line 61 有 `stream.on('error', (e) => finish(() => reject(e)))`）显属遗漏。当 exec 过程中底层 socket 异常（对端 RST / 网络中断 / ssh2 channel 失败），ssh2 stream 会 emit `'error'` 而**不** emit `'close'`——`execOne` 的 Promise 永不 resolve/reject，`stream` 句柄与内部 Promise 永久悬挂。

`executeCommandsOnDevice` 的 for 循环 `await execOne(client, cmd)` 会卡死，外层 `overallTimer` fire 虽能 reject 主 promise（`finish(() => reject(...))`），但：
- `execOne` 的悬挂 Promise 内闭包持有 `buf`、`stream`、`client` 强引用，GC 无法回收；
- 悬挂的 stream 仍注册在 client 上，client.end/destroy 后 ssh2 内部 channel 资源未释放；
- 反复触发（discovery 多设备循环，SC#4 验收点）句柄单调增长。

本 phase 标题即「Robustness & Resource Safety」，CONTEXT line 117 明示 `execOne` 需 researcher 审视 stream 句柄兜底——此遗漏直接违反 phase goal。

**Fix:** 与 `arpCollector.executeSSH` line 61 同模式补 error handler：

```typescript
function execOne(client: Client, command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    client.exec(command, (err, stream) => {
      if (err) return reject(err)
      let buf = ''
      stream.on('data', (data: Buffer) => { buf += decodeDeviceBuffer(data) })
      const stderr = (stream as any).stderr
      if (stderr && typeof stderr.on === 'function') {
        stderr.on('data', () => { /* 忽略 stderr，必要时再收集 */ })
      }
      stream.on('error', (e: Error) => reject(e))   // 新增：stream error 兜底
      stream.on('close', () => resolve(stripAnsi(buf).trim()))
    })
  })
}
```

注意：`executeCommandsOnDevice` 的 ready 回调内已有 `try { ... await execOne ... } catch (err) { results[i] = ... success:false }`（line 364-369）承接 reject，无 reject 路径丢失。

---

### CR-02: executeCommandsOnDevice 的 ready async 回调与 overallTimer 存在 client use-after-destroy race

**File:** `electron/services/ai.ts:355-375`
**Issue:** `client.on('ready', async () => { ... })` 是 async 回调。循环中 `await execOne(client, cmd)`（line 365）期间，若 `overallTimer`（line 346）fire，`finish()` 同步调用 `cleanup()`（`client.end()`）→ 紧接 `client.destroy()`（line 349）。ready 回调的 `await` 完成后继续 `client.exec`（下一轮 execOne）操作一个已被 destroy 的 client，ssh2 行为未定义（可能 emit error 进 finally 已 settled 后的路径，或抛同步异常无人 catch）。

叠加 CR-01 后果更严重：execOne 既不 settle（stream 无 close），client 又被 destroy，ready 回调永远停在 `await`，整条 promise 链依赖 overallTimer reject 兜底——一旦未来改大 overallTimeout 或 commands.length 极大，窗口期拉长，悬挂资源累积。

另外 ready 回调内的 for 循环串行 exec N 条命令，总耗时 `N * 单命令耗时`，而 `overallTimeout = 30000 + commands.length * 15000`（line 330）的 15s/命令预算在慢设备/慢网络下偏紧，timeout fire 时 ready 回调通常停在某个 `await execOne`——race 触发概率高。

**Fix:** ready 回调内每轮 await 前检查 settled 状态，提前退出避免操作已 destroy 的 client；并使 ready 回调整体容错（外部 overallTimer 仍为兜底）：

```typescript
client.on('ready', async () => {
  try {
    for (let i = 0; i < checked.length; i++) {
      if (settled) return                       // 新增：timeout 已 fire 则不再操作 client
      const { cmd, allowed, reason } = checked[i]
      if (!allowed) {
        results[i] = { command: cmd, output: `命令被安全策略拒绝: ${reason}`, success: false }
        continue
      }
      try {
        const output = await execOne(client, cmd)
        results[i] = { command: cmd, output, success: true }
      } catch (err: any) {
        results[i] = { command: cmd, output: `执行失败: ${err.message}`, success: false }
      }
    }
    finish(() => resolve(results))
  } catch (err: any) {
    finish(() => reject(err))
  }
})
```

`if (settled) return` 不改变对外的 reject 语义（timeout 路径已 `finish(() => reject(...))`），仅切断对已销毁 client 的后续访问。

## Warnings

### WR-01: executeTelnet finally 未 await connection.end() — 偏离 D-6-2 决策语义

**File:** `electron/services/arpCollector.ts:109-114`
**Issue:** 06-CONTEXT.md line 43 D-6-2 明示模式：`finally { clearTimeout(timer); try { await connection.end() } catch {}; ... }`。当前实现 `try { connection.end() } catch {}`（line 112）未 await——telnet-client 的 `end()` 是 async（发送 EOF 包），不 await 即返回，紧接 `if (timedOut) { try { connection.destroy() } catch {} }`（line 113）在 end() 写操作进行中 destroy socket，EOF 写入可能失败。虽 destroy 最终回收 socket（无害），但与决策语义不一致；非 timedOut 路径下 end() 异常若在写过程中抛出，因未 await 会变成 unhandled rejection（telnet-client 内部 emitter 可能吞，但不可控）。

**Fix:** finally 改 await（外层 executeTelnet 已是 async 函数，可 await）：

```typescript
}).finally(async () => {
  if (timer) clearTimeout(timer)
  try { await connection.end() } catch { /* ignore */ }
  if (timedOut) { try { connection.destroy() } catch { /* ignore */ } }
})
```

注意：`Promise.prototype.finally` 的回调若是 async，外层 await 会等待它——executeTelnet line 115 `return result` 前会先完成 finally 的 await，语义正确。

---

### WR-02: discovery 两处 parse catch errorMessage 内联拼接 slice(0,200) 与 enrichParseError 重复

**File:** `electron/services/discovery.ts:170-177`、`electron/services/discovery.ts:301-309`
**Issue:** 两处 catch 内 safeLog 的 `errorMessage` 字段手动拼接 `` `${prefix}: ${err.message} | 原始片段: ${(raw || '').slice(0, 200)}` ``（line 175 / 306），紧接的 `throw enrichParseError(...)`（line 177 / 308）内部 line 29 又拼一遍。两处拼接逻辑重复，未来若调整阈值（slice 长度、prefix 文案）易出现 safeLog 落库与抛出错误 message 不一致——而 SC#2 验收点正是「错误上下文可定位」，不一致会让运维据日志定位 vs 据 exception 定位得到不同原始片段。

**Fix:** enrichParseError 返回 Error 后，safeLog 直接复用其 message：

```typescript
} catch (err: any) {
  const enriched = enrichParseError('AI 命令结果解析失败', commandRaw, err)
  safeLog({
    type: 'discovery', status: 'failed',
    deviceIds: deviceIdsStr, deviceNames: deviceNamesStr,
    promptText: commandPromptText,
    aiResponse: commandRaw,
    errorMessage: enriched.message,     // 复用，杜绝双源
  })
  throw enriched
}
```

topology parse catch（line 299-309）同改。

---

### WR-03: executeCommandsOnDevice finally 块为静态 grep 验收补的死分支

**File:** `electron/services/ai.ts:382-387`
**Issue:** finally 块的 `if (!settled) { cleanup() }` 在 Promise executor 同步路径下不可达：
- `client.on('ready')` 与 `client.on('error')` 是同步注册，不抛；
- `client.connect(cfg)` 若同步抛已被 line 379-381 catch 内 finish 处理；
- try 块内无其他可抛同步语句。

故 `try` 块正常退出时 `settled` 必为 false 仅当未触发任何 throw 但也未注册回调——但 `client.connect` 已调度异步事件，settled 必为 false 直到 ready/error/timeout 任一触发。即 finally 同步执行瞬间 settled 必为 false（async 回调尚未运行），`if (!settled) cleanup()` 会**在 connect 刚发起、ready 未到时**就 cleanup()，把 client.end() 提前到 connect 进行中——这与改造意图相反。

**这是潜在 BLOCKER 而非纯死代码**：finally 在 executor 同步返回时同步执行，此时 ready/error/timeout 均未 fire，settled=false，cleanup() 立即清掉 overallTimer 并 client.end()——**整个 executeCommandsOnDevice 在 connect 还没建立时就被关闭**，ready 回调即便后续触发也会因 client 已 end 而 emit error（ssh2 在 end 后 connect 的行为未定义，大概率 emit error → finish → reject），命令永远执行失败。

但 line 385 注释自承「D-6-5 静态 grep finally 命中」——说明 finally 仅为字面验收补入，未追踪同步执行时序。建议验证：若当前测试环境命令执行正常，可能因 ssh2 connect 极快（同步阶段已 emit ready）侥幸成立，但这是 race 而非正确性保证。

**Fix:** 删除该 finally 块（cleanup 已由各 finish 路径覆盖），或改为仅在 ready 回调内触发 finally 语义。最简修复——移除 finally：

```typescript
    client.on('error', (err) => { finish(() => reject(err)) })
    client.connect(cfg)
  })   // Promise executor 结束，不补 finally
}
```

settled-flag + finish() 已覆盖所有出口（ready 成功 / ready catch / client error / overallTimer / 同步 catch），finally 块非必要且有害。若 D-6-5 grep 验收强制要求 finally 命中，建议把 finally 改为 `// no-op` 占位注释，或重新设计为 async/await + try/finally 形态（D-6-2 line 42 明示形态可委托）。

## Info

### IN-01: executeTelnet shellPrompt 正则过宽（FRAG-3 defer 项的提醒）

**File:** `electron/services/arpCollector.ts:100`
**Issue:** `shellPrompt: /[>#]/` 匹配任意含 `>` 或 `#` 字符的输出（设备 banner / MOTD / 命令回显含 `#`），导致 telnet-client 误判 prompt 边界，输出截断或卡死。06-CONTEXT.md line 19 / line 176 已明示 defer 到独立 phase（FRAG-3，非 ROBUST 字面）。本 review 仅作记录，**不要求本 phase 修复**——但因其与 ROBUST-01 的 timeout 兜底有交互（误判 prompt 会让 exec 提前返回空输出，触发后续 ARPParser 解析失败），建议下一 phase 优先处理。

**Fix:** defer（按 CONTEXT 决策）。未来可收紧为 `/(?:[#$])\s*$/` 或厂商特定 prompt。

---

_Reviewed: 2026-07-05_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
