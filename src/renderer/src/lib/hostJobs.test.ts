import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostJobStatus, HostLogPush } from "@server/shared/contract-host";
import { HOST_LOG_CAP } from "@server/shared/contract-host";
import type { ServerPush } from "@server/shared/contract";
import { registry } from "./connection/registry";
import type { EnvLink } from "./connection/link";
import { HOST_LOG_TRUNCATED, hostJobsStore, resetHostJobs, watchJob } from "./hostJobs";

const status: HostJobStatus = { job: "deploy", phase: "running", target: "master", startedAt: 1, finishedAt: null, exit: null, stoppable: false };
let push: (p: ServerPush) => void;
let snapshot: string;
beforeEach(() => {
  resetHostJobs();
  snapshot = "";
  const link = {
    connected: true,
    request: vi.fn(async () => ({ text: snapshot, status })),
    onPush: (f: typeof push) => { push = f; return () => {}; },
    onOpen: () => () => {},
  } as unknown as EnvLink;
  vi.spyOn(registry, "link").mockReturnValue(link);
  vi.spyOn(registry, "linkOf").mockReturnValue(link);
});
afterEach(() => { resetHostJobs(); vi.restoreAllMocks(); });
const text = () => hostJobsStore.getState().jobs["box:deploy"].text;
const append = (chunk: string, reset = false) => push({ push: "host-log", job: "deploy", append: chunk, reset, status } satisfies HostLogPush);

describe("host-job log retention", () => {
  it("keeps the newest log tail within the shared cap plus one truncation line", async () => {
    watchJob("box", "deploy");
    await Promise.resolve();
    append("x".repeat(HOST_LOG_CAP));
    expect(text()).toBe("x".repeat(HOST_LOG_CAP));
    append("newest\n");
    append("last\n");
    expect(text()).toBe(HOST_LOG_TRUNCATED + "x".repeat(HOST_LOG_CAP - 12) + "newest\nlast\n");
    expect(text().length).toBe(HOST_LOG_CAP + HOST_LOG_TRUNCATED.length);
    expect(text().split(HOST_LOG_TRUNCATED)).toHaveLength(2);
    append("fresh\n", true);
    expect(text()).toBe("fresh\n");
  });

  it("bounds an oversized snapshot and a single oversized append", async () => {
    snapshot = "old" + "y".repeat(HOST_LOG_CAP);
    watchJob("box", "deploy");
    await Promise.resolve();
    expect(text()).toBe(HOST_LOG_TRUNCATED + "y".repeat(HOST_LOG_CAP));
    append("z".repeat(HOST_LOG_CAP + 1));
    expect(text()).toBe(HOST_LOG_TRUNCATED + "z".repeat(HOST_LOG_CAP));
  });
});
