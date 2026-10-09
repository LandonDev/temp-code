import { ask, message, updates, type UpdateStatus } from "./native";
import { announceUpdateAvailable } from "./sounds";
import { rememberInstalledUpdate } from "./updateNotice";

/**
 * The update flow on top of main's electron-updater: releases are semver
 * (1.0.N) on the GitHub feed; `apply` downloads a waiting release, and once
 * it is downloaded `apply` again restarts into it. The renderer only
 * mirrors status and asks the user.
 */

export type UpdaterPhase =
  | "idle"
  | "checking"
  | "current"
  | "available"
  | "downloading"
  | "ready"
  | "error";

export type UpdaterSnapshot = {
  phase: UpdaterPhase;
  currentVersion: string;
  availableVersion?: string;
  /** Release notes for the waiting update, shown before installing. */
  notes?: string;
  /** While downloading: whole percent. */
  percent?: number;
  /** Dev instances mirror status but only the installed app applies. */
  canApply?: boolean;
  error?: string;
};

export function snapshotFromStatus(status: UpdateStatus): UpdaterSnapshot {
  const currentVersion = status.current;
  const availableVersion = status.latest ?? undefined;
  const canApply = status.canApply;
  switch (status.phase) {
    case "checking":
      return { phase: "checking", currentVersion, canApply };
    case "downloading":
      return {
        phase: "downloading",
        currentVersion,
        availableVersion,
        percent: status.percent ?? 0,
        canApply,
      };
    case "ready":
      return { phase: "ready", currentVersion, availableVersion, canApply };
    case "error":
      return {
        phase: "error",
        currentVersion,
        availableVersion,
        error: status.error ?? "Update failed.",
        canApply,
      };
    case "idle":
      if (availableVersion) {
        return {
          phase: "available",
          currentVersion,
          availableVersion,
          notes: status.notes.trim() || undefined,
          canApply,
        };
      }
      return {
        phase: status.checked ? "current" : "idle",
        currentVersion,
        canApply,
      };
  }
}

const busy = (phase: UpdaterPhase) =>
  phase === "downloading" || phase === "ready";

let remembered: string | undefined;

/** Mirror main's status stream. Once a download is ready the restart lands
 *  in the new release, whose first boot shows these notes. */
export function watchUpdateStatus(
  onSnapshot: (snapshot: UpdaterSnapshot) => void,
): () => void {
  return updates.onStatus((status) => {
    const snapshot = snapshotFromStatus(status);
    if (
      snapshot.phase === "ready" &&
      snapshot.availableVersion &&
      remembered !== snapshot.availableVersion
    ) {
      remembered = snapshot.availableVersion;
      rememberInstalledUpdate(snapshot.availableVersion);
    }
    onSnapshot(snapshot);
  });
}

export async function runUpdateFlow(
  manual: boolean,
  onProgress?: (snapshot: UpdaterSnapshot) => void,
): Promise<UpdaterSnapshot> {
  const before = snapshotFromStatus(await updates.get());
  if (busy(before.phase)) {
    onProgress?.(before);
    return before;
  }
  onProgress?.({ phase: "checking", currentVersion: before.currentVersion });

  let snapshot: UpdaterSnapshot;
  try {
    snapshot = snapshotFromStatus(await updates.check());
  } catch (err) {
    snapshot = {
      phase: "error",
      currentVersion: before.currentVersion,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  onProgress?.(snapshot);

  if (snapshot.phase === "available") {
    announceUpdateAvailable(snapshot.availableVersion!);
    if (!manual) return snapshot;
    const detail = snapshot.notes ? `\n\n${snapshot.notes}` : "";
    const yes = await ask(
      `Release ${snapshot.availableVersion} is available (you have ${snapshot.currentVersion}).${detail}\n\nDownload it now?`,
      { title: "Update available", kind: "info" },
    );
    return yes ? installPendingUpdate(onProgress) : snapshot;
  }
  if (manual && snapshot.phase === "error") {
    await message(`Couldn't check for updates.\n\n${snapshot.error}`, {
      title: "TempCode",
    });
  } else if (manual && snapshot.phase !== "idle") {
    await message("You're on the latest release.", { title: "TempCode" });
  }
  return snapshot;
}

/** Download the waiting release, or restart into one already downloaded.
 *  Progress then arrives on the status stream. */
export async function installPendingUpdate(
  onProgress?: (snapshot: UpdaterSnapshot) => void,
): Promise<UpdaterSnapshot> {
  const status = await updates.get();
  const snapshot = snapshotFromStatus(status);
  if (snapshot.phase === "ready") {
    if (snapshot.availableVersion) rememberInstalledUpdate(snapshot.availableVersion);
    const restarting = snapshotFromStatus(await updates.apply());
    onProgress?.(restarting);
    return restarting;
  }
  if (snapshot.phase !== "available") {
    onProgress?.(snapshot);
    return snapshot;
  }
  if (!status.canApply) {
    const failed: UpdaterSnapshot = {
      ...snapshot,
      phase: "error",
      error: "This dev instance can't apply updates. Use the installed app.",
    };
    onProgress?.(failed);
    await message(failed.error!, { title: "TempCode" });
    return failed;
  }
  const started = snapshotFromStatus(await updates.apply());
  const result: UpdaterSnapshot = busy(started.phase)
    ? started
    : started.phase === "error"
      ? started
      : { ...snapshot, phase: "error", error: "The download did not start." };
  onProgress?.(result);
  if (result.phase === "error") {
    await message(`Couldn't download the update.\n\n${result.error}`, {
      title: "TempCode",
    });
  }
  return result;
}
