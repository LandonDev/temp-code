// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LiveServer } from "../lib/devServers";

const h = vi.hoisted(() => ({ stop: vi.fn(() => Promise.resolve()), open: vi.fn() }));
vi.mock("../lib/devServers", () => ({ stopLiveServer: h.stop }));
vi.mock("./HostGlyph", () => ({ HostGlyph: () => null }));
vi.mock("../lib/devPorts", async (importOriginal) => ({ ...(await importOriginal<typeof import("../lib/devPorts")>()), openUrl: h.open }));

import { macBridgeStore } from "../lib/macBridge";
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
  callId: null,
  command: "bun run dev",
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

  it("a local server's address is its Open control, named so, with Stop the one word button", () => {
    macBridgeStore.setState({ localId: "env_mac" });
    render(<DevServerRow server={{ ...server, environmentId: "env_mac", port: { number: 5199, environmentId: "env_mac", forwards: undefined } }} />);
    const open = screen.getByRole("button", { name: "Open localhost:5199" });
    expect(open.textContent).toBe("localhost:5199");
    fireEvent.click(open);
    expect(h.open).toHaveBeenCalledWith("http://localhost:5199");
    expect(screen.getAllByRole("button").filter((b) => !b.getAttribute("aria-label")).map((b) => b.textContent)).toEqual(["Stop"]);
  });

  it("a box server forwarded here opens from the Mac's link; its own address stays plain text", () => {
    macBridgeStore.setState({ localId: "env_mac" });
    const forwards = [{ environmentId: "env_mac", macPort: 5174, error: null }] as NonNullable<LiveServer["port"]>["forwards"];
    render(<DevServerRow server={{ ...server, port: { number: 5173, environmentId: "env_box", forwards } }} />);
    const open = screen.getByRole("button", { name: "Open on the Mac, port 5174" });
    expect(open.textContent).toBe("Open on the Mac :5174");
    expect(screen.queryByRole("button", { name: /localhost:5173/ })).toBeNull();
    expect(screen.getByText("localhost:5173").tagName).toBe("SPAN");
  });

  it("a server already stopping keeps Stop off with a spinner", () => {
    render(<DevServerRow server={{ ...server, stopping: "" }} />);
    const stop = screen.getByRole("button", { name: "Stop" });
    expect((stop as HTMLButtonElement).disabled).toBe(true);
    expect(stop.querySelector('[role="status"], [data-slot="spinner"], svg')).not.toBeNull();
  });
  it("a row that picks its console is a container with its open control laid over it: Space and Enter pick, the links and Stop beside it", () => {
    macBridgeStore.setState({ localId: "env_mac" });
    const onPick = vi.fn();
    const local = { ...server, environmentId: "env_mac", port: { number: 5199, environmentId: "env_mac", forwards: undefined } };
    const { container, rerender } = render(<DevServerRow server={local} onPick={onPick} />);
    const row = container.querySelector<HTMLElement>("[data-dev-server]")!;
    const open = screen.getByRole("button", { name: "Vite dev server" });
    // A native button over the whole row: Enter and Space pick it, and no button holds a button.
    expect(open.tagName).toBe("BUTTON");
    expect(open.getAttribute("type")).toBe("button");
    expect(open.hasAttribute("data-row-open")).toBe(true);
    expect(open.className.split(/\s+/)).toEqual(expect.arrayContaining(["absolute", "inset-0"]));
    expect(row.hasAttribute("tabindex")).toBe(false);
    expect(row.className).toContain("hover:bg-foreground/5");
    expect(row.className).toContain("has-[>[data-row-open]:active]:bg-foreground/12");
    for (const name of ["Stop", "Open localhost:5199"]) expect(open.contains(screen.getByRole("button", { name }))).toBe(false);
    // The address link takes the pointer above the row's open control; the rest of what it shows takes none.
    expect(row.querySelector('[data-slot="item-content"]')!.className).toContain("pointer-events-none");
    expect(screen.getByRole("button", { name: "Open localhost:5199" }).className).toContain("pointer-events-auto");
    fireEvent.click(open);
    expect(onPick).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Open localhost:5199" }));
    expect(onPick).toHaveBeenCalledOnce();
    rerender(<DevServerRow server={local} picked onPick={onPick} />);
    expect(open.getAttribute("aria-current")).toBe("true");
    expect(row.className).toContain("bg-muted");
  });
});
