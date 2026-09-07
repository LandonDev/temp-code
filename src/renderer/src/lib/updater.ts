import { ask, message, updates, type UpdateStatus } from "./native";
import { announceUpdateAvailable } from "./sounds";
import { rememberInstalledUpdate } from "./updateNotice";

/**
 * Donor update flow on top of main's self-updater. Releases are numbered,
 * not semver; `apply` builds in main and relaunches the app itself, so the
 * renderer only mirrors status and asks the user.
 */

export type UpdaterPhase =
  | "idle"
  | "checking"
  | "current"
  | "available"
  | "building"
  | "restarting"
  | "error";

export type UpdaterSnapshot = {
  phase: UpdaterPhase;
  currentVersion: string;
  availableVersion?: string;
  /** Release notes for the waiting update, shown before installing. */
  notes?: string;
  /** While building: main's current step and its latest output line. */
  step?: string;
  detail?: string;
  /** While building: when the step began and how long it took last time. */
  stepStartedAt?: number;
  stepEtaMs?: number;
  /** Dev instances mirror status but only the installed app applies. */
  canApply?: boolean;
  error?: string;
};

export function snapshotFromStatus(status: UpdateStatus): UpdaterSnapshot {
  const currentVersion = String(status.current);
  const hasUpdate = status.latest != null && status.latest > status.current;
  const availableVersion = hasUpdate ? String(status.latest) : undefined;
  const canApply = status.canApply;
  switch (status.phase) {
    case "checking":
      return { phase: "checking", currentVersion, canApply };
    case "building":
      return {
        phase: "building",
        currentVersion,
        availableVersion,
        step: status.step,
        detail: status.detail,
        stepStartedAt: status.stepStartedAt,
        stepEtaMs: status.stepEtaMs,
        canApply,
      };
    case "restarting":
      return { phase: "restarting", currentVersion, availableVersion, canApply };
    case "error":
      return {
        phase: "error",
        currentVersion,
        availableVersion,
        error: status.error ?? "Update failed.",
        canApply,
      };
    case "idle":
      if (hasUpdate) {
        return {
          phase: "available",
          currentVersion,
          availableVersion,
          notes: status.notes.trim() || undefined,
          canApply,
        };
      }
      return {
        phase: status.latest == null ? "idle" : "current",
        currentVersion,
        canApply,
      };
  }
}

const busy = (phase: UpdaterPhase) =>
  phase === "building" || phase === "restarting";

let remembered: string | undefined;

/** Mirror main's status stream. Once main restarts into the new release,
 *  the next boot shows its notes. */
export function watchUpdateStatus(
  onSnapshot: (snapshot: UpdaterSnapshot) => void,
): () => void {
  return updates.onStatus((status) => {
    const snapshot = snapshotFromStatus(status);
    if (
      snapshot.phase === "restarting" &&
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
      `Release ${snapshot.availableVersion} is available (you have ${snapshot.currentVersion}).${detail}\n\nInstall now?`,
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

/** Start main's build of the waiting release. Progress then arrives on
 *  the status stream; the app relaunches itself when it is done. */
export async function installPendingUpdate(
  onProgress?: (snapshot: UpdaterSnapshot) => void,
): Promise<UpdaterSnapshot> {
  const status = await updates.get();
  const snapshot = snapshotFromStatus(status);
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
      : { ...snapshot, phase: "error", error: "The update did not start." };
  onProgress?.(result);
  if (result.phase === "error") {
    await message(`Couldn't install the update.\n\n${result.error}`, {
      title: "TempCode",
    });
  }
  return result;
}
