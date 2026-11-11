// A failed turn's card for `bun run ui:preview src/renderer/src/surfaces/FailureCard.tsx#FailureCardView`:
// the pure view, its actions from lib/failureActions.ts as the live card asks for them.
import type { Failure, FailureKind } from "@server/shared/events";
import { failureActions, failureNote, type FailureActionContext } from "../lib/failureActions";
import type { FailureCardState } from "./FailureCard";

const ctx: FailureActionContext = { provider: "claude", model: "claude-opus-5-5", signInHere: true };
const card = (
  kind: FailureKind,
  summary: string,
  cause: string,
  state: FailureCardState = { pending: null, outcome: null },
  roomElsewhere?: boolean,
  offers1m?: boolean,
) => {
  const at = { ...ctx, ...(roomElsewhere === undefined ? {} : { roomElsewhere }), ...(offers1m === undefined ? {} : { offers1m }) };
  return {
    failure: { kind, account: "work", summary, cause, ...(roomElsewhere === undefined ? {} : { roomElsewhere }) } satisfies Failure,
    actions: failureActions(kind, at),
    note: failureNote(kind, at),
    state,
    onAction: "fn",
  };
};
const FABLE_CAP = "throwaway@example.com hit its cap for Fable";
const THRASH = "The context window keeps filling up";
const THRASH_CAUSE = "4 compactions in 6 minutes; the first request held 167k of a 200k window";

export const fixtures = [
  {
    name: "A cap, another account with room",
    props: card("rate_limited", FABLE_CAP, "The usage window is spent until it resets; another account with room can take the thread.", undefined, true),
  },
  {
    name: "A cap, no other account with room",
    props: card(
      "rate_limited",
      FABLE_CAP,
      "The usage window is spent until it resets, and no other account has room for this model; another model can take the thread.",
      undefined,
      false,
    ),
  },
  {
    name: "Continuing on the picked model",
    props: card(
      "rate_limited",
      FABLE_CAP,
      "The usage window is spent until it resets, and no other account has room for this model; another model can take the thread.",
      { pending: "pick-model", outcome: null },
      false,
    ),
  },
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
  { name: "A thrashing window, 1M on offer", props: card("context_thrash", THRASH, THRASH_CAUSE, undefined, undefined, true) },
  {
    name: "A thrashing window, continuing on 1M",
    props: card("context_thrash", THRASH, THRASH_CAUSE, { pending: "use-1m", outcome: null }, undefined, true),
  },
  {
    name: "A thrashing window the CLI stopped, no 1M",
    props: card("context_thrash", THRASH, "Claude Code stopped after the context refilled to its limit 3 times in a row", undefined, undefined, false),
  },
];
