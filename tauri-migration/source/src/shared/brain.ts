export interface BrainSpace { id: string; name: string; kind: 'work' | 'learning' | 'personal'; description: string; isolated: boolean; allowExport: boolean }
export interface SpaceScope { targetSpaceId: string; readableSpaceIds: string[] }
export interface StaleMemory { id: string; title: string; updatedAt: number; dormant: boolean }

export interface BrainNoteMetadata {
  spaceId: string
  zone: 'episodic' | 'semantic' | 'procedural'
  vitality: number
  dormant: boolean
  version: number
}

export interface BrainActivationWave {
  seedNoteId: string
  runId: string
  activatedNoteIds: string[]
  activatedSkillIds: string[]
  edgePairs: [string, string][]
  pprElapsedMs: number
}

export interface EpisodicEvent {
  id: string
  projectId: string
  rawText: string
  sourceType: string
  spaceId: string
  reviewStatus: 'candidate' | 'edited' | 'promoted' | 'discarded'
  sourceRunId: string | null
  salienceScore: number
  createdAt: number
}

export interface SkillInput {
  title: string
  tags: string[]
  system_prompt: string
}

export interface BrainSkill {
  id: string
  title: string
  tags: string[]
  preferredAgentId: string | null
  systemPrompt: string
  usageCount: number
  successCount: number
  allowShell: boolean
  allowNetwork: boolean
  spaceId: string
}

export interface BrainDelta {
  suggested_links: { target_note_id: string; reason: string }[]
  assertion_updates: { note_id: string; old_claim_id: string | null; new_claim: string }[]
  note_evolutions: { target_note_id: string; append_insight: string; delta_summary: string }[]
  suggested_skill: SkillInput | null
}

export interface BrainHistory {
  evolutions: { version: number; summary: string; previousExcerpt: string; createdAt: number; sourceRunId: string | null }[]
  assertions: { id: string; claim: string; observedAt: number; validFrom: number; validTo: number | null; supersededById: string | null; confidence: number }[]
}

export interface BrainApi {
  status(): Promise<{ contextEnabled: boolean; pendingWrites: number }>
  setContext(enabled: boolean): Promise<void>
  metadata(): Promise<Record<string, BrainNoteMetadata>>
  spaces(): Promise<BrainSpace[]>
  saveSpace(space: BrainSpace): Promise<string>
  updateCandidate(id: string, newContent: string, spaceId: string): Promise<void>
  promote(id: string, targetSpaceId: string): Promise<string>
  discard(id: string): Promise<void>
  scan(spaceId: string): Promise<StaleMemory[]>
  capture(projectId: string, rawText: string, spaceId?: string): Promise<string>
  events(projectId?: string, spaceId?: string): Promise<EpisodicEvent[]>
  consolidate(eventIds: string[], title: string, targetNoteId?: string, synthesis?: string): Promise<string>
  stageDream(eventIds: string[], title: string, targetNoteId?: string, synthesis?: string): Promise<string>
  dreamSuggestion(eventIds: string[]): Promise<{ title: string; summary: string }>
  dream(projectId?: string, spaceId?: string): Promise<EpisodicEvent[]>
  skills(): Promise<BrainSkill[]>
  saveSkill(input: SkillInput): Promise<string>
  saveWorkbenchSkill(input: { skillId?: string; input: SkillInput; preferredAgentId?: string;
    allowShell: boolean; allowNetwork: boolean }): Promise<string>
  history(noteId: string): Promise<BrainHistory>
  applyDelta(runId: string): Promise<void>
  recalculate(): Promise<void>
  onChanged(callback: () => void): () => void
  onActivation(callback: (wave: BrainActivationWave) => void): () => void
}
