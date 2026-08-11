/**
 * Capability catalog: what can be spawned, per provider.
 * This is the source of truth for the model/reasoning/agent-type pickers
 * AND for the enums in the orchestrator's spawn_agent MCP tool.
 *
 * Static defaults for now; later hydrated from the drivers themselves
 * (e.g. `codex app-server` advertises models at initialize).
 */

export type ProviderId = 'claude' | 'codex' | 'cursor'

export type Reasoning = 'low' | 'medium' | 'high' | 'max'

export interface ModelInfo {
  id: string
  label: string
}

export interface ProviderInfo {
  id: ProviderId
  label: string
  models: ModelInfo[]
  defaultModel: string
  reasoning: Reasoning[]
  experimental?: boolean
}

export const AGENT_TYPES = ['orchestrator', 'implementer', 'reviewer', 'explorer'] as const
export type AgentType = (typeof AGENT_TYPES)[number]

export const CATALOG: Record<ProviderId, ProviderInfo> = {
  claude: {
    id: 'claude',
    label: 'Claude',
    models: [
      { id: 'claude-fable-5', label: 'Fable 5' },
      { id: 'claude-opus-5', label: 'Opus 5' },
      { id: 'claude-opus-4-8', label: 'Opus 4.8' },
      { id: 'claude-sonnet-5', label: 'Sonnet 5' }
    ],
    defaultModel: 'claude-sonnet-5',
    reasoning: ['low', 'medium', 'high', 'max']
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    models: [
      { id: 'gpt-5.5', label: 'GPT-5.5' },
      { id: 'gpt-5.5-codex', label: 'GPT-5.5 Codex' }
    ],
    defaultModel: 'gpt-5.5',
    reasoning: ['low', 'medium', 'high', 'max'],
    experimental: true
  },
  cursor: {
    id: 'cursor',
    label: 'Cursor',
    models: [
      { id: 'composer-1', label: 'Composer 1' },
      { id: 'sonnet-4.5', label: 'Sonnet 4.5' }
    ],
    defaultModel: 'composer-1',
    reasoning: ['medium'],
    experimental: true
  }
}
