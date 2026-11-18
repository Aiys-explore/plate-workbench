export function webAddress(input: string): string {
  if (typeof input !== 'string' || input.length > 8192 || !input.trim() || /[\u0000-\u001F\u007F\\]/.test(input)) {
    throw new Error('链接地址包含非法字符')
  }
  let url: URL
  try { url = new URL(input.trim()) } catch { throw new Error('链接地址无效') }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error('只允许无凭据的 HTTP 或 HTTPS 链接')
  return url.href
}

export function bitmapPath(input: string): string {
  let decoded: string
  try { decoded = decodeURIComponent(input) } catch { throw new Error('图片路径编码无效') }
  if (typeof input !== 'string' || !decoded || /[\\:\u0000-\u001f?#%]/.test(decoded) || decoded.split('/').some(p => !p || p === '.' || p === '..' || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)) ||
      !/\.(png|jpe?g|gif|webp|bmp|avif|ico)$/i.test(decoded)) throw new Error('只允许笔记内相对路径的受支持位图')
  return decoded
}
