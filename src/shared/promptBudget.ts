/**
 * Byte budgets on the parts of every prompt the host itself writes, held by
 * src/main/server/promptBudget.test.ts. Every Claude and Codex thread pays
 * these on every request, before its own work; a fixed overhead that fills
 * the window makes it compact on every request (docs/agents/prompt-overhead.md).
 * Each budget is what this code measured on 2026-11-11 plus 10%, rounded up
 * to the next KiB. Raising one is a reviewed one-line change with a reason.
 */
export const PROMPT_BUDGET = {
  /** The claude system-prompt append per thread type (orchestration.ts, mechanicsFor and the type's words). */
  'claude.chat': 9_216,
  'claude.planning': 10_240,
  'claude.implementation': 9_216,
  'claude.orchestration': 11_264,
  'claude.research': 10_240,
  'claude.master': 12_288,
  'claude.subagent': 9_216,
  'claude.implementation.away': 11_264,
  /** The app MCP server's tools/list as a claude implementation thread sees it (apptools.ts). */
  'claude.appTools': 19_456,
  /** The codex and Muse bridge's tools/list (scripts/app-mcp-bridge.mjs): the base set, and with the Mac's and the add-ons' tools. */
  'bridge.tools': 32_768,
  'bridge.tools.macAndAddons': 40_960,
  /** What the host wraps around a codex thread's first message (threads.ts threadPreamble) and the house preamble (projectPreamble.ts). */
  'firstMessage.codex.implementation': 5_120,
  'firstMessage.codex.chat': 3_072,
  'firstMessage.housePreamble': 2_048
} as const satisfies Record<string, number>

export type PromptPart = keyof typeof PROMPT_BUDGET
