import { parse } from 'yaml'
import { scanWiki, wikiParser } from '../shared/wiki-markdown'
import { plateTitle } from '../shared/plate-title'

const previewParser = wikiParser().set({html:true})
function bodyPreview(body:string,title:string) {
  const blocks=previewParser.parse(body,{})
  for(let i=0;i<blocks.length;i++) {
    const block=blocks[i]!
    if(block.type!=='inline') continue
    const text=(block.children??[]).map(t=>t.type==='text'||t.type==='code_inline'?t.content:
      t.type==='wiki_link' ? (t.meta?.label===t.meta?.ref && /^[0-9a-f-]{36}$/i.test(String(t.meta?.ref??'')) ? '' : String(t.meta?.label??'')) :
      t.type==='softbreak'||t.type==='hardbreak'?' ':'').join('').replace(/\s+/gu,' ').trim()
    if(!text || (blocks[i-1]?.type==='heading_open' && text===title)) continue
    const chars=Array.from(text)
    return chars.length>113?chars.slice(0,112).join('')+'…':text
  }
  return ''
}

export function noteMetadata(content: string, fallback: string) {
  const title = plateTitle(content)
  const text = title ? content.slice(title.end) : content.replace(/^\uFEFF/, '')
  const frontmatter = /^---[ \t]*\r?\n([\s\S]*?)^---[ \t]*(?:\r?\n|$)/m.exec(text)
  let metadata: { title?: unknown; tags?: unknown } = {}
  let body = text
  if (frontmatter?.index === 0) {
    body = text.slice(frontmatter[0].length)
    try {
      const data: unknown = parse(frontmatter[1], { maxAliasCount: 0, logLevel: 'silent' })
      if (data && typeof data === 'object') metadata = data
    } catch { /* Invalid YAML does not prevent reading or editing the note. */ }
  }
  const heading = /^#[ \t]+(.+?)\s*$/.exec(body.split(/\r?\n/, 1)[0])?.[1]
    .replace(/[ \t]+#+$/, '').trim()
  const metaTitle = typeof metadata.title === 'string' ? metadata.title.trim() : ''
  const tags = new Set<string>()
  const addTag = (tag: string) => {
    const value = tag.trim().replace(/^#/, '').normalize('NFKC').toLowerCase()
    if (value) tags.add(value)
  }
  const metaTags = Array.isArray(metadata.tags) ? metadata.tags
    : typeof metadata.tags === 'string' ? metadata.tags.split(',') : []
  for (const tag of metaTags) if (typeof tag === 'string') addTag(tag)

  const { references, inlineProse } = scanWiki(text)
  const prose = inlineProse.join('\n')
  for (const match of prose.matchAll(/(?:^|[\s(])#([\p{L}\p{N}_][\p{L}\p{N}_/-]*)/gu)) addTag(match[1])
  const name=title ? title.title.trim() || '未命名笔记' : heading || metaTitle || fallback
  return { title:name, tags, references, body, preview:bodyPreview(body,name) }
}
