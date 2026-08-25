# .mcpb 包格式说明

.mcpb 是本工具的 MCP 包格式：一个 zip 压缩包，内含一份 `manifest.json` 描述清单 + 服务程序文件。一个产品一个包（如「绿盟 NF 防火墙工具集」），导入校验通过后即可在新建 MCP 配置时选用。

## 1. manifest.json 全字段说明

manifest.json 必须位于包根目录，UTF-8 JSON，字段如下：

| 字段 | 类型 | 必填 | 约束 |
|------|------|------|------|
| `name` | string | 是 | 包名，全局唯一身份（同名即同包）。1-100 字符，必须字母或数字开头，其后仅允许字母数字/点/下划线/连字符（`..`、路径分隔符 `/` `\`、盘符、绝对路径形态一律拒绝——导入校验 manifest-schema 向量强制） |
| `version` | string | 是 | 语义化版本，如 `0.2.0` |
| `runtime` | `'node' \| 'python'` | 是 | 双轨运行时，二选一 |
| `entry` | string | 是 | 入口文件相对路径（正斜杠 `/` 分隔）。node 轨道只接受 `.js` / `.mjs` / `.cjs`；python 轨道只接受 `.py` |
| `models` | string[] | 是 | 适用设备型号清单（用于配置向导预筛设备），如 `["NF", "ADS"]` |
| `tools` | `{ name, description, readOnlyHint? }[]` | 是 | 声明的工具清单。`name` 只允许字母数字下划线连字符、最长 64；`description` 人话描述；`readOnlyHint: true` 表示只读工具（UI 打「只读」标） |
| `envKeys` | string[] | 否 | 需要在设备绑定层逐台填写值的环境变量键名清单（如 `["NF_API_TOKEN"]`） |
| `envMeta` | `Record<string, EnvMetaEntry>` | 否 | 每个环境变量键的人话元数据（29.1 新增），见下文 envMeta 说明 |

## 2. 目录组织

```
your-package.mcpb（zip）
├── manifest.json            # 固定文件名，必须在包根
├── server.js                # entry 声明的入口（node 轨道示例）
├── lib/                     # 程序自有代码，任意组织
│   └── ...
├── node_modules/            # node 轨道：依赖必须自带，导入方不执行 npm install
└── python/                  # python 轨道：内嵌 Windows 嵌入式 Python（见第 4 节）
```

规则：

- 所有路径必须是相对路径（正斜杠 `/` 分隔）；绝对路径、盘符（`C:`）、反斜杠、`..` 逃逸段一律被拒（zip-slip 防护）。
- manifest 声明的 `entry` 必须真实存在于包内。

## 3. 双轨打包规则

### node 轨道

- 打包前在本机 `npm install --omit=dev`，把 `node_modules/` 一并压入包内（导入方不联网装依赖）。
- `entry` 指向入口脚本，运行时以 `node <entry 绝对路径>` 启动（应用自带 Node 运行时，最终用户无需安装 node）。

### python 轨道

- 下载 **Windows 嵌入式发行版（embeddable package）python 3.10 x64**（python.org 官方 `python-3.10.x-embed-amd64.zip`），解压放入包内 `python/` 目录。
- 预装依赖：向嵌入式 Python 的 `site-packages` 预装 manifest 所需依赖——用 `python -m pip install --target python/Lib/site-packages <pkg>`（嵌入式发行版默认无 pip，需先启用 `python310._pth` 中的 import site，或用本机同版本 Python `--target` 安装后拷入）。
- MCP 依赖基线：`mcp>=1.2.0,<2.0.0` + `httpx` + `pydantic`（参考 nsfocus-nf-mcp 形态）。
- 入口脚本放在包根或任意子目录，`entry` 指向它；运行时以包内 `python/python.exe <entry 绝对路径>` 启动。

## 4. 体积上限

- 包文件（压缩后）≤ **200MB**
- 解压后总尺寸 ≤ **1GB**（防解压炸弹）

超限任一项，导入直接整体拒绝。

## 4a. envMeta（环境变量元数据，可选）

`envMeta` 为每个 `envKeys` 键提供中文人话元数据，导入后在设备环境变量表单中展示（label 替代裸键名、悬浮说明、必填标红、留空默认提示）。schema：

```json
{
  "NF_API_TOKEN": {
    "label": "接口令牌",
    "description": "防火墙 REST API 认证 Token（系统-用户管理处创建）",
    "required": true
  },
  "NF_API_PORT": {
    "label": "API 端口",
    "description": "REST 服务端口",
    "example": "8443",
    "default": "443"
  }
}
```

| 字段 | 类型 | 必填 | 语义 |
|------|------|------|------|
| `label` | string | 是 | 键的人话名称（非空，≤2000 字符） |
| `description` | string | 否 | 悬浮说明文案 |
| `required` | boolean | 否 | `true` = 用户未填值时表单与启动双层拦截（fail-closed） |
| `example` | string | 否 | 输入示例（仅展示提示） |
| `default` | string | 否 | 留空即用的默认值——**启动实例时叠加传入，不落库**；包升级改默认后留空键自动跟随新默认 |

约束（导入校验强制）：

- **键集必须 ⊆ `envKeys`**：envMeta 里出现 envKeys 之外的键 = 越界谎报，整个包拒绝导入（envmeta-lie 向量）。
- 键名与 `envKeys` 同规则：字母/下划线开头，仅字母数字下划线，≤100 字符。
- 键数 ≤100，单字符串字段 ≤2000 字符，序列化总长 ≤64KB（防投毒超大 payload）。
- `envKeys` 有而 `envMeta` 缺某键合法（元数据可选，缺省时 UI 回退裸键名展示）。
- 不含 env 值：明文元数据随包走；真正的值仍由用户在设备绑定层逐台填写并加密存储。

## 5. 六向量校验清单（导入时逐项执行）

1. **manifest-schema**：manifest.json 存在、JSON 可解析、全字段类型/约束合法
2. **entry-whitelist**：runtime 对应的入口扩展名白名单命中
3. **zip-slip**：全部条目路径无逃逸（绝对路径/盘符/反斜杠/`..`）
4. **double-extension**：全树不得出现 `*.js.exe`、`*.py.bat` 等双扩展伪装可执行文件
5. **manifest-lie**：声明的 entry 真实存在、工具名字符合法（防名字注入）
6. **envmeta-lie**：`envMeta` 键集 ⊆ `envKeys`（防越界元数据谎报，29.1 新增）

任一向量失败即导入拒绝，并给出人话原因（可反馈包作者修正后重新打包）。

## 6. 示例 manifest.json

以 nsfocus-nf-mcp（绿盟 NF 防火墙 REST API MCP Server）形态为例：

```json
{
  "name": "nsfocus-nf-mcp",
  "version": "0.2.0",
  "runtime": "python",
  "entry": "nf_mcp/server.py",
  "models": ["NF"],
  "tools": [
    {
      "name": "get_device_info",
      "description": "获取防火墙设备基本信息（型号/序列号/软件版本）",
      "readOnlyHint": true
    },
    {
      "name": "add_security_policy",
      "description": "新增一条安全策略"
    }
  ],
  "envKeys": ["NF_API_BASE_URL", "NF_API_TOKEN"],
  "envMeta": {
    "NF_API_BASE_URL": {
      "label": "API 地址",
      "description": "防火墙 REST API 基础地址",
      "example": "https://192.168.1.10:443"
    },
    "NF_API_TOKEN": {
      "label": "接口令牌",
      "description": "防火墙 REST API 认证 Token",
      "required": true
    }
  }
}
```

node 轨道示例只需把 `runtime` 改为 `"node"`、`entry` 指向 `.js` 入口并自带 `node_modules/`。

## 7. 重导入（版本升级）

同名包再次导入时若内容指纹（SHA-256 全树哈希）不一致，会进入覆盖确认流程：展示新旧指纹、工具增删、env 键保留/新增/删除清单，确认后替换包文件；既有配置与设备绑定关系原样保留。
