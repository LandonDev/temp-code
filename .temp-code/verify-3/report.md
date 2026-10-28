# V3: text hierarchy and deslop, the final review pass

Date: 2026-10-28 (box time). Tree: master 3a49d259 to c545b1a3. Twenty-one commits, each a small slice landed through merge_branch (typecheck in its queue), 118 file changes, +602 −296 lines.

How it was judged. First a sweep of every string the renderer can show: the TypeScript parser over src/renderer/src (about 17,000 literals, with the JSX attribute or object key each sits under), filtered for middle dots, pipes, bullets, Title Case, slop words, exclamation marks, hedges, trailing stops and list markup, then read surface by surface. Then three GPT 6.1 Sol reviewers on the Mac, each on its own preview instance of e18698ff driven over CDP, in dark and light at about 1440 and 1000px: V3-A (first run, rail, tabs, title bar, thread header, transcript, strip, composer; 16 findings), V3-B (every Settings page, Hosts, Accounts, Stats, the project dialogs, the pairing page, the native menu's source; 134 findings, most of them two kinds declined below), V3-C (right panel, dock, files and diffs, master board, thread views, Inbox, Search, overlays, and the two checks the user added; 14 findings). Their findings, 911 screenshots and a text dump beside each are on the box under .temp-code/verify-3/mac/{a,b,c}/ (not committed: 247 MB). The standard: docs/DESIGN.md, which wins, the components README and docs/LAYOUT.md, read with the impeccable skill's clarify, distill, critique and craft-floor references, emil-design-eng and better-ui.

What the sweep found. Little of the familiar slop was left after V1 and V2: no "seamlessly", "powerful", "simply" or exclamation marks, and the status lines' middle dots were fix H's (its slice 6 landed during this pass). What remained was quieter: one fact said twice in two forms, helper lines that restate their control, one concept under two names, words that claim what did not happen, and secondary words taking the lead's room.

## What changed, by surface

### Rail, title bar and menus

| Before | After | Why |
| --- | --- | --- |
| At the default 200px rail, a workspace row read "a…  Needs you" | Under 15rem the row's state word goes and its glyph stays ("alpha ⦿"); the word returns on a wider rail, and the button's name and the line under the row still say it | The name is the row's lead; DESIGN gives tight rows the glyph alone (b5c1c567) |
| Rail toggle tooltip "Toggle Projects" (rail closed) and "Toggle workspaces" (open) | "Workspaces" in both | One name, named by what it shows, as Panel and Sidebar are |
| Title bar tooltips "Go to File", "New Thread"; pickers "Go to File", "Go to Symbol" | "Go to file", "New thread", "Go to symbol" | In-app rows and tooltips are sentence case; the native menu bar keeps macOS Title Case (1ec9b1fb) |
| File tree and transcript path menus: New File, New Folder, Copy Path, Copy Relative Path, Copy File Name, Open Containing Folder, Open in Terminal | Sentence case throughout | Same rule |
| Thread menu "Not a master" | "Remove as master" | A menu row is a verb, beside "Make master thread" (4545fb43) |
| Usage meter popover "Cursor models" beside "other models" | "Other models" | Cursor's report sends it lower case; windowName now capitalises every label |

### Transcript, strip and composer

| Before | After | Why |
| --- | --- | --- |
| Strip, tab hover and title chip: "Needs you  approve Creating empty file approval-preview.txt in workspace" | "Needs you  approve Bash" | DESIGN's own example; the card right below says the rest, and the toast keeps the long words where no card shows (2be17491) |
| A denied call's row: "Created empty file approval-preview.txt in workspace" over "Denied, timed out" | "Create empty file …" over "Denied automatically" | It never ran; the automatic denial was a Stop as often as a timeout, and the event does not say which (c87c27db) |
| Group lines: "Created notes.txt", "Ran 2 commands" for denied calls | Only what ran; a run refused whole reads as what it asked ("Create notes.txt") | Sol's round-1 blocker; refusals were already the line's red figure (c545b1a3) |
| A queued thread: its brief, then "Worked for 1s" | No closing line until the turn runs; no thinking tail; the agent detail's live row says Queued | The turn never started; the strip says Queued (3f1d292b, c545b1a3) |
| Composer permission picker: Supervised, Auto-accept edits, Auto ("An AI reviewer approves routine actions"), Full access | Supervised, Auto-accept edits, Full access; a thread stored as Auto reads Auto-accept edits | The host has no reviewed tier: Auto was the edits policy and read back as Auto-accept edits (07d43579) |
| Quit dialog: "2 chats are still running. Quit anyway? They will resume when you reopen MonoCode." | "2 threads are still running. Quit anyway? They resume when you reopen TempCode." | The app's old name and old noun; the interrupt note and the OpenCode error too (9ed6a4ca) |
| Crash card: "The Claude Code process died mid-turn" over "Its stream ended before the turn finished; the conversation can pick up from its last message." | "… The conversation can pick up from its last message." | The cause repeated the heading before the useful part (46f2bcdc) |
| Strip and board: "Failed  The turn failed" | "Failed" | The generic summary only says the word again; the card keeps it (80084184) |

### Board and thread views

| Before | After | Why |
| --- | --- | --- |
| Narrow board (chat open at 1000px): a batch row showed "Haiku 5.5 medium" and no title at all | The model gives its width up first and clips; the title is cut only once the model is gone | The title is the row's lead (9c52f831) |
| Rules dialog closed on "Branches land as they finish, then Gate and Release. Then you are notified." | Gone | It read the form above it back; rulesSentence went with it (80084184) |
| Rules dialog step: "Release" in the name field and "Release" beside it | The kind's words show only when the name does not already say them | Said once |
| Archive confirms: "They leave the board and stay in the archive list. The master stays." and a three-sentence one for Archive all | "The master stays." / "Running threads stop first; the master stays." | A confirm is one title, one line (872c4325) |

### Dialogs

| Before | After | Why |
| --- | --- | --- |
| Delete thread: "The thread and its whole transcript are gone for good. Archive keeps it instead." | "Its transcript is gone for good." | One line, as Archive's Delete already said |
| Move thread: two sentences above a note that already says what travels; "3 uncommitted files will be carried" | "Its subagents and pages move with it; undo history stays on This Mac."; "3 uncommitted files travel too" | One line; one verb with "Branch … travels too" |
| Settings' Add host opened a dialog titled "Add environment" | "Add host" | One noun |
| Sign-in: "Finish in the window that opened." over a spinner and "Waiting for sign-in", and the instruction stayed beside a failure | The spinner beside one line, "Finish in the window that opened", which leaves when an error replaces it (078348f7) | One wait, said once |
| Preamble field placeholder "The rules every new thread in this project starts with." | No placeholder | The dialog's description says it directly above (d58afcf5) |
| File tree name check: "A file or folder X already exists at this location. Please choose a different name." and four like it | "X already exists here", "Type a name", "A name can't start with a slash", "X can't be a file or folder name", "The name starts or ends with a space" | What is wrong, in one line (1ec9b1fb) |
| Dev server Run on a thread that has one: "This thread already runs a dev server. Replace it, or start another for a different feature?" over Replace and Start another | "This thread already runs a dev server." | The question restated its two buttons |

### Settings, Hosts, Accounts and Stats

| Before | After | Why |
| --- | --- | --- |
| Thread defaults: "Security: Ask first, Auto-edits, Full access", "Every tool call asks before running." | "Permission mode", with the composer picker's names and hints | One name per policy; the old hint was wrong for Supervised (07d43579) |
| A workspace page: "Using the global defaults; any change creates a workspace override." / "Following the global rules. A change makes an override." | "Follows the global defaults." / "Overrides the global defaults." (and the same for the rules) | The Remove override button already shows the mechanism (c164dee5) |
| Hosts → Devices heading: every connected phone by name, squeezing "Devices" to "Devi…" at 1440px | The Xcode in use (and the load where no Load limit row shows it) | Every device and its state is a row below (72887253) |
| "Shutdown" (a booted simulator's button and a stopped one's state); a phone's raw "samemachine" transport | "Shut down"; only USB and Wi-Fi are named | A verb, and no internal enum |
| Hosts → Release row "Publish" with a "Publish Mac release…" button | Row "Mac release", button "Publish…" | Labels are nouns, buttons are verbs, and the verb once |
| Accounts and the account picker: "Refills Wed 3:20 AM, in 4h 19m"; cells "in 4h 19m  3:20 AM" under a tooltip naming the time again | "Refills in 4h 19m" (the countdown, as the rail's meter says it); the cell's tooltip keeps the moment | One time, one form (471d2a08) |
| Stats Model mix: "fable-5-1", "opus-5-5" | "Claude Fable 5.1", "Claude Opus 5.5" | The names the rest of the app uses (b183be80) |
| Stats "When you burn limit" | "Busiest hours" | Plain words; and the Stats page test, red on master since fix D named the pace section Pace, reads Pace |
| Helper lines under Sounds, Result checks, Parallel agents and the Linear row (also in its Connect… dialog); "Applies to subagents." under a Subagent models heading | Gone; the global page's "Models" heading is "Subagent models" too | Each restated its control or heading (d58afcf5) |
| Project sheet's Plans section loaded as one 64px block | Five row skeletons, the rows it becomes | A load is shaped like what comes |

### Files, Inbox and docs

| Before | After | Why |
| --- | --- | --- |
| File tree icon dropped 1.16px when the icon pack landed (the empty box lacked the glyph's align-middle) | The box carries the glyph's classes from the first frame | The user's check; Changes and the editor tab did not move (08742c78) |
| Inbox PR diff: "Diff is too large to display in full. File list is shown without patches." | "Too large to show in full; the files appear without their diffs." | One line, active (7a25d3e7) |
| CLAUDE.md quoted "Project rules · 212 words" | "Project rules  212 words", as the row draws it | Docs say what is true; CLAUDE.md, docs/LAYOUT.md, docs/box.md and docs/master-threads.md follow every renamed label |

## The user's two checks

File icons (V3-C, Mac, 1440, both themes): the tree and Changes draw 16px icons, the editor tab 14px (dense chrome, DESIGN's 14px); each sits on its row's line within 0.16px; no icon shows a tooltip after an 800ms hover and no native title is left. The one shift found, the tree's 1.16px drop on a cold load, is fixed (08742c78). The dev servers console that reopens when a server's command arrives: one mount, 183px high at opacity 1, no close and reopen, in both themes (rAF samples at 50ms over 4s and 20 screenshots at 100ms).

## What was left, and why

| Finding | Why left | Next |
| --- | --- | --- |
| A batch thread idle over live subagents sits in the board's Done section while its row says Watching (V3-C F02) | Moving it to Working, as I first did, left Archive done archiving it and stopping its subagents (Sol round 1); the section must follow the host's done rule | The host's `BatchState.done` (batch.ts) should leave out a thread whose subagents still work; then the board can file it with the work |
| A queued thread's brief shows as its bubble and again as the queue's first row (V3-A F05) | By host design the held row lands and the message waits at the queue's front; hiding one needs to know they are the same message | A marker on the queue item (held: its row has landed) for the composer to skip it |
| Stop words: "The turn ended before it finished / The harness gave no reason." after a Stop, and "Worked for 3s" after Pause then Stop (V3-A F01, F02) | Fix H's slice 2 (a person's Stop is always a stop) landed after the verified build | Recheck on the next build |
| The gate's detail "the batch's gate FAILED at the gate in 0s; nothing was tagged" and the batch line's middle dot (V3-A F10, V3-C F03, F10, F11) | Host words; fix H's slices 4 and 6 rewrote them during this pass | Recheck on the next build |
| Bullets in the project plan's Goals, Risks and Open questions (V3-C F04) | The plan file is the model's own markdown, DESIGN's one exception | None |
| Full stops at the end of settings descriptions and page lines (about 40 of V3-B's lines) | They are full sentences used the same way on every page; DESIGN bans stops only on status details and empty lines | None, unless DESIGN changes |
| Title Case in the native menu bar and the keybinding names that mirror it (41 of V3-B's lines) | macOS menu convention; the in-app rows and tooltips are sentence case | None |
| "Archive 2" on a confirm titled "Archive 2 done threads?" (V3-C F13) | Naming the action and its object on the button is the clarify rule for destructive confirms, and the fleet's confirms do the same | None |
| Inbox empty lines ("Open issues from your Linear teams show here.") (V3-C F12) | They say the list's scope (open items, your teams), which the title does not | None |
| "How can I help you today?" in an empty thread's composer | Claude desktop's own line, the stated reference for the transcript | None |
| The approval toast sat over the board's foot in a master at 1000px (seen in V3-A's shots) | Placement, not copy: the toast measures from the chat's footer, which in a master is the right column | A layout pass on toastInset for split views |

## Sol loop

One reviewer, GPT 6.1 Sol (reviewer, high effort), over all twenty V3 commits with a usability focus. Round 1: CHANGES. S1 blocker, group lines still worded refused calls as done: fixed. S2 should, my board regrouping moved a thread to Working that Archive done still archived: fixed by reverting the regrouping rather than changing the host's done rule. S3 nit, a queued turn made the agent detail's live row read Working: fixed. Round 2: APPROVE, all three resolved, no new findings. One fix commit, c545b1a3, +53 −19 over six files. Usage was not exposed.

## Commits

1ec9b1fb, 9ed6a4ca, 07d43579, 872c4325, c164dee5, 078348f7, b5c1c567, 4545fb43, 9c52f831, 2be17491, c87c27db, 72887253, b183be80, 471d2a08, d58afcf5, 08742c78, 80084184, 46f2bcdc, 3f1d292b, 7a25d3e7, c545b1a3.

Left for a later pass: the two host-side items above (the board's done rule for a watching thread, the held queue item), a recheck of the stop and gate words on a build with fix H, and the approval toast's place in a split view.

## Recheck on fix H's build

Fix H landed on master at 27b85814. V3-R, one GPT 6.1 Sol subagent on the Mac, built that commit in ~/IdeaProjects/temp-code-verify (a profile build) and drove a preview instance over CDP (userData temp-code-verify, port 9231). It shot the master "M1 project check" at 1000×800 in dark and light, with the chat open and folded. The 26 shots, their text and the toast's rects are in .temp-code/verify-3/mac/recheck.tgz, with V3-R's findings.md.

| What | On 27b85814 | Now |
| --- | --- | --- |
| Stop while a question waits (V3-A F02) | "Asked a question", "Dismissed", then the closing line "Stopped"; no failure card | Right: fix H's slice 2 |
| Pause, then Stop, on a batch child (V3-A F01) | The closing line "Worked for 18s"; the board said "ended its turn without completing" | 1b37ad91: the Stop writes the stopped row the pause dropped, so the turn closes "Stopped" and the board says "was stopped" |
| The Gate row when the gate script is missing (V3-A F10, V3-C F10) | "Gate  gate: error: Module not found "scripts/gate.ts"", and the same error as the console's only line | 3245a6ab: "Gate  error: Module not found "scripts/gate.ts"", with no console and no Show |
| The Gate row when a test fails | "vitest: FAIL src/total.test.ts > rounds the total" | 3245a6ab: "vitest: src/total.test.ts > rounds the total" |
| A settled step's time (V3-C F11) | "Gate  passed in 0s  0s" | 3245a6ab: the time column alone; a publish reads "v1.0.N published", a failed shell step "exit 1, …" |
| The gate notice in the chat | "Gate failed  master  at vitest"; the missing script ends on its error line | Right as it stands |
| The batch's done line (V3-C F03) | "Batch done  nothing landed, gate passed in 0s" | Right: commas, no middle dot (fix H's slice 6) |
| A child watching its subagents (V3-C F02) | Fix H's slice 12 took it out of the host's done list, but the board still filed it under Done | 44901c74: under Working, saying Watching; back under Done once they settle |
| A queued thread's brief shown twice (V3-A F05) | Fixed by fix H's slice 13 (846f6ee1) | Not shot this round |
| The approval toast's seat | The table below | Right: 2dd2ea96 |

The toast's seat, the same in both themes, in CSS pixels (window 1000×800, chat column 369 wide):

| Chat | Width | Sides | Bottom |
| --- | --- | --- | --- |
| Open | 337 | 16 inside the chat column each side | 8 above the composer |
| Folded | 340 | 16 inside the board's right edge | 8 above the board's foot |
| Open again | 337 | 16 inside the chat column each side | 8 above the composer |

Left as docs/LAYOUT.md specifies them:
- A blocked child's reason shows on its row, in red over the foot's steps, and in the master's strip.
- The gate notice's log opens on demand beside the foot's console.
- The "Batch done" row is the transcript's record of the end, beside the foot's live rows.

V3-R killed the one instance it started (pid 33354). A second look found nothing listening on 9231 to 9233 and no preview process left. In the scratch repo it removed its fake gate in a commit of its own, and it put the master's steps back as they were.

Recheck commits: 2dd2ea96, 1b37ad91, 3245a6ab, 44901c74.
