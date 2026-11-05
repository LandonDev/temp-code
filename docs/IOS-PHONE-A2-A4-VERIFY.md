# Phone A2 and A4 Mac checks

The Mac pass uses `~/tc-phone-pass` and its
`.claude/worktrees/mac-verify-phone-slices-a2-and-a4` worktree. It uses
`/Applications/Xcode.app/Contents/Developer`, with derived data in
`/tmp/tc-phone-dd`. It does not use the installed desktop app or the user's
checkout. The final live-test and simulator runs set
`TEMP_CODE_WARM_HARNESS=0`: the fixture server stubs actions and does not
need real warm harnesses.

## Checks on 2026-11-05

- `bun run ios:test:client`: 1,011 tests in 192 suites pass. This includes
  TranscriptScenarioTests, ThreadFoldKeyTests, TranscriptRowKeyTests,
  FollowRuleTests, the pacer simulations and word cuts in SmoothTextTests,
  SmoothTextRevealTests, FocusSignalTests, and five BornRowsTests.
- `xcodegen generate --spec ios/TempCode/project.yml`, followed by
  `xcodebuild -project ios/TempCode/TempCode.xcodeproj -scheme TempCode
  -destination 'generic/platform=iOS Simulator' -derivedDataPath
  /tmp/tc-phone-dd build`: succeeds, including the SwiftUI app.
- `bun run typecheck`: passes, including the generated Swift contract check.
- `NODE_ENV=test bun x vitest run scripts/ios-literal-guard.test.ts
  scripts/ios-motion-parity.test.ts scripts/gen-swift-contract.test.ts`:
  all 23 tests pass.
- `NODE_ENV=test bun x vitest run
  src/renderer/src/surfaces/smoothText.test.ts`: all 45 tests pass after the rebase onto `origin/master` (41 before it).

## Fixes

The scenario fixtures wrap tool input strings in `JSONValue.string`.
The DEBUG transcript report reads `TranscriptRowID.key`; the old `seq`
field no longer exists on that type. The pending-turn test sends through
`addPending`, as the client does, so the two rows get distinct keys.

The reveal test clock runs an already-due wake before sampling at 10 ms
intervals. Before the fix it recorded the immediate wake 10 ms late, so a
100 ms step read as 90 ms against the unchanged 99.999 ms lower bound.
The desktop's `smoothText.ts` and `test/revealSim.ts` both schedule steps
from the prior paint time. The six Swift stream simulations pass with
the desktop's thresholds. The pacer, word cut and thresholds stay as they
were.

The live proof caught a second issue: claiming a born-live row during
view preparation let SwiftUI consume its first reveal before the row
appeared. The first capture started at 10 units and retreated to 4.
`BornRows` now lives in the client package. Preparation reads eligibility;
appearance claims the row, so later mounts still show it whole. Five
unit tests cover repeated preparation, history, a provisional key keeping
its claim after the final seq arrives, and waiting for a loaded thread.
The last check also prevents the screen's empty placeholder from setting
an opening seq of zero and treating loaded history as live text. An
empty thread opens at zero once its subscription has loaded.

## Streaming proof

There is no `chat` set. The first `features` pass captured the streaming
chat but later failed at its second-host pairing. It also exposed the
born-row faults above. The focused recheck uses the existing `box` set
with `TC_TEST_THREADS='Streaming on the phone'`, a 20 s settle,
`TC_PROOF_DIR=/tmp/tc-phone-a4/final`, and the same derived-data directory.
Its dedicated iPhone 17 Pro simulator runs iOS 27.0.

A local copy of the runner records only the control URL, so a second
process can call `POST /stream` with `cps: 300, seconds: 4, seed: 1` while
the thread stays open. No pairing link or key goes into the files.
The video, five live screenshots, and layout events are in `final/`.
`stream-analysis.json` checks all 43 recorded changes against the
1,200-character fixture: each ends at a word boundary and none retreats.
The first recorded step is 35 units. The event log's integer timestamps
span 99–316 ms between changes, with a 104 ms median; the hand-clock unit
test keeps its exact 99.999 ms lower bound. The opening seq is 6, history
shows whole, and the transcript stays at its bottom. The 13 s screenshot
shows the full reply and “Worked for 9s”. The proof runner exits zero.

The bundle is `box:/srv/agents/work/temp-code/.temp-code/phone-pass/mac/tc-phone-a4.tgz`.
The earlier captures remain at its root and in `recheck/`; `final/` is
the pass after all fixes. The checks' logs are under `checks/`.
