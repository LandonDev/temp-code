# Zeron look — exact port spec

Source: github.com/zeronsh/comet @ v0.2.1 (MIT), extracted 2026-08-14 from
`crates/ui/src/{theme,motion,transcript,composer,markdown}`. Zeron's gpui UI is
itself a Rust re-implementation of their original Electron app's CSS — every
value below is quoted from their code and maps 1:1 back to Tailwind/CSS.
Screenshot reference: their `docs/screenshot.png`.

## Surfaces (dark — their primary appearance)

| token | value | notes |
|---|---|---|
| bg (main panel) | `#060606` | deepest plane; chat sits on this |
| surface (shell/sidebar) | `#0d0d0d` | one step UP from bg |
| surface_card | `#0e0e0e` | inline cards |
| surface_dialog | `#101010` | modals |
| surface_overlay | `#161616` | popovers/menus — highest plane |
| element_hover | `hsl(0 0% 92% / 0.11)` | soft-white wash, never pure white |
| element_active | `hsl(0 0% 92% / 0.16)` | |
| border | `white/8%` | hairline everywhere |
| border_strong | `white/14%` | focused/raised edges |
| input_bg (composer pill) | `white/3%` | |
| user bubble | `white/8%` wash | translucent, NOT opaque |
| selected (tabs/rows) | `white 92% / 11%` wash + inset ring `white/9%` 1px | hover and selected share the fill; the ring is the difference |
| scrim | `black/60%` | modals |
| band (picker header/footer) | `black/16%` | recessed strip |

Elevation is lightness (#06 → #0d → #0e → #10 → #16), steps small and
deliberate. Hover on opaque pills brightens the plate (`neutral 0.235 → 0.29`),
never swaps to a translucent wash.

## Text

| token | value | contrast |
|---|---|---|
| text | Tailwind neutral-200 (`oklch(0.922 0 0)`) | ~16:1 |
| text_muted | neutral-400 (`oklch(0.708 0 0)`) | ~7.5:1 |
| text_faint | neutral-500 (`oklch(0.556 0 0)`) | placeholders/disabled |
| text_dim | `#989898` | file-path tone |

Fonts: **Geist** / **Geist Mono** (bundled). Body 14px / line-height 22px
(their `MD_LINE_HEIGHT`); code 18px line-height; composer input 14px / 22.75.

## Accents (Tailwind steps, verbatim)

accent indigo-400 `oklch(0.673 0.182 276.935)` (strong: indigo-500) · danger
red-400 · warning amber-400 · success emerald-400 · **busy/streaming pink-400**
`oklch(0.718 0.202 349.761)` · inline code violet-300 on violet-400/12 wash ·
caret its own blue (not accent). Syntax palette = the same 5 hues (indigo, pink,
emerald, amber, red) **at 72% saturation**: keyword/function indigo,
string/constant emerald, number/type/property amber, tag/macro/special pink,
variables/operators/punctuation plain text tone.

## Glass

macOS: real window vibrancy (Electron: `vibrancy: 'under-window'` + transparent
bg) with a `#080808/80%` tint over it for the shell. Popovers/menus: backdrop
blur + `oklch(0.33 0 0)/34%` tint — mid-grey translucent so the backdrop hue
reads through; NOT an opaque slab. Original web recipe was
`blur(44px) saturate(1.8) brightness(1.18)`. Content panel stays opaque #060606.

## Radii & chrome numbers (px)

bubble 16 · panel/card 10 · control (buttons/chips) 6 · titlebar 38 (content
sits 2 lower) · in-card header 44 · status strip above composer 24 (reserved
always — composer never shifts when the working row appears) · spacing steps
4/8/12/16.

## Chat anatomy

- Content column **max 736px** centered. Turn gap 14, block gap 8.
- **User**: right-aligned bubble, white/8% wash, radius 16, max-w 80% of
  column. Attachment thumbs 112×80 above the text.
- **Assistant**: bare markdown on the panel — no bubble, full column.
- **Tools**: one collapsed summary row per burst — see "Tool calls (exact)"
  below.
- **Composer**: pill radius ~16, white/3% fill, hairline border. Placeholder
  "Do anything…". Textarea auto-grows 76→260 (pad-v 20), actions row 46
  (model picker left; attach + round solid send button right — near-white
  circle, dark arrow). Compact single-line mode 49 total. Below the pill: a
  quiet meta row (checkout · branch).
- **Bottom fade**: transcript melts into the panel over a 24px gradient band;
  last row pads past it. "Scroll to bottom" pill (raised surface, radius full)
  appears when > 320px from bottom.
- **Left rail**: block-tick minimap strip, current block highlighted.

## Tool calls (exact — from transcript.rs + proto/view.rs)

Consecutive tool parts fold into ONE group row. While the reply is streaming
and the group is the last part it renders auto-open; once the turn settles it
collapses to the summary line (a user toggle overrides either way).

**Group header** — h 26, px 4, gap 8, 12px text in `text_muted`, whole row
hover → full `text` color, pointer cursor:
- 18px chevron tile: rounded 5, bg `white/6%`, glyph ▸ / ▾ at 10px in
  `text_muted/70%`.
- Summary sentence, truncating. Built from counts joined by `" · "`, only the
  first letter capitalized: `ran N command(s)` · `edited N file(s)` (deduped
  by path; Write+Edit+Patch) · `read N file(s)` · `searched N time(s)`
  (Search+Glob+WebSearch) · `fetched N page(s)` · `updated todos` ·
  `called N tool(s)` (MCP/unknown) · `N failed` last. Fallback "N tools".
  The header stays NEUTRAL when children failed (failed probes are routine;
  a red header read as "the whole step broke") — errors show on the chips
  and in the "· N failed" count only.

**Expanded body** — a 1px vertical guide rail (`white/8%`) at left margin 12,
centered under the chevron tile, stretching the full body height (through
open details). Chip rows: 38px row height, 0 gap, 2px top pad. Each chip is
a card 12px right of the rail: **h 30, rounded 9, border `white/7%`, bg
`white/3%`**.

**Chip row** (inside the card) — px 8, gap 8, 12px text:
- 18px icon tile, rounded 5, bg `white/8%`, 12px icon in `text_muted`.
  Icon set is **Solar** (line style): Exec→Command, Read/Patch→Document,
  Write→Document Add, Edit→Pen, Search→Magnifer, Glob→Folder With Files,
  WebFetch/WebSearch→Global, Todo→Checklist, MCP/unknown→Widget.
- Medium-weight verb label: Run / Read / Write / Edit / Patch / Search /
  Glob / Fetch / Web / Todo / MCP / Tool. Error → label tints red-400.
- One-line detail in `text/85%` (error → red-400), truncating: the command,
  the path, `pattern in path`, the URL, `2/5 done` (todos),
  `server · tool` (MCP). Newlines collapsed to spaces.
- If expandable (all chips are — the invocation block always exists): a
  trailing 18px chevron tile (bg `white/6%`, ▸ / ▾) that flips when open.

**Chip expansion** — the card grows in place (header stays; never a floating
panel). Stacked under 1px `white/6%` hairlines: first the **invocation**
block (the complete command/pattern/URL/JSON, soft-wrapped at 80 cols —
"what was asked"), then the **output/diff** ("what came back").
- Output block: mono 11.5px, 18px line-height, py 6 px 12, `text/85%`,
  verbatim indentation, capped at 24 lines with a `… N more lines` tail row
  (10.5px, `text_faint`).
- Diff: rendered by the real changes-pane component — hunk headers, dual
  line-number gutters, 3 context lines, syntax runs, emerald `+N` / red
  `−N` — identical to the diff sidebar. Capped at 600 lines.
- Below, when the full payload is elsewhere: a 24px affordance row, 10.5px
  faint → muted on hover: `Show full output (12 KB)` / `Loading full
  output…` / `Couldn't load full output — tap to retry`.
- Open/close: 200ms ease-out height tween (both the card AND the group body
  tween together frame-for-frame; heights are analytic, never measured).
  Auto-open, streaming growth, and scroll-back-into-view NEVER animate.

**Error part** (harness error, not a failed tool) — its own 34px chip:
rounded 10, border red-400/16%, bg red-400/5%, 20px tile bg red-400/12% with
a 12px danger-triangle in red-300/80%, medium "Error" label red-300/80%,
message truncating in `text/80%`.

**Question chip** (AskUserQuestion) — same geometry, all neutral: border
`white/8%`, bg `white/4.5%`, 20px tile `white/9%` with 12px chat-round icon,
medium "Question" label in `text_muted`, then the value — first question's
header once resolved, `Awaiting your answer…` while pending. Resolution
never recolors it.

**Timestamps** — hovering anywhere on a message's rows reveals a 16px strip
under its last row: `Jul 1, 3:45 PM` (short month, no leading zero).
Assistant turns get one only after streaming ends.

**Working indicator** (in the reserved 24px strip above the composer, not in
the transcript): gradient matrix spinner (750ms diagonal wave) + rotating
flavour word + elapsed `1m 32s`. `Sending…` bridges send→turn-start. The
exact 20-word list, rotating every 7s, seeded per chat: Thinking, Pondering,
Scheming, Brewing, Weaving, Tinkering, Musing, Composing, Sifting,
Untangling, Distilling, Sketching, Plotting, Riffing, Combobulating,
Percolating, Marinating, Noodling, Puzzling, Conjuring.

## Motion catalog (exact)

| name | spec | used for |
|---|---|---|
| fade-in | 500ms `cubic-bezier(0.16,1,0.3,1)` opacity 0→1 + translateY 4→0 | entrances (messages, panes) |
| fade-quick | 150ms ease | small swaps |
| menu-in | 140ms ease, scale 0.96→1 + translateY −2→0, transform-origin at anchor | popovers (exit 100ms reversed) |
| dialog-in | 180ms ease, scale 0.96→1 | modals |
| hover washes | **150ms `cubic-bezier(0.4,0,0.2,1)`** (Tailwind transition-colors) | EVERY interactive fill — hovers fade, never snap |
| resize | 200ms ease-out | sidebar/pane width+height |
| collapse | 180ms ease-out height | disclosure sections |
| chevron | 200ms rotate | disclosures |
| resort slide | 260ms `cubic-bezier(0.22,1,0.36,1)` | sidebar list reorder |
| tab slide | 150ms ease-out | drag-reorder |
| scroll glide | 500ms ease-in-out, capped at 2.5 viewports | rail jumps / own-send scroll |
| pulse loader | 2.4s staggered cells, opacity 0.08→1, scale 0.9→1 | boot/loaders |
| working indicator | 750ms gradient matrix wave + rotating flavour word (20 words / 7s) + elapsed time | streaming |
| splash-out | 500ms after 150ms hold, fade + lift 6px | boot exit |

Streaming text: **fade-in veil** on newly appended spans (opacity-only, never
affects layout). Reduced-motion snaps everything.

## Sending a message (exact sequence)

1. **Optimistic echo, same frame**: the user bubble renders instantly at
   **65% opacity** (`pending` state); when the server confirms it snaps to
   full opacity in place — same row id, so nothing reflows or flickers.
   Attachment thumbs ride above the bubble, right-aligned; an image-only
   send shows no bubble at all.
2. **Own-send glide**: the transcript un-pins from the bottom and reserves a
   blank "runway" below (analytic height: viewport − inset − bottom pad),
   then **glides the sent prompt up to rest 10px under the titlebar**
   (48px inset; zero for the first message, which already carries the top
   chrome gap) — 500ms ease-in-out, capped at 2.5 viewports of travel.
   The reply then streams INTO the runway beneath the held prompt — the
   prompt stays parked at the top while the answer fills the screen below.
   The hold releases only on a real user wheel/drag (layout growth is
   explicitly not treated as scrolling away).
3. **Working strip** (reserved 24px, so the composer never moves):
   `Sending…` until the turn actually starts, then the matrix spinner +
   flavour word + elapsed.
4. **Send button morph**: no live run → **Send** (arrow); live run with
   text typed → **Steer** (send steers the running turn); live run, empty
   input → **Stop** (red square). The composer pill itself morphs
   compact(49px) ↔ expanded with a 180ms ease-out height tween,
   bottom-anchored (the bottom edge never moves), with the button cluster
   gliding a 4px x-inset and 2.5px y-offset across the morph.

## Streaming text veil (exact algorithm — mugen FadePainter)

Their engine is the npm package **`@wingleeio/mugen-markdown`** (the desktop
app shipped it; the Rust code is a port of it — for our web port we can use
the algorithm, or the package, directly). Newly appended text commits to
layout instantly and dissolves in a paint-only veil (opacity only, zero
translate):

- Cadence EMA of inter-append gaps: seed 160ms,
  `ema = ema×0.7 + min(gap, 1000)×0.3`.
- Per-chunk fade duration fixed at arrival: `clamp(ema × 3, 120ms, 400ms)`.
- Text alpha at progress p: `1 − (1−p)^1.6` (fast early reveal).
- Backed-up stream (3+ chunks fading at once): each speeds up by
  `1 + 0.3×(n−2)`.
- A chunk fades exactly ONCE — settled text never re-animates; markdown
  re-resolving (e.g. `**bol` → bold) re-veils only the changed tail.
- Re-attaching to an already-streaming chat seeds the on-screen text as
  baseline — no whole-reply fade.

## Stick-to-bottom (their exact tuning)

Spring: damping 0.7, stiffness 0.05, mass 1.25 (per-frame at 60fps), growth
EMA 0.12, max chase lead 32px. Wheel-up/drag breaks follow; re-engages within
**70px** of bottom; "at bottom" = 2px. Own send re-engages + glides the new
message to rest 10px under the titlebar.

## Port notes for temp-code

- All Tailwind-native: the oklch values ARE Tailwind 4 palette steps; the
  curves are stock CSS beziers; glass = `backdrop-filter` + Electron vibrancy.
- Diffs from our current look: body 13px→14/22, light+dark→their designed pair
  (they DO have a designed light mode — white content plane, grey chrome,
  600-step accents, same contrast ratios — in `theme.rs` if we keep light),
  Cursor-grey chrome→near-black monochrome + glass, bordered user card→
  translucent wash bubble, our per-tool rows→collapsed burst summaries.
- Their hover-fade discipline (150ms transition-colors on every wash) and the
  reserved 24px status strip are the two cheapest "feel" wins.
