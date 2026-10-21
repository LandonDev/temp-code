import type { FailureKind } from "@server/shared/events";
import { isRoutedProvider } from "@server/shared/accounts";

/**
 * What the failure card offers per kind. Never more than three; Retry is
 * always last. Sign in is only an action where this window can open the
 * Aliax sign-in (a thread on this Mac, in the desktop app): a thread on the
 * box, or a browser window, gets the note instead and Route automatically
 * takes its place.
 */
export type FailureActionId = "route" | "pick-account" | "sign-in" | "pick-model" | "retry";

export interface FailureAction {
  id: FailureActionId;
  label: string;
}

export interface FailureActionContext {
  /** The thread's provider: only claude and codex threads route through Aliax accounts. */
  provider: string;
  /** This window can open the Aliax sign-in for the thread's host. */
  signInHere: boolean;
}

export const SIGN_IN_ELSEWHERE_NOTE = "Sign in on the Mac, the box never signs in.";

const LABELS: Record<FailureActionId, string> = {
  route: "Route automatically",
  "pick-account": "Pick another account",
  "sign-in": "Sign in",
  "pick-model": "Pick another model",
  retry: "Retry",
};

const MAX_ACTIONS = 3;

function ids(kind: FailureKind, ctx: FailureActionContext): FailureActionId[] {
  const routed = isRoutedProvider(ctx.provider);
  switch (kind) {
    case "oauth_expired":
      if (!routed) return ["retry"];
      return ctx.signInHere ? ["sign-in", "route", "retry"] : ["route", "pick-account", "retry"];
    case "account_unknown":
    case "token_expired":
    case "rate_limited":
    case "quota":
      return routed ? ["route", "pick-account", "retry"] : ["retry"];
    case "model_unavailable":
      return ["pick-model", "retry"];
    case "network":
    case "harness_crashed":
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
  if (kind !== "oauth_expired" || ctx.signInHere || !isRoutedProvider(ctx.provider)) return null;
  return SIGN_IN_ELSEWHERE_NOTE;
}
