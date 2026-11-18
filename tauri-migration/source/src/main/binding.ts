import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import type Database from 'better-sqlite3'

export type SessionKey = Readonly<{ agentId: string; externalId: string }>
export type Anchor = Readonly<{ noteId: string; blockId: string }>
export type Request = Readonly<{ session: SessionKey; target: Anchor | null }>

// Trusted main-process port. Synchronous, read-only, stable across check through commit:
// the host must coordinate note/project and editor changes with this transaction.
// null means the identity, ownership, or fresh authoritative evidence cannot be verified.
export interface Authority {
  session(key: SessionKey): { key: SessionKey; revision: string; cwd: string | null } | null
  anchor(key: Anchor): {
    key: Anchor; revision: string; projectId: string;
    archived: boolean; writable: boolean; allowedAgentId: string | null
  } | null
}
type Location = NonNullable<ReturnType<Authority['anchor']>>
type SessionRow = { id: string }
type BlockRow = { note_id: string }
type BindingRow = { block_id: string }
type Failure =
  | 'invalid-request' | 'session-unverified' | 'anchor-unverified'
  | 'anchor-mismatch' | 'archived-target' | 'target-readonly' | 'agent-mismatch'
  | 'target-occupied' | 'run-in-progress' | 'already-bound' | 'already-unbound'
  | 'confirmation-required' | 'stale-preview' | 'busy'
type Refusal = { readonly ok: false; readonly code: Failure }
const refuse = (code: Failure): Refusal => ({ ok: false, code })
const id = (s: unknown): s is string => typeof s === 'string' && s.trim().length > 0 && !s.includes('\0')
const anchorId = (s: unknown): s is string => typeof s === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(s) && s.length === 36
const sameKey = (a: SessionKey, b: SessionKey) => a.agentId === b.agentId && a.externalId === b.externalId
const sameAnchor = (a: Anchor, b: Anchor) => a.noteId === b.noteId && a.blockId === b.blockId

function checkConnection(db: Database.Database) {
  if (db.inTransaction || db.pragma('foreign_keys', { simple: true }) !== 1 ||
      db.pragma('journal_mode', { simple: true }) !== 'wal') {
    throw new Error('Binding requires a top-level transaction, foreign_keys=ON and WAL')
  }
}

// Additive metadata, no second binding table. Triggers see writes from the frozen
// store too, so old previews fail even when a binding changes and changes back.
export function installBindingRevision(db: Database.Database) {
  checkConnection(db)
  db.transaction(() => {
    const migration = db.prepare<[], { version: number }>('SELECT max(version) AS version FROM delegation_migration').get()
    if (migration?.version !== 1) throw new Error('Expected frozen delegation schema v1')
    db.exec(
      'CREATE TABLE IF NOT EXISTS delegation_binding_revision (singleton INTEGER PRIMARY KEY CHECK(singleton=1), ' +
      'revision INTEGER NOT NULL CHECK(revision>=0)) STRICT; ' +
      'INSERT OR IGNORE INTO delegation_binding_revision VALUES (1,0);',
    )
    for (const op of ['INSERT', 'UPDATE', 'DELETE']) {
      db.exec('CREATE TRIGGER IF NOT EXISTS delegation_binding_revision_' + op.toLowerCase() +
        ' AFTER ' + op + ' ON delegation_binding BEGIN ' +
        'UPDATE delegation_binding_revision SET revision=revision+1 WHERE singleton=1; ' +
        "SELECT CASE WHEN changes() <> 1 THEN RAISE(ABORT, 'missing binding revision') END; END;")
    }
  }).immediate()
}

function inspect(db: Database.Database, authority: Authority, request: Request) {
  const get = <T>(sql: string, ...args: string[]) => db.prepare<string[], T>(sql).get(...args)
  const rev = get<{ revision: string }>('SELECT CAST(revision AS TEXT) AS revision FROM delegation_binding_revision WHERE singleton=1')
  if (!rev) throw new Error('Binding revision not installed')
  const fact = authority.session(request.session)
  if (!fact || !sameKey(fact.key, request.session) || !id(fact.revision)) return refuse('session-unverified')
  const session = get<SessionRow>('SELECT id FROM delegation_session WHERE agent_id=? AND external_id=?',
    request.session.agentId, request.session.externalId)
  const current = session && get<BindingRow>('SELECT block_id FROM delegation_binding WHERE session_id=?', session.id)
  const owner = (block: string) => get<BlockRow>('SELECT note_id FROM delegation_block WHERE id=?', block)
  const locate = (key: Anchor): Location | Refusal => {
    const registered = owner(key.blockId)
    if (registered && registered.note_id !== key.noteId) return refuse('anchor-mismatch')
    const s = authority.anchor(key)
    if (!s || !sameAnchor(s.key, key) || !id(s.revision) || !id(s.projectId)) return refuse('anchor-unverified')
    return { key: { ...s.key }, projectId: s.projectId, revision: s.revision, archived: s.archived,
      writable: s.writable, allowedAgentId: s.allowedAgentId }
  }
  let source: Location | null = null
  if (current) {
    const note = owner(current.block_id)
    if (!note) return refuse('anchor-unverified')
    const found = locate({ noteId: note.note_id, blockId: current.block_id })
    if ('ok' in found) return found
    source = found
  }
  let target: Location | null = null
  if (request.target) {
    if (source && sameAnchor(source.key, request.target)) return refuse('already-bound')
    const found = locate(request.target)
    if ('ok' in found) return found
    target = found
    if (target.archived !== false) return refuse('archived-target')
    if (target.writable !== true) return refuse('target-readonly')
    if (target.allowedAgentId !== null && target.allowedAgentId !== request.session.agentId) return refuse('agent-mismatch')
    if (get('SELECT 1 FROM delegation_binding WHERE block_id=?', target.key.blockId)) return refuse('target-occupied')
  }
  if (!source && !target) return refuse('already-unbound')
  const live = "SELECT 1 FROM delegation_run WHERE phase IN ('reserved','dispatching','bound') AND "
  if ((source && get(live + 'block_id=?', source.key.blockId)) ||
      (target && get(live + 'block_id=?', target.key.blockId)) ||
      (session && get(live + '(session_id=? OR target_session_id=?)', session.id, session.id))) {
    return refuse('run-in-progress')
  }
  return {
    ok: true as const,
    revision: rev.revision,
    action: target ? (source ? 'migrate' : 'bind') as 'migrate' | 'bind' : 'unbind' as const,
    session: { ...request.session, localId: session?.id ?? null, evidenceRevision: fact.revision, cwd: fact.cwd },
    source,
    target,
  }
}

type Snapshot = Extract<ReturnType<typeof inspect>, { ok: true }>
type Pending = { request: Request; snapshot: Snapshot; deadline: number }
const PREVIEW_TTL_MS = 5 * 60_000
const isBusy = (e: unknown) => typeof e === 'object' && e !== null && 'code' in e &&
  typeof e.code === 'string' && /^SQLITE_(BUSY|LOCKED)(_|$)/.test(e.code)

export function makeBindingCore(db: Database.Database, authority: Authority,
  clock: () => number = () => performance.now(), persist?: (id:string, result:{sessionId:string; action:Snapshot['action']})=>void) {
  checkConnection(db)
  const pending = new Map<string, Pending>()
  const read = db.transaction((request: Request) => inspect(db, authority, request))
  const commit = db.transaction((entry: Pending, operation?:string) => {
    if (clock() >= entry.deadline) return refuse('stale-preview')
    const next = inspect(db, authority, entry.request)
    if (!next.ok || JSON.stringify(next) !== JSON.stringify(entry.snapshot)) return refuse('stale-preview')
    const { source, target, session } = next
    const sessionId = session.localId ?? randomUUID()
    if (session.localId === null) {
      db.prepare('INSERT INTO delegation_session(id,agent_id,external_id) VALUES (?,?,?)')
        .run(sessionId, session.agentId, session.externalId)
    }
    if (target) {
      db.prepare('INSERT INTO delegation_block(id,note_id) VALUES (?,?) ON CONFLICT(id) DO NOTHING')
        .run(target.key.blockId, target.key.noteId)
    }
    const count = source && target
      ? db.prepare('UPDATE delegation_binding SET block_id=? WHERE block_id=? AND session_id=?')
        .run(target.key.blockId, source.key.blockId, sessionId)
      : source
        ? db.prepare('DELETE FROM delegation_binding WHERE block_id=? AND session_id=?').run(source.key.blockId, sessionId)
        : db.prepare('INSERT INTO delegation_binding(block_id,session_id) VALUES (?,?)').run(target!.key.blockId, sessionId)
    if (count.changes !== 1) throw new Error('Binding compare-and-set did not change exactly one row')
    if (operation) persist?.(operation,{sessionId, action:next.action})
    return { ok: true as const, action: next.action, sessionId, binding: target }
  }).immediate

  return {
    preview(request: Request) {
      checkConnection(db)
      if (!request?.session || !id(request.session.agentId) || !id(request.session.externalId) ||
          (request.target !== null && (!anchorId(request.target?.noteId) || !anchorId(request.target?.blockId)))) {
        return refuse('invalid-request')
      }
      const safe: Request = {
        session: { agentId: request.session.agentId, externalId: request.session.externalId },
        target: request.target && { noteId: request.target.noteId, blockId: request.target.blockId },
      }
      try {
        const snapshot = read(safe)
        if (!snapshot.ok) return snapshot
        const now = clock()
        for (const [token, entry] of pending) if (now >= entry.deadline) pending.delete(token)
        if (pending.size >= 128) pending.delete(pending.keys().next().value!)
        const previewId = randomUUID()
        pending.set(previewId, { request: safe, snapshot, deadline: now + PREVIEW_TTL_MS })
        return { ...structuredClone(snapshot), previewId }
      } catch (e) {
        if (isBusy(e)) return refuse('busy')
        throw e
      }
    },
    cancel(previewId: string) { pending.delete(previewId) },
    confirm(input: { previewId: string; revision: string; confirmed: boolean; operation?: string }) {
      checkConnection(db)
      if (input?.confirmed !== true) return refuse('confirmation-required')
      const entry = pending.get(input.previewId)
      pending.delete(input.previewId)
      if (!entry || input.revision !== entry.snapshot.revision || clock() >= entry.deadline) return refuse('stale-preview')
      try {
        return commit(entry,input.operation)
      } catch (e) {
        if (isBusy(e)) return refuse('busy')
        throw e
      }
    },
  }
}
