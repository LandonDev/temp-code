// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LiveServer } from "../lib/devServers";

const h = vi.hoisted(() => ({ stop: vi.fn(() => Promise.resolve()) }));
vi.mock("../lib/devServers", () => ({ stopLiveServer: h.stop }));
vi.mock("./HostGlyph", () => ({ HostGlyph: () => null }));

import { DevServerRow } from "./DevServerRow";

const server: LiveServer = {
  key: "env_box/res1",
  environmentId: "env_box",
  title: "Vite dev server",
  sessionId: "t1",
  owner: "Coins page",
  port: { number: 5173, environmentId: "env_box", forwards: undefined },
  runId: null,
  resource: { id: "res1", sessionId: "t1" },
  startedAt: 1,
};

afterEach(cleanup);

describe("DevServerRow", () => {
  it("Stop is a button that says its word, with no tooltip, and stops the server", async () => {
    render(<DevServerRow server={server} />);
    const stop = screen.getByRole("button", { name: "Stop" });
    expect(stop.textContent).toBe("Stop");
    expect(stop.getAttribute("aria-label")).toBeNull();
    await act(async () => {
      fireEvent.click(stop);
    });
    expect(h.stop).toHaveBeenCalledWith(server);
  });

  it("a server already stopping keeps Stop off with a spinner", () => {
    render(<DevServerRow server={{ ...server, stopping: "" }} />);
    const stop = screen.getByRole("button", { name: "Stop" });
    expect((stop as HTMLButtonElement).disabled).toBe(true);
    expect(stop.querySelector('[role="status"], [data-slot="spinner"], svg')).not.toBeNull();
  });
});
