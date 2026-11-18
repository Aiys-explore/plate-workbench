import { project, type Snapshot } from './diagnostic-projection'
import type { DelegationService, DispatchRecord } from './delegation'
import manifest from '../../package.json'

const errno = (value: unknown) => value === 'EACCES' || value === 'EPERM' ||
  value === 'ENOENT' || value === 'ENOTDIR' || value === 'ENOEXEC' ? value : undefined
const time = (atMs: number) => ({ atMs, offsetMinutes: -new Date(atMs).getTimezoneOffset() })

// App-owned metadata of the close observation, stored alongside the existing technical
// receipt. Do not pass provider strings or the technical receipt to the projector.
export function closeFact(runId: string, dispatch: DispatchRecord, spawned: boolean, code: unknown,
  observedAt: number, errorAt?: number, providerAuthCode?: '401' | '403', omittedDetail = false) {
  const osCode = spawned ? undefined : errno(code)
  return { schema: 1, runId, dispatchId: dispatch.dispatchId, attemptId: dispatch.dispatchId,
    profileId: dispatch.profileId, spawned, osCode, providerAuthCode, omittedDetail, appVersion: manifest.version,
    ...time(osCode && errorAt !== undefined ? errorAt : observedAt) }
}

type Exit = { dispatchId?: unknown; stop?: unknown; auth?: unknown; permission?: unknown;
  unsupportedModel?: unknown; declaredFailure?: unknown; protocolInvalid?: unknown;
  spawnRefused?: unknown; exitCode?: unknown; diagnosticV1?: ReturnType<typeof closeFact> }

export function delegationDiagnostic(store: DelegationService,
  key: { noteId: string; blockId: string; runId: string }): Snapshot | null {
  try {
    const { noteId, blockId, runId } = key
    const id = store.identity(runId)
    const dispatch = store.readLaunchEvidence<DispatchRecord>(runId, 'dispatch')
    if (!id || id.run.id !== runId || id.run.block_id !== blockId || id.run.phase === 'finished' ||
        !dispatch || dispatch.mode !== 'cli' || dispatch.noteId !== noteId || dispatch.blockId !== blockId ||
        dispatch.profileId !== id.run.agent_id || dispatch.sourceRevision !== id.run.source_revision ||
        dispatch.target !== id.targetExternalId || (dispatch.kind !== 'codex' && dispatch.kind !== 'grok-cli')) return null

    const exit = store.readLaunchEvidence<Exit>(runId, 'cli-exit')
    if (exit && exit.dispatchId !== dispatch.dispatchId) return null
    const saved = exit?.diagnosticV1
    if (saved !== undefined && (!saved || saved.schema !== 1 || saved.runId !== runId ||
        saved.dispatchId !== dispatch.dispatchId || saved.attemptId !== dispatch.dispatchId ||
        saved.profileId !== id.run.agent_id || typeof saved.spawned !== 'boolean')) return null
    const osCode = saved?.spawned === false ? errno(saved.osCode) : undefined
    // abortUnstarted intentionally clears dispatch_id. Only a new, four-way bound
    // observation of spawn refusal can recover this separate cancelled case.
    const refused = id.run.phase === 'cancelled' && id.run.dispatch_id === null &&
      exit?.spawnRefused === true && !!osCode
    if (!refused && id.run.dispatch_id !== dispatch.dispatchId) return null
    if (exit?.stop === 'user') return null
    const conflict = store.readLaunchEvidence<{ dispatchId: string }>(runId, 'cli-conflict')
    const ownConflict = conflict?.dispatchId === dispatch.dispatchId
    if (!exit && !ownConflict) return null

    // R3 stored a close callback result but neither a close timestamp nor the app
    // version. Legacy negative libuv codes are not proven process exit codes.
    const numeric = typeof exit?.exitCode === 'number' && Number.isInteger(exit.exitCode) &&
      exit.exitCode >= -2147483648 && exit.exitCode <= 4294967295
    const observedExit = numeric && (saved ? saved.spawned : exit?.spawnRefused === false && Number(exit.exitCode) >= 0)
    const phase = osCode ? 'cli-start' : exit ? 'cli-close' : 'cli-run'
    const failure = osCode === 'EACCES' || osCode === 'EPERM' ? 'launch-permission' :
      refused ? 'launch-refused' :
      exit?.stop === 'timeout' ? 'cli-timeout' :
      exit?.stop === 'output' ? 'cli-output-limit' :
      exit?.auth === true ? 'cli-auth-indicator' :
      exit?.permission === true ? 'cli-permission-reported' :
      exit?.unsupportedModel === true ? 'cli-model-reported' :
      exit?.declaredFailure === true || observedExit && exit!.exitCode !== 0 ? 'cli-exit-error' :
      'launch-unknown'
    const current = { kind: 'run', sourceId: runId, operationId: dispatch.dispatchId, attemptId: dispatch.dispatchId,
      failureId: dispatch.dispatchId, profileId: id.run.agent_id,
      adapter: dispatch.kind === 'grok-cli' ? 'grok' : 'codex', phase }
    const httpCode = failure === 'cli-auth-indicator' &&
      (saved?.providerAuthCode === '401' || saved?.providerAuthCode === '403') ? saved.providerAuthCode : undefined
    // Only a canonical message from an exact, framed match can be shown. The
    // sentinel merely tells the projector that unframed details were withheld.
    const details = httpCode ? { detailKind: 'framed-http-error',
      detail: httpCode === '401' ? '401 Unauthorized' : '403 Forbidden' } :
      saved?.omittedDetail === true ? { detail: 'unframed-provider-detail' } : {}
    return project(current, {
      scope: { ...current, sourceId: saved?.runId ?? runId, operationId: exit?.dispatchId ?? conflict?.dispatchId,
        attemptId: saved?.attemptId ?? dispatch.dispatchId, profileId: saved?.profileId ?? dispatch.profileId },
      failure, observation: refused ? 'confirmed-unstarted' : undefined,
      ...(saved && { atMs: saved.atMs, offsetMinutes: saved.offsetMinutes, appVersion: saved.appVersion }),
      cliVersion: dispatch.version, code: osCode ?? httpCode, ...details, ...(observedExit && { exitCode: exit!.exitCode, exitEvidence: 'observed-close' })
    })
  } catch { return null }
}
