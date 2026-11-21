interface S10Preferences {
  includeDefaultLogs: boolean
  customLogDirectory: string
  maxSteps: number
  maxBudgetUsd: number
}

const storageKey = 'plate.s10.preferences'
const fallback: S10Preferences = { includeDefaultLogs: true, customLogDirectory: '', maxSteps: 12, maxBudgetUsd: 0.5 }

export function readPreferences(): S10Preferences {
  try {
    const saved: Partial<S10Preferences> = JSON.parse(localStorage.getItem(storageKey) ?? '{}')
    return {
      includeDefaultLogs: typeof saved.includeDefaultLogs === 'boolean' ? saved.includeDefaultLogs : fallback.includeDefaultLogs,
      customLogDirectory: typeof saved.customLogDirectory === 'string' ? saved.customLogDirectory : '',
      maxSteps: Number.isInteger(saved.maxSteps) && saved.maxSteps! >= 1 && saved.maxSteps! <= 40
        ? saved.maxSteps! : fallback.maxSteps,
      maxBudgetUsd: typeof saved.maxBudgetUsd === 'number' && saved.maxBudgetUsd >= 0 && saved.maxBudgetUsd <= 1000
        ? saved.maxBudgetUsd : fallback.maxBudgetUsd,
    }
  } catch { return { ...fallback } }
}

export function savePreferences(preferences: S10Preferences) {
  localStorage.setItem(storageKey, JSON.stringify(preferences))
}
