import { useEffect } from "react";
import type { ComputerAppVerdict, ComputerServiceState, ComputerSettings, ComputerSettingsPatch } from "@server/shared/contract-computer";
import type { Permissions } from "@server/shared/computer/protocol";
import { verdictWords } from "@server/shared/computer/words";
import type { Link } from "../connection/link";
import { useHostRead } from "../connection/hostRead";

/**
 * Settings → Computer use over this Mac's own socket (surfaces/settings/
 * Computer.tsx; every method `local`): the session tier's threshold, the apps
 * the verdicts learned with Forget, the two grants, and Try again on a
 * service down after crashes. The host pushes `computer-settings` after any
 * change, a second apart at most.
 */

export const readComputerSettings = (link: Link): Promise<ComputerSettings> => link.request<ComputerSettings>("computer.settings.get", {});

export const setComputerSettings = (link: Link, patch: ComputerSettingsPatch): Promise<ComputerSettings> =>
  link.request<ComputerSettings>("computer.settings.set", patch);

/** One app's verdict, or every app's with null; the next call to it learns again. */
export const forgetComputerApps = (link: Link, bundleId: string | null): Promise<ComputerSettings> =>
  link.request<ComputerSettings>("computer.verdicts.forget", { bundleId });

/** null: computer use is unavailable here, or the host could not read them. */
export const readComputerPermissions = (link: Link): Promise<Permissions | null> => link.request<Permissions | null>("computer.permissions", {});

export const retryComputerService = (link: Link): Promise<ComputerServiceState> => link.request<ComputerServiceState>("computer.service.retry", {});

/** The host's `computer-settings` push. */
export function onComputerSettings(link: Link, fn: (settings: ComputerSettings) => void): () => void {
  return link.onPush((push) => {
    if (push.push === "computer-settings") fn(push.settings);
  });
}

// ── the threshold, in whole minutes ──

export const IDLE_MINUTES = { min: 1, max: 60 } as const;

/** What the field shows: whole minutes, at least one (a proof's 5 s reads as 1 and is not rewritten until a commit). */
export const idleMinutes = (ms: number): number => Math.max(IDLE_MINUTES.min, Math.round(ms / 60_000));

export const idleMs = (minutes: number): number => minutes * 60_000;

// ── the learned apps ──

/** An app's name, or its bundle id for a verdict saved before names were kept. */
export const appTitle = (app: Pick<ComputerAppVerdict, "name" | "bundleId">): string => app.name ?? app.bundleId;

const takesScreen = (app: ComputerAppVerdict): boolean => verdictWords(app.classes) !== null;

/** Apps that learned anything at the session tier first, then by name. */
export function sortApps(apps: readonly ComputerAppVerdict[]): ComputerAppVerdict[] {
  return [...apps].sort((a, b) => Number(takesScreen(b)) - Number(takesScreen(a)) || appTitle(a).localeCompare(appTitle(b)));
}

// ── the grants ──

/** Poll only while a grant is known to be off: it flips in System Settings, outside the window. */
export const PERMISSION_POLL_MS = 5000;

export const missingGrant = (p: Permissions | null | undefined): boolean => !!p && (!p.accessibility || !p.screenRecording);

export interface ComputerPermissionsRead {
  /** undefined until known; null when the host could not read them */
  value: Permissions | null | undefined;
  error: string | null;
  retry: () => void;
}

/**
 * The two grants: the service's own while it is up (live through the
 * `computer` push), else `computer.permissions`, asked on mount, every 5 s
 * while one is off, and when the window comes back. No system prompt.
 */
export function useComputerPermissions(link: Link, service: ComputerServiceState | null): ComputerPermissionsRead {
  const live = service?.state === "up" ? service.permissions : null;
  const read = useHostRead(link, () => readComputerPermissions(link));
  const asking = live === null;
  const polls = asking && missingGrant(read.value);
  const { retry } = read;

  useEffect(() => {
    if (!polls) return;
    const timer = window.setInterval(retry, PERMISSION_POLL_MS);
    return () => window.clearInterval(timer);
  }, [polls, retry]);

  useEffect(() => {
    if (!asking) return;
    window.addEventListener("focus", retry);
    return () => window.removeEventListener("focus", retry);
  }, [asking, retry]);

  return live ? { value: live, error: null, retry } : { value: read.value, error: read.value === undefined ? read.error : null, retry };
}
