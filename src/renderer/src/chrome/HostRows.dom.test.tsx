// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registry, type Environment, type EnvironmentStatus, type Link } from "../lib/connection";
import { noteBootResume, resetBootResume } from "../lib/bootResume";
import { sessionStore } from "../lib/tcserver/store";
import type { SessionMeta } from "../lib/tcserver/types";
import { resetThreadBatchForTests, useBatchPending } from "../lib/threadBatch";
import { shell } from "../stores/shell";
import { subscribeEnvironmentSwitch } from "../lib/environmentSwitch";
import { HostsRow, useBootResumeToasts, toneOf } from "./HostRows";
import { menuChunk } from "../surfaces/chunks";
import { warmMenus } from "./menuRows";

// The menus here are drawn by their parts (components/ui/lazy-menus.tsx): warm their body first.
beforeAll(async () => {
  await menuChunk.load();
  warmMenus();
});

const toastMock = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({ toast: toastMock }));

const env = (id: string, name: string): Environment => ({ id, name, routes: [], credentialRef: null });
const LOCAL = env("local", "This Mac");
const BOX = env("env_box", "box");

const status = (transport: EnvironmentStatus["transport"], platform?: string): EnvironmentStatus => ({
  transport,
  fresh: true,
  lastHello: platform ? { environmentId: "x", contract: 1, caps: [], build: { platform } as never } : null,
  lastError: null,
  nextRetryAt: null,
  route: null,
  attempts: 0,
});

function hosts(environments: Environment[], statuses: Record<string, EnvironmentStatus>) {
  vi.spyOn(registry, "environmentsSnapshot").mockReturnValue(environments);
  vi.spyOn(registry, "environment").mockImplementation((id) => environments.find((e) => e.id === id));
  const map = new Map(environments.map((e) => [e.id, statuses[e.id] ?? status("open")] as const));
  vi.spyOn(registry, "statuses").mockReturnValue(map);
  vi.spyOn(registry, "statusOf").mockImplementation((id) => map.get(id) ?? status("offline"));
}

const meta = (id: string, environmentId: string, extra: Partial<SessionMeta> = {}): SessionMeta =>
  ({
    environmentId,
    id,
    parentId: null,
    projectId: null,
    workspaceId: null,
    threadType: "chat",
    title: id,
    cwd: "/tmp",
    status: "idle",
    archived: false,
    pinned: false,
    busySince: null,
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  }) as SessionMeta;

const flush = () => new Promise((r) => setTimeout(r, 0));

/** A host link that lists the given threads and nothing else. */
function listing(environmentId: string, metas: SessionMeta[]): Link {
  return {
    environmentId,
    connected: true,
    profile: "local",
    request: <T,>(method: string) => Promise.resolve((method === "session.list" ? metas : null) as T),
    onPush: () => () => {},
    onOpen: () => () => {},
    onClose: () => () => {},
  };
}

function Pending() {
  const pending = useBatchPending();
  return <output data-testid="pending">{pending ? `${pending.action}:${JSON.stringify(pending.scope)}` : ""}</output>;
}

beforeEach(() => resetThreadBatchForTests());
afterEach(() => {
  cleanup();
  toastMock.mockClear();
  resetBootResume();
  sessionStore.reset();
  vi.restoreAllMocks();
});

/** Opens the Hosts row's menu, then one host's submenu. */
async function openHost(name: RegExp) {
  fireEvent.click(screen.getByRole("button", { name: /^Hosts:/ }));
  await act(flush);
  fireEvent.click(await screen.findByRole("menuitem", { name }));
  await act(flush);
}

describe("HostsRow", () => {
  it("draws nothing with one host", () => {
    hosts([LOCAL], {});
    const { container } = render(<HostsRow onAddWorkspace={() => {}} />);
    expect(container.innerHTML).toBe("");
  });

  it("is one 28px row ending in a dot per host, its label naming every host and its state", () => {
    hosts([LOCAL, BOX], { local: status("open", "darwin"), env_box: status("offline", "linux") });
    render(<HostsRow onAddWorkspace={() => {}} />);
    const row = screen.getByRole("button", { name: "Hosts: This Mac connected, box offline" });
    expect(row.className).toContain("h-7");
    const dots = [...row.querySelectorAll("[data-host-status]")];
    expect(dots.map((d) => d.getAttribute("data-host-status"))).toEqual(["open", "offline"]);
    expect(dots[1].className).toContain("bg-muted-foreground/30");
    expect(screen.queryByRole("listitem")).toBeNull();
  });

  it("keeps a well host's dot quiet: muted, never green; only trouble is coloured", () => {
    hosts([LOCAL, BOX], { local: status("open", "darwin"), env_box: status("unauthorized", "linux") });
    render(<HostsRow onAddWorkspace={() => {}} />);
    const row = screen.getByRole("button", { name: /^Hosts:/ });
    const [open, refused] = [...row.querySelectorAll("[data-host-status]")];
    expect(open.className).toMatch(/(^| )bg-muted-foreground( |$)/);
    expect(row.innerHTML).not.toContain("bg-success");
    expect(refused.className).toContain("bg-destructive");
    expect(row.innerHTML).not.toContain("bg-danger");
  });

  it("toneOf: quiet when well, amber while it tries or is slow, red refused", () => {
    expect(toneOf(status("open"))).toBe("bg-muted-foreground");
    expect(toneOf({ ...status("open"), fresh: false })).toBe("bg-muted-foreground/50");
    expect(toneOf(status("open"), true)).toBe("bg-warning");
    expect(toneOf(status("connecting"))).toBe("bg-warning");
    expect(toneOf(status("reconnecting"))).toBe("bg-warning");
    expect(toneOf(status("unauthorized"))).toBe("bg-destructive");
    expect(toneOf(status("offline"))).toBe("bg-muted-foreground/30");
  });

  it("spins an amber spinner in the dot's place while a host reconnects, never a pulse", () => {
    hosts([LOCAL, BOX], { local: status("open", "darwin"), env_box: status("reconnecting", "linux") });
    render(<HostsRow onAddWorkspace={() => {}} />);
    const row = screen.getByRole("button", { name: /^Hosts:/ });
    const spinner = row.querySelector('[data-host-status="reconnecting"]')!;
    expect(spinner.getAttribute("data-slot")).toBe("spinner");
    expect(spinner.getAttribute("class")).toContain("text-warning");
    expect(row.innerHTML).not.toMatch(/animate-(pulse|spin)\b/);
    // The spinner and the dot share one 10px box per host, so no other dot moves.
    const boxes = [...row.querySelectorAll("[data-host-dot]")];
    expect(boxes).toHaveLength(2);
    for (const box of boxes) expect(box.className).toContain("size-2.5");
    expect(boxes[1].contains(spinner)).toBe(true);
  });

  it("lists a submenu per host, with the glyph, the name and the state, then Host settings", async () => {
    hosts([LOCAL, BOX], { local: status("open", "darwin"), env_box: status("offline", "linux") });
    render(<HostsRow onAddWorkspace={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /^Hosts:/ }));
    await act(flush);
    const triggers = [...document.querySelectorAll("[data-host-menu]")];
    expect(triggers.map((t) => t.getAttribute("data-host-menu"))).toEqual(["local", "env_box"]);
    expect(triggers[1].textContent).toContain("box");
    expect(triggers[1].textContent).toContain("offline");
    expect(triggers.map((t) => t.querySelector("[data-host-glyph]")?.getAttribute("data-host-kind"))).toEqual(["mac", "server"]);
    expect(screen.getByRole("menuitem", { name: "Host settings" })).toBeTruthy();
  });

  it("a host's submenu: Switch to, Add workspace here, Mark all read, the fleet switches", async () => {
    hosts([LOCAL, BOX], {});
    const onAdd = vi.fn();
    render(<HostsRow onAddWorkspace={onAdd} />);
    await openHost(/^box/);
    const names = within(screen.getByRole("menu", { name: "box actions" }))
      .getAllByRole("menuitem")
      .map((el) => el.textContent);
    expect(names).toEqual(["Switch to box", "Add workspace here…", "Mark all read", "Pause all", "Resume all", "Stop all", "Archive done"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Add workspace here…" }));
    expect(onAdd).toHaveBeenCalledWith("env_box");
  });

  it("the host on screen has no Switch to", async () => {
    hosts([LOCAL, BOX], {});
    render(<HostsRow onAddWorkspace={() => {}} />);
    await openHost(/^This Mac/);
    expect(screen.queryByRole("menuitem", { name: /^Switch to/ })).toBeNull();
  });

  it("switches the window to another host", async () => {
    hosts([LOCAL, BOX], {});
    const switched = vi.fn();
    const off = subscribeEnvironmentSwitch(switched);
    render(<HostsRow onAddWorkspace={() => {}} />);
    await openHost(/^box/);
    fireEvent.click(screen.getByRole("menuitem", { name: "Switch to box" }));
    expect(switched).toHaveBeenCalledWith("env_box");
    off();
  });

  it("asks the fleet switches' confirm scoped to the host, a switch with nothing to act on disabled", async () => {
    hosts([LOCAL, BOX], {});
    sessionStore.attach(listing("env_box", [meta("run", "env_box", { status: "running" })]));
    await act(flush);
    render(
      <>
        <HostsRow onAddWorkspace={() => {}} />
        <Pending />
      </>,
    );
    await openHost(/^box/);
    expect(screen.getByRole("menuitem", { name: "Resume all" }).getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(screen.getByRole("menuitem", { name: "Stop all" }));
    expect(screen.getByTestId("pending").textContent).toBe('stop:{"kind":"host","environmentId":"env_box","name":"box"}');
  });

  it("opens the Hosts settings page from the menu's foot", async () => {
    hosts([LOCAL, BOX], {});
    const open = vi.spyOn(shell, "openSettings").mockImplementation(() => {});
    render(<HostsRow onAddWorkspace={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /^Hosts:/ }));
    await act(flush);
    fireEvent.click(screen.getByRole("menuitem", { name: "Host settings" }));
    expect(open).toHaveBeenCalledWith("remote");
  });
});

describe("useBootResumeToasts", () => {
  function Probe() {
    useBootResumeToasts();
    return null;
  }

  it("says a host's boot resume once, as a toast, with the host's name when there are two", async () => {
    hosts([LOCAL, BOX], {});
    noteBootResume("env_box", 7, 1234);
    render(<Probe />);
    await act(flush);
    expect(toastMock).toHaveBeenCalledTimes(1);
    expect(toastMock).toHaveBeenCalledWith("7 threads resumed after restart", { description: "box" });
    cleanup();
    render(<Probe />);
    await act(flush);
    expect(toastMock).toHaveBeenCalledTimes(1);
  });

  it("names no host with one", async () => {
    hosts([LOCAL], {});
    noteBootResume("local", 1, 99);
    render(<Probe />);
    await act(flush);
    expect(toastMock).toHaveBeenCalledWith("1 thread resumed after restart", undefined);
  });
});
