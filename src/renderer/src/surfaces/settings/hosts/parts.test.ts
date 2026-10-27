import { describe, expect, it } from "vitest";
import type { AdmissionState } from "@server/shared/contract-admission";
import type { PublishStatus } from "@server/shared/contract-host";
import { budgetParts, gib, publishParts, runningParts, usageParts } from "./parts";

const admission = (over: Partial<AdmissionState> = {}): AdmissionState => ({
  cap: 120,
  pinned: null,
  default: 120,
  running: 118,
  queued: 7,
  memory: { budgetMB: 81920, reserveMB: 20480, perProcessMB: 331, freeMB: 9216, floorMB: 8192 },
  ...over,
});

const publish = (over: Partial<PublishStatus> = {}): PublishStatus =>
  ({
    job: "publish",
    phase: "idle",
    target: null,
    startedAt: null,
    finishedAt: null,
    exit: null,
    stoppable: false,
    checkout: "~/IdeaProjects/temp-code",
    readable: true,
    branch: "master",
    dirty: false,
    version: "1.0.306",
    masterVersion: "1.0.306",
    publishedVersion: "1.0.305",
    commits: [],
    notes: "",
    refusal: null,
    ...over,
  }) as PublishStatus;

describe("host page parts", () => {
  it("words a host's running threads and the memory its cap is sized from", () => {
    expect(runningParts(admission())).toEqual(["118 of 120 running", "7 queued"]);
    expect(runningParts(admission({ queued: 0 }))).toEqual(["118 of 120 running"]);
    expect(budgetParts(admission())).toEqual(["80 GiB budget", "331 MB per thread", "9 GiB free"]);
    expect(gib(2560)).toBe("2.5 GiB");
  });
  it("words what a host has on this Mac now", () => {
    expect(usageParts({ running: 1, held: 2, threads: 1 })).toEqual(["1 running", "2 waiting", "1 thread"]);
    expect(usageParts({ running: 0, held: 0, threads: 3 })).toEqual(["3 threads"]);
    expect(usageParts({ running: 0, held: 0, threads: 0 })).toEqual(["Nothing running"]);
  });
  it("words the Publish row, what would refuse it, and nothing before the status answers", () => {
    expect(publishParts(publish())).toEqual(["v1.0.306 in ~/IdeaProjects/temp-code", "last v1.0.305"]);
    expect(publishParts(publish({ branch: "a16", dirty: true }))).toEqual(["v1.0.306 in ~/IdeaProjects/temp-code", "last v1.0.305", "on a16, not master", "uncommitted changes"]);
    expect(publishParts(publish({ readable: false, refusal: null }))).toEqual(["~/IdeaProjects/temp-code is not readable"]);
    expect(publishParts(publish({ version: null, publishedVersion: null }))).toEqual(["HEAD in ~/IdeaProjects/temp-code"]);
    expect(publishParts(null)).toEqual([]);
  });
});
