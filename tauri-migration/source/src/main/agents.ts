import Database from 'better-sqlite3'
import { localSqlitePath } from './local-sqlite-path'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { checkAgentInput, capabilityKeys, type AgentInput, type AgentProfile, type Capability, type Evidence, type Probe } from '../shared/agents'
import { adapter, executableIdentity, probeExecutable, resolveLog } from './agent-probe'
import { adapterVersion } from './session-logs/adapters'

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const validId = (id: string) => { if (typeof id !== 'string' || !uuid.test(id)) throw new Error('档案 ID 无效') }

function validate(input: AgentInput): AgentInput {
  if (!input || typeof input !== 'object') throw new Error('档案无效')
  const { normalized, errors } = checkAgentInput(input, process.platform==='win32')
  const issue=Object.entries(errors)[0]
  if (issue) throw new Error('字段无效：'+issue[0]+' · '+issue[1])
  const {name,type,executable,model,effort,permission,workdir,extraArgv,logOverride,enabled,icon,color,timeoutMs}=normalized
  return {name,type,executable,model,effort,permission,workdir,extraArgv,logOverride,enabled,icon,color,timeoutMs}
}

type Row = { id: string; config: string; probe: string | null; stamp: string | null; scope_v2: number }
type EvidenceRow = Evidence & { capability: Capability }
// Cosmetic edits and enabled do not change the tested execution configuration.
const execution = (c: AgentInput) => JSON.stringify([c.type,c.executable,c.model,c.effort,c.permission,c.workdir,c.extraArgv,c.logOverride,c.timeoutMs])
const delegationRevision = (c: AgentInput) => createHash('sha256').update(execution(c)).digest('hex')
export class AgentStore {
  private readonly db: Database.Database
  private probing = false
  private closed = false
  constructor(file: string, private readonly zcodeEvidence?: (path: string) => {source:string;at:number|null}[]) {
    this.db = new Database(localSqlitePath(file), { timeout: 1000 })
    this.db.pragma('foreign_keys = ON')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_profile (
        id TEXT PRIMARY KEY, config TEXT NOT NULL CHECK(json_valid(config)), probe TEXT, stamp TEXT
      );
      CREATE TABLE IF NOT EXISTS agent_probe_cache (
        executable TEXT NOT NULL, version TEXT NOT NULL, stamp TEXT NOT NULL,
        timeout_ms INTEGER NOT NULL, adapter TEXT NOT NULL, probe TEXT NOT NULL,
        PRIMARY KEY(executable, version, timeout_ms, adapter)
      );
      CREATE TABLE IF NOT EXISTS agent_capability_evidence (
        profile_id TEXT NOT NULL REFERENCES agent_profile(id) ON DELETE CASCADE,
        scope TEXT NOT NULL, capability TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('supported','unsupported','unknown')),
        source TEXT NOT NULL, adapter TEXT NOT NULL, date TEXT NOT NULL,
        PRIMARY KEY(profile_id, scope, capability),
        CHECK(capability != 'cli')
      );
      CREATE TABLE IF NOT EXISTS agent_cli_history (
        profile_id TEXT PRIMARY KEY REFERENCES agent_profile(id) ON DELETE CASCADE,
        probe TEXT NOT NULL
      );
    `)
    if (!this.db.prepare("SELECT 1 FROM pragma_table_info('agent_profile') WHERE name='scope_v2'").get()) {
      this.db.exec('ALTER TABLE agent_profile ADD COLUMN scope_v2 INTEGER NOT NULL DEFAULT 0')
    }
  }
  deleteDatabase(){return this.db}
  close() { this.closed = true; this.db.close() }

  logSources() {
    const rows = this.db.prepare('SELECT config FROM agent_profile').all() as { config: string }[]
    return rows.map(({ config }) => {
      const { type, enabled, logOverride } = JSON.parse(config) as AgentInput
      const { logPath, logSource } = resolveLog(type, logOverride)
      const archivePath = type === 'codex' && !logOverride && logSource !== 'NOTES_WORKBENCH_AGENT_CODEX_LOG_DIR'
        ? join(dirname(logPath), 'archived_sessions') : undefined
      return { type, enabled, logPath, archivePath }
    })
  }

  private row(id: string) {
    validId(id)
    const row = this.db.prepare('SELECT * FROM agent_profile WHERE id = ?').get(id) as Row | undefined
    if (!row) throw new Error('档案不存在')
    return row
  }

  private async view(row: Row): Promise<AgentProfile> {
    const config = JSON.parse(row.config) as AgentInput
    const log = resolveLog(config.type, config.logOverride)
    const storedProbe = row.probe ? JSON.parse(row.probe) as Probe : null
    let probe = storedProbe
    if (probe?.adapter !== adapter || !row.scope_v2) probe = null
    if (row.stamp && probe) {
      const current = await executableIdentity(config.executable).catch(() => null)
      if (!current || current.stamp !== row.stamp) probe = null
    }
    const capabilities = Object.fromEntries(capabilityKeys.map((key) => [key,
      { state: 'unknown', source: key === 'handoff' ? '仅手动交接（尚无客户端实测）' : '暂无验证证据',
        adapter: key === 'cli' ? adapter : '—', date: null }
    ])) as AgentProfile['capabilities']
    const cliEvidence = (observation: Probe): Evidence => ({
      state: observation.status === 'ok' ? 'supported' : observation.status === 'incompatible' ? 'unsupported' : 'unknown',
      source: observation.steps.length ? observation.steps.map((s) => `${s.flag}: ${s.detail}`).join('；') : '本机可执行路径检查',
      date: observation.date, adapter: observation.adapter
    })
    if (probe) capabilities.cli = cliEvidence(probe)
    // Scope observations to their Agent type, executable identity/version and effective log path.
    // Only application-owned adapter evidence belongs here; profile edits cannot assign capabilities.
    const scope = JSON.stringify([execution(config), probe?.version ?? null, probe ? row.stamp : null, log.logPath])
    const historicalCapabilities: NonNullable<AgentProfile['historicalCapabilities']> = {}
    if (!this.closed && !probe) {
      const prior = this.db.prepare('SELECT probe FROM agent_cli_history WHERE profile_id = ?').get(row.id) as {probe:string} | undefined
      const old = storedProbe ?? (prior ? JSON.parse(prior.probe) as Probe : null)
      if (old) historicalCapabilities.cli = cliEvidence(old)
    }
    if (!this.closed && row.scope_v2 && !(row.stamp && !probe)) {
      const records = this.db.prepare('SELECT capability, state, source, adapter, date FROM agent_capability_evidence WHERE profile_id = ? AND scope = ?')
        .all(row.id, scope) as EvidenceRow[]
      for (const { capability, ...evidence } of records) {
        if (capability !== 'cli' && capabilityKeys.includes(capability)) capabilities[capability] = evidence
      }
    }
    if (!this.closed) {
      const previous = this.db.prepare(
        'SELECT capability, state, source, adapter, date FROM agent_capability_evidence WHERE profile_id = ? AND (? OR scope <> ?) ORDER BY date DESC, scope DESC'
      ).all(row.id, Number(!row.scope_v2 || !!row.stamp && !probe), scope) as EvidenceRow[]
      for (const {capability, ...evidence} of previous) {
        if (capability !== 'cli' && capabilityKeys.includes(capability)) historicalCapabilities[capability] ??= evidence
      }
    }
    if (config.type === 'zcode' && config.enabled && log.logPath && this.zcodeEvidence) {
      const observed = this.zcodeEvidence(log.logPath)
      const grant = (key: Capability, match: (source: string) => boolean, detail: string) => {
        if (!observed.some(x=>match(x.source))) return
        capabilities[key] = {state:'supported',source:detail,adapter:adapterVersion.zcode,date:new Date().toISOString()}
      }
      grant('logs',s=>s==='sqlite/session','当前档案的 SQLite 会话库已只读解析')
      grant('sessions',s=>s==='sqlite/session','当前档案的 session 表提供会话标识')
      grant('replies',s=>s==='sqlite/message+part.text','当前档案有可读对话正文')
      grant('turns',s=>s==='sqlite/turn_usage.completed','当前档案有明确结束的轮次')
      grant('calls',s=>s==='sqlite/tool_usage'||s==='sqlite/part.tool','当前档案有工具执行事件')
      grant('tokens',s=>s==='sqlite/model_usage','当前档案有逐请求用量记录')
    }
    return { ...config, id: row.id, delegationRevision: delegationRevision(config), ...log, probe, capabilities, historicalCapabilities }
  }

  async list() {
    const rows = this.db.prepare("SELECT * FROM agent_profile ORDER BY json_extract(config,'$.name') COLLATE NOCASE, id").all() as Row[]
    return Promise.all(rows.map((row) => this.view(row)))
  }

  delegationProfiles() {
    return this.db.prepare('SELECT id, config FROM agent_profile').all().map(entry => {
      const { id, config } = entry as Pick<Row, 'id' | 'config'>
      const { type, enabled } = JSON.parse(config) as AgentInput
      return { id, type, enabled }
    })
  }

  delegationProfile(id: string) {
    try {
      const config = JSON.parse(this.row(id).config) as AgentInput
      return { ...config, id, revision: delegationRevision(config), ...resolveLog(config.type, config.logOverride) }
    } catch { return undefined }
  }

  async save(id: string | null, input: AgentInput, creationId?: string) {
    const config = validate(input)
    const serialized = JSON.stringify(config)
    if (id === null) {
      id = creationId ?? randomUUID()
      validId(id)
      const existing = this.db.prepare('SELECT * FROM agent_profile WHERE id = ?').get(id) as Row | undefined
      if (existing) {
        if (existing.config !== serialized) throw new Error('该次创建的档案已存在且内容已变化；请先核对。')
        return this.view(existing)
      }
      this.db.prepare('INSERT INTO agent_profile(id, config, scope_v2) VALUES (?, ?, 1)').run(id, serialized)
    } else {
      const row = this.row(id)
      const old = JSON.parse(row.config) as AgentInput
      const reset = !row.scope_v2 || execution(old)!==execution(config)
      this.db.transaction(()=>{
        if (reset && row.probe) this.db.prepare('INSERT OR REPLACE INTO agent_cli_history VALUES (?, ?)').run(id,row.probe)
        this.db.prepare('UPDATE agent_profile SET config=?, probe=?, stamp=?, scope_v2=1 WHERE id=?')
          .run(serialized, reset ? null : row.probe, reset ? null : row.stamp, id)
      })()
    }
    return this.view(this.row(id))
  }

  remove(id: string) {
    validId(id)
    this.db.prepare('DELETE FROM agent_profile WHERE id=?').run(id)
  }

  async setEnabled(id: string, enabled: boolean) {
    if (typeof enabled !== 'boolean') throw new Error('启用状态无效')
    this.row(id)
    this.db.prepare("UPDATE agent_profile SET config=json_set(config,'$.enabled',json(?)) WHERE id=?").run(JSON.stringify(enabled),id)
    return this.view(this.row(id))
  }

  async probe(id: string, force: boolean) {
    if (typeof force !== 'boolean') throw new Error('探测模式无效')
    if (this.probing) throw new Error('已有探测正在运行')
    const row = this.row(id)
    const config = JSON.parse(row.config) as AgentInput
    if (!config.enabled) throw new Error('请先启用此档案')
    this.probing = true
    try {
      const identity = await executableIdentity(config.executable).catch(() => null)
      let result: { probe: Probe; stamp: string | null } | undefined
      if (!force && identity?.stamp && !this.closed) {
        const cached = this.db.prepare(`SELECT probe FROM agent_probe_cache
          WHERE executable=? AND stamp=? AND timeout_ms=? AND adapter=? ORDER BY rowid DESC LIMIT 1`)
          .get(identity.executable, identity.stamp, config.timeoutMs, adapter) as { probe: string } | undefined
        if (cached) result = { probe: { ...JSON.parse(cached.probe), executable: config.executable, cached: true }, stamp: identity.stamp }
      }
      result ??= await probeExecutable(config.executable, config.timeoutMs)
      if (this.closed) throw new Error('应用正在关闭')
      if (this.row(id).config !== row.config) throw new Error('档案已改变，请重新探测')
      const { probe, stamp } = result
      this.db.transaction(() => {
        if (!probe.cached && identity && stamp && probe.version && probe.status === 'ok') {
          this.db.prepare('DELETE FROM agent_probe_cache WHERE executable=? AND timeout_ms=? AND adapter=?')
            .run(identity.executable, config.timeoutMs, adapter)
          this.db.prepare('INSERT INTO agent_probe_cache VALUES (?, ?, ?, ?, ?, ?)')
            .run(identity.executable, probe.version, stamp, config.timeoutMs, adapter, JSON.stringify(probe))
        }
        this.db.prepare('UPDATE agent_profile SET probe=?, stamp=?, scope_v2=1 WHERE id=?').run(JSON.stringify(probe), stamp, id)
      })()
      return this.view(this.row(id))
    } finally { this.probing = false }
  }
}

