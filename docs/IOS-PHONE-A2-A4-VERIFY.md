# Phone A2 and A4 Mac checks

The Mac pass uses `~/tc-phone-pass` and its
`.claude/worktrees/mac-verify-phone-slices-a2-and-a4` worktree. It uses
`/Applications/Xcode.app/Contents/Developer`, with derived data in
`/tmp/tc-phone-dd`. It does not use the installed desktop app or the user's
checkout.

## Checks on 2026-11-05

- `bun run ios:test:client`: 1,006 tests in 191 suites pass. This includes
  TranscriptScenarioTests, ThreadFoldKeyTests, TranscriptRowKeyTests,
  FollowRuleTests, the pacer simulations and word cuts in SmoothTextTests,
  SmoothTextRevealTests, and FocusSignalTests.
- `xcodegen generate --spec ios/TempCode/project.yml`, followed by
  `xcodebuild -project ios/TempCode/TempCode.xcodeproj -scheme TempCode
  -destination 'generic/platform=iOS Simulator' -derivedDataPath
  /tmp/tc-phone-dd build`: succeeds, including the SwiftUI app.
- `bun run typecheck`: passes, including the generated Swift contract check.
- `NODE_ENV=test bun x vitest run scripts/ios-literal-guard.test.ts
  scripts/ios-motion-parity.test.ts scripts/gen-swift-contract.test.ts`:
  all 23 tests pass.
- `NODE_ENV=test bun x vitest run
  src/renderer/src/surfaces/smoothText.test.ts`: all 41 tests pass.

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
