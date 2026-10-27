import { useState } from "react";
import { loadToast } from "../components/ui/toaster";
import {
  ROUTED_PROVIDERS,
  SERVICE_OF,
  SIGN_IN_NAME,
  isRoutedProvider,
  type AccountsSnapshot,
  type RoutedProvider,
} from "@server/shared/accounts";
import { Spinner } from "../components/ui/spinner";
import { registry } from "../lib/connection";
import { defaultSessionChoice } from "../lib/models";
import { accountsStore, useAccounts } from "../stores/accounts";
import { LogIn } from "./icons";
import { RailRow } from "./RailRow";

/** B10's word for a sign-in window closed before it finished. */
const CANCELLED = "cancelled";

/**
 * Which account the rail asks the person to sign in to, or null. Only a
 * window that can sign in (the desktop, not /ui), once this machine's
 * snapshot has loaded, and only while neither Claude nor Codex has a
 * profile: the provider of the default harness when it is routed, else
 * Claude.
 */
export function signInTarget({
  canSignIn,
  loaded,
  snapshot,
  harness,
}: {
  canSignIn: boolean;
  loaded: boolean;
  snapshot: AccountsSnapshot;
  harness: string;
}): RoutedProvider | null {
  if (!canSignIn || !loaded) return null;
  if (ROUTED_PROVIDERS.some((p) => snapshot.providers[p].profiles.length > 0)) return null;
  return isRoutedProvider(harness) ? harness : "claude";
}

/** The live target: this machine's accounts and the harness a new thread gets. */
export function useSignInTarget(): RoutedProvider | null {
  const { snapshot, loaded } = useAccounts(registry.primary().environmentId);
  return signInTarget({ canSignIn: !!window.aliax, loaded, snapshot, harness: defaultSessionChoice().harness });
}

/** The row as drawn: the accent glyph and the verb, or the spinner while it runs. */
export function SignInRowView({
  provider,
  pending,
  onClick,
}: {
  provider: RoutedProvider;
  pending: boolean;
  onClick?: () => void;
}) {
  return (
    <RailRow
      icon={pending ? undefined : LogIn}
      glyph={pending ? <Spinner /> : undefined}
      glyphClassName={pending ? undefined : "text-accent"}
      label={<span className="text-foreground">{pending ? "Signing in…" : `Sign in to ${SIGN_IN_NAME[provider]}`}</span>}
      aria-busy={pending || undefined}
      onClick={pending ? undefined : onClick}
    />
  );
}

/**
 * The foot's first row while this machine is signed in nowhere. A click
 * opens the sign-in window; success says nothing more (the row leaves and
 * the usage meter takes the foot), a cancel says nothing, a failure is one
 * toast.
 */
export function SignInRow({ provider }: { provider: RoutedProvider }) {
  const [pending, setPending] = useState(false);
  const signIn = async () => {
    if (pending || !window.aliax) return;
    setPending(true);
    try {
      const result = await window.aliax.loginStart(SERVICE_OF[provider]);
      if (result.ok) void accountsStore.refresh(registry.primary().environmentId, provider);
      else if (result.error !== CANCELLED) void loadToast().then((toast) => toast.error(result.error));
    } catch (err) {
      void loadToast().then((toast) => toast.error(err instanceof Error ? err.message : String(err)));
    } finally {
      setPending(false);
    }
  };
  return <SignInRowView provider={provider} pending={pending} onClick={() => void signIn()} />;
}
