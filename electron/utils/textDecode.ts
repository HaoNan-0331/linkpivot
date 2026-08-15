import iconv from 'iconv-lite'

/**
 * 设备输出 buffer 解码单一来源（UTF-8 优先，无效序列回退 GBK）。
 *
 * 纯提取自 ai.ts decodeDeviceBuffer（逐字照搬，零语义改动）；
 * connection.ts decodeBuffer 为同构镜像，Wave 2（15-02）接线收敛。
 */

export function decodeDeviceBuffer(data: Buffer): string {
  // Try UTF-8 first; if it contains invalid sequences, fall back to GBK
  const text = data.toString('utf-8')
  if (!text.includes('�')) return text
  return iconv.decode(data, 'gbk')
}
