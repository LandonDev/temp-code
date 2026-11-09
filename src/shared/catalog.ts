/**
 * Capability catalog: what can be spawned, per provider.
 * This is the source of truth for the model/reasoning/agent-type pickers
 * AND for the enums in the orchestrator's spawn_agent MCP tool.
 *
 * Model lists and reasoning ladders are taken from the CLIs themselves
 * (verified 2026-10-09): `codex app-server` → `model/list` (codex-cli
 * 0.162.1), `cursor-agent models` (2026.07.23), `claude --effort` levels
 * plus a one-turn SDK probe per Claude id.
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
  | 'muse'

/** Providers whose model list comes from probing the installed CLI at
 *  boot (and on `catalog.get {refresh}`), not from this file. */
export const PROBED_PROVIDERS: ProviderId[] = ['grok', 'opencode', 'pi', 'omp', 'fx', 'muse']

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

/** Every effort rung, lowest first: the order `fitReasoning` clamps by and
 *  every enum of the wire, the rules and the app tools reads. */
export const REASONING_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const
export type Reasoning = (typeof REASONING_LEVELS)[number]

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
  /** Speed tiers the CLI that serves this model lists for it, by the CLI's
   *  own ids: codex's `model/list` serviceTiers (e.g. ['priority',
   *  'ultrafast']), claude's `supportedModels()` supportsFastMode (['fast']).
   *  Optional on every provider; absent until probed, never assumed. The
   *  drivers send a tier only when it is listed here. */
  speedTiers?: string[]
  /** The oldest codex CLI that serves this model. An older install hides
   *  the row everywhere (picker, spawn table, app tools) instead of
   *  offering a model that fails with a 400 at first use. */
  minCodexVersion?: string
  /** The model's maker when it is not the harness's own (a Meta model
   *  served by the Claude Code or Codex harness). Its window is native,
   *  so it never takes `[1m]`; the picker groups it and marks it. */
  vendor?: 'meta'
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
/** Meta's ladder (dev.meta.ai; it refuses `none`), on the codex rows only. */
const META_EFFORTS: Reasoning[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** Meta's models, served by both harnesses through the gateway. */
function metaRows(efforts: Reasoning[]): ModelInfo[] {
  return [
    {
      id: 'muse-wonder-1.0',
      label: 'Muse Wonder 1.0',
      reasoning: efforts,
      defaultReasoning: 'high',
      context: 1_048_576,
      vendor: 'meta'
    },
    {
      id: 'muse-spark-1.3',
      label: 'Muse Spark 1.3',
      reasoning: efforts,
      defaultReasoning: 'medium',
      context: 1_048_576,
      vendor: 'meta'
    }
  ]
}

export const CATALOG: Record<ProviderId, ProviderInfo> = {
  claude: {
    id: 'claude',
    label: 'Claude',
    models: [
      {
        id: 'claude-fable-5-2',
        label: 'Fable 5.2',
        reasoning: CLAUDE_EFFORTS,
        defaultReasoning: 'high',
        context: 1_000_000
      },
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
        id: 'claude-sonnet-5-5',
        label: 'Sonnet 5.5',
        reasoning: CLAUDE_EFFORTS,
        defaultReasoning: 'medium',
        context: 1_000_000
      },
      {
        id: 'claude-haiku-5-5',
        label: 'Haiku 5.5',
        reasoning: CLAUDE_EFFORTS,
        defaultReasoning: 'medium',
        context: 1_000_000
      },
      // The Claude CLI (2.1.312) takes --effort low|medium|high|xhigh|max only.
      ...metaRows(CLAUDE_EFFORTS)
    ],
    defaultModel: 'claude-fable-5-1'
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    // codex `model/list` (codex-cli 0.162.1 — the Sol pair first appears
    // there; 0.153 still serves astra and the 5.6 family), minus the
    // deprecated gpt-5.4 family. The default stays on gpt-5.6-sol: 0.162
    // defaults to gpt-6.1-sol, but a 0.153 install rejects both Sol ids
    // with a 400, so the default must be a model every CLI can run; the
    // Sol rows carry minCodexVersion (0.162.1 is the oldest CLI verified
    // to run them) and are hidden on an older install.
    models: [
      {
        id: 'gpt-6.1-sol',
        label: 'GPT-6.1 Sol',
        reasoning: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
        defaultReasoning: 'low',
        minCodexVersion: '0.162.1'
      },
      {
        id: 'gpt-6-sol',
        label: 'GPT-6 Sol',
        reasoning: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
        defaultReasoning: 'medium',
        minCodexVersion: '0.162.1'
      },
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
      },
      ...metaRows(META_EFFORTS)
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
  fx: { id: 'fx', label: 'fx', models: [], defaultModel: '', experimental: true },
  // Muse Code (Meta): one `muse serve` per thread over the Muse Session
  // Protocol (drivers/muse.ts); the rows come from `model/list` at boot
  // (harness/museCatalog.ts). The default names the model the CLI itself
  // defaults to until the probe says otherwise.
  muse: { id: 'muse', label: 'Muse Code', models: [], defaultModel: 'muse-spark-1.3', experimental: true }
}

/**
 * The codex CLI version the main process found on the login PATH
 * (drivers/codexVersion.ts), e.g. "0.162.1"; null while unknown or in the
 * renderer, which only ever sees the already-filtered `catalog.get` answer.
 * Unknown never hides a row: a missing CLI shows as such in the doctor.
 */
let installedCodexVersion: string | null = null
export function setInstalledCodexVersion(version: string | null): void {
  installedCodexVersion = version
}

/** Dotted numeric versions ("0.162.1" vs "0.153.4"); a pre-release tag after `-` is ignored. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string): number[] => v.split('-')[0].split('.').map((n) => Number(n) || 0)
  const [pa, pb] = [parts(a), parts(b)]
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d < 0 ? -1 : 1
  }
  return 0
}

/** Whether the installed CLI can run this row (see minCodexVersion). */
export function runnableHere(provider: ProviderId, model: ModelInfo): boolean {
  if (provider !== 'codex' || !model.minCodexVersion || !installedCodexVersion) return true
  return compareVersions(installedCodexVersion, model.minCodexVersion) >= 0
}

/** A provider's rows minus the ones the installed CLI cannot run. */
export function visibleModels(provider: ProviderId): ModelInfo[] {
  return CATALOG[provider].models.filter((m) => runnableHere(provider, m))
}

/**
 * The catalog as offered: every reader that lists models (the picker's
 * `catalog.get`, the spawn table, the app tools' refusals) goes through
 * here so none of them can offer a row another would refuse.
 */
export function visibleCatalog(): Record<ProviderId, ProviderInfo> {
  const out = { ...CATALOG }
  for (const id of Object.keys(CATALOG) as ProviderId[]) {
    const models = visibleModels(id)
    if (models.length !== CATALOG[id].models.length) out[id] = { ...CATALOG[id], models }
  }
  return out
}

/** A provider's entry for a model id, if it's in the catalog and the installed CLI runs it. */
export function modelInfo(provider: ProviderId, modelId: string): ModelInfo | undefined {
  // A provider the catalog does not list (a test's bare session) has no rows.
  return CATALOG[provider]?.models.find((m) => m.id === modelId && runnableHere(provider, m))
}

/** Whether a provider's row is a Meta model (`vendor: 'meta'`). */
export function isMetaModel(provider: ProviderId, modelId: string): boolean {
  return modelInfo(provider, modelId)?.vendor === 'meta'
}

/**
 * Whether a model can run with the 1M context window. Only the Claude
 * harness honours `context1m` (drivers/claude.ts appends `[1m]`), and only
 * models the catalog says serve a million tokens; a vendor row's window is
 * native and never takes `[1m]`. One predicate so the picker, the spawn
 * tools and their refusals can never disagree. `info` is the row of the
 * host that runs it (another host's for a spawn there), this one's by default.
 */
export function supportsContext1m(
  provider: ProviderId,
  modelId: string,
  info: ModelInfo | undefined = modelInfo(provider, modelId)
): boolean {
  if (provider !== 'claude') return false
  return !info?.vendor && (info?.context ?? 0) >= 1_000_000
}

/**
 * A model id names its harness. If the requested provider doesn't serve
 * the model, route to the one that does (claude asked to run gpt-5.6-sol
 * → codex) instead of handing a foreign id to a harness that will error.
 * A model no provider knows stays as asked, under the requested provider.
 * `serves` is the catalog of the host that runs it, this one's by default
 * (another host's for a thread started there).
 */
export function resolveModel(
  provider: ProviderId,
  model: string,
  serves: (provider: ProviderId, modelId: string) => boolean = (p, id) => !!modelInfo(p, id)
): { provider: ProviderId; model: string } {
  if (!model) return { provider, model: CATALOG[provider].defaultModel }
  if (serves(provider, model)) return { provider, model }
  // A Muse id asked of the Muse harness stays there, probed or not: the
  // same `muse-wonder-*` id is also a row under claude and codex (the Meta
  // Model API), and only `muse serve` reaches Wonder Full.
  if (provider === 'muse' && model.startsWith('muse-')) return { provider, model }
  for (const p of Object.keys(CATALOG) as ProviderId[]) {
    if (serves(p, model)) return { provider: p, model }
  }
  // A bare display slug (fable-5.1, opus-5.5): the renderer's built-in
  // picker ids are `claude:fable-5.1` and a stripped one once reached the
  // driver as `--model fable-5.1[1m]`. The catalog id is the provider name
  // plus the slug with dots as dashes; only that exact shape matches, so
  // gpt-5.5 / cursor-grok-4.6 cannot be mis-hit.
  const slug = model.toLowerCase().replace(/\./g, '-')
  for (const p of [provider, ...(Object.keys(CATALOG) as ProviderId[])]) {
    if (serves(p, `${p}-${slug}`)) return { provider: p, model: `${p}-${slug}` }
  }
  // Unknown to the catalog (a model newer than this file, or a typo): keep
  // it under the provider asked for and let the harness judge it. Swapping
  // in the default here silently moved threads onto another model.
  return { provider, model }
}
