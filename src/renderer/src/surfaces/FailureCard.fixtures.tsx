// A failed turn's card for `bun run ui:preview src/renderer/src/surfaces/FailureCard.tsx#FailureCardView`:
// the pure view, its actions from lib/failureActions.ts as the live card asks for them.
import type { Failure, FailureKind } from "@server/shared/events";
import { failureActions, failureNote, type FailureActionContext } from "../lib/failureActions";
import type { FailureCardState } from "./FailureCard";

const ctx: FailureActionContext = { provider: "claude", model: "claude-opus-5-5", signInHere: true };
const card = (kind: FailureKind, summary: string, cause: string, state: FailureCardState = { pending: null, outcome: null }) => ({
  failure: { kind, account: "work", summary, cause } satisfies Failure,
  actions: failureActions(kind, ctx),
  note: failureNote(kind, ctx),
  state,
  onAction: "fn",
});

export const fixtures = [
  { name: "Rate limited", props: card("rate_limited", "Account work hit its 5-hour limit", "It resets at 4:15 PM; another account has room") },
  { name: "Network", props: card("network", "The provider could not be reached", "The connection dropped before the first reply") },
  { name: "Harness crashed", props: card("harness_crashed", "Claude Code exited mid-turn", "The process ended with code 137, likely out of memory") },
  {
    name: "Retrying, the buttons at rest",
    props: card("network", "The provider could not be reached", "The connection dropped before the first reply", { pending: "retry", outcome: null }),
  },
  {
    name: "After an action, its outcome under the buttons",
    props: card("rate_limited", "Account work hit its 5-hour limit", "It resets at 4:15 PM", { pending: null, outcome: "Routed to personal; it starts on the next turn" }),
  },
];
