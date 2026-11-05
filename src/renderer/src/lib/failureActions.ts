import type { FailureKind } from "@server/shared/events";
import { isPickedProvider, routedProviderOf } from "@server/shared/accounts";

/**
 * What the failure card offers per kind. Never more than three; Retry is
 * always last. Sign in is only an action where this window can open the
 * Aliax sign-in (a thread on this Mac, in the desktop app): a thread on the
 * box, or a browser window, gets the note instead and Route automatically
 * takes its place.
 */
export type FailureActionId = "route" | "pick-account" | "sign-in" | "add-key" | "open-accounts" | "pick-model" | "retry";

export interface FailureAction {
  id: FailureActionId;
  label: string;
}

export interface FailureActionContext {
  /** The thread's provider: only claude and codex threads route through Aliax accounts. */
  provider: string;
  /** The thread's model: a Meta row routes through Meta keys, whatever the harness. */
  model?: string | null;
  /** This window can open the Aliax sign-in for the thread's host. */
  signInHere: boolean;
  /** A cap's verdict: whether another account had room for the model (absent: the host did not say). */
  roomElsewhere?: boolean;
}

export const SIGN_IN_ELSEWHERE_NOTE = "Sign in on the Mac, the box never signs in.";

const LABELS: Record<FailureActionId, string> = {
  route: "Route automatically",
  "pick-account": "Pick another account",
  "sign-in": "Sign in",
  "add-key": "Add key…",
  "open-accounts": "Open accounts",
  "pick-model": "Continue on another model",
  retry: "Retry",
};

const MAX_ACTIONS = 3;

function ids(kind: FailureKind, ctx: FailureActionContext): FailureActionId[] {
  const routed = isPickedProvider(ctx.provider);
  const meta = routedProviderOf(ctx.provider, ctx.model) === "meta";
  switch (kind) {
    case "key_invalid":
      return ["open-accounts", "retry"];
    case "oauth_expired":
      if (!routed) return ["retry"];
      return ctx.signInHere ? ["sign-in", "route", "retry"] : ["route", "pick-account", "retry"];
    case "account_unknown":
      // A Meta thread with no key on this host: the fix is a key, not a route.
      if (meta) return ["add-key", "retry"];
      return routed ? ["route", "pick-account", "retry"] : ["retry"];
    case "token_expired":
      return routed ? ["route", "pick-account", "retry"] : ["retry"];
    case "rate_limited":
    case "quota":
      // A Meta key's per-minute limit lifts on its own and its quota is billing: the keys, not the model.
      if (meta) return ["route", "pick-account", "retry"];
      // A cap is per account and model: another account while one has room, else another model.
      if (routed && ctx.roomElsewhere !== false) return ["route", "pick-model", "retry"];
      return ["pick-model", "retry"];
    case "model_unavailable":
      return ["pick-model", "retry"];
    case "network":
    case "harness_crashed":
    case "turn_ended":
    case "unknown":
      return ["retry"];
  }
}

export function failureActions(kind: FailureKind, ctx: FailureActionContext): FailureAction[] {
  const list = ids(kind, ctx).slice(0, MAX_ACTIONS);
  // Retry closes every set, whatever the kind added before it.
  const ordered = [...list.filter((id) => id !== "retry"), "retry" as const];
  return ordered.map((id) => ({ id, label: LABELS[id] }));
}

/** The note under the lines when signing in is not something this window can do. */
export function failureNote(kind: FailureKind, ctx: FailureActionContext): string | null {
  if (kind !== "oauth_expired" || ctx.signInHere || !isPickedProvider(ctx.provider)) return null;
  return SIGN_IN_ELSEWHERE_NOTE;
}
