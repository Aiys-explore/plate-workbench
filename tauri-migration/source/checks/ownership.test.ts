import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { installBindingRevision, makeBindingCore } from '../src/main/binding.ts'
import type { Anchor, Authority, Request, SessionKey } from '../src/main/binding.ts'
import { detachedProject, suggestOwnership } from '../src/main/ownership.ts'
import type { Decision, Project } from '../src/main/ownership.ts'
import { schema } from '../src/main/delegation-schema.ts'

const dir = (canonicalWindowsPath: string) => ({ canonicalWindowsPath })
const undecided = { kind: 'undecided' } as const
const project = (id: string, path: string, archivedAt: number | null = null): Project =>
  ({ id, name: '同名', archivedAt, root: dir(path) })
const main = project('p-main', 'C:\\work')
const deep = project('p-deep', 'c:\\work\\alpha\\')
const twin = project('p-same', 'C:\\work\\alpha')
const archived = project('p-archived', 'C:\\work\\alpha', 1)
const defaultProject = project('default', 'C:\\')

test('canonical paths, boundary, overlaps, exact/same roots and stable ID order', () => {
  const cwd = dir('\\\\?\\c:\\work\\alpha')
  const choices = [twin, defaultProject, main, archived, deep]
  const result = suggestOwnership(cwd, choices, undecided)
  assert.deepEqual(result.suggestion, { kind: 'choose', projectIds: ['p-deep', 'p-same', 'p-main'] })
  assert.deepEqual(result.candidates.map(c => c.evidence), ['exact', 'exact', 'ancestor'])
  assert.deepEqual(result.effective, { kind: 'undecided', projectId: null })
  const unique = suggestOwnership(cwd, [main, archived], undecided)
  assert.deepEqual(unique.suggestion, { kind: 'unique', projectId: 'p-main' })
  assert.equal(unique.effective.projectId, null)
  for (const s of ['C:\\workbench', 'C:\\workspace\\alpha', 'D:\\work\\alpha']) {
    assert.equal(suggestOwnership(dir(s), choices, undecided).suggestion.kind, 'no-match')
  }
  for (const s of ['C:work', '..\\work', 'C:\\work\\..\\else', 'C:\\work\\bad.', '\\\\.\\C:\\work',
    'C:\\\\', 'C:\\work\n', '\\\\server', 'C:/work']) {
    assert.equal(suggestOwnership(dir(s), choices, undecided).suggestion.kind, 'unknown-cwd')
  }
  assert.equal(suggestOwnership(null, choices, undecided).suggestion.kind, 'unknown-cwd')
  assert.equal(suggestOwnership(cwd, [{ ...main, root: null }], undecided).suggestion.kind, 'no-match')
  assert.equal(suggestOwnership(dir('C:\\foo'), [project('root', 'c:\\')], undecided).suggestion.kind, 'unique')
  const unc = project('unc', '\\\\HOST\\share\\w\\')
  assert.equal(suggestOwnership(dir('\\\\?\\UNC\\host\\share\\w\\子'), [unc], undecided).suggestion.kind, 'unique')
  assert.equal(suggestOwnership(dir('\\\\host\\share2\\w\\子'), [unc], undecided).suggestion.kind, 'no-match')
  assert.throws(() => suggestOwnership(cwd, [main, { ...main, name: 'renamed' }], undecided), /duplicate/)
})

test('cwd recommendations preserve manual choice, explicit unassigned and inherited archive', () => {
  const manual: Decision = Object.freeze({ kind: 'manual-project', projectId: archived.id })
  const projects = [main, archived]
  const activeAgain = { ...archived, archivedAt: null }
  for (const cwd of [null, dir('C:\\work'), dir('C:\\else')]) {
    assert.deepEqual(suggestOwnership(cwd, projects, manual).effective,
      { kind: 'manual', projectId: archived.id, status: 'archived' })
    assert.deepEqual(suggestOwnership(cwd, projects, { kind: 'manual-unassigned' }).effective,
      { kind: 'manual-unassigned', projectId: null })
  }
  const binding = { projectId: archived.id, noteId: 'stable-note', blockId: 'stable-block' }
  assert.deepEqual(suggestOwnership(dir('C:\\work'), projects, manual, binding).effective,
    { kind: 'inherited', ...binding })
  assert.equal(detachedProject(manual, projects), null)
  assert.equal(detachedProject(manual, [main, activeAgain]), archived.id)
  assert.equal(detachedProject(undecided, [main]), null)
  assert.equal(suggestOwnership(null, [main, activeAgain], manual).effective.projectId, archived.id)
})

const uuid = (n: number) => '71000000-0000-4000-8000-' + n.toString().padStart(12, '0')
const A = { noteId: uuid(1), blockId: uuid(11) }
const B = { noteId: uuid(2), blockId: uuid(12) }
const C = { noteId: uuid(3), blockId: uuid(13) }
const D = { noteId: uuid(4), blockId: uuid(14) }
const old = { agentId: 'codex-main', externalId: 'same-external' }
const other = { agentId: 'other-agent', externalId: old.externalId }
const external = { agentId: old.agentId, externalId: 'external-only' }
const req = (target: Anchor | null, session = old): Request => ({ target, session })
type Location = NonNullable<ReturnType<Authority['anchor']>>
const testRoot = fileURLToPath(new URL('.', import.meta.url))
const sha = (data: string | Buffer) => createHash('sha256').update(data).digest('hex')

function fixture() {
  const paths = mkdtempSync(join(testRoot, '.sample-'))
  const delegates = join(paths, 'delegation.sqlite')
  const open = (file = delegates) => {
    const db = new Database(file, { timeout: 0 })
    db.pragma('journal_mode=WAL')
    db.pragma('foreign_keys=ON')
    db.pragma('synchronous=FULL')
    return db
  }
  const db = open()
  db.exec(schema)
  db.exec('CREATE TABLE delegation_migration(version INTEGER PRIMARY KEY) STRICT; INSERT INTO delegation_migration VALUES(1);')
  db.exec('CREATE TABLE p10_write (runId TEXT PRIMARY KEY REFERENCES delegation_run(id), noteId TEXT NOT NULL,' +
    ' blockId TEXT NOT NULL, ordinal INTEGER NOT NULL, conclusion TEXT NOT NULL CHECK(json_valid(conclusion)),' +
    " state TEXT NOT NULL CHECK(state IN ('pending','written','conflict','failed')), issue TEXT NOT NULL DEFAULT ''," +
    ' beforeRevision TEXT, afterSha TEXT, fingerprint TEXT, staged TEXT, path TEXT) STRICT;')
  const logs = open(join(paths, 'session-index.sqlite'))
  logs.exec('CREATE TABLE agent_session (adapter TEXT NOT NULL, id TEXT NOT NULL, projection TEXT NOT NULL,' +
    ' archived INTEGER NOT NULL, last_at INTEGER, PRIMARY KEY(adapter,id));' +
    ' CREATE TABLE session_tombstone (adapter TEXT NOT NULL, id TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(adapter,id));')
  const index = open(join(paths, 'index.sqlite'))
  index.exec('CREATE TABLE project (id TEXT PRIMARY KEY, name TEXT NOT NULL, root_path TEXT NOT NULL, color TEXT,' +
    ' archived_at INTEGER, created_at INTEGER NOT NULL);' +
    ' CREATE TABLE note (id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, title TEXT NOT NULL,' +
    ' project_id TEXT NOT NULL REFERENCES project(id), kind TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);')
  const notes = new Map<string, string>()
  for (const p of ['p-main', 'p-deep']) {
    index.prepare('INSERT INTO project VALUES (?,?,?,NULL,NULL,1)').run(p, '重复名称', './managed/' + p)
  }
  for (const a of [A, B, C, D]) {
    const path = join(paths, a.noteId + '.md')
    notes.set(a.noteId, path)
    index.prepare("INSERT INTO note VALUES (?,?,?,?,'note',1,1)")
      .run(a.noteId, './managed/' + a.noteId + '.md', '重复标题', a === A ? 'p-main' : 'p-deep')
    writeFileSync(path, ['# 重复标题', '<!-- workbench-task:' + a.blockId + ' note:' + a.noteId + ' -->',
      '重复任务', a === A ? '已写结论：保留在原笔记' : '', ''].join('\n'))
    if (a !== D) db.prepare('INSERT INTO delegation_block VALUES (?,?)').run(a.blockId, a.noteId)
  }
  db.prepare('INSERT INTO delegation_session VALUES (?,?,?)').run('sid-main', old.agentId, old.externalId)
  db.prepare('INSERT INTO delegation_session VALUES (?,?,?)').run('sid-other', other.agentId, other.externalId)
  db.prepare('INSERT INTO delegation_binding VALUES (?,?)').run(A.blockId, 'sid-main')
  db.prepare("INSERT INTO delegation_run VALUES (?,?,?,?,'original-revision',2,'new',NULL,'finished','dispatch','sid-main','receipt','completion')")
    .run('r1', A.blockId, old.agentId, 'a'.repeat(64))
  db.prepare("INSERT INTO delegation_intent VALUES (?,?,?,'r1','owner',NULL)").run('i1', A.blockId, 'a'.repeat(64))
  db.prepare("INSERT INTO p10_write VALUES ('r1',?,?,1,?,'written','','before','after','fingerprint',NULL,?)")
    .run(A.noteId, A.blockId, JSON.stringify({ body: '已写结论' }), './managed/' + A.noteId + '.md')
  for (const s of [old, other, external]) {
    logs.prepare('INSERT INTO agent_session VALUES (?,?,?,0,1)').run(s.agentId, s.externalId,
      JSON.stringify({ title: '相同会话标题', cwd: 'C:\\work' }))
  }
  const anchors = new Map<string, Omit<Location, 'projectId' | 'archived'>>()
  for (const a of [A, B, C, D]) anchors.set(a.blockId,
    { key: a, revision: 'anchor-1', writable: true, allowedAgentId: old.agentId })
  const authority: Authority = {
    session(s: SessionKey) {
      const p = logs.prepare<[string, string], { projection: string; id: string; adapter: string }>(
        'SELECT * FROM agent_session WHERE adapter=? AND id=? AND archived=0').get(s.agentId, s.externalId)
      if (!p) return null
      return { key: { agentId: p.adapter, externalId: p.id }, revision: sha(p.projection),
        cwd: (JSON.parse(p.projection) as { cwd: string }).cwd }
    },
    anchor(a) {
      const fact = anchors.get(a.blockId)
      const p = index.prepare<[string], { id: string; archived_at: number | null }>(
        'SELECT p.* FROM note n JOIN project p ON p.id=n.project_id WHERE n.id=?').get(a.noteId)
      return fact && p ? { ...fact, projectId: p.id, archived: p.archived_at !== null } : null
    },
  }
  installBindingRevision(db)
  const rows = (conn: Database.Database, table: string) => conn.prepare('SELECT * FROM ' + table + ' ORDER BY 1,2').all()
  const retained = () => ({
    runs: rows(db, 'delegation_run'), intents: rows(db, 'delegation_intent'), writeback: rows(db, 'p10_write'),
    externalSessions: rows(logs, 'agent_session'), tombstones: rows(logs, 'session_tombstone'),
    notes: rows(index, 'note'), projects: rows(index, 'project'),
    markdown: [...notes].map(([noteId, path]) => ({ noteId, sha256: sha(readFileSync(path)) })),
  })
  const relations = (conn = db) => ({
    bindings: rows(conn, 'delegation_binding'), sessions: rows(conn, 'delegation_session'), blocks: rows(conn, 'delegation_block'),
    revision: conn.prepare('SELECT revision FROM delegation_binding_revision').pluck().get(),
  })
  const connections = [db, index, logs]
  return {
    db, index, logs, authority, anchors, retained, relations, core: makeBindingCore(db, authority),
    peer() { const c = open(); connections.push(c); return c },
    close() {
      for (const c of connections) if (c.open) c.close()
      assert.equal(join(paths, '..'), testRoot.replace(/[\\/]$/u, ''))
      rmSync(paths, { recursive: true })
    },
  }
}

type Core = ReturnType<typeof makeBindingCore>
const preview = (core: Core, r: Request) => {
  const p = core.preview(r)
  if (!p.ok) assert.fail('Unexpected refusal: ' + p.code)
  return p
}
const confirm = (core: Core, p: ReturnType<typeof preview>) =>
  core.confirm({ previewId: p.previewId, revision: p.revision, confirmed: true })
const denied = (code: string) => ({ ok: false, code })

test('external bind, migrate, unlink, restart and row / Markdown preservation', t => {
  const f = fixture()
  t.after(f.close)
  const retained = f.retained()
  const before = f.relations()
  const bind = preview(f.core, req(D, external))
  assert.equal(bind.action, 'bind')
  assert.equal(bind.source, null)
  assert.equal(bind.session.localId, null)
  assert.equal(bind.session.cwd, 'C:\\work')
  assert.deepEqual(bind.target?.key, D)
  assert.deepEqual(f.core.confirm({ ...bind, confirmed: false }), denied('confirmation-required'))
  f.core.cancel(bind.previewId)
  assert.deepEqual(confirm(f.core, bind), denied('stale-preview'))
  assert.deepEqual(f.relations(), before)
  const linked = confirm(f.core, preview(f.core, req(D, external)))
  assert.ok(linked.ok && linked.action === 'bind')
  const afterBind = f.relations()
  assert.equal(afterBind.blocks.length, 4)
  assert.equal(afterBind.sessions.length, 3)
  assert.ok(afterBind.bindings.some(b => (b as { session_id: string }).session_id === linked.sessionId))

  const move = preview(f.core, req(B))
  assert.deepEqual(move.source?.key, A)
  assert.equal(move.source?.projectId, 'p-main')
  assert.deepEqual(move.target?.key, B)
  assert.equal(move.target?.projectId, 'p-deep')
  f.core.cancel(move.previewId)
  assert.deepEqual(confirm(f.core, move), denied('stale-preview'))
  assert.deepEqual(f.relations(), afterBind)
  const moved = confirm(f.core, preview(f.core, req(B)))
  assert.ok(moved.ok && moved.action === 'migrate')
  assert.deepEqual(f.core.preview(req(B)), denied('already-bound'))
  const afterMove = f.relations()
  assert.deepEqual(afterMove.bindings, [
    { block_id: B.blockId, session_id: 'sid-main' }, { block_id: D.blockId, session_id: linked.sessionId },
  ])
  const migrationRestart = f.peer()
  assert.deepEqual(f.relations(migrationRestart), afterMove)
  assert.deepEqual(makeBindingCore(migrationRestart, f.authority).preview(req(B)), denied('already-bound'))
  migrationRestart.close()
  const detach = preview(f.core, req(null))
  assert.deepEqual(detach.source?.key, B)
  assert.equal(detach.target, null)
  f.core.cancel(detach.previewId)
  assert.deepEqual(f.relations(), afterMove)
  assert.deepEqual(confirm(f.core, detach), denied('stale-preview'))
  const unbound = confirm(f.core, preview(f.core, req(null)))
  assert.ok(unbound.ok && unbound.action === 'unbind')
  assert.deepEqual(f.core.preview(req(null)), denied('already-unbound'))
  const afterUnlink = f.relations()
  assert.deepEqual(afterUnlink.sessions, afterBind.sessions)
  assert.deepEqual(afterUnlink.blocks, afterBind.blocks)
  assert.deepEqual(afterUnlink.bindings, [{ block_id: D.blockId, session_id: linked.sessionId }])
  const preservedAfter = f.retained()
  assert.deepEqual(preservedAfter, retained)
  f.db.close()
  const reopened = f.peer()
  installBindingRevision(reopened)
  const afterReopen = f.relations(reopened)
  assert.deepEqual(afterReopen, afterUnlink)
  assert.deepEqual(reopened.pragma('foreign_key_check'), [])
  assert.deepEqual(reopened.pragma('integrity_check'), [{ integrity_check: 'ok' }])
  const core = makeBindingCore(reopened, f.authority)
  assert.deepEqual(core.preview(req(D, external)), denied('already-bound'))
  assert.deepEqual(core.preview(req(null)), denied('already-unbound'))
  assert.equal(preview(core, req(C)).session.localId, 'sid-main')
  if (process.env.M42_RECORD === '1') {
    const alias = (value: unknown) => JSON.parse(JSON.stringify(value).replaceAll(linked.sessionId, 'sample-new-local-id')) as unknown
    const data = { sqlite: reopened.prepare('SELECT sqlite_version()').pluck().get(),
      before, afterBind: alias(afterBind), afterMove: alias(afterMove), movedReopenVerified: true, afterUnlink: alias(afterUnlink),
      afterReopen: alias(afterReopen), preservedBefore: retained, preservedAfter,
      aliases: { 'sample-new-local-id': 'Random local session ID normalized only in evidence' },
    }
    writeFileSync(join(testRoot, 'data-evidence.json'), JSON.stringify(data, null, 2) + '\n')
  }
})

test('occupation, fake note ownership, missing anchor, readonly, archive and wrong Agent', t => {
  const f = fixture()
  t.after(f.close)
  const before = f.relations()
  assert.deepEqual(f.core.preview(req(A, external)), denied('target-occupied'))
  assert.deepEqual(f.core.preview(req({ ...B, noteId: C.noteId })), denied('anchor-mismatch'))
  assert.deepEqual(f.core.preview(req({ ...B, blockId: '重复任务' })), denied('invalid-request'))
  assert.deepEqual(f.core.preview(req({ ...B, blockId: uuid(99) })), denied('anchor-unverified'))
  assert.deepEqual(f.core.preview(req(B, { agentId: 'absent', externalId: old.externalId })), denied('session-unverified'))
  assert.deepEqual(f.core.preview(req(B, other)), denied('agent-mismatch'))
  const mismatched = makeBindingCore(f.db, { ...f.authority, session: () => f.authority.session(other) })
  assert.deepEqual(mismatched.preview(req(B)), denied('session-unverified'))
  f.anchors.set(B.blockId, { ...f.anchors.get(B.blockId)!, writable: false })
  assert.deepEqual(f.core.preview(req(B)), denied('target-readonly'))
  f.index.prepare("UPDATE project SET archived_at=1 WHERE id='p-deep'").run()
  assert.deepEqual(f.core.preview(req(C)), denied('archived-target'))
  assert.deepEqual(f.relations(), before)
  const exact = preview(f.core, req(null))
  assert.equal(exact.session.localId, 'sid-main')
  f.index.prepare("UPDATE project SET archived_at=1 WHERE id='p-main'").run()
  assert.deepEqual(confirm(f.core, exact), denied('stale-preview'))
  assert.deepEqual(f.relations(), before)
  assert.equal(preview(f.core, req(null)).source?.archived, true)
})

test('stale anchor, cwd, archive, expired and wrong revision confirmations', t => {
  const f = fixture()
  t.after(f.close)
  const before = f.relations()
  const a = preview(f.core, req(B))
  f.anchors.set(B.blockId, { ...f.anchors.get(B.blockId)!, revision: 'anchor-2' })
  assert.deepEqual(confirm(f.core, a), denied('stale-preview'))
  const b = preview(f.core, req(null))
  f.anchors.set(A.blockId, { ...f.anchors.get(A.blockId)!, revision: 'source-2' })
  assert.deepEqual(confirm(f.core, b), denied('stale-preview'))
  const c = preview(f.core, req(B))
  f.logs.prepare('UPDATE agent_session SET projection=? WHERE adapter=? AND id=?')
    .run(JSON.stringify({ cwd: 'C:\\new' }), old.agentId, old.externalId)
  assert.deepEqual(confirm(f.core, c), denied('stale-preview'))
  const d = preview(f.core, req(B))
  f.index.prepare("UPDATE project SET archived_at=1 WHERE id='p-deep'").run()
  assert.deepEqual(confirm(f.core, d), denied('stale-preview'))
  f.index.prepare("UPDATE project SET archived_at=NULL WHERE id='p-deep'").run()
  let now = 1
  const timed = makeBindingCore(f.db, f.authority, () => now)
  const e = preview(timed, req(B))
  now += 300_000
  assert.deepEqual(confirm(timed, e), denied('stale-preview'))
  const wrong = preview(timed, req(B))
  assert.deepEqual(timed.confirm({ ...wrong, revision: '999', confirmed: true }), denied('stale-preview'))
  assert.deepEqual(confirm(timed, wrong), denied('stale-preview'))
  assert.deepEqual(f.relations(), before)
})

test('two SQLite connections: lock, target race, same-session race and ABA', t => {
  const f = fixture()
  t.after(f.close)
  const peer = f.peer()
  const second = makeBindingCore(peer, f.authority)
  const before = f.relations()
  const locked = preview(f.core, req(B))
  peer.exec('BEGIN IMMEDIATE')
  try { assert.deepEqual(confirm(f.core, locked), denied('busy')) }
  finally { peer.exec('ROLLBACK') }
  assert.deepEqual(confirm(f.core, locked), denied('stale-preview'))
  assert.deepEqual(f.relations(), before)
  const loserTarget = preview(f.core, req(B))
  const winner = preview(second, req(B, external))
  assert.ok(confirm(second, winner).ok)
  assert.deepEqual(confirm(f.core, loserTarget), denied('stale-preview'))
  assert.deepEqual(f.core.preview(req(B)), denied('target-occupied'))
  assert.ok(f.relations().bindings.some(b => (b as { block_id: string }).block_id === A.blockId))
  const loserSession = preview(f.core, req(C))
  assert.ok(confirm(second, preview(second, req(D))).ok)
  assert.deepEqual(confirm(f.core, loserSession), denied('stale-preview'))
  const aba = preview(f.core, req(C))
  peer.prepare('UPDATE delegation_binding SET block_id=? WHERE session_id=?').run(A.blockId, 'sid-main')
  peer.prepare('UPDATE delegation_binding SET block_id=? WHERE session_id=?').run(D.blockId, 'sid-main')
  assert.deepEqual(confirm(f.core, aba), denied('stale-preview'))
  assert.equal(f.relations().bindings.length, 2)
  assert.throws(() => peer.prepare('INSERT INTO delegation_binding VALUES (?,?)').run(C.blockId, 'sid-main'),
    /UNIQUE constraint failed/)
  assert.throws(() => peer.prepare('INSERT INTO delegation_binding VALUES (?,?)').run(D.blockId, 'sid-other'),
    /UNIQUE constraint failed/)
})

test('live delegation at source, target or for the session blocks conflicting changes', t => {
  const f = fixture()
  t.after(f.close)
  const p = preview(f.core, req(B))
  const addRun = f.db.prepare('INSERT INTO delegation_run ' +
    '(id,block_id,agent_id,request_hash,source_revision,source_line,mode,target_session_id,phase) ' +
    "VALUES(?,?,?,?,'rev',1,?,?,'reserved')")
  addRun.run('source', A.blockId, old.agentId, 'a'.repeat(64), 'new', null)
  assert.deepEqual(confirm(f.core, p), denied('stale-preview'))
  assert.deepEqual(f.core.preview(req(null)), denied('run-in-progress'))
  f.db.prepare("UPDATE delegation_run SET phase='cancelled' WHERE id='source'").run()
  addRun.run('target', B.blockId, old.agentId, 'a'.repeat(64), 'new', null)
  assert.deepEqual(f.core.preview(req(B)), denied('run-in-progress'))
  addRun.run('session', C.blockId, old.agentId, 'a'.repeat(64), 'resume', 'sid-main')
  assert.deepEqual(f.core.preview(req(D)), denied('run-in-progress'))
})

test('SQL failures roll back session, block, relation and revision; nested writer refused', t => {
  const f = fixture()
  t.after(f.close)
  const before = f.relations()
  const preserved = f.retained()
  const p = preview(f.core, req(D, external))
  f.db.exec("CREATE TRIGGER fault AFTER INSERT ON delegation_binding BEGIN SELECT RAISE(ABORT,'injected late failure'); END;")
  assert.throws(() => confirm(f.core, p), /injected late failure/)
  assert.deepEqual(f.relations(), before)
  assert.deepEqual(f.retained(), preserved)
  assert.deepEqual(confirm(f.core, p), denied('stale-preview'))
  assert.throws(() => f.db.transaction(() => f.core.preview(req(B))).immediate(), /top-level transaction/)
  f.db.exec('DROP TRIGGER fault')
  const m = preview(f.core, req(B))
  f.db.exec("CREATE TRIGGER fault AFTER UPDATE ON delegation_binding BEGIN SELECT RAISE(ABORT,'injected move failure'); END;")
  assert.throws(() => confirm(f.core, m), /injected move failure/)
  assert.deepEqual(f.relations(), before)
  assert.deepEqual(f.retained(), preserved)
})
