const NOW = Date.UTC(2026, 9, 27, 17)
const HOUR = 3_600_000
const DAY = 24 * HOUR
const fn = 'fn'
const actions = {
  onCapture: fn, onAdd: fn, onReauth: fn, onUse: fn, onDelete: fn, onRefresh: fn,
  onSetupToken: fn, onConvertAll: fn, onSetHome: fn, onSync: fn
}

const views = [
  {
    id: 'claude-code', name: 'Claude Code', installed: true, canAddAccount: true, canSaveCurrent: false, switchTargets: [],
    billingUrl: 'https://claude.ai/settings/billing',
    profiles: [
      { name: 'main@x.com', email: 'main@x.com', nickname: 'Main', color: '#38bdf8', createdAt: 1, active: true, static: true, expiresAt: NOW + 200 * DAY },
      { name: 'spare@x.com', email: 'spare@x.com', nickname: 'Spare', color: '#a78bfa', createdAt: 2, active: false },
      { name: 'old@x.com', email: 'old@x.com', color: '#fbbf24', createdAt: 3, active: false, static: true, expiresAt: NOW + 12 * DAY }
    ]
  },
  {
    id: 'codex', name: 'Codex', installed: true, canAddAccount: true, canSaveCurrent: true, switchTargets: [],
    profiles: [{ name: 'work@x.com', email: 'work@x.com', nickname: 'Work', createdAt: 1, active: true, owner: 'env_box', syncedAt: NOW - 4 * 60_000 }]
  },
  { id: 'cursor', name: 'Cursor', installed: false, canAddAccount: false, canSaveCurrent: false, switchTargets: [], profiles: [] }
]

const usage = {
  'claude-code': [
    {
      profileName: 'main@x.com',
      plan: { name: 'Max 20x', monthlyUsd: 200, renewsAt: NOW + 16 * DAY },
      windows: [
        { label: '5h', usedPercent: 30, resetsAt: NOW + 2.2 * HOUR, periodMs: 5 * HOUR },
        { label: 'Weekly', usedPercent: 82, resetsAt: NOW + 3 * DAY, periodMs: 7 * DAY }
      ]
    },
    {
      profileName: 'spare@x.com',
      plan: { name: 'Pro', monthlyUsd: 20, cancelsAt: NOW + 9 * DAY },
      windows: [
        { label: '5h', usedPercent: 5, resetsAt: NOW + 4 * HOUR, periodMs: 5 * HOUR },
        { label: 'Weekly', usedPercent: 40, resetsAt: NOW + 5 * DAY, periodMs: 7 * DAY }
      ]
    },
    { profileName: 'old@x.com', windows: [], rateLimit: { provider: 'claude' } }
  ],
  codex: [
    {
      profileName: 'work@x.com', banked: 2, plan: { name: 'Plus', monthlyUsd: 20, renewsAt: NOW + 4 * DAY },
      windows: [
        { label: '5h', usedPercent: 60, resetsAt: NOW + HOUR, periodMs: 5 * HOUR },
        { label: 'Weekly', usedPercent: 20, resetsAt: NOW + 6 * DAY, periodMs: 7 * DAY }
      ]
    }
  ]
}

const headroom = { 'claude-code': { 'main@x.com': { room: 0.4, ratePerMin: 3, resetsAt: NOW + 20 * 60_000 } } }

const base = {
  ...actions, views, usage, headroom, busy: null, homes: {},
  peers: { env_box: { name: 'box', connected: true, lastSyncAt: NOW, error: null } },
  environments: [{ id: 'env_box', name: 'box' }], localName: 'This Mac', now: NOW,
  mint: { rows: { 'spare@x.com': { state: 'minting', at: NOW } }, run: null }
}

export default [
  { name: 'Three providers: a mint, a lapsing token, a copy the box refreshes, one not installed', props: base },
  { name: 'Loading usage after Refresh', props: { ...base, usage: {}, mint: { rows: {}, run: { total: 3, done: 1 } } } }
]
