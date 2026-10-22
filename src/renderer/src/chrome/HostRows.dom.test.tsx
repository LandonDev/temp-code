// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registry, type Environment, type EnvironmentStatus, type Link } from "../lib/connection";
import { noteBootResume, resetBootResume } from "../lib/bootResume";
import { sessionStore } from "../lib/tcserver/store";
import type { SessionMeta } from "../lib/tcserver/types";
import { resetThreadBatchForTests, useBatchPending } from "../lib/threadBatch";
import { shell } from "../stores/shell";
import { HostRows } from "./HostRows";

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
  resetBootResume();
  sessionStore.reset();
  vi.restoreAllMocks();
});

describe("HostRows", () => {
  it("draws nothing with one host", () => {
    hosts([LOCAL], {});
    const { container } = render(<HostRows onAddWorkspace={() => {}} />);
    expect(container.innerHTML).toBe("");
  });

  it("draws one row per host: the glyph, the name, the dot with its state, the boot-resume line", () => {
    hosts([LOCAL, BOX], { local: status("open", "darwin"), env_box: status("offline", "linux") });
    noteBootResume("env_box", 7, 1234);
    render(<HostRows onAddWorkspace={() => {}} />);
    const rows = screen.getAllByRole("listitem");
    expect(rows.map((r) => r.getAttribute("data-host-row"))).toEqual(["local", "env_box"]);
    expect(rows.map((r) => r.querySelector("button")?.className.includes("h-7"))).toEqual([true, true]);
    const box = rows[1];
    expect(box.querySelector("[data-host-status]")?.getAttribute("title")).toBe("box: offline");
    expect(box.querySelector("[data-host-status]")?.className).toContain("bg-content/25");
    expect(box.querySelector("[data-boot-resume]")?.textContent).toBe("7 threads resumed after restart");
    expect(rows[0].querySelector("[data-boot-resume]")).toBeNull();
    expect(rows[0].querySelector("[data-host-status]")?.getAttribute("title")).toBe("This Mac: connected");
    expect(rows.map((r) => r.querySelector("[data-host-glyph]")?.getAttribute("data-host-kind"))).toEqual(["mac", "server"]);
  });

  it("drops the boot-resume line on its own after a while", () => {
    vi.useFakeTimers();
    try {
      hosts([LOCAL, BOX], {});
      noteBootResume("env_box", 2, 99);
      render(<HostRows onAddWorkspace={() => {}} />);
      expect(document.querySelector("[data-boot-resume]")).not.toBeNull();
      act(() => {
        vi.advanceTimersByTime(15_000);
      });
      expect(document.querySelector("[data-boot-resume]")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("opens the host's menu: Add workspace here, Mark all read, the fleet switches, Remote access", () => {
    hosts([LOCAL, BOX], {});
    const onAdd = vi.fn();
    render(<HostRows onAddWorkspace={onAdd} />);
    fireEvent.click(screen.getByRole("button", { name: /^box,/ }));
    const names = screen.getAllByRole("menuitem").map((el) => el.textContent);
    expect(names).toEqual([
      "Add workspace here…",
      "Mark all read",
      "Pause all",
      "Resume all",
      "Stop all",
      "Archive done",
      "Remote access settings",
    ]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Add workspace here…" }));
    expect(onAdd).toHaveBeenCalledWith("env_box");
  });

  it("asks the fleet switches' confirm scoped to the host, a switch with nothing to act on disabled", async () => {
    hosts([LOCAL, BOX], {});
    sessionStore.attach(listing("env_box", [meta("run", "env_box", { status: "running" })]));
    await act(flush);
    render(
      <>
        <HostRows onAddWorkspace={() => {}} />
        <Pending />
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: /^box,/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Resume all" }));
    expect(screen.getByTestId("pending").textContent).toBe("");
    fireEvent.click(screen.getByRole("menuitem", { name: "Stop all" }));
    expect(screen.getByTestId("pending").textContent).toBe('stop:{"kind":"host","environmentId":"env_box","name":"box"}');
  });

  it("opens Remote access from the menu", () => {
    hosts([LOCAL, BOX], {});
    const open = vi.spyOn(shell, "openSettings").mockImplementation(() => {});
    render(<HostRows onAddWorkspace={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /^This Mac,/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Remote access settings" }));
    expect(open).toHaveBeenCalledWith("remote");
  });
});
