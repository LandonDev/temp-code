import { useEffect, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import type { Failure } from "@server/shared/events";
import { SERVICE_OF, isRoutedProvider } from "@server/shared/accounts";
import { AlertCircle } from "../chrome/icons";
import { AccountsPopover } from "../chrome/AccountsPopover";
import { LOCAL_ENVIRONMENT_ID } from "../lib/connection/registry";
import { scopeOf } from "../lib/accountScope";
import { ENTER } from "../lib/ease";
import {
  failureActions,
  failureNote,
  type FailureAction,
  type FailureActionContext,
  type FailureActionId,
} from "../lib/failureActions";
import { requestModelPicker } from "../lib/modelPickerSignal";
import { continueSession, rerouteSession } from "../lib/tcserver/commands";
import { useSessionMeta } from "../lib/tcserver/store";
import { useProjects, useWorkspaces } from "../lib/tcserver/workspaces";
import { useSlowClock } from "../lib/turnClock";
import { useAccounts } from "../stores/accounts";
import { CHIP } from "./chip";

/**
 * The row a failed turn ends on, with the host's verdict: one line naming
 * what happened and the account, one line with the likely cause, and up to
 * three actions that fit the kind (lib/failureActions.ts), Retry last. The
 * words come from main (failureKind.ts); nothing here parses an error.
 */

/** What an action is doing, printed after the buttons until the thread moves. */
export interface FailureCardState {
  /** The action in flight, if any. */
  pending: FailureActionId | null;
  /** One line about the last action's outcome (where the thread landed, a refusal). */
  outcome: string | null;
}

export function FailureCardView({
  failure,
  actions,
  note,
  state,
  onAction,
  busy,
  pickAccountRef,
}: {
  failure: Failure;
  actions: FailureAction[];
  note: string | null;
  state: FailureCardState;
  onAction: (id: FailureActionId) => void;
  /** The thread is working again: the buttons rest while the card is on its way out. */
  busy?: boolean;
  /** The Pick another account button, for the popover to anchor on. */
  pickAccountRef?: React.RefObject<HTMLButtonElement | null>;
}) {
  const reduce = useReducedMotion() === true;
  const pendingLabel = (id: FailureActionId): string => {
    switch (id) {
      case "retry":
        return "Retrying…";
      case "route":
        return "Routing…";
      case "sign-in":
        return "Signing in…";
      default:
        return "";
    }
  };
  return (
    <motion.div
      role="alert"
      data-failure-kind={failure.kind}
      initial={reduce ? false : ENTER.initial}
      animate={ENTER.animate}
      transition={ENTER.transition}
      className="flex min-w-0 items-start gap-2 py-2 font-sans text-[12px]"
    >
      <AlertCircle className="mt-0.5 size-3.5 shrink-0 text-danger" strokeWidth={1.75} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="min-w-0 break-words font-medium leading-4 text-content">{failure.summary}</span>
        <span className="min-w-0 break-words leading-4 text-content/60">{failure.cause}</span>
        {note ? <span className="min-w-0 break-words leading-4 text-content/60">{note}</span> : null}
        <span className="mt-0.5 flex min-w-0 flex-wrap items-center gap-1.5">
          {actions.map((action) => {
            const pending = state.pending === action.id;
            return (
              <button
                key={action.id}
                ref={action.id === "pick-account" ? pickAccountRef : undefined}
                type="button"
                data-failure-action={action.id}
                disabled={busy || state.pending !== null}
                className={CHIP}
                onClick={() => onAction(action.id)}
              >
                {pending ? pendingLabel(action.id) || action.label : action.label}
              </button>
            );
          })}
          {state.outcome ? (
            <span className="min-w-0 truncate text-[11px] text-content/50" aria-live="polite">
              {state.outcome}
            </span>
          ) : null}
        </span>
      </div>
    </motion.div>
  );
}

/** Whether this window can open the Aliax sign-in for a thread's host: the
 *  thread lives on this machine and the desktop app's bridge is here. */
export function canSignInHere(environmentId: string | null | undefined): boolean {
  return environmentId === LOCAL_ENVIRONMENT_ID && typeof window !== "undefined" && !!window.aliax;
}

export function FailureCard({ sessionId, failure, busy }: { sessionId: string; failure: Failure; busy?: boolean }) {
  const meta = useSessionMeta(sessionId);
  const environmentId = meta?.environmentId ?? LOCAL_ENVIRONMENT_ID;
  const provider = meta?.provider ?? "claude";
  const ctx: FailureActionContext = { provider, signInHere: canSignInHere(environmentId) };
  const actions = failureActions(failure.kind, ctx);
  const note = failureNote(failure.kind, ctx);
  const [state, setState] = useState<FailureCardState>({ pending: null, outcome: null });
  const [picking, setPicking] = useState(false);
  const pickRef = useRef<HTMLButtonElement>(null);
  const { snapshot } = useAccounts(environmentId);
  const projects = useProjects();
  const workspaces = useWorkspaces();
  const now = useSlowClock(picking);
  const scope = scopeOf(meta, projects, workspaces);
  const accounts = scope ? snapshot.providers[scope.provider] : null;

  // The thread is working again: whatever was pending has landed.
  useEffect(() => {
    if (busy) setState((s) => (s.pending ? { pending: null, outcome: s.outcome } : s));
  }, [busy]);

  const settle = (outcome: string | null) => setState({ pending: null, outcome });

  const onAction = (id: FailureActionId) => {
    switch (id) {
      case "retry":
        setState({ pending: "retry", outcome: null });
        void continueSession(sessionId).catch((err: unknown) => settle(errorLine(err)));
        return;
      case "route":
        setState({ pending: "route", outcome: null });
        void rerouteSession(sessionId)
          .then(({ account, moved }) => {
            if (!moved) {
              settle("No other account has room right now.");
              return;
            }
            setState({ pending: "retry", outcome: account ? `Now on ${account}` : null });
            return continueSession(sessionId).catch((err: unknown) => settle(errorLine(err)));
          })
          .catch((err: unknown) => settle(errorLine(err)));
        return;
      case "pick-account":
        if (!accounts || accounts.profiles.length === 0) {
          settle("No saved accounts on this host.");
          return;
        }
        setPicking((open) => !open);
        return;
      case "sign-in": {
        if (!window.aliax || !isRoutedProvider(provider)) return;
        setState({ pending: "sign-in", outcome: null });
        void window.aliax
          .loginStart(SERVICE_OF[provider], failure.account ?? undefined)
          .then((result) => settle(result.ok ? "Signed in. Retry to pick the work back up." : result.error))
          .catch((err: unknown) => settle(errorLine(err)));
        return;
      }
      case "pick-model":
        requestModelPicker(sessionId);
        return;
    }
  };

  return (
    <div className="relative">
      <FailureCardView
        failure={failure}
        actions={actions}
        note={note}
        state={state}
        onAction={onAction}
        busy={busy}
        pickAccountRef={pickRef}
      />
      {picking && scope && accounts ? (
        <AccountsPopover
          anchor={pickRef}
          provider={scope.provider}
          accounts={accounts}
          scope={scope}
          now={now}
          onDismiss={() => setPicking(false)}
        />
      ) : null}
    </div>
  );
}

function errorLine(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.replace(/\s+/g, " ").trim() || "That did not work.";
}
