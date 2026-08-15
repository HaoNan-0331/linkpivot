import iconv from 'iconv-lite'

/**
 * 设备输出 buffer 解码单一来源（UTF-8 优先，无效序列回退 GBK）。
 *
 * 纯提取自 ai.ts decodeDeviceBuffer（逐字照搬，零语义改动）；
 * ai.ts / connection.ts 已接线（15-01/15-02 完成）。Telnet 终端纯 GBK
 * 解码（connection.ts connectTelnet 裸 iconv.decode）为历史行为，非收敛遗漏。
 */

export function decodeDeviceBuffer(data: Buffer): string {
  // Try UTF-8 first; if it contains invalid sequences, fall back to GBK
  const text = data.toString('utf-8')
  if (!text.includes('�')) return text
  return iconv.decode(data, 'gbk')
}
