# Review before merge

An optional second model between an implementation thread's green gate and
its merge to the project branch. Off by default.

## The setting

Settings → Reviews is the global set; a project's settings dialog carries a
Reviews disclosure that overrides it whole ("Use global setting" removes the
override). Precedence is project → global → defaults, never field by field.

| Key | Default | Meaning |
| --- | --- | --- |
| `beforeMerge` | off | review every `merge_branch` call in the scope |
| `provider`, `model`, `reasoning` | codex, gpt-6.1-sol, high | the reviewer; the picker lists models the orchestration rules approve and this machine can run (Sol rows hide on a codex older than 0.162.1) |
| `blockOn` | confirmed | `confirmed`: a finding the reviewer verified (or reported without a verdict) holds the merge; `any`: a PLAUSIBLE one does too |
| `maxMinutes` | 15 | past it the merge proceeds and the row says the review timed out |

Stored in the settings table as `review` and `review:project:<id>`
(`src/shared/review.ts`). RPCs: `review.get { projectId }` answers
`{ override, global, settings, source }`; `review.set`; `review.override`
(capability approve) is the card's Merge anyway.

## The hook: `merge_branch`

Every thread has the `merge_branch` app tool (claude in-process, codex over
the stdio bridge). It is the merge: in the project checkout it fast-forwards
the project branch (the project's branch, else the repo's default branch) to
the named branch and pushes when the repo has an origin. The branch defaults
to the one the thread's directory is on; a thread working in a worktree of
its own passes `branch`. Refusals come back as text the model acts on: a
checkout not on the target, uncommitted changes to tracked files, a merge
that is not a fast-forward ("rebase onto the target and call again").

When the scope's set is on, the tool reviews first:

1. The bundle (`mergeBranch.ts buildMergeBundle`): the diff against
   `merge-base(target, branch)` (capped at 400 KB), the commits, the files,
   and the thread's first message as its brief. A branch that IS the target
   is compared against `origin/<target>`.
2. A reviewer child session: agentType `reviewer`, parentId the thread,
   the thread's permission, the set's provider/model/reasoning, titled
   `Review: <branch> → <target>`, run in the worktree where the branch is
   checked out (else the project checkout with a `git show` note). It gets
   the bundle and the instruction to call `report_findings` once.
3. The wait: the report, the reviewer settling without one, or the time
   limit, whichever is first.

Why a tool rather than an intercepted `git merge`/`git push`: the harnesses
run the model's shell themselves (Claude's Bash, Codex's sandbox), so a
shim on PATH would have to exist for every harness, would still miss
`git -C`, aliases, scripts and a push typed by hand, and could hand nothing
back. A held merge must be read by the model as the next thing in its turn:
the tool's result is that read. The implementation preamble and the turn
pass tell a reviewed project's threads to land only through the tool.

## Outcomes

Each lands as a `notice` row (kind `review`, payload `ReviewNotice`) that the
transcript draws as `ReviewCard.tsx`, and as the tool's result text.

| Outcome | Merge | Row | Tool result |
| --- | --- | --- | --- |
| no blocking findings | proceeds, pushed | "Reviewed by GPT-6.1 Sol: no blocking findings (2 minor)" | the same line, the minor findings listed |
| blocking findings | held | the card: findings as file:line (opens the file), summary, failure scenario; chip to the reviewer thread; Merge anyway | "HELD: … Address these before merging, then call merge_branch again" |
| time limit | proceeds; the reviewer is interrupted | "Review by … timed out after 15 min — merged without it" | the same |
| reviewer ended without a report | proceeds | "Review by … failed to run (…) — merged without it" | the same |
| Merge anyway | the branch as it stands now, pushed | "Merged anyway: 1 blocking finding overridden"; the held card settles | none (the thread is idle) |

A head that passed is remembered: a failed push after a pass retries without
a second reviewer. Runs persist as `review:run:<id>` so Merge anyway works
after a restart; a run that was mid-review when the host died is dropped.

Reviewers are ordinary children: they show in the thread's subagent list,
archive with the thread, and reach the Inbox only when their own run
errored. Their settle never wakes the implementation thread
(`orchestration.ts suppressSettleReports`): the verdict already came back
through the tool, and a haiku implementer that received the automatic
subagent report refused to act on it.

## The gate before the fast-forward

After the review (or at once when the set is off) and before the merge,
`merge_branch` gates the branch on the host's one gate queue
(`src/main/server/gateQueue.ts`: FIFO, one run at a time, a waiter hears its
position and the tool's answer says how long it waited). Which step depends
on who calls (`src/shared/gate.ts`):

| Caller | Step | Where |
| --- | --- | --- |
| a batch child (a session with `masterId`) | `bun run typecheck` | the branch's worktree |
| a thread outside any batch | `bun scripts/gate.ts --tier commit --since <merge-base>` | the branch's worktree |

A batch child runs typecheck alone so a break is named to its thread; the
batch's own gate runs the whole commit tier once on the merged tree
(`batch_gate`, CLAUDE.md "Master threads"). A thread outside a batch keeps
the commit tier it used to run itself, now serialized with every other gate
on the host. A branch checked out nowhere is refused: the gate needs its tree.

Every run lands as a `notice` row of kind `gate` (`GateNotice`: step,
branch, ok, the last 40 lines, when) drawn by `GateCard.tsx`: "Typecheck
failed · feature · 2 errors" with the tail folded, no actions; a green run is
the quiet line "Typecheck passed · feature". A red run answers the tool
`HELD: typecheck failed on feature · 2 errors`, the last 20 lines and "call
merge_branch again"; the review's verdict stands (a passed head is not
reviewed twice). Merge anyway past a held review skips the gate: it is the
person's call. `TEMP_CODE_GATE_STUB=<json>` (rules `{ step, branch?, ok,
log? }`) decides a step without spawning anything, for the proofs.

## Proof

`bun run script:e2e-merge-review` (build first): a headless instance with its
own userData, a scratch repo with a bare origin and a feature branch in a
worktree, a project whose set is on with a claude-haiku-5-5 reviewer, and an
implementation thread told to call `merge_branch`. `TEMP_CODE_REVIEW_STUB_FILE`
makes the reviewer report that file's findings: one CONFIRMED finding first
(held, origin unmoved, the card row, the HELD text), Merge anyway over the
RPC (origin moves, the merged-anyway row, a second override refused), then a
new commit with no findings (merged and pushed, the pass line), the bridge's
tool list, and the archive. Unit tests: `src/shared/review.test.ts`,
`src/main/server/mergeBranch.test.ts` (a real scratch repo),
`src/main/server/mergeReview.test.ts` (fake registry and git: the bundle
sent, the three outcomes, the override, the timeout, the settle suppression,
the gate held and green, the commit tier outside a batch, the shared queue),
`src/main/server/gateQueue.test.ts`, `gateRun.test.ts`, `batch.test.ts`
(the three steps, persistence, batch_gate's refusals and answers), the
renderer's `GateCard.dom.test.tsx`; `bun run script:e2e-batch-gate` is the
in-process proof of the batch flow,
`src/main/server/threads-review.test.ts` (the preamble under the setting),
`src/renderer/src/lib/tcserver/fold.test.ts` and `lib/reviewScope.test.ts`.
