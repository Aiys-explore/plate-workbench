import { nativeImage } from 'electron'
import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs'
import { extname, join, relative, sep, isAbsolute } from 'node:path'
import { bitmapPath } from '../shared/media-address'

const signatures: Record<string, (bytes: Buffer) => boolean> = {
  '.png': b => b.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')),
  '.jpg': b => b.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex')),
  '.gif': b => /^GIF8[79]a$/.test(b.toString('ascii', 0, 6)),
  '.webp': b => b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP',
  '.bmp': b => b.toString('ascii', 0, 2) === 'BM',
  '.avif': b => /^ftypavi[fs]$/.test(b.toString('ascii', 4, 12)),
  '.ico': b => b.subarray(0, 4).equals(Buffer.from('00000100', 'hex'))
}
signatures['.jpeg'] = signatures['.jpg']

export function readBitmap(directory: string, address: string): string {
  const path = bitmapPath(address)
  const base = realpathSync.native(directory)
  if (relative(directory, base)) throw new Error('笔记目录已改变')
  const file = join(base, ...path.split('/'))
  const inside = relative(base, realpathSync.native(file))
  if (!inside || isAbsolute(inside) || inside.split(sep)[0] === '..') throw new Error('图片不在授权笔记目录内')
  if (relative(file, join(base, inside))) throw new Error('图片路径需使用普通目录和文件')
  let component = base
  const parts = path.split('/')
  for (const [index, part] of parts.entries()) {
    component = join(component, part)
    const stat = lstatSync(component)
    if (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory()) throw new Error('图片路径需使用普通目录和文件')
  }
  const fd = openSync(file, 'r')
  try {
    const stat = fstatSync(fd, { bigint: true })
    const current = lstatSync(file, { bigint: true })
    if (!stat.isFile() || stat.size <= 0 || stat.size > 16n * 1024n * 1024n || !current.isFile() ||
        stat.ino !== current.ino || stat.dev !== current.dev || realpathSync.native(file) !== join(base, inside)) {
      throw new Error('图片不可用、过大或路径已改变')
    }
    const bytes = Buffer.alloc(Number(stat.size))
    let count = 0
    while (count < bytes.length) {
      const read = readSync(fd, bytes, count, bytes.length - count, count)
      if (!read) break
      count += read
    }
    const after = fstatSync(fd, { bigint: true })
    if (count !== bytes.length || after.mtimeNs !== stat.mtimeNs || after.ctimeNs !== stat.ctimeNs) throw new Error('图片已改变，请重试')
    if (!signatures[extname(path).toLowerCase()]?.(bytes)) throw new Error('文件内容与位图类型不符')
    const image = nativeImage.createFromBuffer(bytes)
    if (image.isEmpty()) throw new Error('无法解码图片')
    const { width, height } = image.getSize()
    if (width * height > 24_000_000) throw new Error('图片像素过多')
    return image.toDataURL()
  } finally { closeSync(fd) }
}
