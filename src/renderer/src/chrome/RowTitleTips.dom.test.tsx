// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { tooltipChunk, warmTooltips } from "../components/ui/tooltip";
import { threadRow } from "../lib/workspaceSessions";
import type { SessionMeta } from "../lib/tcserver/types";
import { AgentRowView } from "../surfaces/threads/fleet/AgentRow";
import { FLEET_ROWS } from "../surfaces/threads/fleet/fleetFixture";
import { Folder } from "./icons";
import { RailRow } from "./RailRow";
import { rowMark, ThreadRowView } from "./WorkspaceSessions";

const TITLE = "Port the settings pages onto the shared row and keep their widths";

const meta = (extra: Partial<SessionMeta> = {}): SessionMeta =>
  ({
    environmentId: "local",
    id: "t1",
    parentId: null,
    projectId: "p1",
    workspaceId: null,
    threadType: "chat",
    title: TITLE,
    cwd: "/wt/p1",
    status: "idle",
    archived: false,
    pinned: false,
    busySince: null,
    createdAt: 1,
    updatedAt: 100,
    ...extra,
  }) as SessionMeta;

/** Every truncating element cuts its text. */
function cutEverything() {
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(400);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(100);
}

const hover = (el: HTMLElement) => {
  fireEvent.pointerEnter(el);
  fireEvent.mouseEnter(el);
  fireEvent.focus(el);
};
const tipText = () => document.querySelector('[data-slot="tooltip-content"]')?.textContent ?? null;

beforeAll(async () => {
  await act(async () => {
    await tooltipChunk.load();
    warmTooltips();
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("a clipped title", () => {
  it("is the rail row's one tooltip, with the state word under it", async () => {
    cutEverything();
    const row = threadRow(meta({ status: "paused" }), {});
    const word = rowMark(row).label;
    render(<ThreadRowView row={row} />);
    hover(screen.getByText(TITLE).closest<HTMLElement>("[data-thread-row]")!);
    await waitFor(() => expect(tipText()).toBe(`${TITLE}${word}`), { timeout: 2000 });
  });

  it("is the whole tooltip of a quiet rail row; a title that fits gives none", async () => {
    cutEverything();
    const quiet = render(<ThreadRowView row={threadRow(meta(), {})} />);
    hover(screen.getByText(TITLE).closest<HTMLElement>("[data-thread-row]")!);
    await waitFor(() => expect(tipText()).toBe(TITLE), { timeout: 2000 });
    quiet.unmount();
    vi.restoreAllMocks();
    render(<ThreadRowView row={threadRow(meta(), {})} />);
    hover(screen.getByText(TITLE).closest<HTMLElement>("[data-thread-row]")!);
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(tipText()).toBeNull();
  });

  it("is the agent row's tooltip in the right panel", async () => {
    cutEverything();
    const { meta: agent, status } = FLEET_ROWS[0];
    render(<AgentRowView meta={agent} status={status} onOpen={() => {}} />);
    hover(screen.getByText(agent.title!));
    await waitFor(() => expect(tipText()).toBe(agent.title), { timeout: 2000 });
  });
});

describe("a subagent row", () => {
  it("ends in its glyph, with its model on the hover line", async () => {
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(100);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(100);
    const row = threadRow(meta({ id: "k1", parentId: "t0", title: "Read the docs", provider: "claude", model: "claude-opus-5-5" }), {});
    render(<ThreadRowView row={row} child />);
    const el = screen.getByText("Read the docs").closest<HTMLElement>("[data-thread-row]")!;
    expect(el.textContent).not.toContain("Opus");
    hover(el);
    await waitFor(() => expect(tipText()).toContain("Claude Opus 5.5"), { timeout: 2000 });
  });
});

describe("a clipped rail row label", () => {
  const NAME = "temp-code-verify-second-checkout";

  it("shows the whole workspace name on hover while it is cut; one that fits shows none", async () => {
    cutEverything();
    const cut = render(<RailRow icon={Folder} label={NAME} onClick={() => {}} />);
    hover(screen.getByRole("button", { name: NAME }));
    await waitFor(() => expect(tipText()).toBe(NAME), { timeout: 2000 });
    expect(document.querySelector("[title]")).toBeNull();
    cut.unmount();
    vi.restoreAllMocks();
    render(<RailRow icon={Folder} label={NAME} onClick={() => {}} />);
    hover(screen.getByRole("button", { name: NAME }));
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(tipText()).toBeNull();
  });

  it("keeps a given tooltip over the cut label", async () => {
    cutEverything();
    render(<RailRow icon={Folder} label={NAME} tooltip="Inbox ⌘I" onClick={() => {}} />);
    hover(screen.getByRole("button", { name: NAME }));
    await waitFor(() => expect(tipText()).toBe("Inbox ⌘I"), { timeout: 2000 });
  });
});
