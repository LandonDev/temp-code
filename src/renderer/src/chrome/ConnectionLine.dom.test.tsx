// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Degraded } from "../lib/connection";

let degraded: Degraded | null = null;
vi.mock("../lib/connection", async (original) => ({
  ...(await original<typeof import("../lib/connection")>()),
  useEnvironmentDegraded: () => degraded,
  useEnvironments: () => [{ id: "env_box", name: "box", routes: [], credentialRef: null }],
}));

import { ConnectionLine } from "./ConnectionLine";

const status = { transport: "reconnecting", fresh: false, lastHello: null, lastError: null, nextRetryAt: null, route: null, attempts: 2 } as never;

afterEach(cleanup);

describe("ConnectionLine", () => {
  it("spins the one Spinner while the host reconnects, with no pulse", () => {
    degraded = { kind: "reconnecting", status };
    const { container } = render(<ConnectionLine environmentId="env_box" />);
    expect(container.querySelector('[data-slot="spinner"]')?.getAttribute("aria-hidden")).toBe("true");
    expect(container.innerHTML).not.toContain("animate-pulse");
  });

  it.each(["offline", "unauthorized"] as const)("keeps a still dot when the host is %s", (kind) => {
    degraded = { kind, status };
    const { container } = render(<ConnectionLine environmentId="env_box" />);
    expect(container.querySelector('[data-slot="spinner"]')).toBeNull();
    expect(container.querySelector(".rounded-full")).not.toBeNull();
  });
});
