/**
 * Capability catalog: what can be spawned, per provider.
 * This is the source of truth for the model/reasoning/agent-type pickers
 * AND for the enums in the orchestrator's spawn_agent MCP tool.
 *
 * Model lists and reasoning ladders are taken from the CLIs themselves
 * (verified 2026-08-15): `codex app-server` → `model/list` (codex-cli
 * 0.147.0), `cursor-agent models` (2026.07.23), `claude --effort` levels.
 * Reasoning is PER MODEL — ladders differ within one provider.
 */

export type ProviderId =
  | 'claude'
  | 'codex'
  | 'cursor'
  | 'grok'
  | 'opencode'
  | 'pi'
  | 'omp'
  | 'fx'

/** Providers whose model list comes from probing the installed CLI at
 *  boot (and on `catalog.get {refresh}`), not from this file. */
export const PROBED_PROVIDERS: ProviderId[] = ['grok', 'opencode', 'pi', 'omp', 'fx']

/** Replace a probed provider's models in place; the object identity of
 *  CATALOG never changes, so every reader sees the update. */
export function applyProbedCatalog(
  id: ProviderId,
  probed: { label?: string; models: ModelInfo[]; defaultModel: string } | null
): void {
  const entry = CATALOG[id]
  if (!probed) return
  entry.models = probed.models
  entry.defaultModel = probed.defaultModel
  if (probed.label) entry.label = probed.label
}

export type Reasoning = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra'

export interface ModelInfo {
  id: string
  label: string
  /** Effort levels this model supports; empty = no reasoning control. */
  reasoning: Reasoning[]
  /** Where the effort select lands when this model is picked. */
  defaultReasoning?: Reasoning
  /** Context window in tokens, when known — the ONE source of truth the
   *  composer trigger and the context meter both present. Every current
   *  claude model serves 1M natively (verified live: threads sail past
   *  250k with no beta flag, no compaction, no errors). */
  context?: number
}

export interface ProviderInfo {
  id: ProviderId
  label: string
  models: ModelInfo[]
  defaultModel: string
  experimental?: boolean
}

export const AGENT_TYPES = ['orchestrator', 'implementer', 'reviewer', 'explorer'] as const
export type AgentType = (typeof AGENT_TYPES)[number]

const CLAUDE_EFFORTS: Reasoning[] = ['low', 'medium', 'high', 'xhigh', 'max']

export const CATALOG: Record<ProviderId, ProviderInfo> = {
  claude: {
    id: 'claude',
    label: 'Claude',
    models: [
      {
        id: 'claude-fable-5-1',
        label: 'Fable 5.1',
        reasoning: CLAUDE_EFFORTS,
        defaultReasoning: 'medium',
        context: 1_000_000
      },
      {
        id: 'claude-fable-5',
        label: 'Fable 5',
        reasoning: CLAUDE_EFFORTS,
        defaultReasoning: 'medium',
        context: 1_000_000
      },
      {
        id: 'claude-opus-5-5',
        label: 'Opus 5.5',
        reasoning: CLAUDE_EFFORTS,
        defaultReasoning: 'medium',
        context: 1_000_000
      },
      {
        id: 'claude-opus-5',
        label: 'Opus 5',
        reasoning: CLAUDE_EFFORTS,
        defaultReasoning: 'medium',
        context: 1_000_000
      },
      {
        id: 'claude-opus-4-8',
        label: 'Opus 4.8',
        reasoning: CLAUDE_EFFORTS,
        defaultReasoning: 'medium',
        context: 1_000_000
      },
      {
        id: 'claude-sonnet-5',
        label: 'Sonnet 5',
        reasoning: CLAUDE_EFFORTS,
        defaultReasoning: 'medium',
        context: 1_000_000
      }
    ],
    defaultModel: 'claude-fable-5-1'
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    // codex `model/list` (codex-cli 0.153.1 — gpt-6-astra first appears
    // there), minus the deprecated gpt-5.4 family (each row carries an
    // upgrade pointer to its 5.6 replacement).
    models: [
      {
        id: 'gpt-6-astra',
        label: 'GPT-6 Astra',
        reasoning: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
        defaultReasoning: 'medium'
      },
      {
        id: 'gpt-5.6-sol',
        label: 'GPT-5.6 Sol',
        reasoning: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
        defaultReasoning: 'low'
      },
      {
        id: 'gpt-5.6-terra',
        label: 'GPT-5.6 Terra',
        reasoning: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
        defaultReasoning: 'medium'
      },
      {
        id: 'gpt-5.6-luna',
        label: 'GPT-5.6 Luna',
        reasoning: ['low', 'medium', 'high', 'xhigh', 'max'],
        defaultReasoning: 'medium'
      },
      {
        id: 'gpt-5.5',
        label: 'GPT-5.5',
        reasoning: ['low', 'medium', 'high', 'xhigh'],
        defaultReasoning: 'medium'
      },
      {
        id: 'gpt-5.3-codex-spark',
        label: 'GPT-5.3 Codex Spark',
        reasoning: ['low', 'medium', 'high', 'xhigh'],
        defaultReasoning: 'high'
      }
    ],
    defaultModel: 'gpt-5.6-sol'
  },
  cursor: {
    id: 'cursor',
    label: 'Cursor',
    // Curated from `cursor-agent models`; effort permutations collapse into
    // one entry per family (the driver resolves the concrete id).
    models: [
      { id: 'auto', label: 'Auto', reasoning: [] },
      { id: 'composer-2.5', label: 'Composer 2.5', reasoning: [] },
      {
        id: 'cursor-grok-4.6',
        label: 'Cursor Grok 4.6',
        reasoning: ['low', 'medium', 'high', 'xhigh'],
        defaultReasoning: 'high'
      },
      {
        id: 'gpt-5.3-codex',
        label: 'Codex 5.3',
        reasoning: ['low', 'medium', 'high', 'xhigh'],
        defaultReasoning: 'medium'
      },
      {
        id: 'gpt-5.6-sol',
        label: 'GPT-5.6 Sol',
        reasoning: ['high', 'xhigh'],
        defaultReasoning: 'high'
      },
      {
        id: 'gpt-5.6-luna',
        label: 'GPT-5.6 Luna',
        reasoning: ['medium', 'high', 'xhigh', 'max'],
        defaultReasoning: 'medium'
      },
      {
        id: 'claude-fable-5-thinking',
        label: 'Fable 5 Thinking',
        reasoning: ['high', 'xhigh'],
        defaultReasoning: 'high'
      },
      {
        id: 'claude-opus-5-thinking',
        label: 'Opus 5 Thinking',
        reasoning: ['low', 'medium', 'high', 'xhigh', 'max'],
        defaultReasoning: 'high'
      },
      {
        id: 'claude-sonnet-5-thinking',
        label: 'Sonnet 5 Thinking',
        reasoning: ['high', 'xhigh'],
        defaultReasoning: 'high'
      }
    ],
    defaultModel: 'composer-2.5'
  },
  // Second-class harnesses: probed at boot from the installed CLIs (see
  // PROBED_PROVIDERS); an uninstalled one keeps an empty list.
  grok: { id: 'grok', label: 'Grok Build', models: [], defaultModel: '', experimental: true },
  opencode: { id: 'opencode', label: 'OpenCode', models: [], defaultModel: '', experimental: true },
  pi: { id: 'pi', label: 'Pi', models: [], defaultModel: '', experimental: true },
  omp: { id: 'omp', label: 'omp', models: [], defaultModel: '', experimental: true },
  fx: { id: 'fx', label: 'fx', models: [], defaultModel: '', experimental: true }
}

/** A provider's entry for a model id, if it's in the catalog. */
export function modelInfo(provider: ProviderId, modelId: string): ModelInfo | undefined {
  return CATALOG[provider].models.find((m) => m.id === modelId)
}

/**
 * Whether a model can run with the 1M context window. Only the Claude
 * harness honours `context1m` (drivers/claude.ts appends `[1m]`), and only
 * models the catalog says serve a million tokens. One predicate so the
 * picker, the spawn tools and their refusals can never disagree.
 */
export function supportsContext1m(provider: ProviderId, modelId: string): boolean {
  return provider === 'claude' && (modelInfo(provider, modelId)?.context ?? 0) >= 1_000_000
}

/**
 * A model id names its harness. If the requested provider doesn't serve
 * the model, route to the one that does (claude asked to run gpt-5.6-sol
 * → codex) instead of handing a foreign id to a harness that will error.
 * A model no provider knows stays as asked, under the requested provider.
 */
export function resolveModel(
  provider: ProviderId,
  model: string
): { provider: ProviderId; model: string } {
  if (!model) return { provider, model: CATALOG[provider].defaultModel }
  if (modelInfo(provider, model)) return { provider, model }
  for (const p of Object.keys(CATALOG) as ProviderId[]) {
    if (modelInfo(p, model)) return { provider: p, model }
  }
  // A bare display slug (fable-5.1, opus-5.5): the renderer's built-in
  // picker ids are `claude:fable-5.1` and a stripped one once reached the
  // driver as `--model fable-5.1[1m]`. The catalog id is the provider name
  // plus the slug with dots as dashes; only that exact shape matches, so
  // gpt-5.5 / cursor-grok-4.6 cannot be mis-hit.
  const slug = model.toLowerCase().replace(/\./g, '-')
  for (const p of [provider, ...(Object.keys(CATALOG) as ProviderId[])]) {
    if (modelInfo(p, `${p}-${slug}`)) return { provider: p, model: `${p}-${slug}` }
  }
  // Unknown to the catalog (a model newer than this file, or a typo): keep
  // it under the provider asked for and let the harness judge it. Swapping
  // in the default here silently moved threads onto another model.
  return { provider, model }
}
