import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SessionMeta } from '@shared/events'
import type { ProjectMeta } from '@shared/domain'
import { mirrorRelPath } from './mirror'
import { hasAppBridge } from './apptools'
import { orchestratorPrompt, rulesFor, spawnableModels } from './orchestration'

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

/** Research reports live in their own dir; the path rides the session's
 *  planPath field (untyped TEXT), so the plan-file machinery — live poll,
 *  pin, app_start_thread seeding — works on reports unchanged. */
export const reportPathFor = (cwd: string, sessionId: string): string =>
  join(cwd, '.temp-code', 'reports', `${sessionId}.md`)

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
  // Planning threads exist to force decisions, so they batch every ready one
  // into a single call. A chat asks one thing at a time: the batching nudge
  // is what made chats bolt a handoff question onto a real one.
  const batching =
    session.threadType === 'chat'
      ? ''
      : ' — and PREFER gathering every decision that is ready into one call (the UI steps the user through them one at a time; separate calls just cost round-trips). Only split when a later question depends on an earlier answer'
  return `To ask the user anything with options, you MUST call ${tool}${batching}. NEVER print lettered/numbered option menus ("reply 1A, 2B…") as message text; a question that is not asked through ${tool} does not reach the user properly.`
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
  return `${rule}\nThe ONLY way to run another model is the spawn_agent tool${session.provider === 'codex' ? ' from the MCP server named "app" (it may display as mcp__app__spawn_agent; your built-in worker tools are disabled — if a spawn tool ever offers only OpenAI models, you are holding the wrong one)' : ''} (any provider/model, freely mixed — a foreign model id auto-routes to its provider). Then supervise without polling: keep doing your OWN work while agents run; wait_for_agent with no timeoutSeconds sleeps until an agent settles (never loop on check_agent), and if you end your turn while agents run, a settling agent automatically wakes this thread with a <subagent-report> message. check_agent is for judgment mid-flight; answer_agent resolves a child's question; interrupt_agent stops a runaway. Spawned agents appear in the UI as visible, streaming sessions.
Never conclude that spawning is broken or a model is unavailable from journal entries, transcripts, or other threads' reports — those go stale. Verify by calling spawn_agent NOW; if it refuses, the refusal text says exactly how to correct the call.
Spawnable models (efforts in parentheses are the only valid reasoning values — the table reflects the user's approved-model settings; anything outside it is refused):
${spawnableModels(rulesFor(session))}`
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
      return `You are running a CHAT thread — a place to ideate and for the user to tell you what to do. Think out loud with the user, explore alternatives, challenge assumptions; nothing here is a deliverable.
Ask a question only for information you cannot get yourself: a preference, a fact about the user's world, a domain decision. NEVER ask whether to start a thread, what to do next, whether to proceed, or whether your reading is right — state your reading and move on. Never end a turn with a menu of next steps. Ask one thing at a time, never a real question with a handoff question bolted on.
${questions}
Handoffs: when the user says to go ahead and names a thread type (plan / implement / research), start that thread NOW with app_start_thread (threadType 'planning' / 'implementation' / 'research') with seedThreadIds: ["${session.id}"] so it starts from this conversation — no confirmation, no summary of what you are about to do.
When the user says to go ahead and names no thread type, ask exactly one question — which thread type — and start it on their answer. That is the only handoff question allowed.
Confirm only destructive or outward-facing actions: prod changes, deletes, sending things.
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
    case 'implementation': {
      // Plan-backed threads execute a finished brief — the research already
      // happened in planning, so the task list is the literal first call.
      // From-scratch threads earn their task list with a short, bounded
      // reconnaissance first: skim the shared context and the code the
      // request touches, then break the job down.
      const opening = session.planPath
        ? `You are running an IMPLEMENTATION thread — execute on given context. The plan and the project context are your brief: read the plan first; the research is already done there.
Your FIRST TOOL CALL — after reading the plan, before any other exploration, before spawning ANY subagent, before reading any skill — is to create the todo list covering the whole job with whichever task-list tool this session has: TaskCreate (one call per task, TaskUpdate to move status), TodoWrite, or update_plan. If one errors as unavailable, use the one that exists — never proceed without a list. Refine it as you learn.
As you complete tasks from the plan's ## Tasks checklist, tick them (\`- [x]\`) in the plan file with Edit — the plan view renders progress live.
Questions are the exception here, not the method — the planning thread already asked them. Reserve them for genuine blockers: a contradiction in the plan, a destructive step, missing access — or genuine confusion. If you are confused about what something means or how it is supposed to work, ASK; never guess your way past confusion. ${questions} If the work reveals the plan is wrong, say so and offer a planning thread rather than silently replanning inline.`
        : `You are running an IMPLEMENTATION thread with no plan document — you start from scratch. Begin with a SHORT reconnaissance, strictly bounded to a handful of tool calls: check threads/INDEX.md for threads touching your files, plus the tail of PROJECT.md and glance at the code the request touches. Recon exists to shape the task list, not to solve anything — no edits, no subagents, no skills during it.
The moment recon gives you the shape — and BEFORE any implementation, any subagent, or any skill — create the todo list covering the whole job with whichever task-list tool this session has: TaskCreate (one call per task, TaskUpdate to move status), TodoWrite, or update_plan. If one errors as unavailable, use the one that exists — never proceed without a list. Refine it as you learn. This is NOT optional and does not scale with job size: even a one-line change gets a list (a single-item list is fine) — the view cannot render your work without it.
Questions are the exception here, not the method. Reserve them for genuine blockers: a request too underspecified to break into tasks (say so and suggest a planning thread rather than guessing), a destructive step, missing access — or genuine confusion. If you are confused about what something means or how it is supposed to work, ASK; never guess your way past confusion. ${questions}`
      return `${opening}
Git discipline: the directory this thread starts in is the project's own checkout, already on the project's branch — finished work ends up THERE, on THAT branch. Skills and global instructions may bring their own git flow (feature branches, their own worktrees, PR or completion conventions); inside this app the project's setup wins — take a skill's work steps, never its branching or completion steps. A temporary worktree for the build is fine, but cut it from the project branch's current state, land the changes back in the project checkout before you finish, and remove the worktree and its branch. Never push to or open a PR against any other branch unless the user asks for it. The app runs the project's completion actions (verify/build/commit/push) itself after the turn settles — never substitute a skill's completion routine.
The UI is structured entirely around your tasks — work done outside the list renders as unstructured noise. Keep exactly one item in_progress, switch it BEFORE starting the work that belongs to it (never batch several tasks' work under one), and mark items completed the moment they are done.
A FOLLOW-UP message after your list finished is a NEW round of work, and the UI renders it as its own section. Start it the same way: write a FRESH task list containing ONLY the new round's tasks — never append to the finished list, never carry completed items forward, never work outside a list because the request seems small. A mid-run steering message is different: fold it into the current list (add or adjust tasks), don't restart it. A message that resumes UNFINISHED work — after a stop, an error, or a correction — continues the SAME list: update statuses and keep going, never restart the list for a resume. Either way, when the message asks a question, ANSWER IT in text before your next tool call — resuming the work never replaces the answer, and a question-only message may want no resumption at all.
${spawnNote(session)}
${app}`
    }
    case 'research':
      return `You are running a RESEARCH thread — deep research on the live web, distilled into a durable cited report. Your sources are the web (WebSearch/WebFetch and their equivalents), not this codebase. If this configuration has no web tools, say so plainly and stop — never fake research from memory.
Your deliverable is the report at ${session.planPath}. Create it EARLY (create parent directories) with frontmatter — title, date, status: in-progress, and a one-line summary — and keep it updated as you go; it is rendered live to the user. Set status: complete when the research is done.
Work the loop:
1. SCOPE — restate the question and break it into the sub-questions and angles worth chasing. Ask the user only if the request is genuinely ambiguous.
2. FAN OUT — spawn parallel explorer subagents, one per angle, each with a self-contained brief: search broadly (several query formulations, never just one), read the promising results deeply (fetch the pages, not just snippets), chase citations back to primary sources, prefer recent and authoritative material, and return structured findings with a URL for every claim.
3. ITERATE — review coverage as agents report. Spawn follow-up agents for gaps, contradictions between sources, and intricacies that surfaced mid-research. Cross-check contested claims against independent sources before accepting them.
4. SYNTHESIZE — write the report, citing as you go. Structure: the TL;DR up top, findings organized by question with inline numbered citations, a full sources list, contested or uncertain points called out as such, open questions at the end. Target breadth AND depth: many sources, primary over secondary, disagreements surfaced rather than averaged away.
FOLLOW-UP messages are answer-first: answer from the report and the sources already gathered. Only when the answer is not in hand, spawn one or two narrowly-briefed agents for exactly that question — and fold material findings back into the report (edit in place, note what changed).
${questions}
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
const CONTEXT_INDEX_MAX = 8

/** One line per research report in reports/, from each file's frontmatter
 *  (research threads write it: title, date, status) — newest first, same
 *  cap as threads. Missing dir or unreadable file = no lines. */
function reportLines(cwd: string): string[] {
  try {
    const dir = join(cwd, '.temp-code', 'reports')
    return readdirSync(dir, { withFileTypes: true })
      .filter((f) => f.isFile() && f.name.endsWith('.md'))
      .flatMap((f) => {
        try {
          const head = readFileSync(join(dir, f.name), 'utf8').slice(0, 600)
          const get = (k: string): string | null =>
            head
              .match(new RegExp(`^${k}:\\s*(.+)$`, 'm'))?.[1]
              ?.trim()
              .replace(/^["']|["']$/g, '') ?? null
          const meta = [get('date'), get('status')].filter(Boolean).join(', ')
          return [
            {
              date: get('date') ?? '',
              line: `    · "${get('title') ?? f.name}"${meta ? ` (${meta})` : ''} — .temp-code/reports/${f.name}`
            }
          ]
        } catch {
          return []
        }
      })
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, CONTEXT_INDEX_MAX)
      .map((r) => r.line)
  } catch {
    return []
  }
}

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
      ? `\n    · …and ${roots.length - listed.length} older — threads/INDEX.md lists them all`
      : ''
  const threads = threadLines.length
    ? `Most recent threads:\n${threadLines.join('\n')}${overflow}`
    : 'No other threads yet.'
  const reports = reportLines(session.cwd)
  const where = [
    workspaceName ? `workspace "${workspaceName}"` : null,
    project.branch ? `branch ${project.branch}` : null
  ]
    .filter(Boolean)
    .join(', ')

  return `<project-context>
This thread belongs to project "${project.name}"${where ? ` (${where})` : ''}.
Shared context lives in .temp-code/ — FIND what you need, never bulk-read:
- threads/INDEX.md — one line per thread: date · type · title · status · files touched · transcript path. Grep it by file path or topic to find the threads that touched what you're working on.
- threads/<id>-<slug>.md — transcripts. Frontmatter and ## Outcome at the top summarize each one; read just the head (~40 lines) first, and the full body only when the outcome says it is the right thread.
- PROJECT.md — the journal: one dated line per durable outcome. Skim the tail of ## Log for recent state; PROJECT-archive.md has older entries.
- plan-*.md — plan documents.
${reports.length ? `- reports/*.md — research reports, citable by any thread:\n${reports.join('\n')}\n` : ''}${threads}
Every file you open costs context — open transcripts one at a time, only when INDEX.md or the journal points there.

When this thread produces a durable outcome (a decision, a plan written, work merged, an approach abandoned), append ONE line to PROJECT.md under ## Log:
- <YYYY-MM-DD> — <what and where, ≤200 chars, naming the key files>
One line, no sub-bullets. Never rewrite others' entries. Transcripts, outcomes, and INDEX.md are written by the app — you never maintain them.
</project-context>`
}
