import { useEffect, useRef, useState } from "react";
import type { Failure } from "@server/shared/events";
import { SERVICE_OF, isRoutedProvider } from "@server/shared/accounts";
import { AccountsPopover } from "../chrome/AccountsPopover";
import { LOCAL_ENVIRONMENT_ID } from "../lib/connection/registry";
import { scopeOf } from "../lib/accountScope";
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
import { Button } from "../components/ui/button";
import { Spinner } from "../components/ui/spinner";
import { StatusMark } from "../components/ui/status";

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
    <div
      role="alert"
      data-failure-kind={failure.kind}
      className="my-2 min-w-0 rounded-lg border border-border bg-card p-3 font-sans"
    >
      <div className="flex min-w-0 items-start gap-2">
        <span className="flex h-5 shrink-0 items-center">
          <StatusMark state="failed" word={false} />
        </span>
        <span className="min-w-0 break-words text-[13px] font-medium leading-5 text-foreground">{failure.summary}</span>
      </div>
      <div className="min-w-0 pl-5.5">
        <p className="mt-0.5 min-w-0 break-words text-[13px] leading-5 text-muted-foreground">{failure.cause}</p>
        {note ? <p className="mt-1 min-w-0 break-words text-xs text-muted-foreground">{note}</p> : null}
        <div className="mt-3 flex min-w-0 flex-wrap items-center gap-2">
          {actions.map((action, i) => {
            const pending = state.pending === action.id;
            return (
              <Button
                key={action.id}
                ref={action.id === "pick-account" ? pickAccountRef : undefined}
                size="sm"
                variant={i === 0 ? "default" : "secondary"}
                data-failure-action={action.id}
                disabled={busy || state.pending !== null}
                onClick={() => onAction(action.id)}
              >
                {pending ? <Spinner className="size-3.5" /> : null}
                {pending ? pendingLabel(action.id) || action.label : action.label}
              </Button>
            );
          })}
        </div>
        {state.outcome ? (
          <p className="mt-2 min-w-0 break-words text-xs text-muted-foreground" aria-live="polite">
            {state.outcome}
          </p>
        ) : null}
      </div>
    </div>
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
