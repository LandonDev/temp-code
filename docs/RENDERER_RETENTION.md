# Renderer retention

These bounds apply to renderer caches and logs. They leave the normal
interface and persisted event history as they are.

| Owner | Bound and removal rule | Unit tests |
| --- | --- | --- |
| `lib/tcserver/store.ts` history head | Keep every persisted row. Replace each tool call's ephemeral partial input in its first replay slot, so interleaved calls keep their order. Release the buffer when the head settles, resets or unloads. | `lib/tcserver/store.test.ts`: 200 previews, persisted rows, and the same full fold for open and completed calls |
| `chrome/lightboxStore.ts` | A 64 MiB LRU, counting two bytes per data URL character. Hits refresh recency; null, failed and oversized results stay out of the cache. Concurrent reads of one attachment share a request. | `chrome/lightboxStore.test.ts`: eviction, retry, shared reads and oversized images |
| `lib/hostJobs.ts` | Keep the last `HOST_LOG_CAP` code units (512 × 1024, the host's existing string-length cap) plus one `Earlier log output was removed.` line. Bound snapshots and appends; reset removes the line. The constant lives in `src/shared/contract-host.ts`. | `lib/hostJobs.test.ts`: tail, one marker, reset, snapshot and oversized append |
| `lib/devServers.ts` | Remove logs when a replacement or refresh removes their run, or when their host leaves. A host refresh still keeps finished run rows for their logs until a replacement removes them. Stop subscriptions on host removal and ignore late host refreshes and log reads. | `lib/devServers.test.ts`: replacement, host and target refresh, removal and late replies |
| `lib/threadResources.ts`, `lib/macBridgeRules.ts` | Use `registry.onLink`'s existing-link replay once, without a second loop over those links. | Each owner's test: two open links each attach once; resource reads happen once per link |
| `lib/perfMarks.ts` | Keep at most 200 `tc:` marks. Count names as marks arrive; on overflow clear all occurrences of the oldest name, as required by `performance.clearMarks(name)`. No per-mark timeline scan. Other marks stay; listeners hear every call. | `lib/perfMarks.test.ts`: 1,000 distinct and repeated marks, listener delivery and no scans |

Paths in the table are under `src/renderer/src/` unless stated otherwise.
These are local bounds, not a total renderer memory budget. Persisted rows
and finished dev-run rows still follow their owners' history rules. The
image budget excludes decoded images held by mounted elements and reads
that have yet to settle.
