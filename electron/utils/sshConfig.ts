import type { ConnectConfig } from 'ssh2'

// SSH 握手 ready 超时（TCP connect + KEX + auth → 'ready' 事件）。
// ai.ts buildSSHConfig 与 arpCollector.ts executeSSH 共用同一常量，
// 防止两路径数值漂移（历史 bug：buildSSHConfig 10s / executeSSH 30s 不一致，
// 慢设备 10-30s 区间握手时 AI/discovery 路径触发 ssh2 readyTimeout → "连接超时"）。
export const SSH_READY_TIMEOUT_MS = 30000

// algorithms 取 ai.ts 与 arpCollector.ts 历史列表的并集，保最大设备兼容
// （运维工具需连各种厂商/老型号设备，宁可列宽不可漏）。
export const SSH_ALGORITHMS: ConnectConfig['algorithms'] = {
  kex: [
    'curve25519-sha256',
    'ecdh-sha2-nistp256', 'ecdh-sha2-nistp384', 'ecdh-sha2-nistp521',
    'diffie-hellman-group-exchange-sha256', 'diffie-hellman-group14-sha256',
    'diffie-hellman-group15-sha512', 'diffie-hellman-group16-sha512',
    'diffie-hellman-group-exchange-sha1', 'diffie-hellman-group14-sha1',
    'diffie-hellman-group1-sha1',
  ],
  cipher: [
    'aes128-gcm@openssh.com', 'aes256-gcm@openssh.com',
    'aes128-gcm', 'aes256-gcm',
    'aes128-ctr', 'aes192-ctr', 'aes256-ctr',
    'aes128-cbc', 'aes192-cbc', 'aes256-cbc',
    '3des-cbc', 'blowfish-cbc',
  ],
  serverHostKey: [
    'ssh-ed25519',
    'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521',
    'rsa-sha2-512', 'rsa-sha2-256',
    'ssh-rsa', 'ssh-dss',
  ],
}
