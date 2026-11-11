# The iOS contract package is generated

- `ios/TempCodeContract` holds the Swift `Codable` types of the remote wire,
  generated from zod by `scripts/gen-swift-contract.ts` (`bun run gen:swift`).
  `src/shared/wireSchemas.ts` is the zod for every server → client shape,
  pinned to its interface by type-level checks that the typecheck runs; the
  generator's `SUBSET` array is the one list of what the phone speaks.
- Never edit `Sources/TempCodeContract/Generated/`. Change the contract,
  run `bun run gen:swift`, commit the output: `bun run check:swift-contract`
  (inside `bun run typecheck`) fails the gate when it is stale, and
  `bun run ios:test` (in the gate too) builds and tests the package.
  Fixtures under `Tests/Fixtures` come from a real server through
  `bun run script:capture-swift-fixtures`; re-record them when a captured
  shape changes (on the box, where the esbuild → node path fails:
  `bun --preload ./scripts/lib/electron-stub.ts scripts/capture-swift-fixtures.ts`).
  The capture reads a scratch deploy directory, never the machine's own log.
  The package README has the subset policy and what L2
  (the socket actor) builds on it. The subset covers the master, notes,
  project-plan, review, plans, resources, devices, deploy, Mac bridge and
  accounts methods and their pushes (`notes`, `batch`, `resources`,
  `boot-resume`, `accounts`, `host.devices`, `host-log`, `macBridge.held`);
  the README's table is the list, with the capability each needs. The
  generator refuses a `local` method (`jsonSchemas` throws), names
  `BuildFacts` and `NoticeKind` once, and `scripts/gen-swift-contract.test.ts`
  pins its rules; `DecoderRulesTests.swift` proves the decoder on
  hand-written JSON, so it passes before the fixtures are re-recorded.
