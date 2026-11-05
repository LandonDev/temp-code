// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Link } from "../lib/connection";
import type { Catalog } from "../lib/projectContext";
import { sessionStore } from "../lib/tcserver/store";
import type { SessionMeta } from "../lib/tcserver/types";
import { buildHeaderModel, orderModel } from "../lib/threadHeaderModel";
import type { ThreadHeaderProps } from "./ThreadHeader";
import { tooltipChunk, warmTooltips } from "../components/ui/tooltip";
import { TabVisitNav, TitleBar, TrafficLightSpacer, tabScrollBehavior } from "./TitleBar";
import { chipThreadsOf } from "./ShellTitleBar";
import { newSession } from "../lib/session";
import { shellStore } from "../stores/shell";

vi.mock("./WindowControls", () => ({ WindowControls: () => null }));
vi.mock("./ProjectPlanChip", () => ({ ProjectPlanChip: () => <button type="button">Plan</button> }));

const header: ThreadHeaderProps = {
  model: { live: [], dormant: [], activeId: null },
  planReady: {},
  archived: [],
  workspaceId: null,
  cost: null,
  running: 0,
  railOpen: false,
  onSelect: () => {},
  onRename: () => {},
  onArchive: () => {},
  onDelete: () => {},
  onAction: () => {},
  onSetRules: () => {},
  onRestore: () => {},
  onNew: () => {},
  onPauseAll: () => Promise.resolve(),
  onToggleRail: () => {},
  onSetType: () => {},
};

function bar(over: Partial<ComponentProps<typeof TitleBar>> = {}) {
  render(
    <TitleBar
      activeId=""
      cwd="/Users/me/repo"
      header={header}
      onToggleSidebar={() => {}}
      onNew={() => {}}
      onNewTerminal={vi.fn()}
      onShowTerminal={vi.fn()}
      {...over}
    />,
  );
}

afterEach(() => {
  cleanup();
  sessionStore.reset();
});

const chat = {
  environmentId: "env_local",
  id: "loose-chat",
  parentId: null,
  projectId: null,
  workspaceId: "w1",
  threadType: "chat",
  title: "A loose chat",
  cwd: "/w1",
  status: "idle",
  archived: false,
  pinned: false,
  busySince: null,
  createdAt: 1,
  updatedAt: 1,
} as SessionMeta;

/** A host that lists the given threads and nothing else. */
function listing(metas: SessionMeta[]): Link {
  return {
    environmentId: "env_local",
    connected: true,
    profile: "local",
    request: <T,>(method: string) => Promise.resolve((method === "session.list" ? metas : null) as T),
    onPush: () => () => {},
    onOpen: () => () => {},
    onClose: () => () => {},
  };
}

describe("TitleBar", () => {
  it("the terminal is a row of the thread menu, not a title bar button", () => {
    bar();
    expect(screen.queryByRole("button", { name: /Terminal/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Thread menu" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Panel" })).toBeTruthy();
  });

  it("with no room for the panel, its toggle is disabled and says why on hover", async () => {
    await tooltipChunk.load();
    warmTooltips();
    const onToggleRail = vi.fn();
    bar({ header: { ...header, railOpen: true, panelRoom: false, onToggleRail } });
    const toggle = screen.getByRole("button", { name: "Panel" });
    expect(toggle.getAttribute("aria-disabled")).toBe("true");
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(toggle);
    expect(onToggleRail).not.toHaveBeenCalled();
    fireEvent.pointerEnter(toggle, { pointerType: "mouse" });
    fireEvent.mouseEnter(toggle);
    fireEvent.mouseMove(toggle);
    await waitFor(() => expect(screen.getByText("No room for the panel")).toBeTruthy(), { timeout: 1500 });
  });

  it("New thread stays out of the chips' tablist, and the Plan chip sits before the thread menu", () => {
    bar({ header: { ...header, model: { live: [], dormant: [], activeId: null } } });
    const plus = screen.getByRole("button", { name: "New thread" });
    expect(plus.closest('[role="tablist"]')).toBeNull();
    const plan = screen.getByRole("button", { name: "Plan" });
    const menu = screen.getByRole("button", { name: "Thread menu" });
    expect(plan.closest('[role="tablist"]')).toBeNull();
    expect(plan.compareDocumentPosition(menu) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("an overflowing live row draws its right arrow in its own box, clear of the Panel toggle", () => {
    const width = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
    const scroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollWidth");
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 100 });
    Object.defineProperty(HTMLElement.prototype, "scrollWidth", { configurable: true, get: () => 300 });
    try {
      bar();
      const arrow = screen.getByRole("button", { name: "Scroll threads right" });
      const box = arrow.parentElement!.closest(".relative")!;
      expect(box.contains(screen.getByRole("tablist", { name: "Threads" }))).toBe(true);
      expect(box.contains(screen.getByRole("button", { name: "Panel" }))).toBe(false);
    } finally {
      if (width) Object.defineProperty(HTMLElement.prototype, "clientWidth", width);
      if (scroll) Object.defineProperty(HTMLElement.prototype, "scrollWidth", scroll);
    }
  });

  it("brings the active chip into view when another pane of the tab takes focus, and when it moves to the shelf", () => {
    const reveal = vi.fn();
    Element.prototype.scrollIntoView = reveal;
    const chip = (id: string, title: string) => ({
      id,
      thread: { ...chat, id, title, status: "running" as const },
      tabId: "tab",
      live: true,
      status: "running" as const,
      unread: false,
      updatedAt: 1,
    });
    const live = [chip("a", "Alpha"), chip("b", "Beta")];
    const props = (model: ThreadHeaderProps["model"]) => ({ header: { ...header, model }, activeId: "tab" });
    const view = render(<TitleBar cwd="/r" onToggleSidebar={() => {}} onNew={() => {}} {...props({ live, dormant: [], activeId: "a" })} />);
    const shown = () => reveal.mock.instances.at(-1) as unknown as HTMLElement;
    expect(shown().textContent).toContain("Alpha");
    view.rerender(<TitleBar cwd="/r" onToggleSidebar={() => {}} onNew={() => {}} {...props({ live, dormant: [], activeId: "b" })} />);
    expect(shown().textContent).toContain("Beta");
    const settled = { ...live[1], live: false };
    const calls = reveal.mock.calls.length;
    view.rerender(
      <TitleBar cwd="/r" onToggleSidebar={() => {}} onNew={() => {}} {...props({ live: [live[0]], dormant: [settled], activeId: "b" })} />,
    );
    expect(reveal.mock.calls.length).toBe(calls + 1);
    expect(shown().closest('[role="tablist"]')?.getAttribute("aria-label")).toBe("Settled threads");
  });

  it("off macOS the end group reaches the bar's end, with no second window title beside the strip", () => {
    // jsdom's navigator is not a Mac: this is the web /ui and a Linux window.
    bar();
    const bar_ = screen.getByRole("banner");
    expect(bar_.textContent).not.toContain("TempCode");
    const panel = screen.getByRole("button", { name: "Panel" });
    // The strip's box holds the end group (Panel last) and is the row's one
    // growing box, so nothing splits the bar beside it.
    const row = bar_.lastElementChild!;
    const growing = [...row.children].filter((el) => el.classList.contains("flex-1"));
    expect(growing).toHaveLength(1);
    expect(growing[0].contains(panel)).toBe(true);
  });

  it("re-measures the live row's arrows when a chip joins a full row", () => {
    const width = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
    const scroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollWidth");
    let content = 100;
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 100 });
    Object.defineProperty(HTMLElement.prototype, "scrollWidth", { configurable: true, get: () => content });
    try {
      const chip = (id: string) => ({
        id, thread: { ...chat, id, title: id, status: "running" as const }, tabId: id, live: true,
        status: "running" as const, unread: false, updatedAt: 1,
      });
      const view = (live: ReturnType<typeof chip>[]) => (
        <TitleBar cwd="/r" activeId="a" onToggleSidebar={() => {}} onNew={() => {}} header={{ ...header, model: { live, dormant: [], activeId: "a" } }} />
      );
      const { rerender } = render(view([chip("a")]));
      expect(screen.queryByRole("button", { name: "Scroll threads right" })).toBeNull();
      // The box and the tab stay; only the row's content grows.
      content = 300;
      rerender(view([chip("a"), chip("b")]));
      expect(screen.getByRole("button", { name: "Scroll threads right" })).toBeTruthy();
    } finally {
      if (width) Object.defineProperty(HTMLElement.prototype, "clientWidth", width);
      if (scroll) Object.defineProperty(HTMLElement.prototype, "scrollWidth", scroll);
    }
  });

  it("names the rail's toggle by what it shows, as the panel's and the sidebar's are", () => {
    render(<TabVisitNav onTogglePanel={() => {}} />);
    expect(screen.getByRole("button", { name: "Workspaces" })).toBeTruthy();
  });
});

describe("the tab strip's arrows", () => {
  it("glide the strip, and jump it under reduced motion", () => {
    const original = window.matchMedia;
    try {
      window.matchMedia = ((query: string) => ({ matches: false, media: query })) as typeof window.matchMedia;
      expect(tabScrollBehavior()).toBe("smooth");
      window.matchMedia = ((query: string) => ({ matches: query.includes("reduce"), media: query })) as typeof window.matchMedia;
      expect(tabScrollBehavior()).toBe("auto");
    } finally {
      window.matchMedia = original;
    }
  });
});

describe("TitleBar's controls", () => {
  it("draws its icon buttons 28px, beside the 28px chips, at the default stroke", () => {
    bar();
    const panel = screen.getByRole("button", { name: "Panel" });
    expect(panel.className).toContain("size-7");
    for (const svg of panel.closest("header")!.querySelectorAll("button svg")) expect(svg.getAttribute("stroke-width")).toBe("1.5");
  });

  it("holds a disabled Back still: half opacity, no hover or press fill", () => {
    render(<TabVisitNav canGoForward onGoBack={() => {}} onGoForward={() => {}} />);
    const back = screen.getByRole("button", { name: /Back/ });
    expect(back.getAttribute("aria-disabled")).toBe("true");
    for (const name of ["aria-disabled:opacity-50", "aria-disabled:hover:bg-transparent", "aria-disabled:active:bg-transparent"]) expect(back.classList).toContain(name);
    expect(back.className).not.toContain("opacity-40");
  });

  const withRail = (open: boolean, run: () => void) => {
    const rail = shellStore.getState().projectRailOpen;
    shellStore.setState({ projectRailOpen: open });
    try {
      run();
    } finally {
      shellStore.setState({ projectRailOpen: rail });
    }
  };

  it("ends 12px from the window's edge, with no padded group after Panel when the rail is open", () => {
    withRail(true, () => {
      bar();
      const panel = screen.getByRole("button", { name: "Panel" });
      expect(document.querySelector("[data-stand-ins]")).toBeNull();
      // The bar's content box carries the inset; the thread menu's group adds none of its own.
      const content = panel.closest(".pe-3")!;
      expect(content.parentElement!.tagName).toBe("HEADER");
      expect(panel.parentElement!.className).not.toMatch(/(^|\s)m[er]-/);
    });
  });

  it("with the rail closed in a project, the stand-ins follow Panel 2px apart and drop New thread for the strip's +", () => {
    withRail(false, () => {
      bar();
      const group = document.querySelector<HTMLElement>("[data-stand-ins]")!;
      expect(group.className).toContain("ps-0.5");
      expect(group.className).toContain("gap-0.5");
      expect(group.className).not.toMatch(/(^|\s)px-/);
      expect(screen.getByRole("button", { name: "Go to file" })).toBeTruthy();
      // One control named New thread: the strip's, which opens the type chooser.
      const plus = screen.getAllByRole("button", { name: /New thread/ });
      expect(plus).toHaveLength(1);
      expect(group.contains(plus[0])).toBe(false);
    });
  });

  it("with the rail closed on the home, which draws no +, the New thread stand-in stays", () => {
    withRail(false, () => {
      Element.prototype.scrollIntoView = () => {};
      bar({ header: { ...header, model: { live: [], dormant: [], activeId: null, heading: null } } });
      const group = document.querySelector<HTMLElement>("[data-stand-ins]")!;
      expect(group.contains(screen.getByRole("button", { name: "New thread" }))).toBe(true);
    });
  });

  it("keeps the traffic lights' 78px only on macOS", () => {
    const rail = shellStore.getState().projectRailOpen;
    shellStore.setState({ projectRailOpen: false });
    try {
      bar({ cwd: "" });
      // jsdom is no Mac: the rail toggle leads with no room kept for traffic lights.
      expect(screen.getByRole("button", { name: "Sidebar" })).toBeTruthy();
      expect(document.querySelector("[data-traffic-lights]")).toBeNull();
    } finally {
      shellStore.setState({ projectRailOpen: rail });
    }
    cleanup();
    const { container } = render(<TrafficLightSpacer mac />);
    expect(container.querySelector("[data-traffic-lights]")?.className).toContain("w-[78px]");
    expect(render(<TrafficLightSpacer mac={false} />).container.firstChild).toBeNull();
  });
});

describe("TitleBar's agents cue", () => {
  const meta = (id: string, over: Partial<SessionMeta>) => ({ ...chat, id, title: id, ...over }) as SessionMeta;

  it("sits in the end group before the thread menu while a subagent works, and a subagent's tab shows none", async () => {
    sessionStore.attach(listing([meta("root", { status: "idle" }), meta("kid", { parentId: "root", status: "running" })]));
    await act(() => new Promise((r) => setTimeout(r, 0)));
    bar({ header: { ...header, model: { live: [], dormant: [], activeId: "root" } } });
    const cue = screen.getByRole("button", { name: "Agents: 1 working" });
    const menu = screen.getByRole("button", { name: "Thread menu" });
    expect(cue.compareDocumentPosition(menu) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(cue.closest('[role="tablist"]')).toBeNull();
    cleanup();
    bar({ header: { ...header, model: { live: [], dormant: [], activeId: "kid" } } });
    expect(document.querySelector("[data-agents-cue]")).toBeNull();
  });
});

describe("TitleBar with no project selected", () => {
  it("a loose chat on screen has its chip and the thread menu lists its rows", async () => {
    Element.prototype.scrollIntoView = () => {};
    sessionStore.attach(listing([chat]));
    await act(() => new Promise((r) => setTimeout(r, 0)));
    const catalog = { workspaces: [{ id: "w1", path: "/w1" }], projects: [] } as unknown as Catalog;
    const model = orderModel(
      buildHeaderModel({
        threads: [chat],
        tabs: [{ id: "tab", sessionIds: [chat.id] }],
        scope: { loose: new Set(["w1"]), catalog },
        activeTabId: "tab",
        lastSeen: { [chat.id]: 1 },
        planReady: {},
      }),
      [],
    );
    bar({ header: { ...header, model } });
    expect(screen.getByText("A loose chat")).toBeTruthy();
    // Settled and seen, it is the active chip on the shelf.
    const shelf = screen.getByRole("tablist", { name: "Settled threads" });
    expect(shelf.querySelector('[aria-selected="true"]')?.textContent).toContain("A loose chat");
    fireEvent.click(screen.getByRole("button", { name: "Thread menu" }));
    for (const name of ["Rename", "Type", /^Archive/]) expect(await screen.findByRole("menuitem", { name })).toBeTruthy();
  });
});

describe("TitleBar and an unsent draft", () => {
  const catalog = { workspaces: [{ id: "w1", path: "/w1" }], projects: [] } as unknown as Catalog;
  const draft = { ...newSession("env_local", "claude", "/w1", undefined, undefined, undefined, { workspaceId: "w1" }), id: "draft-1" };
  const modelFor = (sessions: ReturnType<typeof newSession>[], activeIds: string[]) =>
    orderModel(
      buildHeaderModel({
        threads: chipThreadsOf([chat], sessions),
        tabs: [{ id: "tab", sessionIds: activeIds }],
        scope: { loose: new Set(["w1"]), catalog },
        activeTabId: "tab",
        lastSeen: { [chat.id]: 1 },
        planReady: {},
      }),
      [],
    );

  it("draws no chip for an unsent draft on screen and marks none", () => {
    Element.prototype.scrollIntoView = () => {};
    const model = modelFor([draft], [draft.id]);
    expect(model.activeId).toBeNull();
    bar({ header: { ...header, model } });
    expect(screen.queryByText("claude")).toBeNull();
    expect(document.querySelector('[role="tab"][aria-selected="true"]')).toBeNull();
    expect(screen.getByText("A loose chat")).toBeTruthy();
  });

  it("draws a sent draft's chip with its first row, before the meta lands", () => {
    Element.prototype.scrollIntoView = () => {};
    const sent = { ...draft, title: "Fix the login flow", blocks: [{ id: "u1", role: "user" as const, text: "Fix the login flow" }] };
    const model = modelFor([sent], [sent.id]);
    expect(model.activeId).toBe(sent.id);
    bar({ header: { ...header, model } });
    expect(screen.getByText("Fix the login flow")).toBeTruthy();
  });

  it("a project switch that seeds a draft draws no New chat chip", () => {
    Element.prototype.scrollIntoView = () => {};
    const seeded = { ...draft, id: "seeded", title: "New chat" };
    const model = modelFor([draft, seeded], [chat.id]);
    bar({ header: { ...header, model } });
    expect(screen.queryByText("New chat")).toBeNull();
    expect([...model.live, ...model.dormant].map((c) => c.id)).toEqual([chat.id]);
  });
});

describe("TitleBar at the home", () => {
  const catalog = { workspaces: [{ id: "w1", path: "/w1" }], projects: [] } as unknown as Catalog;
  const home = { ...chat, id: "home-chat", workspaceId: null, cwd: "/tmp", title: "A home chat" } as SessionMeta;
  const other = { ...home, id: "home-other", title: "Another home chat", status: "running", updatedAt: 2 } as SessionMeta;
  const homeModel = (activeIds: string[]) =>
    orderModel(
      buildHeaderModel({
        threads: [home, other],
        tabs: [{ id: "tab", sessionIds: activeIds }],
        scope: { loose: null, catalog },
        activeTabId: "tab",
        lastSeen: { [home.id]: 1 },
        planReady: {},
      }),
      [],
    );

  it("draws no strip: the thread on screen's title, the thread menu and the panel toggle", async () => {
    Element.prototype.scrollIntoView = () => {};
    sessionStore.attach(listing([home, other]));
    await act(() => new Promise((r) => setTimeout(r, 0)));
    bar({ header: { ...header, model: homeModel([home.id]) } });
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByRole("tab")).toBeNull();
    expect(screen.queryByText("Another home chat")).toBeNull();
    expect(screen.queryByRole("button", { name: /New thread/ })).toBeNull();
    const heading = screen.getByRole("heading", { name: "A home chat" });
    // The title sits in the bar's one 40px row, beside the end group.
    const row = heading.closest(".h-10");
    expect(row?.querySelector('[aria-label="Thread menu"]')).toBeTruthy();
    expect(screen.getByRole("button", { name: /Panel/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Thread menu" }));
    for (const name of ["Rename", /^Archive/]) expect(await screen.findByRole("menuitem", { name })).toBeTruthy();
  });

  it("renames the title in place on a double-click", () => {
    Element.prototype.scrollIntoView = () => {};
    const onRename = vi.fn();
    bar({ header: { ...header, onRename, model: homeModel([home.id]) } });
    fireEvent.doubleClick(screen.getByRole("heading", { name: "A home chat" }));
    const input = screen.getByRole("textbox", { name: "Thread title" }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Renamed" } });
    fireEvent.blur(input);
    expect(onRename).toHaveBeenCalledWith(home.id, "Renamed");
  });

  it("draws nothing in the row's place with no thread on screen", () => {
    Element.prototype.scrollIntoView = () => {};
    bar({ header: { ...header, model: homeModel([]) } });
    expect(screen.queryByRole("heading")).toBeNull();
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.getByRole("button", { name: "Thread menu" })).toBeTruthy();
  });

  it("a workspace's loose chats keep their strip", () => {
    Element.prototype.scrollIntoView = () => {};
    const model = orderModel(
      buildHeaderModel({
        threads: [chat],
        tabs: [{ id: "tab", sessionIds: [chat.id] }],
        scope: { loose: new Set(["w1"]), catalog },
        activeTabId: "tab",
        lastSeen: { [chat.id]: 1 },
        planReady: {},
      }),
      [],
    );
    bar({ header: { ...header, model } });
    expect(screen.getByRole("tablist", { name: "Threads" })).toBeTruthy();
    expect(screen.queryByRole("heading")).toBeNull();
  });
});
