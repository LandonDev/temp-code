# Beautiful UI — agent-native primitives

Components copied from https://www.beautifului.dev/ (formerly
beautiful-ui-five.vercel.app) live here. There is no registry — copy from the
site, paste as a `.tsx` file in this folder, then adapt it before first use.
The site ships 19 primitives; the table below lists the ones we plan to use
(also available: Loading State, Chat, Recommendation Card, Context Cards,
Records/Filter Table, Sidebar Nav, Search, Insight Cards, Fine-tune Card,
Selection Actions).

## Adaptation checklist (every copied component)

1. Swap hardcoded colors, radii, spacing, and shadows for our tokens
   (`src/renderer/src/assets/main.css`): `bg-card`, `border-border`,
   `text-muted-foreground`, `rounded-lg`, etc.
2. Replace its icon imports with `lucide-react`.
3. If it animates, use our `motion` package and the easings in
   `src/renderer/src/lib/ease.ts` so it moves like the BeUI pieces.
4. Wire props to the normalized event schema (`src/shared/events.ts`),
   not to any provider-native shape.

## Which primitives we want, and what they render

| Beautiful UI component | Renders                                        |
| ---------------------- | ---------------------------------------------- |
| Thinking               | `thinking` events (collapsed reasoning trace)  |
| Streaming Text         | `assistant-text` deltas                        |
| Tool Chips             | `tool-call` / `tool-result` pairs              |
| Approval Card          | permission prompts (plan Milestone 4)          |
| Task Rows              | subagent sessions with live status             |
| Prompt Bar             | the composer + model picker                    |
| Code Block             | code in assistant output (shiki)               |
| Diff Table             | checkpoint diffs (later)                       |

`Transcript.tsx` currently renders these surfaces with plain Tailwind —
replace surface by surface as primitives get copied in (docs/PLAN.md
Milestone 3).
