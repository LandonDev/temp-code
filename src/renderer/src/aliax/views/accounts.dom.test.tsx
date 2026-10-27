// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServiceView, UsageReport } from "aliax-core/shared/types";
import { AccountsView, type AccountsViewProps } from "./accounts";

const NOW = Date.UTC(2026, 9, 27, 12);
const HOUR = 3_600_000;

const services = (): ServiceView[] => [
  {
    id: "claude-code",
    name: "Claude Code",
    installed: true,
    canAddAccount: true,
    canSaveCurrent: true,
    switchTargets: [],
    profiles: [
      { name: "a@x.com", email: "a@x.com", nickname: "Main", createdAt: 1, active: true },
      { name: "b@x.com", email: "b@x.com", nickname: "Spare", createdAt: 2, active: false },
    ],
  },
  { id: "codex", name: "Codex", installed: true, canAddAccount: true, canSaveCurrent: false, switchTargets: [], profiles: [] },
  { id: "cursor", name: "Cursor", installed: false, canAddAccount: false, canSaveCurrent: false, switchTargets: [], profiles: [] },
];

const report: UsageReport = {
  profileName: "a@x.com",
  windows: [
    { label: "5h", usedPercent: 30, resetsAt: NOW + 2.5 * HOUR, periodMs: 5 * HOUR },
    { label: "Weekly", usedPercent: 50, resetsAt: NOW + 50 * HOUR, periodMs: 168 * HOUR },
  ],
};

let props: AccountsViewProps;

beforeEach(() => {
  (window as unknown as { aliax: unknown }).aliax = { openExternal: vi.fn(), updateProfile: vi.fn(async () => ({ ok: true })) };
  props = {
    views: services(),
    usage: { "claude-code": [report] },
    headroom: { "claude-code": { "a@x.com": { room: 0.4, ratePerMin: 2, resetsAt: NOW + HOUR } as never } },
    busy: null,
    homes: {},
    peers: { env_box: { name: "box", connected: true, lastSyncAt: null, error: null } },
    environments: [{ id: "env_box", name: "box" }],
    localName: "This Mac",
    now: NOW,
    onCapture: vi.fn(),
    onAdd: vi.fn(),
    onReauth: vi.fn(),
    onUse: vi.fn(),
    onDelete: vi.fn(),
    onRefresh: vi.fn(),
    onSetupToken: vi.fn(),
    onConvertAll: vi.fn(),
    onSetHome: vi.fn(),
    onSync: vi.fn(),
  };
});
afterEach(cleanup);

const flush = () => act(() => new Promise((r) => setTimeout(r, 0)));

describe("AccountsView", () => {
  it("holds the live account's switch on and disabled, and turning another on uses it", () => {
    render(<AccountsView {...props} />);
    const main = screen.getByRole("switch", { name: "Use Main" });
    expect(main.getAttribute("aria-checked")).toBe("true");
    expect((main as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("switch", { name: "Use Spare" }));
    expect(props.onUse).toHaveBeenCalledWith("claude-code", "b@x.com");
  });

  it("keeps a switching account's switch on and disabled", () => {
    render(<AccountsView {...props} busy="use:claude-code:b@x.com" />);
    const spare = screen.getByRole("switch", { name: "Use Spare" });
    expect(spare.getAttribute("aria-checked")).toBe("true");
    expect((spare as HTMLButtonElement).disabled).toBe(true);
  });

  it("the section menu converts every account and sets the refreshing host", async () => {
    render(<AccountsView {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Claude Code actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Convert all to one-year tokens" }));
    expect(props.onConvertAll).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Claude Code actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Refreshed by" }));
    await flush();
    fireEvent.click(screen.getByRole("menuitemradio", { name: "box" }));
    expect(props.onSetHome).toHaveBeenCalledWith("claude", "env_box");
  });

  it("Remove asks first, and only its Remove removes", () => {
    render(<AccountsView {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "More actions for Spare" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove…" }));
    const dialog = screen.getByRole("alertdialog");
    expect(within(dialog).getByText("Remove Spare?")).toBeTruthy();
    expect(props.onDelete).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    expect(props.onDelete).toHaveBeenCalledWith("claude-code", "b@x.com");
  });

  it("opens a row's usage details from the keyboard and returns focus on Escape", async () => {
    render(<AccountsView {...props} />);
    const details = screen.getByRole("button", { name: "Usage details for Main" });
    expect(screen.getByRole("progressbar", { name: "5h: 70 percent left" }).getAttribute("data-fill")).toBe("muted");
    details.focus();
    fireEvent.keyDown(details, { key: "Enter" });
    fireEvent.click(details);
    await flush();
    const pop = screen.getByRole("dialog");
    expect(within(pop).getByText(/^Refills .+, in 2h 30m$/)).toBeTruthy();
    expect(within(pop).getByText("2 answers in the last minute, every host")).toBeTruthy();
    fireEvent.keyDown(pop, { key: "Escape" });
    await flush();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(details);
  });

  it("lists every window in the popover, even past the bar cap", async () => {
    const windows = ["5h", "Weekly", "Opus", "Fable"].map((label, i) => ({ label, usedPercent: 10 * i, resetsAt: NOW + (i + 1) * HOUR, periodMs: 168 * HOUR }));
    render(<AccountsView {...props} usage={{ "claude-code": [{ profileName: "a@x.com", windows }] }} />);
    expect(screen.queryByRole("progressbar", { name: /^Fable/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Usage details for Main" }));
    await flush();
    expect(within(screen.getByRole("dialog")).getByText("Fable")).toBeTruthy();
  });

  it("says No answer yet once for an account no host has heard from", async () => {
    render(<AccountsView {...props} headroom={{ "claude-code": { "a@x.com": { room: null, ratePerMin: 0, seenAt: null } as never } }} />);
    fireEvent.click(screen.getByRole("button", { name: "Usage details for Main" }));
    await flush();
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getAllByText(/No answer/)).toHaveLength(1);
    expect(dialog.textContent).not.toContain("No answer seen");
  });

  it("has no details button for a row without a report", () => {
    render(<AccountsView {...props} />);
    expect(screen.queryByRole("button", { name: "Usage details for Spare" })).toBeNull();
  });

  it("shows no rows or actions for a service that is not installed, and an empty one says so", () => {
    render(<AccountsView {...props} />);
    const cursor = screen.getByRole("region", { name: "Cursor" });
    expect(within(cursor).getByText("Not installed")).toBeTruthy();
    expect(within(cursor).queryByRole("button")).toBeNull();
    const codex = screen.getByRole("region", { name: "Codex" });
    expect(within(codex).getByText("No accounts saved")).toBeTruthy();
  });

  it("says how far a convert run has got", () => {
    render(<AccountsView {...props} mint={{ rows: {}, run: { total: 5, done: 1 } }} />);
    expect(screen.getByText("Converting 2 of 5 to one-year tokens")).toBeTruthy();
  });
});
