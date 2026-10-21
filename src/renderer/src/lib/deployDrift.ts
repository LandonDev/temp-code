import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import {
  behindCount,
  driftKindOf,
  type BuildFacts,
  type DriftHostKind,
  type MasterRelease,
} from "@server/shared/deployDrift";
import { LOCAL_ENVIRONMENT_ID, registry } from "./connection/registry";
import { useEnvironmentStatus } from "./connection/status";
import { isWebMode } from "./nativeWeb";

/**
 * Deploy drift: how far a host's running build is behind master. Each host
 * says what it runs in its hello (`build`: release number, version, commit,
 * platform); this machine's main process reads master's release.json from
 * GitHub every ten minutes (src/main/deployDrift.ts) and tells the local
 * socket the number with `deploy-master`. The mark (chrome/DeployDrift.tsx)
 * is the difference, and the Deploy button beside it reads the same hook.
 */
export interface DeployDrift {
  /** Releases behind master; 0 when current; null until both numbers are known. */
  behind: number | null;
  /** What the host runs, `1.0.N`; null before its hello. */
  deployedVersion: string | null;
  /** Master's `1.0.N`; null before the first fetch landed. */
  masterVersion: string | null;
  /** The host's commit, when its build recorded one. */
  sha: string | null;
  /** Box: deployed over ssh. Mac: published with the release script. */
  kind: DriftHostKind;
  /** The two release numbers, for the tooltip. */
  running: number | null;
  master: number | null;
}

type State = { master: MasterRelease | null };
export const deployDriftStore = createStore<State>(() => ({ master: null }));

/** The pure half: a host's hello facts against master's number. */
export function driftOf(build: BuildFacts | null | undefined, master: MasterRelease | null): DeployDrift {
  return {
    behind: behindCount(master?.release, build?.release),
    deployedVersion: build?.version ?? null,
    masterVersion: master?.version ?? null,
    sha: build?.sha ?? null,
    kind: driftKindOf(build?.platform),
    running: build?.release ?? null,
    master: master?.release ?? null,
  };
}

const local = () => registry.link(LOCAL_ENVIRONMENT_ID);

async function loadMaster(): Promise<void> {
  const link = local();
  if (!link?.connected) return;
  try {
    const master = await link.request<MasterRelease | null>("deploy.master", {});
    deployDriftStore.setState({ master });
  } catch {
    // An older server without the watcher: nothing to compare against.
  }
}

let started = false;
/** Listen on the local link for master's release number (desktop only); idempotent. */
export function startDeployDrift(): void {
  if (started || isWebMode()) return;
  started = true;
  const attach = (link: NonNullable<ReturnType<typeof local>>) => {
    link.onOpen(() => void loadMaster());
    link.onPush((push) => {
      if (push.push === "deploy-master") deployDriftStore.setState({ master: push.master });
    });
    if (link.connected) void loadMaster();
  };
  const now = local();
  if (now) attach(now);
  else
    registry.onLink((link, event) => {
      if (event === "added" && link.environmentId === LOCAL_ENVIRONMENT_ID)
        attach(link as NonNullable<ReturnType<typeof local>>);
    });
}

/** The drift of one environment, live: its hello's build against the cached master number. */
export function useDeployDrift(environmentId: string): DeployDrift {
  const master = useStore(deployDriftStore, (s) => s.master);
  const status = useEnvironmentStatus(environmentId);
  return driftOf(status.lastHello?.build, master);
}

/** Tests: reset the listener and the cached number. */
export function resetDeployDriftForTest(master: MasterRelease | null = null): void {
  started = false;
  deployDriftStore.setState({ master });
}
