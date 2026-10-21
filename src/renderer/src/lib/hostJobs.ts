import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import type { DeployStatus, HostJob, HostJobStatus, HostLogPush, PublishStatus } from "@server/shared/contract-host";
import type { ServerPush } from "@server/shared/contract";
import { LOCAL_ENVIRONMENT_ID, registry } from "./connection/registry";

/**
 * Deploy and publish from the app, renderer side (docs/box.md "Updating" →
 * "Deploy from the app"). A job is watched per host: `host.log` answers the
 * log so far and the host's socket pushes `host-log` from then on; a
 * link-up (the box restarts into the new build mid-deploy) asks again and
 * takes the whole log back, so the card keeps tailing. The box's deploy
 * status rides its own link (admin); the Mac's publish status rides the
 * local one.
 */

export type JobEntry = {
  environmentId: string;
  job: HostJob;
  status: HostJobStatus;
  text: string;
};

type State = {
  /** Watched jobs by `${environmentId}:${job}`. */
  jobs: Record<string, JobEntry>;
  /** Each box's deploy status, as last read; null when the host answered an error. */
  deploy: Record<string, DeployStatus | null>;
  publish: PublishStatus | null;
};

const store = createStore<State>(() => ({ jobs: {}, deploy: {}, publish: null }));
export const hostJobsStore = store;
const keyOf = (environmentId: string, job: HostJob): string => `${environmentId}:${job}`;
const watchers = new Map<string, () => void>();

export async function refreshDeployStatus(environmentId: string): Promise<DeployStatus | null> {
  const link = registry.link(environmentId);
  if (!link?.connected) return store.getState().deploy[environmentId] ?? null;
  try {
    const status = await link.request<DeployStatus>("host.deployStatus", {});
    store.setState((s) => ({ deploy: { ...s.deploy, [environmentId]: status } }));
    return status;
  } catch {
    store.setState((s) => ({ deploy: { ...s.deploy, [environmentId]: null } }));
    return null;
  }
}

export async function refreshPublishStatus(): Promise<PublishStatus | null> {
  const link = registry.link(LOCAL_ENVIRONMENT_ID);
  if (!link?.connected) return store.getState().publish;
  try {
    const status = await link.request<PublishStatus>("host.publishStatus", {});
    store.setState({ publish: status });
    return status;
  } catch {
    store.setState({ publish: null });
    return null;
  }
}

function setEntry(environmentId: string, job: HostJob, patch: Partial<JobEntry>): void {
  const key = keyOf(environmentId, job);
  store.setState((s) => {
    const prev = s.jobs[key];
    const next: JobEntry = prev
      ? { ...prev, ...patch }
      : { environmentId, job, status: { job, phase: "idle", target: null, startedAt: null, finishedAt: null, exit: null, stoppable: false }, text: "", ...patch };
    return { jobs: { ...s.jobs, [key]: next } };
  });
}

async function load(environmentId: string, job: HostJob): Promise<void> {
  const link = registry.link(environmentId);
  if (!link?.connected) return;
  try {
    const snapshot = await link.request<{ text: string; status: HostJobStatus }>("host.log", { job });
    setEntry(environmentId, job, { text: snapshot.text, status: snapshot.status });
  } catch {
    // an older host, or the link closed under the request: the next link-up asks again
  }
}

/** Tail a job on a host until `dismissJob`. Idempotent. */
export function watchJob(environmentId: string, job: HostJob): void {
  const key = keyOf(environmentId, job);
  if (watchers.has(key)) return;
  const link = registry.linkOf(environmentId);
  setEntry(environmentId, job, {});
  const onPush = (push: ServerPush): void => {
    if (push.push !== "host-log" || push.job !== job) return;
    const p = push as HostLogPush;
    const prev = store.getState().jobs[key];
    const text = (p.reset ? "" : (prev?.text ?? "")) + (p.append ?? "");
    setEntry(environmentId, job, { text, status: p.status });
    if (job === "deploy" && p.status.phase === "done") void refreshDeployStatus(environmentId);
    if (job === "publish" && p.status.phase === "done") void refreshPublishStatus();
  };
  const offPush = link.onPush(onPush);
  // Every (re)open: the socket is new, so the subscription is, and the log comes back whole.
  const offOpen = link.onOpen(() => {
    void load(environmentId, job);
    if (job === "deploy") void refreshDeployStatus(environmentId);
  });
  watchers.set(key, () => {
    offPush();
    offOpen();
  });
  void load(environmentId, job);
}

export function dismissJob(environmentId: string, job: HostJob): void {
  const key = keyOf(environmentId, job);
  watchers.get(key)?.();
  watchers.delete(key);
  store.setState((s) => {
    const jobs = { ...s.jobs };
    delete jobs[key];
    return { jobs };
  });
}

export async function startDeploy(environmentId: string, ref: string): Promise<void> {
  const link = registry.linkOf(environmentId);
  const status = await link.request<DeployStatus>("host.deploy", { ref });
  store.setState((s) => ({ deploy: { ...s.deploy, [environmentId]: status } }));
  watchJob(environmentId, "deploy");
}

export async function startPublish(notes: string): Promise<void> {
  const link = registry.linkOf(LOCAL_ENVIRONMENT_ID);
  const status = await link.request<PublishStatus>("host.publish", { notes });
  store.setState({ publish: status });
  watchJob(LOCAL_ENVIRONMENT_ID, "publish");
}

export async function stopPublish(): Promise<void> {
  const link = registry.linkOf(LOCAL_ENVIRONMENT_ID);
  const status = await link.request<PublishStatus>("host.publishStop", {});
  store.setState({ publish: status });
}

export async function setReleaseCheckout(checkout: string): Promise<void> {
  const link = registry.linkOf(LOCAL_ENVIRONMENT_ID);
  const status = await link.request<PublishStatus>("host.releaseCheckout.set", { checkout });
  store.setState({ publish: status });
}

export function useHostJob(environmentId: string, job: HostJob): JobEntry | undefined {
  return useStore(store, (s) => s.jobs[keyOf(environmentId, job)]);
}
export function useDeployStatuses(): Record<string, DeployStatus | null> {
  return useStore(store, (s) => s.deploy);
}
export function usePublishStatus(): PublishStatus | null {
  return useStore(store, (s) => s.publish);
}

/** Test seam. */
export function resetHostJobs(): void {
  for (const off of watchers.values()) off();
  watchers.clear();
  store.setState({ jobs: {}, deploy: {}, publish: null });
}
