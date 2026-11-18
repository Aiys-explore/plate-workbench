import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { terminalPluginNames, type CatalogListing, type TerminalPlugin, type TerminalPluginId } from '../../shared/plate-terminal/contract'

const ids = Object.keys(terminalPluginNames) as TerminalPluginId[]
const validId = (value: unknown): value is TerminalPluginId => typeof value === 'string' && ids.some(id => id === value)
const version = (value: unknown): value is string => typeof value === 'string' && /^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(value)
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

function repositoryId(value: string): string {
  if (typeof value !== 'string' || value.length > 160) throw Error('请输入 GitHub 仓库，例如 owner/repo')
  const ref = value.trim().replace(/^https:\/\/github\.com\//i, '').replace(/\/$/, '')
  if (!/^[a-z\d](?:[a-z\d-]{0,38})\/[a-z\d_][a-z\d_.-]{0,99}$/i.test(ref) || ref.endsWith('.git')) {
    throw Error('请输入 GitHub 仓库，例如 owner/repo')
  }
  return ref
}

function parseObject(bytes: Uint8Array): Record<string, unknown> {
  const json: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw Error('插件文件格式无效')
  return json as Record<string, unknown>
}

const maxFileBytes = 32768
async function readGithub(repo: string, file: string): Promise<Uint8Array> {
  const response = await fetch('https://raw.githubusercontent.com/' + repo + '/main/' + file, {
    redirect: 'error', signal: AbortSignal.timeout(8000), credentials: 'omit',
  })
  if (!response.ok || !response.body) throw Error('无法读取 GitHub 插件目录或插件包（HTTP ' + response.status + '）')
  const reader = response.body.getReader()
  const parts: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > maxFileBytes) throw Error('插件文件超出大小限制')
      parts.push(value)
    }
    return Buffer.concat(parts)
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

type Entry = { id: TerminalPluginId; version: string; sha256: string }
function catalogEntries(bytes: Uint8Array): Entry[] {
  const data = parseObject(bytes)
  if (data.schema !== 1 || !Array.isArray(data.plugins) || !data.plugins.length || data.plugins.length > ids.length) throw Error('不支持此插件目录格式')
  const seen = new Set<string>()
  return data.plugins.map((p: Entry) => {
    if (!p || !validId(p.id) || seen.has(p.id) || !version(p.version) || typeof p.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(p.sha256)) {
      throw Error('目录含重复插件、当前版本不兼容的适配器或无效校验值')
    }
    seen.add(p.id)
    return { id: p.id, version: p.version, sha256: p.sha256 }
  })
}

export class TerminalPlugins {
  private readonly file: string
  private readonly catalogs = new Map<string, { entries: Entry[]; expires: number }>()

  constructor(private readonly userData: string) { this.file = join(userData, 'plate-terminal-plugins.json') }

  list(): TerminalPlugin[] {
    try {
      const parsed = parseObject(readFileSync(this.file))
      if (parsed.schema !== 1 || !Array.isArray(parsed.plugins)) throw Error('本机插件记录格式无效')
      return parsed.plugins.map((p: TerminalPlugin) => {
        if (!p || !validId(p.id) || !version(p.version) || typeof p.source !== 'string') throw Error('本机插件记录无效')
        return { id: p.id, version: p.version, source: p.source === 'local' ? 'local' : repositoryId(p.source) }
      })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }

  has(id: unknown): boolean { return validId(id) && this.list().some(p => p.id === id) }

  private save(plugins: TerminalPlugin[]): TerminalPlugin[] {
    mkdirSync(this.userData, { recursive: true })
    writeFileSync(this.file + '.tmp', JSON.stringify({ schema: 1, plugins }, null, 2) + '\n')
    renameSync(this.file + '.tmp', this.file)
    return plugins
  }

  async catalog(repository: string): Promise<CatalogListing> {
    const repo = repositoryId(repository)
    const entries = catalogEntries(await readGithub(repo, 'plate-plugins.json'))
    if (this.catalogs.size >= 12) this.catalogs.clear()
    this.catalogs.set(repo, { entries, expires: Date.now() + 15 * 60 * 1000 })
    return { repository: repo, plugins: entries.map(({id, version}) => ({ id, version, source: repo })) }
  }

  async install(id: TerminalPluginId, repository?: string): Promise<TerminalPlugin[]> {
    if (!validId(id)) throw Error('此版本的 Plate 不支持该插件')
    let item: TerminalPlugin = { id, version: '1.0.0', source: 'local' }
    if (repository !== undefined) {
      const repo = repositoryId(repository)
      const catalog = this.catalogs.get(repo)
      const entry = catalog && catalog.expires >= Date.now() && catalog.entries.find(p => p.id === id)
      if (!entry) throw Error('请刷新 GitHub 目录后再安装')
      const bytes = await readGithub(repo, 'plugins/' + id + '.json')
      if (sha256(bytes) !== entry.sha256) throw Error('插件校验失败，请刷新目录后重试')
      const data = parseObject(bytes)
      if (Object.keys(data).length !== 4 || data.schema !== 1 || data.id !== id ||
          data.version !== entry.version || data.adapter !== id) throw Error('插件适配器或版本不匹配')
      item = { id, version: entry.version, source: repo }
    }
    return this.save([...this.list().filter(p => p.id !== id), item])
  }

  remove(id: TerminalPluginId): TerminalPlugin[] {
    if (!validId(id)) throw Error('此版本的 Plate 不支持该插件')
    return this.save(this.list().filter(p => p.id !== id))
  }
}
