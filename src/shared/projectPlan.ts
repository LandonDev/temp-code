/**
 * The project plan: one file per project, `<cwd>/.temp-code/plans/project.md`,
 * written by a `project-plan` thread and read by the plan view, the project
 * header and the phone (docs/PROJECT-PLAN.md). Fixed sections, milestones
 * as `###` headings under ## Milestones, each ticked `### [x] N. Title` when
 * its implementation lands. Pure: no node, no electron, shared by the main
 * process, the renderer and the proof scripts.
 */

export const PROJECT_PLAN_SECTIONS = [
  'Goals',
  'Current state',
  'Milestones',
  'Risks',
  'Open questions'
] as const
export type ProjectPlanSection = (typeof PROJECT_PLAN_SECTIONS)[number]

/** Relative to the project cwd; `.temp-code` is already git-ignored there. */
export const PROJECT_PLAN_RELATIVE = '.temp-code/plans/project.md'

export const projectPlanPathFor = (cwd: string): string =>
  `${cwd.replace(/\/+$/, '')}/${PROJECT_PLAN_RELATIVE}`

export const isProjectPlanPath = (path: string | null | undefined): boolean =>
  typeof path === 'string' && path.endsWith(`/${PROJECT_PLAN_RELATIVE}`)

/** A project plan is the one plan type that NEVER starts a build on its own,
 *  whatever the auto-implement setting says: its milestones are planned one
 *  at a time, by a person choosing from the options card. */
export const planMayAutoStart = (threadType: string | null | undefined): boolean =>
  threadType === 'planning'

export type ProjectPlanStatus = 'in-progress' | 'complete'

export interface Milestone {
  /** 1-based, from the heading's own number when it has one, else its position */
  index: number
  title: string
  done: boolean
  scope: string | null
  dependencies: string | null
  doneWhen: string | null
  /** everything under the heading, verbatim */
  body: string
  /** 0-based line of the `###` heading in the document */
  line: number
}

export interface ProjectPlan {
  title: string | null
  status: ProjectPlanStatus | null
  completedAt: string | null
  /** `## <heading>` → its body, as written */
  sections: Record<string, string>
  /** fixed sections the document lacks (case-insensitive match) */
  missing: ProjectPlanSection[]
  milestones: Milestone[]
}

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n?/

function frontmatterOf(md: string): { fields: Record<string, string>; rest: string } {
  const m = FRONTMATTER.exec(md)
  if (!m) return { fields: {}, rest: md }
  const fields: Record<string, string> = {}
  for (const line of m[1].split('\n')) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line)
    if (kv) fields[kv[1]] = kv[2].trim()
  }
  return { fields, rest: md.slice(m[0].length) }
}

const MILESTONE_HEADING = /^###\s+(?:\[([ xX])\]\s+)?(?:(\d+)[.)]\s+)?(.+?)\s*$/

/** `- Scope: …`, `**Scope:** …`, `Scope: …` — the first line that names the field. */
function field(body: string, name: string): string | null {
  const re = new RegExp(`^\\s*(?:[-*]\\s*)?(?:\\*\\*)?(?:${name})(?:\\*\\*)?\\s*:\\s*(?:\\*\\*)?\\s*(.*)$`, 'im')
  const m = re.exec(body)
  if (!m) return null
  const v = m[1].trim()
  return v.length ? v : null
}

export function parseProjectPlan(md: string): ProjectPlan {
  const { fields, rest } = frontmatterOf(md)
  const lines = rest.split('\n')
  const offset = md.length - rest.length ? md.slice(0, md.length - rest.length).split('\n').length - 1 : 0
  let title: string | null = null
  const sections: Record<string, string> = {}
  const milestones: Milestone[] = []
  let current: string | null = null
  let sectionStart = -1
  let milestone: { heading: Milestone; start: number } | null = null
  let inFence = false

  const closeMilestone = (end: number): void => {
    if (!milestone) return
    const body = lines.slice(milestone.start, end).join('\n').replace(/\s+$/, '')
    const m = milestone.heading
    m.body = body
    m.scope = field(body, 'Scope')
    m.dependencies = field(body, 'Dependencies|Depends on')
    m.doneWhen = field(body, 'Done when|Done-when')
    milestones.push(m)
    milestone = null
  }
  const closeSection = (end: number): void => {
    closeMilestone(end)
    if (current !== null) sections[current] = lines.slice(sectionStart, end).join('\n').replace(/\s+$/, '')
    current = null
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^```/.test(line)) inFence = !inFence
    if (inFence) continue
    const h1 = /^#\s+(.+?)\s*$/.exec(line)
    if (h1 && title === null) {
      title = h1[1]
      continue
    }
    const h2 = /^##\s+(.+?)\s*$/.exec(line)
    if (h2) {
      closeSection(i)
      current = h2[1]
      sectionStart = i + 1
      continue
    }
    if (current !== null && current.toLowerCase() === 'milestones') {
      const h3 = MILESTONE_HEADING.exec(line)
      if (h3) {
        closeMilestone(i)
        milestone = {
          heading: {
            index: h3[2] ? Number(h3[2]) : milestones.length + 1,
            title: h3[3],
            done: (h3[1] ?? ' ').toLowerCase() === 'x',
            scope: null,
            dependencies: null,
            doneWhen: null,
            body: '',
            line: i + offset
          },
          start: i + 1
        }
      }
    }
  }
  closeSection(lines.length)

  const have = new Set(Object.keys(sections).map((s) => s.toLowerCase()))
  const missing = PROJECT_PLAN_SECTIONS.filter((s) => !have.has(s.toLowerCase()))
  const status = fields.status === 'complete' ? 'complete' : fields.status === 'in-progress' ? 'in-progress' : null
  return { title, status, completedAt: fields.completed ?? null, sections, missing, milestones }
}

export function milestoneProgress(md: string): { done: number; total: number } {
  const { milestones } = parseProjectPlan(md)
  return { done: milestones.filter((m) => m.done).length, total: milestones.length }
}

/** The first milestone not ticked, in document order. */
export function nextMilestone(md: string): Milestone | null {
  return parseProjectPlan(md).milestones.find((m) => !m.done) ?? null
}

export function milestoneAt(md: string, index: number): Milestone | null {
  return parseProjectPlan(md).milestones.find((m) => m.index === index) ?? null
}

/** The document with milestone `index` ticked or unticked; unchanged when
 *  there is no such milestone. The heading keeps its number and title. */
export function setMilestoneDone(md: string, index: number, done: boolean): string {
  const m = milestoneAt(md, index)
  if (!m) return md
  const lines = md.split('\n')
  const h = MILESTONE_HEADING.exec(lines[m.line])
  if (!h) return md
  const number = h[2] ? `${h[2]}. ` : ''
  lines[m.line] = `### [${done ? 'x' : ' '}] ${number}${h[3]}`
  return lines.join('\n')
}

/** The document with `status` (and `completed`) in its frontmatter; a
 *  document without frontmatter gets one. Everything else is untouched. */
export function setPlanStatus(md: string, status: ProjectPlanStatus, now = new Date()): string {
  const { fields, rest } = frontmatterOf(md)
  const next: Record<string, string> = { ...fields, status }
  if (status === 'complete') next.completed = now.toISOString()
  else delete next.completed
  const block = Object.entries(next)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n')
  return `---\n${block}\n---\n${rest.replace(/^\n+/, '')}`
}

/** A plan counts as done when the thread said so (plan_complete) — the
 *  options card and the project header read nothing else. */
export const projectPlanComplete = (md: string | null | undefined): boolean =>
  !!md && parseProjectPlan(md).status === 'complete'

/** The summary line the project header shows for a pinned plan. */
export function milestoneSummary(md: string | null | undefined): string | null {
  if (!md) return null
  const { done, total } = milestoneProgress(md)
  if (total === 0) return 'Plan'
  return `Plan · ${done} of ${total} milestone${total === 1 ? '' : 's'} done`
}

const describe = (m: Milestone): string => {
  const parts = [`Milestone ${m.index}: ${m.title}`]
  if (m.scope) parts.push(`Scope: ${m.scope}`)
  if (m.dependencies) parts.push(`Dependencies: ${m.dependencies}`)
  if (m.doneWhen) parts.push(`Done when: ${m.doneWhen}`)
  return parts.join('\n')
}

/** The first message of the planning thread "Plan the next milestone" starts:
 *  it points at the project plan and names the milestone to plan. */
export function milestonePlanningBrief(planPath: string, m: Milestone): string {
  return `Plan milestone ${m.index} of the project plan at ${planPath}: "${m.title}".

${describe(m)}

Read the project plan first — its Goals, Current state and the other milestones are the context — and plan ONLY this milestone: what to build, in what order, with the tasks an implementation thread will work through. Treat the milestone's "Done when" as the plan's finish line. Milestones that depend on this one are out of scope.`
}

/** The first message of an orchestration thread started for one milestone. */
export function milestoneOrchestrationBrief(planPath: string, m: Milestone): string {
  return `Orchestrate milestone ${m.index} of the project plan at ${planPath}: "${m.title}".

${describe(m)}

Read the project plan first for the goals and the current state, then split this one milestone across subagents and land it; its "Done when" is the finish line. Other milestones are out of scope.`
}

/** The title a thread started for a milestone carries. */
export const milestoneThreadTitle = (m: Milestone): string => `M${m.index} · ${m.title}`
