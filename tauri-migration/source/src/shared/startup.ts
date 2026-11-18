export const STARTUP = 'startup:location'
export type Candidate = { token: string; path: string; kind: 'new' | 'empty' | 'existing' }
export type RebuildOffer = { token: string; source: string }
export type StartupState =
  | { phase: 'reading' }
  | { phase: 'choose'; suggested?: string; candidate?: Candidate; error?: string; rebuild?: RebuildOffer }
  | { phase: 'blocked'; path?: string; candidate?: Candidate; error: string; override?: boolean; rebuild?: RebuildOffer }
  | { phase: 'opening'; path: string }
  | { phase: 'ready'; path: string; intro: boolean; agent: 'unconfigured' | 'unchecked' | 'failed'; error?: string }
export interface StartupApi {
  state(): Promise<StartupState>
  suggest(): Promise<StartupState>
  browse(): Promise<StartupState>
  submit(token: string): Promise<StartupState>
  rebuild(token: string): Promise<StartupState>
  retry(): Promise<StartupState>
  continue(): Promise<StartupState>
  exit(): Promise<void>
}
