type Position = { run: number; sequence: number }
export type NoteIndexState = Position & (
  | { phase: 'waiting' | 'ready' | 'cancelled' | 'blocked' }
  | { phase: 'collecting'; found: number }
  | { phase: 'reading'; found: number; read: number }
  | { phase: 'committing'; read: number }
  | { phase: 'failed'; message: string }
)
export type NoteIndexStage = NoteIndexState extends infer T ? T extends Position ? Omit<T, keyof Position> : never : never
export type NoteIndexAction = { accepted: boolean; state: NoteIndexState }

export interface NoteIndexApi {
  status(): Promise<NoteIndexState>
  cancel(run: number): Promise<NoteIndexAction>
  retry(run: number): Promise<NoteIndexAction>
  onProgress(listener: (state: NoteIndexState) => void): () => void
}
