# Launch: the rail paints from the launch mirror

- The desktop no longer waits for every host's `session.list` before the
  rail is whole. The main process keeps a launch mirror in the app database
  (src/main/server/launchMirror.ts: `launch_mirror_hosts`,
  `launch_mirror_sessions`): per host (`local` and every saved environment)
  the session SUMMARIES the renderer last saw (a SessionMeta minus
  `activity`/`activityKind`), the workspace and project lists, and the list
  cursor. Summaries only, never transcript rows; capped at
  `MIRROR_MAX_SESSIONS` (2,000) per host, newest kept, and archived threads
  older than 30 days leave the mirror (the host still has them).
- Boot (src/renderer/src/main.tsx → lib/tcserver/launchMirror.ts): before
  environment zero and before the first render, `hydrateFromLaunchMirror`
  reads the mirror synchronously through preload (`launch-mirror:read`,
  `ipcRenderer.sendSync`; the /ui page has none), registers the saved hosts
  in the registry so the rail has their sections from the first frame, and
  seeds the session and workspace stores. A key route whose ticket mint
  needs the local link waits for it (`registry.primaryOpen`) instead of
  failing its first attempt into a backoff. Then the sockets open and each
  host reconciles: `session.changes { afterSeq, generation }` (contract.ts;
  capability read) answers the metas that changed and the ids that left
  since the cursor from the server's in-memory change log
  (src/main/server/listChanges.ts: one slot per id, a 5,000-entry window,
  a generation per server run), or `reset`, on which the store lists whole
  as before. A changed row is updated in place, a gone one dropped, an
  untouched one is the same object (nothing re-enters: the rail has no
  enter animation, and reconcile is a high-frequency event). The boot prune
  of the seen map (`stores/subscriptions.ts`) waits `BOOT_SETTLE_MS` (2 s)
  for the lists and then takes the mirror's rows for a host that has not
  answered; its rows show under that host's existing offline tint. A saved
  host with neither a list nor a mirror still holds the prune. The main
  process logs the one synchronous read as `[boot] launch-mirror read <ms>
  hosts=<n> bytes=<b>`, and the renderer measures the hydrate as
  `tc:launch-mirror` (performance marks around it).
- The writer (`installLaunchMirrorWriter`) follows `onMetaChange` and the
  workspace catalog, diffs each LISTED host's rows against what it last
  wrote (object identity), and sends the difference over
  `launch-mirror:write` after a 750 ms quiet period or when the page hides,
  landed in batches of 200 rows on the host;
  the first write per host is `full`. A host still painted from the mirror
  is never written (it would be rewritten from itself). The cursor saved
  with the host is the `session.changes` head the next boot resumes from.
- Seam: `TEMP_CODE_PEER_DELAY_MS=<ms>` (src/main/server/peerDelay.ts) holds
  every request a REMOTE principal makes on that host before handling it;
  local sockets never wait. Proof: `bun run script:e2e-launch-mirror`
  (scripts/e2e-launch-mirror.ts): a headless slow box and a windowed
  desktop under xvfb, paired; a cold start with the host saved and no
  mirror, then one with the mirror after the box renamed, archived, deleted
  and added a thread while the desktop was down. Measured tc:ready → the
  rail's first full paint (`tc:rail-complete`, marked once every host has
  listed or was painted from the mirror), peer delay 3 s, 12 threads:
  before 6,026 ms, after 11 ms (docs/box.md "The launch
  mirror against a slow box").
