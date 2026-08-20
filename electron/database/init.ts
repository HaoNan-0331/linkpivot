import { getDatabase } from './connection'
import { createSystemLog } from '../services/systemLog'

export function createTables() {
  getDatabase().exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS topologies (
      id TEXT PRIMARY KEY,
      name_enc TEXT NOT NULL,
      data_enc TEXT NOT NULL,
      status TEXT DEFAULT 'active' CHECK(status IN ('active','pending','draft')),
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY,
      topology_id TEXT,
      name_enc TEXT NOT NULL,
      vendor_enc TEXT,
      model_enc TEXT,
      version_enc TEXT,
      ip_enc TEXT,
      device_type TEXT DEFAULT 'generic' CHECK(device_type IN ('router','switch','firewall','server','generic')),
      connection_type TEXT CHECK(connection_type IN ('ssh','telnet','web','rdp')),
      port_enc TEXT,
      username_enc TEXT,
      password_enc TEXT,
      ssh_key_path_enc TEXT,
      ssh_key_content_enc TEXT,
      web_url_enc TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (topology_id) REFERENCES topologies(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS ai_config (
      id TEXT PRIMARY KEY,
      provider_enc TEXT,
      api_key_enc TEXT,
      base_url_enc TEXT,
      model_name_enc TEXT,
      exec_mode TEXT DEFAULT 'confirm' CHECK(exec_mode IN ('confirm','smart','auto')),
      mcp_max_rounds INTEGER NOT NULL DEFAULT 5,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS command_whitelist (
      id TEXT PRIMARY KEY,
      pattern TEXT NOT NULL UNIQUE
    );

    CREATE TABLE IF NOT EXISTS ai_exec_logs (
      id TEXT PRIMARY KEY,
      device_id TEXT,
      device_name_enc TEXT,
      command TEXT NOT NULL,
      status TEXT CHECK(status IN ('approved','rejected','pending','executed','failed')),
      mode TEXT CHECK(mode IN ('confirm','smart','auto')),
      ai_reason TEXT,
      prompt_text TEXT,
      ai_response TEXT,
      prompt_text_enc TEXT,
      ai_response_enc TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS chat_history (
      id TEXT PRIMARY KEY,
      role TEXT NOT NULL,
      content_enc TEXT NOT NULL,
      device_id TEXT,
      session_id TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS chat_sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      device_id TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS ai_system_logs (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL DEFAULT 'discovery' CHECK(type IN ('discovery','acl','migration','backup','security')),
      status TEXT NOT NULL CHECK(status IN ('success','failed','warning')),
      device_ids TEXT,
      device_names TEXT,
      prompt_text TEXT,
      ai_response TEXT,
      parsed_result TEXT,
      error_message TEXT,
      prompt_text_enc TEXT,
      ai_response_enc TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );

    -- WR-01 fix（Phase 23 code-review）：移除 enable/system-view 种子——配置模式命令
    -- 违反「只读查询命令」红线，不得经白名单进入 AI 执行流。存量库已有行由
    -- commandSafety 黑名单首词兜底拦截（黑名单优先于白名单，立即生效）。
    INSERT OR IGNORE INTO command_whitelist (id, pattern) VALUES
      ('w1', 'display'),
      ('w2', 'show'),
      ('w5', 'quit'),
      ('w6', 'ping'),
      ('w7', 'traceroute'),
      ('w8', 'terminal'),
      -- Phase 23（23-03 复验反馈）：服务器只读第一批（INSERT OR IGNORE 新 id，
      -- 存量库启动时增量补种）。排除 cat（任意文件读）/ top、vi、less（交互式挂死
      -- SSH exec）/ systemctl（首词匹配连带 start/stop/reboot 子命令）/ sudo。
      ('w9', 'uname'),
      ('w10', 'hostnamectl'),
      ('w11', 'uptime'),
      ('w12', 'df'),
      ('w13', 'free'),
      ('w14', 'ps'),
      ('w15', 'ip'),
      ('w16', 'netstat'),
      ('w17', 'ss'),
      ('w18', 'ifconfig');

    -- IP Management tables (from network-ip merge)

    CREATE TABLE IF NOT EXISTS arp_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT NOT NULL,
      ip TEXT NOT NULL,
      mac TEXT NOT NULL,
      vlan TEXT,
      interface TEXT,
      collected_at TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_arp_entries_ip ON arp_entries(ip);
    CREATE INDEX IF NOT EXISTS idx_arp_entries_mac ON arp_entries(mac);
    CREATE INDEX IF NOT EXISTS idx_arp_entries_device ON arp_entries(device_id);
    -- 18-02（TXN-03 前置）：retention 按时间窗删除 arp_entries 的查询索引（v14 迁移双路径同款）
    CREATE INDEX IF NOT EXISTS idx_arp_entries_collected_at ON arp_entries(collected_at);

    CREATE TABLE IF NOT EXISTS network_segments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      network TEXT NOT NULL,
      mask TEXT NOT NULL,
      cidr INTEGER NOT NULL,
      gateway TEXT,
      description TEXT,
      is_auto_discovered INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_network_segments_network ON network_segments(network);

    CREATE TABLE IF NOT EXISTS ip_mac_bindings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ip TEXT NOT NULL,
      mac TEXT NOT NULL,
      first_seen TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      is_baseline INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      UNIQUE(ip, mac)
    );
    CREATE INDEX IF NOT EXISTS idx_ip_mac_bindings_ip ON ip_mac_bindings(ip);
    CREATE INDEX IF NOT EXISTS idx_ip_mac_bindings_active ON ip_mac_bindings(is_active);

    CREATE TABLE IF NOT EXISTS ip_mac_changes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ip TEXT NOT NULL,
      old_mac TEXT,
      new_mac TEXT,
      change_type TEXT NOT NULL CHECK(change_type IN ('mac_changed', 'new_ip', 'ip_reused')),
      detected_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      acknowledged INTEGER NOT NULL DEFAULT 0,
      acknowledged_at TEXT,
      notes TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_ip_mac_changes_detected ON ip_mac_changes(detected_at);
    CREATE INDEX IF NOT EXISTS idx_ip_mac_changes_ack ON ip_mac_changes(acknowledged);

    CREATE TABLE IF NOT EXISTS excluded_ips (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ip_or_cidr TEXT NOT NULL UNIQUE,
      description TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS oui_database (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      oui_prefix TEXT NOT NULL UNIQUE,
      vendor_name TEXT NOT NULL,
      is_custom INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_oui_prefix ON oui_database(oui_prefix);

    CREATE TABLE IF NOT EXISTS ip_status (
      ip TEXT PRIMARY KEY,
      mac TEXT,
      status TEXT NOT NULL DEFAULT 'used' CHECK(status IN ('used', 'deprecated')),
      first_seen TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_ip_status_status ON ip_status(status);

    CREATE TABLE IF NOT EXISTS scheduler_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      enabled INTEGER NOT NULL DEFAULT 0,
      interval_minutes INTEGER NOT NULL DEFAULT 60,
      last_run TEXT,
      next_run TEXT,
      retention_days INTEGER DEFAULT 90
    );

    CREATE TABLE IF NOT EXISTS backup_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      enabled INTEGER NOT NULL DEFAULT 1,
      interval_minutes INTEGER NOT NULL DEFAULT 1440,
      periodic_retention INTEGER NOT NULL DEFAULT 7,
      premigration_retention INTEGER NOT NULL DEFAULT 5,
      last_run TEXT,
      next_run TEXT
    );

    -- Knowledge Base tables

    CREATE TABLE IF NOT EXISTS kb_documents (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      file_name TEXT NOT NULL,
      file_path TEXT NOT NULL,
      file_type TEXT NOT NULL,
      file_size INTEGER,
      category TEXT DEFAULT 'manual' CHECK(category IN ('manual','api','template','notes')),
      device_id TEXT,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending','processing','ready','error')),
      error_message TEXT,
      chunk_count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS kb_chunks (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL REFERENCES kb_documents(id) ON DELETE CASCADE,
      chunk_index INTEGER NOT NULL,
      title TEXT,
      content TEXT NOT NULL,
      level INTEGER DEFAULT 1,
      image_ids TEXT,
      char_count INTEGER,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_kb_chunks_doc ON kb_chunks(document_id);

    CREATE TABLE IF NOT EXISTS kb_images (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL REFERENCES kb_documents(id) ON DELETE CASCADE,
      chunk_id TEXT REFERENCES kb_chunks(id) ON DELETE CASCADE,
      file_path TEXT NOT NULL,
      description TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_kb_images_doc ON kb_images(document_id);
    CREATE INDEX IF NOT EXISTS idx_kb_images_chunk ON kb_images(chunk_id);

    CREATE VIRTUAL TABLE IF NOT EXISTS kb_chunks_fts USING fts5(
      title,
      content,
      image_desc,
      content='kb_chunks',
      content_rowid='rowid',
      tokenize='unicode61'
    );

    -- 三触发器 image_desc 恒 NULL（18-02 Q10 方案 A 终裁，v14 迁移同款重建）：
    -- GROUP_CONCAT 子查询是非确定性来源（图片行可在 chunk 索引化后插入/变更），delete 端命令值
    -- 与索引不符时 FTS5 抛 database disk image is malformed。kb_chunks_fts 零生产 MATCH 读者，
    -- 双端 NULL 常量可静态证明不 mismatch。
    CREATE TRIGGER IF NOT EXISTS kb_chunks_ai AFTER INSERT ON kb_chunks BEGIN
      INSERT INTO kb_chunks_fts(rowid, title, content, image_desc)
        VALUES (new.rowid, new.title, new.content, NULL);
    END;

    CREATE TRIGGER IF NOT EXISTS kb_chunks_ad AFTER DELETE ON kb_chunks BEGIN
      INSERT INTO kb_chunks_fts(kb_chunks_fts, rowid, title, content, image_desc)
        VALUES ('delete', old.rowid, old.title, old.content, NULL);
    END;

    CREATE TRIGGER IF NOT EXISTS kb_chunks_au AFTER UPDATE ON kb_chunks
      WHEN OLD.content IS NOT NEW.content OR OLD.title IS NOT NEW.title OR OLD.image_ids IS NOT NEW.image_ids
    BEGIN
      INSERT INTO kb_chunks_fts(kb_chunks_fts, rowid, title, content, image_desc)
        VALUES ('delete', old.rowid, old.title, old.content, NULL);
      INSERT INTO kb_chunks_fts(rowid, title, content, image_desc)
        VALUES (new.rowid, new.title, new.content, NULL);
    END;

    -- Experience tables (Phase 7: 经验沉淀数据层，独立于 kb_* 文档表)
    -- 列设计取舍（与 design 文档一致）：
    --   - content 明文不加密：attrs/正文分离，content 进未来 Phase 11 FTS5 检索，加密则无法索引
    --   - attrs_enc 加密：troubleshooting 处置可能贴含密码的命令，必须 AES-256-GCM；JSON blob 整体加密
    --   - tags 明文 JSON 数组：列表筛选需裸查，不加密
    --   - status 含 4 态（draft/confirmed/published/invalid）为 Phase 8-10 预埋
    --   - source_session_id / last_verified_at / reuse_count 为 Phase 8/9/11 预埋列，建表即存在避免后续补迁移
    --   - bi-temporal：valid_at + invalid_at 各建索引，支撑「有效检索」过滤

    CREATE TABLE IF NOT EXISTS experiences (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'troubleshooting'
        CHECK(category IN ('troubleshooting','best_practices','product','env')),
      content TEXT NOT NULL DEFAULT '',
      tags TEXT DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'draft'
        CHECK(status IN ('draft','confirmed','published','invalid')),
      source_session_id TEXT,
      attrs_enc TEXT,
      duplicate_of_exp_id TEXT,
      severity TEXT,
      valid_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      invalid_at TEXT,
      last_verified_at TEXT,
      reuse_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (source_session_id) REFERENCES chat_sessions(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_experiences_category ON experiences(category);
    CREATE INDEX IF NOT EXISTS idx_experiences_status ON experiences(status);
    CREATE INDEX IF NOT EXISTS idx_experiences_valid ON experiences(valid_at);
    CREATE INDEX IF NOT EXISTS idx_experiences_invalid ON experiences(invalid_at);
    CREATE INDEX IF NOT EXISTS idx_experiences_source_session ON experiences(source_session_id);

    CREATE TABLE IF NOT EXISTS exp_device_rel (
      id TEXT PRIMARY KEY,
      experience_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      relation_type TEXT NOT NULL DEFAULT 'primary',
      created_at TEXT DEFAULT (datetime('now','localtime')),
      UNIQUE(experience_id, device_id),
      FOREIGN KEY (experience_id) REFERENCES experiences(id) ON DELETE CASCADE,
      FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_exp_device_rel_exp ON exp_device_rel(experience_id);
    CREATE INDEX IF NOT EXISTS idx_exp_device_rel_device ON exp_device_rel(device_id);

    -- Phase 20（20-01）+ Phase 21（21-01 v16 形态）：提示词 override 表 + MCP 配置表（一对多形态）。
    -- prompt_overrides DDL 与 migrations.ts v15 迁移 DDL 逐字一致；
    -- mcp_configs/mcp_device_rel DDL 必须与 migrations.ts v16 迁移 DDL 逐字一致
    -- （双路径一致红线，v7/v8/v13/v14/v15 注释同款要求）。
    -- prompt_overrides.content 明文不加密：默认值本身在代码 registry 明文单一来源，加密无增益（20-CONTEXT 决策）。
    -- mcp_configs v16 一对多形态（D-03）：device_id 内嵌列移除，绑定关系入 mcp_device_rel
    -- （device_id 单列 UNIQUE——一台设备至多绑一个配置；D-04 冲突拦截在 service 层，DB UNIQUE 兜底）。
    -- env_json_enc：stdio 环境变量键值对整体 JSON 加密（A4 裁决）；credential_enc：http token，
    -- nullable（禁 NOT NULL、禁空串默认）——NULL/空串双态区分是读侧
    -- 「列存在性判据、禁试解密」的语义根基（v13:369-370 同款语义注释）。
    -- source（D-06，默认 manual UI 不暴露）+ last_test_*（D-09 最近测试结果）。

    CREATE TABLE IF NOT EXISTS prompt_overrides (
      prompt_id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      based_on_version INTEGER NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS mcp_configs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('stdio','http')),
      command_or_url TEXT NOT NULL,
      args_json TEXT,
      env_json_enc TEXT,
      credential_enc TEXT,
      source TEXT NOT NULL DEFAULT 'manual',
      enabled INTEGER NOT NULL DEFAULT 1,
      last_test_at TEXT,
      last_test_status TEXT,
      last_test_tool_count INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS mcp_device_rel (
      id TEXT PRIMARY KEY,
      mcp_config_id INTEGER NOT NULL,
      device_id TEXT NOT NULL UNIQUE,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (mcp_config_id) REFERENCES mcp_configs(id) ON DELETE CASCADE,
      FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_mcp_device_rel_mcp ON mcp_device_rel(mcp_config_id);
    CREATE INDEX IF NOT EXISTS idx_mcp_device_rel_device ON mcp_device_rel(device_id);

    -- Phase 22（22-01 v17）：MCP 工具级策略表。DDL 必须与 migrations.ts v17 迁移 DDL
    -- 逐字一致（双路径一致红线，v7/v8/v13-v16 注释同款要求）。
    -- tool_meta 存 JSON 字符串（description/annotations/inputSchema），明文不加密
    -- （prompt_overrides 明文先例，工具级开关非敏感）。skip_confirm 写入由 service 层
    -- 双条件守卫（isReadOnlyEligible）拒绝不满足者——判定权在 main（T-22-01）。

    CREATE TABLE IF NOT EXISTS mcp_tools (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      config_id INTEGER NOT NULL,
      tool_name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      skip_confirm INTEGER NOT NULL DEFAULT 0,
      tool_meta TEXT,
      updated_at TEXT,
      UNIQUE(config_id, tool_name)
    );
  `)

  // 散落迁移块（chat_history.session_id / ai_exec_logs.prompt_text+ai_response /
  // devices.status+last_checked / ai_config.vision_* / devices.connection_type 'rdp' 重建）
  // 已由 Plan 01 迁入 electron/database/migrations.ts 注册表（v1-v5），
  // 由 connection.ts migrateAndSecure() 在 createTables 之后统一调用迁移入口执行。
  // 本文件不再持有任何迁移逻辑（单一真相收敛，ARCH-01）。

  // Initialize default OUI data
  initDefaultOUIData(getDatabase())
}

function initDefaultOUIData(db: any) {
  const count = (db.prepare('SELECT COUNT(*) as cnt FROM oui_database').get() as any).cnt
  if (count > 0) {
    // PERF-04：OUI seed 已存在跳过（可观测日志，二次启动可见）
    try {
      createSystemLog({ type: 'migration', status: 'success', errorMessage: `[startup] initDefaultOUIData 跳过：oui_database 已有 ${count} 行 seed，不重复插入` })
    } catch { console.log(`[startup] initDefaultOUIData 跳过：oui_database 已有 ${count} 行（system_logs 未就绪回退 console）`) }
    return
  }

  const stmt = db.prepare('INSERT OR IGNORE INTO oui_database (oui_prefix, vendor_name) VALUES (?, ?)')
  const entries = [
    ['00:01:02', 'Huawei'], ['00:18:82', 'Huawei'], ['00:E0:FC', 'Huawei'], ['20:A6:CD', 'Huawei'],
    ['48:46:FB', 'Huawei'], ['54:89:98', 'Huawei'], ['70:3A:0E', 'Huawei'], ['78:1D:AA', 'Huawei'],
    ['88:28:B3', 'Huawei'], ['A8:6B:AD', 'Huawei'], ['BC:4A:CA', 'Huawei'], ['CC:A2:23', 'Huawei'],
    ['E0:24:7F', 'Huawei'], ['E4:68:9B', 'Huawei'], ['F4:8E:38', 'Huawei'],
    ['00:0F:E2', 'H3C'], ['00:12:3F', 'H3C'], ['00:1E:EC', 'H3C'], ['00:21:91', 'H3C'],
    ['00:25:11', 'H3C'], ['3C:8C:40', 'H3C'], ['48:7B:6B', 'H3C'], ['58:66:BA', 'H3C'],
    ['6C:3A:E3', 'H3C'], ['78:AC:58', 'H3C'], ['88:15:44', 'H3C'], ['A0:36:9F', 'H3C'],
    ['B0:F1:63', 'H3C'], ['C8:91:0E', 'H3C'], ['E0:BE:03', 'H3C'], ['F0:29:29', 'H3C'],
    ['00:00:0C', 'Cisco'], ['00:03:FD', 'Cisco'], ['00:06:28', 'Cisco'], ['00:0B:BE', 'Cisco'],
    ['00:0D:BD', 'Cisco'], ['00:0D:ED', 'Cisco'], ['00:11:21', 'Cisco'], ['00:11:93', 'Cisco'],
    ['00:12:DA', 'Cisco'], ['00:13:C3', 'Cisco'], ['00:14:A8', 'Cisco'], ['00:15:F9', 'Cisco'],
    ['00:16:46', 'Cisco'], ['00:17:94', 'Cisco'], ['00:18:18', 'Cisco'], ['00:18:BA', 'Cisco'],
    ['00:19:06', 'Cisco'], ['00:19:55', 'Cisco'], ['00:1A:30', 'Cisco'], ['00:1A:A1', 'Cisco'],
    ['00:1B:0D', 'Cisco'], ['00:1B:D4', 'Cisco'], ['00:1C:0E', 'Cisco'], ['00:1C:42', 'Cisco'],
    ['00:1C:58', 'Cisco'], ['00:1C:B7', 'Cisco'], ['00:1D:45', 'Cisco'], ['00:1D:A1', 'Cisco'],
    ['00:1E:13', 'Cisco'], ['00:1E:49', 'Cisco'], ['00:1E:4A', 'Cisco'], ['00:1E:7A', 'Cisco'],
    ['00:1F:9C', 'Cisco'], ['00:1F:A7', 'Cisco'], ['00:22:55', 'Cisco'], ['00:22:BD', 'Cisco'],
    ['00:23:04', 'Cisco'], ['00:23:33', 'Cisco'], ['00:23:5E', 'Cisco'], ['00:24:13', 'Cisco'],
    ['00:24:97', 'Cisco'], ['00:24:C4', 'Cisco'], ['00:25:45', 'Cisco'], ['00:25:84', 'Cisco'],
    ['00:25:B5', 'Cisco'], ['00:26:0B', 'Cisco'], ['00:26:51', 'Cisco'], ['00:26:98', 'Cisco'],
    ['00:50:56', 'VMware'], ['00:0C:29', 'VMware'], ['00:05:69', 'VMware'], ['00:1C:14', 'VMware'],
    ['54:9F:13', 'Ruijie'], ['F0:29:29', 'Ruijie'], ['D0:D0:4B', 'Ruijie'], ['A4:56:02', 'Ruijie'],
    ['00:24:A8', 'Ruijie'], ['84:78:3E', 'Ruijie'], ['90:B1:1C', 'Ruijie'], ['B0:6E:BF', 'Ruijie'],
    ['00:03:47', 'Intel'], ['00:04:23', 'Intel'], ['00:07:E9', 'Intel'], ['00:0E:0C', 'Intel'],
    ['00:0F:B0', 'Intel'], ['00:12:3B', 'Intel'], ['00:13:20', 'Intel'], ['00:15:17', 'Intel'],
    ['00:16:76', 'Intel'], ['00:18:DE', 'Intel'], ['00:19:D1', 'Intel'], ['00:1B:21', 'Intel'],
    ['00:1C:BF', 'Intel'], ['00:1D:72', 'Intel'], ['00:1E:64', 'Intel'], ['00:1F:16', 'Intel'],
    ['00:22:68', 'Intel'], ['00:23:14', 'Intel'], ['00:24:D7', 'Intel'], ['00:25:64', 'Intel'],
    ['00:26:B0', 'Intel'], ['00:26:C7', 'Intel'], ['00:27:0E', 'Intel'],
    ['00:03:93', 'Apple'], ['00:05:02', 'Apple'], ['00:0A:27', 'Apple'], ['00:0A:95', 'Apple'],
    ['00:0D:93', 'Apple'], ['00:11:24', 'Apple'], ['00:14:51', 'Apple'], ['00:16:CB', 'Apple'],
    ['00:17:F2', 'Apple'], ['00:19:E3', 'Apple'], ['00:1B:63', 'Apple'], ['00:1C:B3', 'Apple'],
    ['00:1D:4F', 'Apple'], ['00:1E:52', 'Apple'], ['00:1E:C2', 'Apple'], ['00:1F:5B', 'Apple'],
    ['00:1F:6B', 'Apple'], ['00:22:41', 'Apple'], ['00:23:32', 'Apple'], ['00:23:6C', 'Apple'],
    ['00:23:DF', 'Apple'], ['00:24:36', 'Apple'], ['00:25:00', 'Apple'], ['00:25:4B', 'Apple'],
    ['00:25:BC', 'Apple'], ['00:26:08', 'Apple'], ['00:26:4A', 'Apple'], ['00:26:B0', 'Apple'],
    ['00:26:BB', 'Apple'], ['A4:83:E7', 'Apple'], ['AC:87:A3', 'Apple'], ['B8:17:C2', 'Apple'],
    ['F8:1E:DF', 'Apple'],
    ['00:12:FB', 'Samsung'], ['00:13:77', 'Samsung'], ['00:15:B9', 'Samsung'], ['00:16:6B', 'Samsung'],
    ['00:17:C9', 'Samsung'], ['00:18:AF', 'Samsung'], ['00:1A:8A', 'Samsung'], ['00:1B:59', 'Samsung'],
    ['00:1C:62', 'Samsung'], ['00:1D:BA', 'Samsung'], ['00:1E:75', 'Samsung'], ['00:1F:28', 'Samsung'],
    ['00:24:90', 'Samsung'], ['E8:50:8B', 'Samsung'], ['F0:25:B7', 'Samsung'],
    ['00:27:19', 'TP-Link'], ['50:C7:BF', 'TP-Link'], ['54:E6:FC', 'TP-Link'], ['5C:62:8B', 'TP-Link'],
    ['60:32:B1', 'TP-Link'], ['6C:5B:3B', 'TP-Link'], ['88:25:93', 'TP-Link'], ['9C:A6:15', 'TP-Link'],
    ['A0:F3:C1', 'TP-Link'], ['B0:A7:B9', 'TP-Link'], ['B4:B0:24', 'TP-Link'], ['C0:61:AE', 'TP-Link'],
    ['D4:6F:5D', 'TP-Link'], ['DC:FE:18', 'TP-Link'], ['E8:48:B8', 'TP-Link'], ['F8:1A:67', 'TP-Link'],
  ]
  const insertMany = db.transaction(() => {
    for (const [prefix, vendor] of entries) {
      stmt.run(prefix, vendor)
    }
  })
  insertMany()
}
