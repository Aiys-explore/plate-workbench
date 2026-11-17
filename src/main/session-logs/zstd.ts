import { zstdDecompressSync } from 'node:zlib'

// Read frame boundaries independently: Node's Zstd decoder stops at the first frame.
// Returns null for a partial frame and throws only for a malformed header/block.
export function frameAt(b: Buffer, start = 0): { end: number; skip: boolean } | null {
  if (start + 4 > b.length) return null
  const magic = b.readUInt32LE(start)
  let pos = start + 4
  if ((magic >>> 4) === 0x184d2a5) {
    if (pos + 4 > b.length) return null
    const end = pos + 4 + b.readUInt32LE(pos)
    return end <= b.length ? { end, skip: true } : null
  }
  if (magic !== 0xfd2fb528) throw new Error('zstd-magic')
  if (pos >= b.length) return null
  const descriptor = b[pos++], single = Boolean(descriptor & 32)
  if (descriptor & 8) throw new Error('zstd-header')
  pos += (single ? 0 : 1) + [0, 1, 2, 4][descriptor & 3] + [single ? 1 : 0, 2, 4, 8][descriptor >> 6]
  for (;;) {
    if (pos + 3 > b.length) return null
    const header = b.readUIntLE(pos, 3), type = (header >> 1) & 3, size = header >>> 3
    if (type === 3 || size > 128 * 1024) throw new Error('zstd-block')
    pos += 3 + (type === 1 ? 1 : size)
    if (header & 1) {
      const end = pos + (descriptor & 4 ? 4 : 0)
      return end <= b.length ? { end, skip: false } : null
    }
    if (pos > b.length) return null
  }
}
export const decompressFrame = (b: Buffer) => zstdDecompressSync(b, { maxOutputLength: 16 * 1024 * 1024 })
