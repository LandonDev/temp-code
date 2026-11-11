# Review before merge: an optional second model between the gate and the merge

- Off by default. Settings → Reviews holds the global set; a project's
  settings sheet (its Reviews section) overrides it whole, with "Use global
  setting" to go back. Keys: `review` and `review:project:<id>` in the
  settings table (`src/shared/review.ts` ReviewSettingsSchema: beforeMerge,
  provider + model (default codex gpt-6.1-sol at high; the picker shows only
  models the orchestration rules approve and this machine can run), blockOn
  `confirmed` | `any`, maxMinutes 15). RPCs `review.get` (override, global,
  effective + source), `review.set`, `review.override` (approve).
- The hook is the `merge_branch` app tool (`src/main/server/mergeReview.ts`,
  the git side in `mergeBranch.ts`), on every thread, claude in-process and
  codex over the bridge: it fast-forwards the project branch to the named
  branch in the project checkout (default: the branch the thread's directory
  is on; a thread working in its own worktree passes `branch`) and pushes
  when the repo has an origin. With the set on, it first starts a reviewer
  child (agentType reviewer, parentId = the thread, titled `Review: <branch>
  → <target>`, run in the worktree that has the branch) with the diff against
  the merge-base, the commits, the files and the thread's first message, and
  waits for ONE `report_findings` call (the ReportFindings shape: file, line,
  summary, failure_scenario, verdict) or the time limit. Why a tool and not
  an intercepted `git merge`: the harnesses own the model's shell, a git shim
  would miss `git -C`, aliases, scripts and hand-typed pushes, and a held
  merge has to be READ by the model as the next thing in its turn. The
  implementation preamble and the turn pass tell a reviewed project's
  threads to merge only through the tool. `TEMP_CODE_REVIEW_STUB_FILE` makes
  the reviewer report that file's findings (the proof).
- Outcomes land as `notice` rows (kind `review`, payload ReviewNotice) that
  the transcript renders as ReviewCard.tsx: pass → merged, "Reviewed by
  GPT-6.1 Sol: no blocking findings (2 minor)"; blocking findings → the
  merge is held, the card lists file:line, summary and failure scenario with
  a chip to the reviewer thread and "Merge anyway" (`review.override`, which
  merges the branch as it stands now and rows "Merged anyway"), and the tool
  answers "HELD … Address these before merging, then call merge_branch
  again"; timeout → the reviewer is interrupted and the merge proceeds with a
  row saying so; a reviewer that ends without reporting → "failed to run",
  merged. A head that passed is not reviewed twice (a failed push retries
  without a new reviewer). Runs persist as `review:run:<id>` so Merge anyway
  survives a restart. A reviewer's settle never wakes the implementation
  thread (orchestration.ts `suppressSettleReports`): the verdict already came
  back through the tool. Reviewers are ordinary children: in the subagent
  list, archived with the thread, in the Inbox only when their own run
  errored. Proof: `bun run script:e2e-merge-review` (headless instance, a
  scratch repo with a bare origin, two real haiku threads, the stub file
  for one blocking finding then none; build first).
  The gate before the fast-forward (typecheck alone for a batch child, the
  commit tier for a thread outside a batch, both on the host's `GateQueue`)
  is "Master threads" below: the review decides whether the branch may
  merge, the gate whether the tree is green, and a head that passed review
  is not reviewed again when its gate held it.
