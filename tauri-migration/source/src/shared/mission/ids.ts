declare const __brand: unique symbol

export type Brand<T, B extends string> = T & { readonly [__brand]: B }

export type MissionId = Brand<string, 'MissionId'>
export type SlotId = Brand<string, 'SlotId'>
export type CrewTemplateId = Brand<string, 'CrewTemplateId'>
export type ProviderId = Brand<string, 'ProviderId'>
export type ProviderSessionId = Brand<string, 'ProviderSessionId'>
export type ContextVersionId = Brand<string, 'ContextVersionId'>
export type Sha256Hash = Brand<`sha256:${string}`, 'Sha256Hash'>
export type CommandRequestId = Brand<string, 'CommandRequestId'>
export type TerminalHandleId = Brand<string, 'TerminalHandleId'>
export type EventId = Brand<string, 'EventId'>
export type EventSeq = Brand<number, 'EventSeq'>
export type ArtifactId = Brand<string, 'ArtifactId'>

const requireNonEmpty = (value: string, label: string): string => {
  const trimmed = value.trim()
  if (trimmed.length === 0) throw new RangeError(`${label} must be a non-empty string`)
  return trimmed
}

const asBrandedString = <B extends string>(value: string, label: string): Brand<string, B> =>
  requireNonEmpty(value, label) as Brand<string, B>

export const missionId = (value: string): MissionId => asBrandedString(value, 'missionId')
export const slotId = (value: string): SlotId => asBrandedString(value, 'slotId')
export const crewTemplateId = (value: string): CrewTemplateId => asBrandedString(value, 'crewTemplateId')
export const providerId = (value: string): ProviderId => asBrandedString(value, 'providerId')
export const providerSessionId = (value: string): ProviderSessionId =>
  asBrandedString(value, 'providerSessionId')
export const contextVersionId = (value: string): ContextVersionId =>
  asBrandedString(value, 'contextVersionId')
export const commandRequestId = (value: string): CommandRequestId =>
  asBrandedString(value, 'commandRequestId')
export const terminalHandleId = (value: string): TerminalHandleId =>
  asBrandedString(value, 'terminalHandleId')
export const eventId = (value: string): EventId => asBrandedString(value, 'eventId')
export const artifactId = (value: string): ArtifactId => asBrandedString(value, 'artifactId')

export const sha256Hash = (value: string): Sha256Hash => {
  if (!/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw new RangeError('sha256Hash must match sha256:<64 lowercase hex chars>')
  }
  return value as Sha256Hash
}

export const eventSeq = (value: number): EventSeq => {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError('eventSeq must be an integer >= 0')
  }
  return value as EventSeq
}

export const firstSeq = (): EventSeq => eventSeq(1)
