import type Database from 'better-sqlite3'
import type { Receipt } from '../shared/p11'

export const missing:Receipt = {status:'missing',message:'没有可核实的提交记录。请核对当前状态并重新预览。'}
export class Journal {
  constructor(private db:Database.Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS p11_operation (
      id TEXT PRIMARY KEY, subject TEXT NOT NULL, applied TEXT CHECK(json_valid(applied)), started INTEGER NOT NULL, request TEXT
    ) STRICT;
    CREATE UNIQUE INDEX IF NOT EXISTS p11_pending ON p11_operation(subject) WHERE applied IS NULL;`)
    if (!(db.prepare('PRAGMA table_info(p11_operation)').all() as {name:string}[]).some(c=>c.name==='request'))
      db.exec('ALTER TABLE p11_operation ADD COLUMN request TEXT')
    // Only SQLite writes are journaled. If a process dies before the final
    // transaction commits, both the mutation and success receipt roll back.
    db.prepare('UPDATE p11_operation SET applied=? WHERE applied IS NULL')
      .run(JSON.stringify({status:'unchanged',message:'重启对账：事务未提交。'} satisfies Receipt))
  }
  get(id:string):Receipt|null|undefined {
    const row=this.db.prepare('SELECT applied FROM p11_operation WHERE id=?').get(id) as {applied:string|null}|undefined
    return row?.applied ? JSON.parse(row.applied) as Receipt : row ? null : undefined
  }
  identity(id:string) {
    return this.db.prepare('SELECT request FROM p11_operation WHERE id=?').get(id) as {request:string|null}|undefined
  }
  start(id:string,subject:string,request:string) {
    this.db.prepare('INSERT INTO p11_operation(id,subject,started,request) VALUES(?,?,?,?)').run(id,subject,Date.now(),request)
  }
  finish(id:string,receipt:Receipt) {
    if (this.db.prepare('UPDATE p11_operation SET applied=? WHERE id=? AND applied IS NULL')
      .run(JSON.stringify(receipt),id).changes!==1) throw new Error('提交回执无法同步核实')
    return receipt
  }
}

