import { describe, expect, it } from "vitest";
import type { HostJobStatus } from "@server/shared/contract-host";
import { deployConfirmText, deployRowLine, hostJobCard, tailLines } from "./hostJobCard";

const status = (patch: Partial<HostJobStatus>): HostJobStatus => ({
  job: "deploy",
  phase: "idle",
  target: null,
  startedAt: null,
  finishedAt: null,
  exit: null,
  stoppable: false,
  ...patch,
});
const deploy = (patch: Partial<HostJobStatus>, text = "", extra: Partial<Parameters<typeof hostJobCard>[0]> = {}) =>
  hostJobCard({ job: "deploy", status: status(patch), text, hostName: "box", linkUp: true, ...extra });
const publish = (patch: Partial<HostJobStatus>, text = "") =>
  hostJobCard({ job: "publish", status: status({ job: "publish", stoppable: true, ...patch }), text, hostName: "This Mac", linkUp: true });

describe("hostJobCard", () => {
  it("shows nothing while idle", () => {
    expect(deploy({}).visible).toBe(false);
  });
  it("pending: waiting for the trigger, no Stop", () => {
    const card = deploy({ phase: "pending", target: "master" }, "== deploy master requested\n");
    expect(card).toMatchObject({ visible: true, title: "Deploying master to box", note: "Waiting for the trigger on the box", stoppable: false, ending: null });
    expect(card.lines).toEqual(["== deploy master requested"]);
  });
  it("running: says the box cannot be stopped, and that it is restarting when the link is down", () => {
    expect(deploy({ phase: "running", target: "master" }).note).toBe("Cannot be stopped mid-way; the box rolls back on failure");
    expect(deploy({ phase: "running", target: "master" }, "", { linkUp: false }).note).toBe("The box is restarting; the log continues when it is back");
    expect(deploy({ phase: "running", target: "v1.0.273" }).title).toBe("Deploying v1.0.273 to box");
  });
  it("done: the deployed version and that the service is back, or the failure", () => {
    expect(deploy({ phase: "done", target: "master", exit: 0 }, "", { deployedVersion: "1.0.273" }).ending).toEqual({ text: "Deployed v1.0.273, the service is back", failed: false });
    expect(deploy({ phase: "done", target: "master", exit: 0 }).ending).toEqual({ text: "Deployed master, the service is back", failed: false });
    expect(deploy({ phase: "done", target: "master", exit: 1 }, "ROLLBACK: restoring 1.0.270\n").ending).toEqual({ text: "Deploy failed (exit 1)", failed: true });
    expect(deploy({ phase: "done", target: "master", exit: null }).ending).toEqual({ text: "Deploy did not start", failed: true });
  });
  it("publish: Stop while running, then published, stopped or failed", () => {
    const running = publish({ phase: "running", target: "v1.0.273" });
    expect(running).toMatchObject({ title: "Publishing v1.0.273", stoppable: true, ending: null });
    expect(publish({ phase: "done", target: "v1.0.273", exit: 0 }).ending).toEqual({ text: "Published v1.0.273; the installed app offers it on its next check", failed: false });
    expect(publish({ phase: "done", target: "v1.0.273", exit: 143 })).toMatchObject({ title: "Publish of v1.0.273 stopped", ending: { text: "Stopped; nothing was published", failed: true }, stoppable: false });
    expect(publish({ phase: "done", target: null, exit: 1 }).ending).toEqual({ text: "Publish failed (exit 1)", failed: true });
    expect(publish({ phase: "running", target: null }).title).toBe("Publishing the Mac release");
  });
  it("keeps the last 40 lines and drops the trailing newline", () => {
    const text = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
    const lines = tailLines(text);
    expect(lines).toHaveLength(40);
    expect(lines[0]).toBe("line 11");
    expect(lines[39]).toBe("line 50");
    expect(tailLines("")).toEqual([]);
    expect(tailLines("a\nb")).toEqual(["a", "b"]);
  });
});

describe("deployConfirmText", () => {
  it("names the versions and the releases between them", () => {
    expect(deployConfirmText("box", "1.0.270", "1.0.273")).toMatch(/^v1\.0\.270 → v1\.0\.273, 3 releases\./);
    expect(deployConfirmText("box", "1.0.272", "1.0.273")).toMatch(/^v1\.0\.272 → v1\.0\.273, 1 release\./);
    expect(deployConfirmText("box", "1.0.273", "1.0.273")).toMatch(/already runs v1\.0\.273/);
    expect(deployConfirmText("box", "1.0.274", "1.0.273")).toMatch(/master is behind/);
    expect(deployConfirmText("box", "1.0.270", null)).toMatch(/^box runs v1\.0\.270\./);
    expect(deployConfirmText("box", null, null)).toMatch(/^box rebuilds master/);
  });
});

describe("deployRowLine", () => {
  it("says what the box runs and how far behind master it is", () => {
    expect(deployRowLine({ installed: true, version: "1.0.270", masterVersion: "1.0.273", connected: true, phase: "idle" })).toBe("Runs v1.0.270 · 3 releases behind master");
    expect(deployRowLine({ installed: true, version: "1.0.273", masterVersion: "1.0.273", connected: true, phase: "idle" })).toBe("Runs v1.0.273 · up to date with master");
    expect(deployRowLine({ installed: true, version: "1.0.273", masterVersion: null, connected: true, phase: "idle" })).toBe("Runs v1.0.273.");
    expect(deployRowLine({ installed: true, version: "1.0.270", masterVersion: "1.0.273", connected: true, phase: "running" })).toBe("Runs v1.0.270 · deploying");
    expect(deployRowLine({ installed: false, version: "1.0.270", masterVersion: "1.0.273", connected: true, phase: "idle" })).toBe("Deploy from the app is not installed on this host.");
    expect(deployRowLine({ installed: true, version: "1.0.270", masterVersion: "1.0.273", connected: false, phase: "idle" })).toBe("Not connected right now.");
  });
});
