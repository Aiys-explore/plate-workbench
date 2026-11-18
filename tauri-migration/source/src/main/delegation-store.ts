import Database from 'better-sqlite3'
import { localSqlitePath } from './local-sqlite-path'
import { createHash, randomUUID } from 'node:crypto'
import { schema } from './delegation-schema'
import { taskIdPattern } from '../shared/task-anchor'
import { delegationRecovery as action, type DelegationPhase, type DelegationReceipt, type DelegationRejection } from '../shared/delegation'

const isText = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
const digest = (fields: unknown[]) => createHash('sha256').update(JSON.stringify(fields)).digest('hex')
export interface ConfirmedDelegation {
  intentId: string; blockId: string; noteId: string; agentId: string; revision: string
  cwd: string; model: string | null; effort: string | null; text: string
}
export interface SourceSnapshot {
  noteId: string; revision: string; dirty: boolean; scanComplete: boolean
  locations: { noteId: string; blockId: string; line: number }[]
}
// Main-only contract for M3.2 / M3.4b. No IPC accepts or generates these objects.
export interface AdapterEvidence {
  verified: boolean; dispatchId: string; agentId: string; externalId: string; evidenceRef: string
}
type RunRow = { id: string; block_id: string; agent_id: string; phase: DelegationPhase; mode: 'new' | 'resume';
  target_session_id: string | null; dispatch_id: string | null; session_id: string | null;
  receipt_ref: string | null; completion_ref: string | null; request_hash: string; source_revision: string }
type IntentRow = { id: string; run_id: string; request_hash: string; outcome: DelegationReceipt['code']; source_hash: string | null }
type SessionRow = { id: string; agent_id: string; external_id: string }
type RecoveryRow = { runId: string; blockId: string; noteId: string; agentId: string; phase: DelegationPhase;
  mode: RunRow['mode']; ownerIntentId: string; sourceRevision: string; sourceLine: number;
  dispatchId: string | null; externalId: string | null; targetExternalId: string | null }
type Refusal = { code: DelegationRejection }
type RecheckSource = () => Refusal | undefined

export function migrate(db: Database.Database, ddl = schema) {
  if (db.inTransaction) throw new Error('Delegation migration requires a top-level transaction')
  db.transaction(() => {
    db.exec('CREATE TABLE IF NOT EXISTS delegation_migration (version INTEGER PRIMARY KEY) STRICT')
    const { version } = db.prepare('SELECT coalesce(max(version), 0) AS version FROM delegation_migration').get() as { version: number }
    if (version > 1) throw new Error('Unsupported delegation schema')
    if (version === 0) {
      db.exec(ddl)
      db.exec('INSERT INTO delegation_migration VALUES (1)')
    }
  }).immediate()
}

export function openDb(file: string) {
  const db = new Database(localSqlitePath(file), { timeout: 5000 })
  try {
    db.pragma('foreign_keys = ON')
    if (db.pragma('journal_mode = WAL', { simple: true }) !== 'wal') throw new Error('Delegation needs SQLite WAL')
    db.pragma('synchronous = FULL')
    migrate(db)
    return db
  } catch (err) {
    db.close()
    throw err
  }
}

function validRequest(r: ConfirmedDelegation) {
  return r && [r.intentId, r.blockId].every(id => typeof id === 'string' && taskIdPattern.test(id)) &&
    [r.noteId, r.agentId, r.cwd, r.text, r.revision].every(isText) &&
    [r.model, r.effort].every(value => value === null || isText(value))
}

function requestHash(r: ConfirmedDelegation) {
  return digest([r.blockId, r.noteId, r.revision, r.agentId, r.cwd, r.model, r.effort, r.text])
}

// snapshot is trusted main-process data from a fresh parsed source read, never renderer claims.
function locate(r: ConfirmedDelegation, snapshot?: SourceSnapshot): { line: number } | Refusal {
  if (!snapshot || snapshot.noteId !== r.noteId || snapshot.revision !== r.revision ||
      snapshot.dirty !== false) return { code: 'source-changed' }
  if (snapshot.scanComplete !== true || !Array.isArray(snapshot.locations)) return { code: 'source-unverified' }
  if (snapshot.locations.length === 0) return { code: 'anchor-missing' }
  if (snapshot.locations.length !== 1) return { code: 'anchor-ambiguous' }
  const match = snapshot.locations[0]
  if (match?.blockId !== r.blockId || match.noteId !== r.noteId ||
      !Number.isSafeInteger(match.line) || match.line < 1) return { code: 'anchor-mismatch' }
  return { line: match.line }
}

const evidenceOk = (e: AdapterEvidence, dispatchId: string) => e?.verified === true && e.dispatchId === dispatchId &&
  [e.agentId, e.externalId, e.evidenceRef].every(isText)

export function makeCore(db: Database.Database, newId: () => string = randomUUID) {
  const get = <T>(sql: string, ...params: unknown[]) => db.prepare<unknown[], T>(sql).get(...params)
  const write = (sql: string, ...params: unknown[]) => db.prepare(sql).run(...params)
  const tx = <A extends unknown[], R>(fn: (...args: A) => R) => {
    const immediate = db.transaction(fn).immediate
    return (...args: A): R => {
      // better-sqlite3 nests with a savepoint, which cannot grant a durable claim.
      if (db.inTransaction) throw new Error('Delegation writes require a top-level transaction')
      return immediate(...args)
    }
  }
  const runFor = (id: string) => get<RunRow>('SELECT * FROM delegation_run WHERE id=?', id)
  const intentFor = (id: string) => get<IntentRow>('SELECT * FROM delegation_intent WHERE id=?', id)
  const sessionFor = (id: string) => get<SessionRow>('SELECT * FROM delegation_session WHERE id=?', id)
  const bindingFor = (block: string) => get<SessionRow>(
    'SELECT s.* FROM delegation_binding b JOIN delegation_session s ON s.id=b.session_id WHERE b.block_id=?', block)
  const view = (intent: IntentRow, replay: boolean): DelegationReceipt => {
    const run = runFor(intent.run_id)!
    return { code: intent.outcome, replay, runId: run.id, phase: run.phase, recovery: action[run.phase] }
  }

  return {
    replay(intentId: string, sourceHash: string): DelegationReceipt | Refusal | undefined {
      const previous = intentFor(intentId)
      if (previous) return previous.source_hash === sourceHash ? view(previous, true) : { code: 'intent-mismatch' }
    },

    owner(blockId: string) {
      return get<{ note_id: string }>('SELECT note_id FROM delegation_block WHERE id=?', blockId)?.note_id
    },

    ownedBy(noteId: string) {
      return db.prepare<[string], { id: string }>('SELECT id FROM delegation_block WHERE note_id=?').all(noteId).map(row => row.id)
    },

    registerBlock: tx((blockId: string, noteId: string) => {
      write('INSERT INTO delegation_block VALUES (?,?)', blockId, noteId)
    }),

    reserve: tx((r: ConfirmedDelegation, snapshot?: SourceSnapshot, sourceHash?: string,
      recheck?: RecheckSource, onReserve?: (runId: string) => void): DelegationReceipt | Refusal => {
      if (!validRequest(r)) return { code: 'invalid-request' }
      const hash = requestHash(r)
      const previous = intentFor(r.intentId)
      if (previous) return previous.request_hash === hash && previous.source_hash === (sourceHash ?? null)
        ? view(previous, true) : { code: 'intent-mismatch' }
      const source = locate(r, snapshot)
      if ('code' in source) return source
      const changed = recheck?.()
      if (changed) return changed
      const block = get<{ note_id: string }>('SELECT note_id FROM delegation_block WHERE id=?', r.blockId)
      if (block && block.note_id !== r.noteId) return { code: 'anchor-owner-mismatch' }
      const active = get<RunRow>(`SELECT * FROM delegation_run WHERE block_id=?
        AND phase IN ('reserved', 'dispatching', 'bound')`, r.blockId)
      if (active) {
        const outcome = active.request_hash === hash ? 'coalesced' : 'active-conflict'
        write('INSERT INTO delegation_intent VALUES (?,?,?,?,?,?)', r.intentId, r.blockId, hash, active.id, outcome, sourceHash ?? null)
        return view(intentFor(r.intentId)!, false)
      }
      const current = bindingFor(r.blockId)
      if (current && current.agent_id !== r.agentId) return { code: 'bound-to-other-agent' }
      if (!block) write('INSERT INTO delegation_block VALUES (?,?)', r.blockId, r.noteId)
      const runId = newId()
      write(`INSERT INTO delegation_run(id,block_id,agent_id,request_hash,source_revision,source_line,mode,target_session_id,phase)
             VALUES (?,?,?,?,?,?,?,?,'reserved')`,
      runId, r.blockId, r.agentId, hash, r.revision, source.line, current ? 'resume' : 'new', current?.id ?? null)
      write("INSERT INTO delegation_intent VALUES (?,?,?,?,'owner',?)", r.intentId, r.blockId, hash, runId, sourceHash ?? null)
      onReserve?.(runId)
      return view(intentFor(r.intentId)!, false)
    }),

    // Only a fresh 'claimed' reply can authorize a single adapter call. Never store/replay it in IPC.
    claim: tx((r: ConfirmedDelegation, snapshot: SourceSnapshot, verifiedResumeTarget: string | null = null,
      recheck?: RecheckSource, onClaim?: (runId: string, dispatchId: string) => void) => {
      if (!validRequest(r)) return { code: 'invalid-request' }
      const intent = intentFor(r.intentId)
      if (!intent || intent.request_hash !== requestHash(r)) return { code: 'intent-mismatch' }
      if (intent.outcome !== 'owner') return { code: 'not-owner' }
      const run = runFor(intent.run_id)!
      if (run.phase !== 'reserved') return { code: action[run.phase] }
      const source = locate(r, snapshot)
      if ('code' in source) return source
      const changed = recheck?.()
      if (changed) return changed
      const current = bindingFor(r.blockId)
      if ((current?.id ?? null) !== run.target_session_id) return { code: 'binding-changed' }
      if (run.mode === 'resume' && (!isText(verifiedResumeTarget) || current?.external_id !== verifiedResumeTarget)) {
        return { code: 'resume-unverified' }
      }
      const dispatchId = newId()
      write("UPDATE delegation_run SET phase='dispatching',dispatch_id=? WHERE id=?", dispatchId, run.id)
      onClaim?.(run.id, dispatchId)
      return { code: 'claimed' as const, runId: run.id, dispatchId, mode: run.mode, externalId: current?.external_id ?? null }
    }),

    cancelBeforeDispatch: tx((intentId: string) => {
      const intent = intentFor(intentId)
      if (!intent || intent.outcome !== 'owner') return { code: 'not-owner' }
      const { id, phase } = runFor(intent.run_id)!
      if (phase !== 'reserved') return { code: action[phase] }
      write("UPDATE delegation_run SET phase='cancelled' WHERE id=?", id)
      return { code: 'cancelled' }
    }),

    // Main only: the caller observed an OS spawn error before the child emitted 'spawn'.
    // A launched process, missing event, time limit or exit code is never this proof.
    abortUnstarted: tx((runId: string, dispatchId: string) => {
      const run = runFor(runId)
      if (!run || run.phase !== 'dispatching' || run.dispatch_id !== dispatchId) return false
      write("UPDATE delegation_run SET phase='cancelled',dispatch_id=NULL WHERE id=?", runId)
      return true
    }),

    blockRuns(block: string) {
      const active = get<RunRow>(`SELECT * FROM delegation_run WHERE block_id=?
        AND phase IN ('reserved','dispatching','bound')`, block)
      const prior = get<RunRow>("SELECT * FROM delegation_run WHERE block_id=? AND phase='finished' ORDER BY rowid DESC LIMIT 1", block)
      const current = bindingFor(block)
      return { active, prior, current }
    },

    ownerIntent(runId: string) {
      return get<IntentRow>("SELECT * FROM delegation_intent WHERE run_id=? AND outcome='owner'", runId)?.id
    },

    outcome(runId: string) {
      const run = runFor(runId)
      if (!run) return null
      return { phase: run.phase, mode: run.mode, externalId: run.session_id ? sessionFor(run.session_id)?.external_id : undefined }
    },

    identity(runId: string) {
      const run = runFor(runId)
      if (!run) return
      const target = run.target_session_id && sessionFor(run.target_session_id)
      return { run, externalId: run.session_id ? sessionFor(run.session_id)?.external_id : undefined,
        targetExternalId: target ? target.external_id : undefined }
    },

    recordReceipt: tx((runId: string, dispatchId: string, evidence: AdapterEvidence) => {
      const run = runFor(runId)
      if (!run || !run.dispatch_id || run.dispatch_id !== dispatchId) return { code: 'dispatch-mismatch' }
      if (!evidenceOk(evidence, dispatchId) || evidence.agentId !== run.agent_id) return { code: 'verify-dispatch' }
      const current = bindingFor(run.block_id)
      const known = get<SessionRow>('SELECT * FROM delegation_session WHERE agent_id=? AND external_id=?', evidence.agentId, evidence.externalId)
      if (run.phase === 'bound' || run.phase === 'finished') {
        return known && known.id === run.session_id && run.receipt_ref === evidence.evidenceRef
          ? { code: 'receipt-replay', sessionId: known.id }
          : { code: 'receipt-conflict' }
      }
      if (run.phase !== 'dispatching') return { code: 'verify-dispatch' }

      let sessionId
      if (run.mode === 'resume') {
        if (!known || current?.id !== run.target_session_id || known.id !== run.target_session_id) {
          return { code: 'receipt-conflict' }
        }
        sessionId = known.id
        if (get('SELECT 1 FROM delegation_run WHERE session_id=? AND (receipt_ref=? OR completion_ref=?)', sessionId, evidence.evidenceRef, evidence.evidenceRef)) {
          return { code: 'receipt-conflict' }
        }
      } else {
        if (current || known || get('SELECT 1 FROM delegation_session WHERE external_id=?', evidence.externalId)) {
          return { code: 'receipt-conflict' }
        }
        sessionId = newId()
        write('INSERT INTO delegation_session VALUES (?,?,?)', sessionId, evidence.agentId, evidence.externalId)
        write('INSERT INTO delegation_binding VALUES (?,?)', run.block_id, sessionId)
      }
      write("UPDATE delegation_run SET phase='bound',session_id=?,receipt_ref=? WHERE id=?",
        sessionId, evidence.evidenceRef, runId)
      return { code: 'bound', sessionId }
    }),

    finish: tx((runId: string, dispatchId: string, evidence: AdapterEvidence) => {
      const run = runFor(runId)
      if (!run || !run.dispatch_id || run.dispatch_id !== dispatchId) return { code: 'dispatch-mismatch' }
      if (run.phase !== 'bound' && run.phase !== 'finished') return { code: 'receipt-required' }
      const session = run.session_id && sessionFor(run.session_id)
      if (!session || !evidenceOk(evidence, dispatchId) || evidence.agentId !== session.agent_id ||
          evidence.externalId !== session.external_id) return { code: 'completion-unverified' }
      if (run.phase === 'finished') {
        return { code: run.completion_ref === evidence.evidenceRef ? 'finish-replay' : 'completion-conflict' }
      }
      if (get('SELECT 1 FROM delegation_run WHERE session_id=? AND id<>? AND (receipt_ref=? OR completion_ref=?)', session.id, run.id, evidence.evidenceRef, evidence.evidenceRef)) {
        return { code: 'completion-conflict' }
      }
      write("UPDATE delegation_run SET phase='finished',completion_ref=? WHERE id=?", evidence.evidenceRef, runId)
      return { code: 'finished' }
    }),

    recover() {
      return db.prepare<[], RecoveryRow>(`SELECT r.id AS runId,r.block_id AS blockId,b.note_id AS noteId,r.agent_id AS agentId,r.phase,r.mode,
        i.id AS ownerIntentId,r.source_revision AS sourceRevision,r.source_line AS sourceLine,
        r.dispatch_id AS dispatchId, s.external_id AS externalId, target.external_id AS targetExternalId
        FROM delegation_run r JOIN delegation_block b ON b.id=r.block_id JOIN delegation_intent i ON i.run_id=r.id AND i.outcome='owner'
        LEFT JOIN delegation_session s ON s.id=r.session_id
        LEFT JOIN delegation_session target ON target.id=r.target_session_id
        WHERE phase IN ('reserved','dispatching','bound') ORDER BY r.id`).all()
        .map(row => ({ ...row, recovery: action[row.phase] }))
    }
  }
}
