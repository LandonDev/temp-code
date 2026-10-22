import { z } from 'zod'

/**
 * Review before merge: an optional second-model review of an implementation
 * thread's branch, run by the app between the thread's green gate and the
 * merge to the project branch. Off by default. Stored as one whole set
 * globally (`review`) with a whole-object per-project override
 * (`review:project:<id>`), the shape turnpass.* and defaults.* use: a
 * project without a set of its own follows the global one.
 *
 * The thread merges through the `merge_branch` app tool (apptools.ts), never
 * by running git itself when this is on: the tool is where the review
 * happens, and its result is what the model reads next.
 */
export const ReviewSettingsSchema = z.object({
  /** review every merge_branch call in the scope; off = the tool merges at once */
  beforeMerge: z.boolean().default(false),
  /** the reviewer's provider and model; the picker is limited to the approved, runnable catalog */
  provider: z.enum(['claude', 'codex', 'cursor', 'grok', 'opencode', 'pi', 'omp', 'fx']).default('codex'),
  model: z.string().default('gpt-6.1-sol'),
  reasoning: z.enum(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']).default('high'),
  /** what holds the merge: a finding the reviewer confirmed, or any finding at all */
  blockOn: z.enum(['confirmed', 'any']).default('confirmed'),
  /** the review's budget; past it the merge proceeds and the row says so */
  maxMinutes: z.number().int().min(1).max(240).default(15)
})
export type ReviewSettings = z.infer<typeof ReviewSettingsSchema>

/** What `review.get` answers: the scope's own set (null when it follows),
 *  the global set, the effective one and where it came from (the phone's
 *  generated contract pins this shape). */
export const ReviewScopeSchema = z.object({
  override: ReviewSettingsSchema.nullable(),
  global: ReviewSettingsSchema.nullable(),
  settings: ReviewSettingsSchema,
  source: z.enum(['project', 'global', 'default'])
})
export type ReviewScope = z.infer<typeof ReviewScopeSchema>

export const DEFAULT_REVIEW_SETTINGS: ReviewSettings = {
  beforeMerge: false,
  provider: 'codex',
  model: 'gpt-6.1-sol',
  reasoning: 'high',
  blockOn: 'confirmed',
  maxMinutes: 15
}

/** Parse stored JSON; anything invalid reads as unset. */
export function parseReviewSettings(raw: string | null): ReviewSettings | null {
  if (!raw) return null
  try {
    return ReviewSettingsSchema.parse(JSON.parse(raw))
  } catch {
    return null
  }
}

/** The set a project runs under: its own, else the global one, else the defaults. */
export function effectiveReviewSettings(
  project: ReviewSettings | null,
  global: ReviewSettings | null
): { settings: ReviewSettings; source: 'project' | 'global' | 'default' } {
  if (project) return { settings: project, source: 'project' }
  if (global) return { settings: global, source: 'global' }
  return { settings: DEFAULT_REVIEW_SETTINGS, source: 'default' }
}

// ── the reviewer's report (the report_findings app tool) ─────────────

export const REVIEW_FINDINGS_MAX = 32

/** One finding, the shape Claude Code's ReportFindings tool reports in, so a
 *  reviewer that already speaks it needs no translation. */
export const ReviewFindingSchema = z.object({
  /** repo-relative path */
  file: z.string().min(1).max(512),
  /** 1-indexed line the finding anchors to */
  line: z.number().int().optional(),
  /** one-sentence statement of the defect */
  summary: z.string().min(1).max(2000),
  /** concrete inputs or state → wrong output or crash */
  failure_scenario: z.string().max(4000).default(''),
  /** CONFIRMED when the reviewer verified it against the code; PLAUSIBLE when not */
  verdict: z.enum(['CONFIRMED', 'PLAUSIBLE']).optional(),
  /** short kebab-case slug of the finding type, e.g. correctness */
  category: z.string().max(40).optional(),
  /** ≤60 chars, the claim alone */
  short_summary: z.string().max(60).optional()
})
export type ReviewFinding = z.infer<typeof ReviewFindingSchema>

export const ReportFindingsSchema = z.object({
  findings: z.array(ReviewFindingSchema).max(REVIEW_FINDINGS_MAX),
  level: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional()
})
export type ReportFindings = z.infer<typeof ReportFindingsSchema>

/** A finding holds the merge when the set's blockOn admits it: a confirmed
 *  one always; a plausible one only under `any`. A finding with no verdict
 *  counts as confirmed — a reviewer that reports without verdicts means
 *  every row. */
export function isBlocking(finding: ReviewFinding, blockOn: ReviewSettings['blockOn']): boolean {
  if (blockOn === 'any') return true
  return finding.verdict !== 'PLAUSIBLE'
}

/** Blocking findings first, then the rest, each list in reported order. */
export function splitFindings(
  findings: ReviewFinding[],
  blockOn: ReviewSettings['blockOn']
): { blocking: ReviewFinding[]; minor: ReviewFinding[] } {
  const blocking: ReviewFinding[] = []
  const minor: ReviewFinding[] = []
  for (const f of findings) (isBlocking(f, blockOn) ? blocking : minor).push(f)
  return { blocking, minor }
}

// ── what the transcript shows (the `notice` event's `review` payload) ───

export const REVIEW_OUTCOMES = ['pass', 'held', 'timeout', 'failed', 'merged-anyway', 'skipped'] as const
export type ReviewOutcome = (typeof REVIEW_OUTCOMES)[number]

export const ReviewNoticeSchema = z.object({
  /** one run = one merge_branch call under review; the override names it */
  runId: z.string(),
  /** the reviewer thread, linked from the card */
  reviewerId: z.string().optional(),
  provider: z.string(),
  model: z.string(),
  outcome: z.enum(REVIEW_OUTCOMES),
  branch: z.string(),
  target: z.string(),
  blocking: z.array(ReviewFindingSchema).default([]),
  minor: z.array(ReviewFindingSchema).default([]),
  /** the merge landed (pass, timeout, failed-but-merged, merged-anyway) */
  merged: z.boolean().default(false),
  pushed: z.boolean().default(false),
  /** why a failed or skipped run did what it did */
  reason: z.string().optional(),
  /** the budget the timeout row names, minutes */
  minutes: z.number().optional()
})
export type ReviewNotice = z.infer<typeof ReviewNoticeSchema>

/** The one-line row text for a review outcome, as the transcript's plain
 *  fallback and the e2e's assertion. */
export function reviewLine(n: ReviewNotice, modelLabel = n.model): string {
  const minor = n.minor.length ? ` (${n.minor.length} minor)` : ''
  switch (n.outcome) {
    case 'pass':
      return `Reviewed by ${modelLabel}: no blocking findings${minor}`
    case 'held':
      return `Reviewed by ${modelLabel}: ${n.blocking.length} blocking finding${n.blocking.length === 1 ? '' : 's'}${minor} — merge held`
    case 'timeout':
      return `Review by ${modelLabel} timed out after ${n.minutes ?? '?'} min — merged without it`
    case 'failed':
      return `Review by ${modelLabel} failed to run${n.reason ? ` (${n.reason})` : ''} — merged without it`
    case 'merged-anyway':
      return `Merged anyway: ${n.blocking.length} blocking finding${n.blocking.length === 1 ? '' : 's'} overridden`
    case 'skipped':
      return `Merged ${n.branch} into ${n.target}${n.reason ? ` (${n.reason})` : ''}`
  }
}

// ── the two app tools (apptools.ts; scripts/app-mcp-bridge.mjs copies these) ──

export const MERGE_BRANCH_TOOL_NAME = 'merge_branch'
export const MERGE_BRANCH_TOOL_DESCRIPTION =
  "Land this thread's branch on the project branch: a fast-forward merge in the project checkout, then a push when the repo has an origin. When the project reviews before merge, a second model reviews the branch's diff first and this call answers with the verdict: merged, or HELD with the findings to address before calling again (a head that already passed is not reviewed twice). Call it when your gate is green instead of running git merge or git push yourself; a refusal names what to fix (not a fast-forward: rebase onto the target and call again)."
export const MERGE_BRANCH_PARAMS = {
  branch: "The branch to merge. Defaults to the branch this thread's directory is on.",
  push: 'Push the project branch to origin after the merge. Defaults to true when the repo has an origin.'
}

export const REPORT_FINDINGS_TOOL_NAME = 'report_findings'
export const REPORT_FINDINGS_TOOL_DESCRIPTION =
  'Report the findings of a merge review as a typed list, once, when the review is done: every defect with its file, 1-indexed line, one-sentence summary, the concrete failure scenario and a verdict (CONFIRMED when you verified it against the code, PLAUSIBLE when you could not). An empty list means the change is sound. Only this call counts; prose in your reply is not read. Available only to the reviewer thread of a merge review.'
export const REPORT_FINDINGS_PARAMS = {
  findings: 'Verified findings, most severe first; empty if none survived',
  level: 'Effort level the review ran at'
}
export const REVIEW_FINDING_PARAMS = {
  file: 'Repo-relative path of the file the finding is in',
  line: '1-indexed line the finding anchors to',
  summary: 'One-sentence statement of the defect',
  failure_scenario: 'Concrete inputs/state → wrong output/crash',
  verdict: 'CONFIRMED when verified against the code, PLAUSIBLE when not',
  category: 'Short kebab-case slug of the finding type, e.g. "correctness"',
  short_summary: 'Compressed label (≤60 chars): the claim alone'
}
