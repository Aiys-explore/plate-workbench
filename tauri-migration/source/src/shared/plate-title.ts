export function plateTitle(source: string) {
  const start = source.startsWith('\uFEFF') ? 1 : 0
  const match = /^<!-- plate-title:([A-Za-z0-9_.!~*'()%+-]*) -->(?:\r\n|\n|\r)/.exec(source.slice(start))
  if (!match) return undefined
  try { return { start, end: start + match[0].length, title: decodeURIComponent(match[1]) } } catch { return undefined }
}

export function plateTitleLine(value: string, newline = '\n') {
  return '<!-- plate-title:' + encodeURIComponent(value) + ' -->' + newline
}

export function noteTitle(source: string) {
  const metadata = plateTitle(source)
  if (metadata) return metadata
  const start = source.startsWith('\uFEFF') ? 1 : 0
  const legacy = /^# ([^\r\n]*)(?:\r\n|\r|\n|$)/.exec(source.slice(start))
  const title = legacy?.[1].trim().replace(/#+$/, '').trim()
  if (legacy && title) return { start, end: start + legacy[0].length, title }
}
