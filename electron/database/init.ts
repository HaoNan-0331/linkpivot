import { getDatabase } from './connection'

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
      exec_mode TEXT DEFAULT 'confirm' CHECK(exec_mode IN ('confirm','auto')),
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
      mode TEXT CHECK(mode IN ('confirm','auto')),
      ai_reason TEXT,
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
      type TEXT NOT NULL DEFAULT 'discovery' CHECK(type IN ('discovery')),
      status TEXT NOT NULL CHECK(status IN ('success','failed')),
      device_ids TEXT,
      device_names TEXT,
      prompt_text TEXT,
      ai_response TEXT,
      parsed_result TEXT,
      error_message TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );

    INSERT OR IGNORE INTO command_whitelist (id, pattern) VALUES
      ('w1', 'display'),
      ('w2', 'show'),
      ('w3', 'enable'),
      ('w4', 'system-view'),
      ('w5', 'quit'),
      ('w6', 'ping'),
      ('w7', 'traceroute'),
      ('w8', 'terminal');

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

    CREATE TRIGGER IF NOT EXISTS kb_chunks_ai AFTER INSERT ON kb_chunks BEGIN
      INSERT INTO kb_chunks_fts(rowid, title, content, image_desc)
        VALUES (new.rowid, new.title, new.content,
          (SELECT GROUP_CONCAT(description, ' ') FROM kb_images WHERE chunk_id = new.id));
    END;

    CREATE TRIGGER IF NOT EXISTS kb_chunks_ad AFTER DELETE ON kb_chunks BEGIN
      INSERT INTO kb_chunks_fts(kb_chunks_fts, rowid, title, content, image_desc)
        VALUES ('delete', old.rowid, old.title, old.content,
          (SELECT GROUP_CONCAT(description, ' ') FROM kb_images WHERE chunk_id = old.id));
    END;

    CREATE TRIGGER IF NOT EXISTS kb_chunks_au AFTER UPDATE ON kb_chunks BEGIN
      INSERT INTO kb_chunks_fts(kb_chunks_fts, rowid, title, content, image_desc)
        VALUES ('delete', old.rowid, old.title, old.content,
          (SELECT GROUP_CONCAT(description, ' ') FROM kb_images WHERE chunk_id = old.id));
      INSERT INTO kb_chunks_fts(rowid, title, content, image_desc)
        VALUES (new.rowid, new.title, new.content,
          (SELECT GROUP_CONCAT(description, ' ') FROM kb_images WHERE chunk_id = new.id));
    END;
  `)

  // Migrate: add session_id column to existing chat_history table
  const db = getDatabase()
  const cols = db.prepare("PRAGMA table_info(chat_history)").all() as any[]
  if (!cols.some((c) => c.name === 'session_id')) {
    db.exec('ALTER TABLE chat_history ADD COLUMN session_id TEXT')
  }

  // Migrate: add prompt_text and ai_response columns to ai_exec_logs
  const execLogCols = db.prepare("PRAGMA table_info(ai_exec_logs)").all() as any[]
  if (!execLogCols.some((c) => c.name === 'prompt_text')) {
    db.exec("ALTER TABLE ai_exec_logs ADD COLUMN prompt_text TEXT DEFAULT ''")
  }
  if (!execLogCols.some((c) => c.name === 'ai_response')) {
    db.exec("ALTER TABLE ai_exec_logs ADD COLUMN ai_response TEXT DEFAULT ''")
  }

  // Migrate: add status and last_checked columns to devices table
  const deviceCols = db.prepare("PRAGMA table_info(devices)").all() as any[]
  if (!deviceCols.some((c) => c.name === 'status')) {
    db.exec("ALTER TABLE devices ADD COLUMN status TEXT DEFAULT 'unknown' CHECK(status IN ('online','offline','unknown'))")
  }
  if (!deviceCols.some((c) => c.name === 'last_checked')) {
    db.exec('ALTER TABLE devices ADD COLUMN last_checked TEXT')
  }

  // Migrate: add vision model columns to ai_config table
  const aiConfigCols = db.prepare("PRAGMA table_info(ai_config)").all() as any[]
  if (!aiConfigCols.some((c) => c.name === 'vision_base_url_enc')) {
    db.exec("ALTER TABLE ai_config ADD COLUMN vision_base_url_enc TEXT")
  }
  if (!aiConfigCols.some((c) => c.name === 'vision_api_key_enc')) {
    db.exec("ALTER TABLE ai_config ADD COLUMN vision_api_key_enc TEXT")
  }
  if (!aiConfigCols.some((c) => c.name === 'vision_model_enc')) {
    db.exec("ALTER TABLE ai_config ADD COLUMN vision_model_enc TEXT")
  }

  // Migrate: expand connection_type CHECK constraint to include 'rdp'
  // SQLite doesn't support ALTER CHECK, so recreate the table
  const connTypeCheck = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='devices'").get() as any)?.sql || ''
  if (!connTypeCheck.includes("'rdp'")) {
    // 重建表（SQLite 不支持 ALTER CHECK），整段包事务保证原子：
    // 中途失败自动回滚，避免 devices 已 DROP 未 RENAME 致子表外键悬空、重启即崩。
    const rebuildDevices = db.transaction(() => {
      db.exec("DROP TABLE IF EXISTS devices_new")
      db.exec(`
        CREATE TABLE devices_new (
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
          status TEXT DEFAULT 'unknown',
          last_checked TEXT,
          created_at TEXT DEFAULT (datetime('now','localtime')),
          updated_at TEXT DEFAULT (datetime('now','localtime')),
          FOREIGN KEY (topology_id) REFERENCES topologies(id) ON DELETE SET NULL
        );
        INSERT INTO devices_new
          SELECT id, topology_id, name_enc, vendor_enc, model_enc, version_enc, ip_enc,
            COALESCE(device_type, 'generic'), connection_type, port_enc, username_enc,
            password_enc, ssh_key_path_enc, ssh_key_content_enc, web_url_enc,
            COALESCE(status, 'unknown'), last_checked, created_at, updated_at
          FROM devices;
        DROP TABLE devices;
        ALTER TABLE devices_new RENAME TO devices;
      `)
      const fkErrors = db.pragma('foreign_key_check') as any[]
      if (fkErrors.length > 0) {
        throw new Error('devices 重建后外键完整性校验失败: ' + JSON.stringify(fkErrors))
      }
    })
    rebuildDevices()
  }

  // Initialize default OUI data
  initDefaultOUIData(db)
}

function initDefaultOUIData(db: any) {
  const count = (db.prepare('SELECT COUNT(*) as cnt FROM oui_database').get() as any).cnt
  if (count > 0) return

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
