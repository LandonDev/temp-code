# tc-computer

TempCode's computer-use service on the Mac. docs/computer-protocol.md is the
contract: the wire, the observation, the input tiers, the smart wait, capture.
Each Swift thread fills its own target (§11 there).

| Target | What | Builds on |
|---|---|---|
| `ComputerProtocol` | the wire types, generated from `src/shared/computer/protocol.ts`, and the framing | Linux and Mac |
| `ComputerCore` | the seams the Service shell joins | Linux and Mac |
| `AXText` | the AX reader's rules that need no live element: keep, index, fold, budget, render, diff; the observation tables generated from `observation.ts` | Linux and Mac |
| `AXReader` | the walk over `AXUIElement`, handles, windows, `AXManualAccessibility`, the change monitor, `AppReader` | Mac (its files sit under `canImport(ApplicationServices)`) |
| `Input`, `Capture`, `ComputerService`, `tc-computer` | the other threads' targets | Mac |
| `tc-ax` | the AX reader's dev tool for the live proof and the timings; never shipped | Mac |

Tests: `bun run computer:test` on the Mac (every target); on the box the Linux
toolchain under `~/toolchains` runs `swift test` for `ComputerProtocolTests`
and `AXTextTests`, the goldens of `src/main/server/computer/fixtures/apps`
included (`TC_AX_GOLDEN=update` rewrites them; read each before committing).

## Private symbols

One class of private symbol is allowed in tc-computer (the person's ruling,
2026-11-08): read-only calls, resolved by name at run time, each with a public
fallback that a unit test forces. Nothing private that posts input or changes
window state.

| Symbol | Where | Why | Fallback |
|---|---|---|---|
| `_AXUIElementGetWindow` | `Sources/AXReader/Windows.swift` (`WindowIDLookup.live`, `dlsym` by name) | an AX window's CGWindowID, so a base's window key tells two windows apart | `WindowMatch.pick`: the one window of that pid in `CGWindowListCopyWindowInfo` whose bounds equal the AX frame within a point and whose title matches when CG gives one; with neither, the read answers `window_not_found` |
