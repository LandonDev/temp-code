# tc-computer

TempCode's computer-use service on the Mac: one Swift process per app instance that reads accessibility trees, acts on elements and captures windows, driven by the host over newline JSON-RPC on stdio. `docs/computer-protocol.md` is the contract; this file holds what applies to the package as a whole.

## Targets

| Target | What it is | Builds on |
|---|---|---|
| `ComputerProtocol` | the wire: `Generated/` from `src/shared/computer/protocol.ts`, the framing, `JSONValue`. Foundation only. | Linux and Mac |
| `ComputerServiceKit` | the shell's pure rules: router, outbox, wait rule, Mac-wide locks, app matcher, session book, held ledger, clipboard rule, trace. Foundation only. | Linux and Mac |
| `ComputerCore` | the seams between the modules (`Seams.swift`), `CoordinateMapping`, `PrivateSymbol`. | Linux and Mac |
| `AXText` | the AX reader's rules that need no live element: keep, index, fold, budget, render, diff; the title-bar rule (`TitleBar`: a window's buttons last, the capture's sharing badge dropped, docs/computer-protocol.md §22) the text and the change monitor share; the observation tables generated from `observation.ts`. | Linux and Mac |
| `AXReader` | the walk over `AXUIElement`, handles, windows, `AXManualAccessibility`, the change monitor, `AppReader`, `AXReaders`. | Mac (its files sit under `canImport(ApplicationServices)`) |
| `Input`, `Capture` | the input tiers, the background fallbacks (docs/computer-protocol.md §24) and the clipboard paste; screenshots, the preview stream, the pixel watch. Input's Foundation-only files (the key table, `TierPlan`'s route order, `MenuShortcut`, `MenuSearch`, `HitPlan`, `ScrollPlan`, `PasteFlow` and their neighbours, the list in `scripts/computer-text-test.sh`) build on Linux too, as the scratch target `InputPure`. | Mac |
| `ComputerService` | the shell: handlers, inventory, launcher, workers and app slots, the smart wait, watchers, TCC, lifecycle, `Modules.live()`. | Mac |
| `tc-computer` | `main`: `serve`, `permissions [--prompt]`, `version`, `hold-lock clipboard\|session <ms>`. | Mac |
| `tc-ax`, `capture-proof`, `tc-input-proof` | the modules' live-proof tools; never shipped. | Mac |

Only the `tc-computer` product ships: `scripts/lib/tcComputerBuild.ts` builds `--product tc-computer` into `resources/native/tc-computer`.

Tests: `bun run computer:test` on the Mac (every target). The whole package builds only on the Mac, so on the box the Linux toolchain under `~/toolchains` runs `sh scripts/computer-text-test.sh`: `InputPureTests` (Input's FallbackTests.swift and PersonGuardTests.swift), `ComputerProtocolTests`, `ComputerServiceKitTests` and `AXTextTests` from a scratch package linked back into the checkout, the goldens of `src/main/server/computer/fixtures/apps` included (`TC_AX_GOLDEN=update` rewrites them in place; read each before committing).

## Event taps

The service makes two active `CGEventTap`s at the session tap point, never at the HID point, and both need only the Accessibility grant. The escape tap (`ComputerService/EscapeTap.swift`) is head-inserted and runs only while `escape.watch` is on; the person guard's tap (`Input/PersonTap.swift`) is tail-appended and enabled only while a guard is on (docs/computer-protocol.md §14.9). Head-insert puts a tap before the taps already there and tail-append after them, so the escape tap sees every event first whichever was made first: the person's Escape is taken there, and its timestamp cuts the guard's replay. No unit test makes either tap.

## stdout

stdout carries JSON-RPC frames and nothing else; a stray line breaks the host's reader. No product target calls `print(` or writes `FileHandle.standardOutput`; log text goes to stderr. `scripts/tc-computer-guard.test.ts` holds this.

## Private symbols

A private symbol is allowed in a product target only when it is read-only (it reads state; it never posts input and never changes a window, a Space or an app), it is resolved by name at run time through `PrivateSymbol.lookup` (`ComputerCore/PrivateSymbol.swift`, the one file that calls `dlsym`), it has a public fallback, and a unit test exercises that fallback by forcing the lookup to miss (`PrivateSymbol.forcedMisses`, or `TC_COMPUTER_PRIVATE_MISS=all` for a whole process). `@_silgen_name` and linking a private framework appear nowhere. `scripts/tc-computer-guard.test.ts` holds every rule here: each looked-up name has a row, each row's test exists under `Tests/`. `CaptureTests/PrivateCallScanTests` holds every shipped file but `PrivateSymbol.swift` to no `dlopen` or `dlsym` and every one to no SkyLight, CGS or SLS name; a new row here needs its name allowed there.

| Symbol | Module | Reads | Public fallback | Test |
|---|---|---|---|---|
| `_AXUIElementGetWindow` | AXReader (`Windows.swift`, `WindowIDLookup.live`) | an AX window's CGWindowID, so a base's window key tells two windows apart | `WindowMatch.pick`: the one window of that pid in `CGWindowListCopyWindowInfo` whose bounds equal the AX frame within a point and whose title matches when CG gives one; with neither, the read answers `window_not_found` | `aMissingSymbolFallsBackToTheWindowList` |

### Refused

| Symbol | Asked for by | Why refused |
|---|---|---|
| SkyLight's key-window call (`SLPSSetFrontProcessWithOptions` and kin) | Input tiers | it changes window state; the policy admits read-only calls only |

### Proof only

Executables that never ship are outside the policy, since they are not in the binary: `capture-proof`'s `PrivateSpaces.swift` reads which Space a window is on, to stage the capture proof.
