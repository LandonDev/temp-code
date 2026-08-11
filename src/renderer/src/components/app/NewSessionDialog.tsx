import { useState } from 'react'
import { X } from 'lucide-react'
import type { ProviderId, Reasoning } from '@shared/catalog'
import { AGENT_TYPES, type AgentType } from '@shared/catalog'
import { useApp } from '../../state/store'

export function NewSessionDialog({ onClose }: { onClose: () => void }): React.JSX.Element | null {
  const catalog = useApp((s) => s.catalog)
  const createSession = useApp((s) => s.createSession)
  const [provider, setProvider] = useState<ProviderId>('claude')
  const [model, setModel] = useState<string | null>(null)
  const [reasoning, setReasoning] = useState<Reasoning>('medium')
  const [agentType, setAgentType] = useState<AgentType>('implementer')
  const [cwd, setCwd] = useState('')
  const [busy, setBusy] = useState(false)

  if (!catalog) return null
  const info = catalog[provider]
  const effectiveModel = model ?? info.defaultModel

  const create = async (): Promise<void> => {
    if (!cwd.trim()) return
    setBusy(true)
    try {
      await createSession({
        provider,
        model: effectiveModel,
        reasoning: info.reasoning.includes(reasoning) ? reasoning : 'medium',
        agentType,
        cwd: cwd.trim(),
        parentId: null
      })
      onClose()
    } finally {
      setBusy(false)
    }
  }

  const field = 'w-full rounded-md border bg-card px-2.5 py-1.5 text-sm outline-none focus:ring-1 focus:ring-ring'
  const label = 'mb-1 block text-xs text-muted-foreground'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="w-96 rounded-xl border bg-popover p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-medium">New session</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X className="size-4" />
          </button>
        </div>

        <div className="space-y-3">
          <div>
            <span className={label}>Provider</span>
            <div className="flex gap-1.5">
              {(Object.keys(catalog) as ProviderId[]).map((p) => (
                <button
                  key={p}
                  onClick={() => {
                    setProvider(p)
                    setModel(null)
                  }}
                  className={`flex-1 rounded-md border px-2 py-1.5 text-sm ${
                    provider === p ? 'border-ring bg-accent' : 'hover:bg-accent/50'
                  }`}
                >
                  {catalog[p].label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <span className={label}>Model</span>
            <select value={effectiveModel} onChange={(e) => setModel(e.target.value)} className={field}>
              {info.models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>

          <div className="flex gap-3">
            <div className="flex-1">
              <span className={label}>Reasoning</span>
              <select
                value={reasoning}
                onChange={(e) => setReasoning(e.target.value as Reasoning)}
                className={field}
              >
                {info.reasoning.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex-1">
              <span className={label}>Agent type</span>
              <select
                value={agentType}
                onChange={(e) => setAgentType(e.target.value as AgentType)}
                className={field}
              >
                {AGENT_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <span className={label}>Working directory</span>
            <div className="flex gap-1.5">
              <input
                value={cwd}
                onChange={(e) => setCwd(e.target.value)}
                placeholder="/Users/landon/IdeaProjects/…"
                className={`${field} font-mono text-xs`}
              />
              <button
                onClick={() => {
                  void window.api.pickDirectory(cwd || undefined).then((dir) => {
                    if (dir) setCwd(dir)
                  })
                }}
                className="shrink-0 rounded-md border px-2.5 text-sm hover:bg-accent/50"
              >
                Browse
              </button>
            </div>
          </div>
        </div>

        <button
          onClick={() => void create()}
          disabled={busy || !cwd.trim()}
          className="mt-4 w-full rounded-md bg-primary py-2 text-sm font-medium text-primary-foreground disabled:opacity-40"
        >
          {busy ? 'Starting…' : 'Start session'}
        </button>
      </div>
    </div>
  )
}
