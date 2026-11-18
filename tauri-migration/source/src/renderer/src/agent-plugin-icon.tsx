import { useId, type SVGProps } from 'react'

const gradients: Record<string, { id: string; from: string; to: string }> = {
  codex: { id: 'codex', from: '#4f7cff', to: '#8b5cf6' },
  dsh: { id: 'dsh', from: '#38bdf8', to: '#2563eb' },
  claude: { id: 'claude', from: '#f59e0b', to: '#c2410c' },
  opencode: { id: 'opencode', from: '#22d3ee', to: '#0f766e' },
  gemini: { id: 'gemini', from: '#a78bfa', to: '#4f46e5' },
  aider: { id: 'aider', from: '#fb7185', to: '#be123c' },
  kimi: { id: 'kimi', from: '#facc15', to: '#ea580c' },
  minimax: { id: 'minimax', from: '#f472b6', to: '#db2777' },
  'minimax-code': { id: 'minimax', from: '#f472b6', to: '#db2777' },
  zcode: { id: 'zcode', from: '#2dd4bf', to: '#0f766e' },
}

function pluginGradient(id: string) {
  return gradients[id] ?? { id: 'plate-agent', from: '#94a3b8', to: '#475569' }
}

export function AgentPluginIcon({ id, ...props }: { id: string } & SVGProps<SVGSVGElement>) {
  const gradient = pluginGradient(id)
  const gradientId = `plate-agent-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  return <svg viewBox="0 0 32 32" role="img" aria-hidden="true" focusable="false" {...props}>
    <defs>
      <linearGradient id={gradientId} x1="4" y1="3" x2="27" y2="29" gradientUnits="userSpaceOnUse">
        <stop stopColor={gradient.from} />
        <stop offset="1" stopColor={gradient.to} />
      </linearGradient>
    </defs>
    <rect x="1" y="1" width="30" height="30" rx="9" fill="#000" fillOpacity=".07" />
    {id === 'codex' && <>
      <path d="M16 4l10 6v12l-10 6-10-6V10z" fill={`url(#${gradientId})`} />
      <path d="M12 13h8M12 17h8m-8 4h5" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
    </>}
    {id === 'dsh' && <>
      <path d="M5 18c5 0 7-8 11-8s6 8 11 8" fill="none" stroke={`url(#${gradientId})`} strokeWidth="3.2" strokeLinecap="round" />
      <path d="M11 22h10" stroke="#0f172a" strokeOpacity=".55" strokeWidth="2.4" strokeLinecap="round" />
    </>}
    {id === 'claude' && <>
      <path d="M8 8l4 4m12-4l-4 4M8 24l4-4m12 4l-4-4M16 7v18" stroke={`url(#${gradientId})`} strokeWidth="3.2" strokeLinecap="round" />
      <circle cx="16" cy="16" r="3.4" fill={`url(#${gradientId})`} />
    </>}
    {id === 'opencode' && <>
      <path d="M6 18V9a3 3 0 016 0v7m0-4a3 3 0 016 0v4m0-2a3 3 0 016 0v8c0 5-3 8-8 8H14" fill="none" stroke={`url(#${gradientId})`} strokeWidth="3" strokeLinecap="round" />
    </>}
    {id === 'gemini' && <>
      <path d="M16 5c2 5 5 8 10 10-5 2-8 5-10 10-2-5-5-8-10-10 5-2 8-5 10-10z" fill={`url(#${gradientId})`} />
    </>}
    {id === 'aider' && <>
      <path d="M7 24l6-16 6 16m-10-5h8" fill="none" stroke={`url(#${gradientId})`} strokeWidth="3.2" strokeLinecap="round" />
      <circle cx="24" cy="10" r="3" fill={`url(#${gradientId})`} />
    </>}
    {id === 'kimi' && <>
      <path d="M16 4l11 6v12l-11 6-11-6V10z" fill={`url(#${gradientId})`} />
      <path d="M11 18c2-4 5-4 7 0s5 4 7 0" stroke="#fff" strokeWidth="2.4" fill="none" strokeLinecap="round" />
    </>}
    {(id === 'minimax' || id === 'minimax-code') && <>
      <rect x="4" y="13" width="4" height="6" rx="2" fill={`url(#${gradientId})`} />
      <rect x="11" y="8" width="4" height="16" rx="2" fill={`url(#${gradientId})`} />
      <rect x="18" y="12" width="4" height="8" rx="2" fill={`url(#${gradientId})`} />
      <rect x="25" y="15" width="3" height="2" rx="1" fill={`url(#${gradientId})`} />
    </>}
    {id === 'zcode' && <>
      <rect x="4" y="4" width="24" height="24" rx="7" fill={`url(#${gradientId})`} />
      <path d="M11 11h10l-10 10h10" fill="none" stroke="#fff" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" />
    </>}
    {!['codex', 'dsh', 'claude', 'opencode', 'gemini', 'aider', 'kimi', 'minimax', 'minimax-code', 'zcode'].includes(id) && <>
      <rect x="4" y="4" width="24" height="24" rx="8" fill={`url(#${gradientId})`} fillOpacity=".92" />
      <path d="M16 9v8m0 4.5v.5" stroke="#fff" strokeWidth="3.2" strokeLinecap="round" />
    </>}
  </svg>
}
