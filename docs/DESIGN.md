# Design system

The target look is **Cursor**: quiet chrome, white/near-black surfaces, one
step of gray between sidebar and content, hairline borders, small type,
almost no color — and motion that feels physical, not decorative. Layouts are
specified separately; this doc fixes the ingredients every layout is built
from.

## The three libraries and how they layer

| Layer | Library | Role | How it gets in |
| --- | --- | --- | --- |
| Base system | **ReUI** (radix-nova) | Structural components: buttons, dialogs, popovers, selects, scroll areas, data-grid, tree. The shadcn-compatible foundation everything sits on. | `npx shadcn@latest add @reui/<name>` → `components/ui` + `components/reui`. Pro key in `.env.local` unlocks premium blocks (verified live: 643 items visible). |
| Motion | **BeUI** (beui.dev) | Animated primitives built on `motion/react`: stateful/magnetic buttons, morphing modals, animated tabs, toast stacks, drawers, command palette. 104 components, Tailwind 4 + React 19. | `npx shadcn@latest add @beui/<name>` → adapted into `components/motion`. |
| Agent-native | **Beautiful UI** (beautifului.dev — the old beautiful-ui-five.vercel.app) | The 19 AI-interface primitives: Thinking, Streaming Text, Tool Chips, Approval Card, Task Rows, Prompt Bar, Code Block, Diff Table, Loading State, Chat, Sidebar Nav, Search, Context Cards, Selection Actions, … Copy-paste only, no registry. | Copy from the site → `components/bui`, then run the adaptation checklist in `components/bui/README.md`. |

Conflict rule: **structure from ReUI, movement from BeUI, agent semantics
from Beautiful UI.** When two libraries offer the same thing, the more
specific layer wins (a Beautiful UI Prompt Bar beats composing one from ReUI
inputs). Every copied component is adapted before first use — our tokens, our
lucide icons, our springs — so nothing on screen betrays which library it
came from.

## Theme

Tokens live in `src/renderer/src/assets/main.css` and are the only place
color, radius, or shadow values may be written. Two themes, switched by `.dark`
on `<html>`, which `main.tsx` syncs to the OS setting.

- **Light** (the screenshot): white content, warm paper-gray chrome
  (`--sidebar` oklch 0.972), near-black text, borders at black/8%.
- **Dark**: neutral grays — content oklch 0.185, sidebar 0.155, cards 0.215,
  borders at white/9%.
- `--sidebar` exists because Cursor's chrome always sits one gray step from
  content. Sidebar darker than content in dark mode, lighter in light mode.
- `--primary` is near-black (light) / near-white (dark): primary actions are
  quiet dark pills, like Cursor's "Connect Slack". Color is reserved for
  meaning: `--info` blue (the one accent, e.g. "Update"), `--success`
  emerald, `--destructive` red, `--warning` yellow. Status dots and the rare
  CTA are the only colored things on screen.
- `--radius` 0.5rem base. Rows and chips use `md`/`lg`; only the prompt bar
  and floating panels go `xl`.
- Depth comes from the gray step + hairline border, not shadows. Shadows are
  for floating layers only (popover, dialog, prompt bar), and stay soft.

## Typography

System font stack (SF Pro on macOS), antialiased. Per Apple's typography
rules:

- UI text is small and dense: 13px default (`text-[13px]`), 12px for
  secondary rows, `text-sm` ceiling for body content in the transcript.
- Tracking is size-specific: large headings get `-0.02em`; body stays at 0.
  Never one letter-spacing for all sizes.
- Hierarchy comes from weight + color (foreground vs `muted-foreground`),
  not size jumps. Cursor's "Thought **for 2s**" pattern — same size, dimmer
  color — is the house move for secondary halves of a phrase.
- Code is SF Mono / ui-monospace, one size down from surrounding text.

## Motion language

All springs live in `src/renderer/src/lib/ease.ts` — components never inline
transition values. The presets already follow Apple's damping/response model
(critically damped by default; bounce only where momentum exists).

| Preset | Use |
| --- | --- |
| `SPRING_PRESS` | press feedback on tappable surfaces |
| `SPRING_SWAP` | label/icon slots trading places (StatefulButton) |
| `SPRING_PANEL` | modal/sheet entrances |
| `SPRING_LAYOUT` | shared-layout glides — selection pills, morphing tabs |
| `SPRING_MOUSE` | decorative pointer-follow only |
| `SPRING_GLIDE` | dragged handles/fills, critically damped |
| `EASE_OUT` / `EASE_DRAWER` | exits and non-gesture CSS transitions |

House rules (from the apple-design skill, enforced in review):

1. **Respond on pointer-down**, never on release. No latency on the input
   path; feedback is continuous during a gesture, not only at the end.
2. **Every animation is interruptible.** Animate from the current on-screen
   value; never lock input during a transition. Springs, not fixed-duration
   keyframes, for anything a user can touch.
3. **Velocity hands off.** A released drag continues at the finger's
   velocity; flicks project momentum to pick their target.
4. **Spatial consistency.** Things exit the way they entered; popovers and
   menus scale from their trigger (`transform-origin` at the source).
5. **Critically damped by default.** Overshoot only when the user's gesture
   carried momentum. A menu that just fades in never bounces.
6. **Rubber-band at edges** instead of hard stops.
7. **Animate only `transform` and `opacity`**; streaming text and lists never
   trigger layout-animating ancestors.
8. **Reduced motion is a real path**: cross-fades replace slides/springs
   (`useReducedMotion` in Motion components + the global CSS guard).
9. **Materialize translucency**: if a surface blurs (`backdrop-filter`),
   animate blur + scale together on entry; honor
   `prefers-reduced-transparency` by going frosty/solid.

## Component source map

Where each app surface gets its component when layouts are built:

| Surface | Source |
| --- | --- |
| Sidebar session rows, groups | Beautiful UI Sidebar Nav / Task Rows patterns, ReUI primitives |
| Prompt bar (composer, model picker) | Beautiful UI Prompt Bar |
| Streaming answer / markdown | Beautiful UI Streaming Text + our shiki Code Block |
| Thinking traces | Beautiful UI Thinking |
| Tool calls/results | Beautiful UI Tool Chips |
| Approvals | Beautiful UI Approval Card |
| Subagent status | Beautiful UI Task Rows |
| Diffs (checkpoints, later) | Beautiful UI Diff Table |
| Command palette / search | BeUI Command Palette, Beautiful UI Search |
| Dialogs, dropdowns, selects, tooltips | ReUI (`components/ui`) |
| Buttons with async state | BeUI StatefulButton (`components/motion`) |
| Tabs, drawers, toasts | BeUI |

## Restraint (what we do not do)

No cards within cards. No glows. No decorative badges or chips. No repeating
the same data twice. No over-explaining — states are shown, not narrated. No
color without meaning. No shadows for flat, docked UI. Confirmation dialogs
only for destructive, irreversible actions. Every spacing and timing value is
a deliberate choice we can defend.
