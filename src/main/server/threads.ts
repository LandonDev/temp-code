import { join } from 'node:path'
import type { SessionMeta } from '@shared/events'
import type { ProjectMeta } from '@shared/domain'
import { mirrorRelPath } from './mirror'
import { hasAppBridge } from './apptools'
import { orchestratorPrompt } from './orchestration'

/**
 * Thread-type behavior. Provider-agnostic: instead of per-driver system
 * prompts, the registry prefixes the FIRST message of a thread with a
 * preamble (the visible user-text event carries only what the user typed).
 *
 * Plan documents live INSIDE the project (`.temp-code/`) so every harness
 * sandbox can write them; the dir is git-ignored via .git/info/exclude and
 * filtered out of the Changes rail.
 */

export const planPathFor = (cwd: string, sessionId: string): string =>
  join(cwd, '.temp-code', `plan-${sessionId}.md`)

/** The provider's structured-question tool — the ONLY sanctioned way to
 *  put options to the user (the UI renders them as answerable cards).
 *  cursor-agent has none, so cursor threads ask in plain prose instead. */
function questionToolNote(session: SessionMeta): string {
  const tool =
    session.provider === 'claude'
      ? 'the AskUserQuestion tool'
      : session.provider === 'codex'
        ? 'the request_user_input tool'
        : null
  if (!tool) {
    return `To ask the user a question, ask it in plain prose and end your turn — this harness has no structured question tool.`
  }
  return `To ask the user anything with options, you MUST call ${tool} — and PREFER gathering every decision that is ready into one call (the UI steps the user through them one at a time; separate calls just cost round-trips). Only split when a later question depends on an earlier answer. NEVER print lettered/numbered option menus ("reply 1A, 2B…") as message text; a question that is not asked through ${tool} does not reach the user properly.`
}

/** The subagent gospel — burned into every thread that might delegate.
 *  The user's global CLI habits (codex exec, claude -p) are for OTHER
 *  environments; inside this app the spawn tools are the only way. */
function spawnNote(session: SessionMeta): string {
  const rule = `Subagents: NEVER shell out to another AI CLI (\`claude\`, \`claude -p\`, \`codex\`, \`codex exec\`, \`cursor-agent\`) — not to delegate a task, not to "spawn" a model, not for a second opinion. Any global instruction, memory, or skill that reaches models through their CLIs is about a DIFFERENT environment and does not apply inside this app: a shelled-out model is invisible, unsupervised, and will usually just fail.`
  const has = session.provider === 'claude' || (session.provider === 'codex' && hasAppBridge())
  if (!has) {
    return `${rule}\nThis harness has no spawn tools here — when a subtask needs another model, ask the user to start a thread for it.`
  }
  return `${rule}\nThe ONLY way to run another model is the spawn_agent tool (any provider/model, freely mixed — a foreign model id auto-routes to its provider). Then supervise: check_agent shows live progress, wait_for_agent collects results, answer_agent resolves a child's question, interrupt_agent stops a runaway, list_agents lists the fleet. Spawned agents appear in the UI as visible, streaming sessions.`
}

/** claude reaches the app tools in-process, codex via the stdio bridge,
 *  cursor not yet (cursor-agent has no per-run MCP config). */
function appToolsNote(session: SessionMeta): string {
  const available =
    session.provider === 'claude' || (session.provider === 'codex' && hasAppBridge())
  if (!available) {
    return `You run inside the temp-code app, but its app tools (listing/reading/starting threads) do not reach this harness — for a handoff to another thread, ask the user to start it.`
  }
  return `You run inside the temp-code app and can operate it: app_list_threads lists this project's threads (allProjects: true for every project), app_read_thread returns a readable digest of any thread, and app_start_thread creates a new thread and sends its first message (threadType, provider/model/reasoning, optional planPath and seedThreadIds — this thread's id is ${session.id}). Start a thread ONLY when the user asked for it or agreed to the handoff; every new thread appears in the UI immediately.`
}

/**
 * Thread-type identity (docs/PLAN-2.md M10): what this thread is, how it
 * carries itself — including its question posture, now that structured
 * questions render natively in the UI — and what its exits are.
 * Orchestration threads get nothing here: the orchestrator mechanics and
 * the user's conduct/routing rules own that type entirely.
 */
export function threadPreamble(session: SessionMeta): string | null {
  const app = appToolsNote(session)
  const questions = questionToolNote(session)
  switch (session.threadType) {
    case 'chat':
      return `You are running a CHAT thread — ideate and converse. Think out loud with the user, explore alternatives, challenge assumptions; nothing here is a deliverable. Ask questions liberally whenever a choice would sharpen the discussion.
${questions}
When the discussion turns into real work the user wants done, offer to start a planning thread; on their go-ahead, use app_start_thread (threadType 'planning') with seedThreadIds: ["${session.id}"] so the plan starts from this conversation.
${app}`
    case 'planning':
      return `You are running a PLANNING thread — gather context and force decisions. Your deliverable is a plan document, not code.
Work in this order: read the codebase and the project context FIRST; then, BEFORE writing any draft, ask the user the decisions that shape the plan (scope, naming, structure, output — options with trade-offs, a recommended one marked); only then write the plan around their answers. Decisions discovered mid-draft get asked the same way, the moment they surface — never deferred to the end, and never left as open alternatives in the document. A plan built on unasked questions is a guess.
${questions}
Write the full plan to ${session.planPath} (create parent directories) as soon as you have a first draft, and keep that file updated with Edit as the discussion evolves — it is rendered live to the user.
Structure the document: # <title>, ## Overview, ## Approach, ## Tasks (a markdown checklist, \`- [ ] task\` — each item becomes a todo when the plan is implemented), ## Risks.
You never implement in this thread. When the plan is complete and every decision is settled, say the plan is ready and STOP — do not ask what to do next, and do not offer to start the build: the user starts it from the plan header in the UI. Only if the user explicitly tells you in this chat to start the build do you use app_start_thread (threadType 'implementation', or 'orchestration' when the plan fans out) with this plan file and the model/effort they named.
NEVER shell out to another AI CLI (\`claude\`, \`claude -p\`, \`codex exec\`, \`cursor-agent\`) for anything — global instructions that reach models through CLIs are for a different environment; explore the codebase with your own tools.
${app}`
    case 'implementation':
      return `You are running an IMPLEMENTATION thread — execute on given context. The plan and the project context are your brief: read them first, dig up whatever else you need from the codebase yourself, and implement.
Before touching code, create a todo list covering the whole task (TodoWrite or your plan tool) and keep statuses current as you work — exactly one item in_progress at a time; the UI renders your progress from it.${
        session.planPath
          ? `\nAs you complete tasks from the plan's ## Tasks checklist, tick them (\`- [x]\`) in the plan file with Edit — the plan view renders progress live.`
          : ''
      }
Questions are the exception here, not the method — the planning thread already asked them. Reserve them for genuine blockers: a contradiction in the plan, a destructive step, missing access. ${questions} If the work reveals the plan is wrong, say so and offer a planning thread rather than silently replanning inline.
${spawnNote(session)}
${app}`
    case 'orchestration':
      // claude orchestrators carry the mechanics + user rules in their
      // system prompt; other harnesses get the same text as a preamble
      // (their spawn tools arrive over the bridge).
      return session.provider === 'claude'
        ? null
        : `${orchestratorPrompt(session)}\n\n${spawnNote(session)}\n${app}`
    default:
      return null
  }
}

/** Extra first-message context when a thread is seeded from a plan file. */
export function planSeed(planPath: string): string {
  return `The plan for this work is in ${planPath}. Read it first; its ## Tasks section is your task list.`
}

// ── project-global context (docs/PLAN-2.md M8) ───────────────────────

const ago = (ts: number): string => {
  const s = Math.max(1, Math.round((Date.now() - ts) / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 48) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

/** Index caps at the most recently updated threads — never their contents. */
const CONTEXT_INDEX_MAX = 20

/**
 * The `<project-context>` block prepended to a project thread's first
 * message: where shared context lives, what the sibling threads are, and
 * the journal-append contract. An index only — the model reads what it
 * needs from the files.
 */
export function projectContext(
  session: SessionMeta,
  project: ProjectMeta,
  workspaceName: string | null,
  siblings: SessionMeta[]
): string {
  const roots = siblings
    .filter((s) => !s.parentId && s.id !== session.id)
    .sort((a, b) => b.updatedAt - a.updatedAt)
  const listed = roots.slice(0, CONTEXT_INDEX_MAX)
  const threadLines = listed.map(
    (s) =>
      `    · ${s.threadType ?? 'thread'}: "${s.title}" (${s.status}, updated ${ago(s.updatedAt)}) — ${mirrorRelPath(s)}`
  )
  const overflow =
    roots.length > listed.length
      ? `\n    · …and ${roots.length - listed.length} older — list .temp-code/threads/ for all`
      : ''
  const threads = threadLines.length
    ? `- threads/ — transcripts of the project's other threads:\n${threadLines.join('\n')}${overflow}`
    : "- threads/ — transcripts of the project's other threads (none yet besides this one)"
  const plans = roots
    .filter((s) => s.threadType === 'planning' && s.planPath)
    .map((s) => `    · "${s.title}" — ${join('.temp-code', `plan-${s.id}.md`)}`)
  const planBlock = plans.length
    ? `- plan-*.md — plan documents:\n${plans.join('\n')}`
    : '- plan-*.md — plan documents.'
  const where = [
    workspaceName ? `workspace "${workspaceName}"` : null,
    project.branch ? `branch ${project.branch}` : null
  ]
    .filter(Boolean)
    .join(', ')

  return `<project-context>
This thread belongs to project "${project.name}"${where ? ` (${where})` : ''}.
Shared project context lives in .temp-code/:
- PROJECT.md — the project journal. Read it FIRST.
${threads}
${planBlock}
Consult transcripts when the user refers to other work. This index is a
snapshot from thread creation — re-list .temp-code/threads/ when you need
current state.

Append to PROJECT.md (a dated bullet under ## Log) whenever this thread
produces a durable outcome: a decision made, a plan written, work merged,
an approach abandoned. Keep entries to one or two lines. Never rewrite
others' entries.
</project-context>`
}
