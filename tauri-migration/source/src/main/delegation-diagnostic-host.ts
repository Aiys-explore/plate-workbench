import { randomUUID } from 'node:crypto'
import type { DiagnosticCopy, DiagnosticPreview } from '../shared/delegation-diagnostic'
import type { Snapshot } from './diagnostic-projection'

type Lease = {
  owner: number
  ticket: string
  snapshot: Snapshot
  resolve: () => Snapshot | null
}

// One preview per owning main frame. Open, authorization and the native write
// are synchronous: no focus/object change can interleave with the clipboard call.
export class DelegationDiagnosticHost {
  private lease?: Lease
  private writing = false
  constructor(private readonly clipboard: { writeText(text: string): void | Promise<void>; readText(): string | Promise<string> }) {}

  open(owner: number, resolve: () => Snapshot | null): DiagnosticPreview | null {
    this.lease = undefined
    const snapshot = resolve()
    if (!snapshot) return null
    const ticket = randomUUID()
    this.lease = { owner, ticket, snapshot, resolve }
    return { ticket, text: snapshot.text }
  }

  invalidate(owner: number) {
    if (this.lease?.owner === owner) this.lease = undefined
  }

  close(owner: number, ticket: unknown) {
    if (this.lease?.owner === owner && this.lease.ticket === ticket) this.lease = undefined
  }

  async copy(owner: number, ticket: unknown, focused: () => boolean): Promise<DiagnosticCopy> {
    const lease = this.lease
    if (!lease || lease.owner !== owner || lease.ticket !== ticket) return 'stale'
    if (this.writing) return 'failed'
    this.writing = true
    try {
      const current = focused() ? lease.resolve() : null
      if (!current || current.text !== lease.snapshot.text) {
        this.lease = undefined
        return 'stale'
      }
      const text = lease.snapshot.text
      await this.clipboard.writeText(text)
      const written = await this.clipboard.readText()
      if (this.lease !== lease || !focused()) return 'stale'
      return written === text ? 'copied' : 'failed'
    } catch { return 'failed' } finally { this.writing = false }
  }
}
