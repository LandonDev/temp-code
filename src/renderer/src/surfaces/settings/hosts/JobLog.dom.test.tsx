// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { HostJobStatus } from "@server/shared/contract-host";

/**
 * A job's log under its row: open while the job runs and after a failure,
 * folded to its line after a pass; Stop only for a publish that can be
 * stopped; Dismiss once the job is done.
 */

let entry: { status: HostJobStatus; text: string } | undefined;
const dismissed: string[] = [];
let stops = 0;

vi.mock("../../../lib/connection", () => ({
  useEnvironmentStatus: () => ({ transport: "open" }),
}));
vi.mock("../../../lib/hostJobs", () => ({
  useHostJob: () => entry,
  useDeployStatuses: () => ({}),
  dismissJob: (env: string, job: string) => dismissed.push(`${env}:${job}`),
  stopPublish: async () => {
    stops++;
  },
}));

const { JobLog, openByDefault } = await import("./JobLog");

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
const isOpen = (container: HTMLElement) => container.querySelector("[data-slot=collapsible-content]") !== null && !container.querySelector("[data-slot=collapsible-content]")?.hasAttribute("hidden");

afterEach(() => {
  cleanup();
  entry = undefined;
  dismissed.length = 0;
  stops = 0;
});

describe("JobLog", () => {
  it("shows nothing for an idle job", () => {
    entry = { status: status({}), text: "" };
    const { container } = render(<JobLog environmentId="env_box" job="deploy" hostName="box" />);
    expect(container.innerHTML).toBe("");
  });

  it("is open on the console while a deploy runs, with the spinner and no Stop or Dismiss", () => {
    entry = { status: status({ phase: "running", target: "master" }), text: "== building\nok\n" };
    const { container } = render(<JobLog environmentId="env_box" job="deploy" hostName="box" />);
    expect(isOpen(container)).toBe(true);
    expect(container.querySelector("pre")?.textContent).toBe("== building\nok");
    expect(container.querySelector("[data-slot=spinner]")).not.toBeNull();
    expect(screen.getByText("Deploying master to box")).toBeTruthy();
    expect(screen.queryByText("Stop")).toBeNull();
    expect(screen.queryByText("Dismiss")).toBeNull();
  });

  it("folds to its ending line after a pass, and Dismiss clears it", () => {
    entry = { status: status({ phase: "done", target: "master", exit: 0 }), text: "done\n" };
    const { container } = render(<JobLog environmentId="env_box" job="deploy" hostName="box" />);
    expect(isOpen(container)).toBe(false);
    expect(container.querySelector("[data-job-ending]")?.textContent).toBe("Deployed master, the service is back");
    fireEvent.click(screen.getByText("Dismiss"));
    expect(dismissed).toEqual(["env_box:deploy"]);
  });

  it("stays open after a failure, its ending in red", () => {
    entry = { status: status({ phase: "done", target: "master", exit: 2 }), text: "boom\n" };
    const { container } = render(<JobLog environmentId="env_box" job="deploy" hostName="box" />);
    expect(isOpen(container)).toBe(true);
    expect(container.querySelector("[data-job-ending]")?.className).toContain("text-destructive");
  });

  it("offers Stop for a publish that can be stopped", () => {
    entry = { status: status({ job: "publish", phase: "running", target: "1.0.306", stoppable: true }), text: "" };
    render(<JobLog environmentId="local" job="publish" hostName="This Mac" />);
    expect(screen.getByText("Waiting for output…")).toBeTruthy();
    fireEvent.click(screen.getByText("Stop"));
    expect(stops).toBe(1);
  });

  it("takes its default open state from the phase and the ending", () => {
    expect(openByDefault({ phase: "running", ending: null })).toBe(true);
    expect(openByDefault({ phase: "done", ending: { text: "", failed: false } })).toBe(false);
    expect(openByDefault({ phase: "done", ending: { text: "", failed: true } })).toBe(true);
  });
});
