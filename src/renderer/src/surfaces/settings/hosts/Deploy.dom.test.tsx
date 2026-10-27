// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

/**
 * A box's Deploy row: while the link is down (the box restarting into the
 * new build) the row goes but the deploy's log stays on screen.
 */

let transport = "open";
vi.mock("../../../lib/connection", () => ({
  LOCAL_ENVIRONMENT_ID: "local",
  useEnvironmentStatus: () => ({ transport }),
}));
vi.mock("../../../lib/deployDrift", () => ({ useDeployDrift: () => ({ deployedVersion: "1.0.303", masterVersion: "1.0.306" }) }));
vi.mock("../../../lib/hostJobs", () => ({
  refreshDeployStatus: async () => null,
  refreshPublishStatus: async () => null,
  watchJob: () => {},
  setReleaseCheckout: async () => {},
  startDeploy: async () => {},
  startPublish: async () => {},
  useDeployStatuses: () => ({
    env_box: { job: "deploy", phase: "running", target: "master", startedAt: 1, finishedAt: null, exit: null, stoppable: false, installed: true, installHint: "", version: "1.0.303" },
  }),
  usePublishStatus: () => null,
}));
vi.mock("./JobLog", () => ({ JobLog: ({ environmentId }: { environmentId: string }) => <div data-job-log-stub={environmentId} /> }));

const { HostDeploy } = await import("./Deploy");

afterEach(() => {
  cleanup();
  transport = "open";
});

describe("HostDeploy", () => {
  it("shows the Deploy row and its log while connected", () => {
    const { container } = render(<HostDeploy environmentId="env_box" name="box" />);
    expect(container.querySelector('[data-deploy-row="env_box"]')).not.toBeNull();
    expect(container.querySelector('[data-job-log-stub="env_box"]')).not.toBeNull();
  });

  it("keeps the log while the box restarts and the link is down", () => {
    transport = "reconnecting";
    const { container } = render(<HostDeploy environmentId="env_box" name="box" />);
    expect(container.querySelector('[data-deploy-row="env_box"]')).toBeNull();
    expect(container.querySelector('[data-job-log-stub="env_box"]')).not.toBeNull();
  });
});
