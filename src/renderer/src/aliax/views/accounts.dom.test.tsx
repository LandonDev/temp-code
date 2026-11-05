// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServiceView, UsageReport } from "aliax-core/shared/types";
import type { KeyProfileView } from "@shared/accounts";
import { tooltipChunk, warmTooltips } from "@renderer/components/ui/tooltip";
import { clockTime } from "@renderer/lib/duration";
import { dayClockTime } from "./accounts/rowLine";
import { AccountsSkeleton, AccountsView, type AccountsViewProps } from "./accounts";
import { AccountsPagePreview } from "./accounts.preview";
import PREVIEW_FIXTURES from "./accounts.preview.fixtures";

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
    onAddKey: vi.fn(),
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
    expect(screen.getByRole("progressbar", { name: /^5h: 70 percent left, resets / }).getAttribute("data-fill")).toBe("muted");
    details.focus();
    fireEvent.keyDown(details, { key: "Enter" });
    fireEvent.click(details);
    await flush();
    const pop = screen.getByRole("dialog");
    // The refill is the row's; the popover adds the pace and the rate.
    expect(within(pop).queryByText("Refills in 2h 30m")).toBeNull();
    expect(within(pop).getAllByText(/An even burn leaves/).length).toBeGreaterThan(0);
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
    expect(within(codex).getByText("No accounts saved").getAttribute("data-slot")).toBe("page-empty");
    expect(codex.querySelector("[data-slot=empty]")).toBeNull();
  });

  it("says how far a convert run has got", () => {
    render(<AccountsView {...props} mint={{ rows: {}, run: { total: 5, done: 1 } }} />);
    expect(screen.getByText("Converting 2 of 5 to one-year tokens")).toBeTruthy();
  });

  describe("a key service (Meta)", () => {
    const work: KeyProfileView = { name: "Work", createdAt: 1, active: false, static: true, kind: "key", color: "#38bdf8", accountId: "1607339912" };
    const old: KeyProfileView = { name: "Meta key …9QzT", createdAt: 2, active: false, static: true, kind: "key", accountId: "2214" };
    const meta: ServiceView = { id: "meta", name: "Meta Model API", installed: true, canAddAccount: false, canSaveCurrent: false, switchTargets: [], profiles: [work, old] };
    const keyed = (extra: Partial<AccountsViewProps> = {}) =>
      render(
        <AccountsView
          {...props}
          views={[meta]}
          usage={{ meta: [{ profileName: "Work", windows: [], note: "pay as you go" }, { profileName: "Meta key …9QzT", windows: [], expired: true, note: "key revoked" }] }}
          headroom={{ meta: { Work: { room: 0.8, ratePerMin: 4, resetsAt: NOW + HOUR } as never } }}
          {...extra}
        />,
      );

    it("leads with Add key…, never a sign-in, and has no section menu", () => {
      keyed();
      const section = screen.getByRole("region", { name: "Meta Model API" });
      expect(within(section).queryByRole("button", { name: /Sign in|Add account/ })).toBeNull();
      expect(within(section).queryByRole("button", { name: "Meta Model API actions" })).toBeNull();
      fireEvent.click(within(section).getByRole("button", { name: "Add key…" }));
      expect(props.onAddKey).toHaveBeenCalledWith("meta");
    });

    it("shows each key masked from its account id, and its state in the status column", () => {
      keyed();
      expect(screen.getByText("LLM_1607…")).toBeTruthy();
      expect(screen.getByText("LLM_2214…")).toBeTruthy();
      expect(document.body.textContent).not.toContain("1607339912");
      expect(screen.getByText("Pay as you go").className).toContain("text-muted-foreground");
      expect(screen.getByText("Key revoked").className).toContain("text-warning");
      // Never the lapsed-token line a static profile would otherwise get.
      expect(screen.queryByText(/One-year token/)).toBeNull();
    });

    it("keeps the rate bar and draws no usage windows", () => {
      keyed();
      expect(screen.getByRole("button", { name: "Usage details for Work" })).toBeTruthy();
      expect(screen.getAllByRole("progressbar")).toHaveLength(1);
      expect(screen.getByRole("progressbar").getAttribute("aria-label")).toMatch(/^Rate/);
    });

    it("has no switch, and its menu is Remove alone", () => {
      keyed();
      expect(screen.queryByRole("switch")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "More actions for Work" }));
      expect(screen.getAllByRole("menuitem").map((m) => m.textContent)).toEqual(["Remove…"]);
      fireEvent.click(screen.getByRole("menuitem", { name: "Remove…" }));
      const dialog = screen.getByRole("alertdialog");
      expect(within(dialog).getByText("The key is deleted from every host. Adding it again brings it back.")).toBeTruthy();
      fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
      expect(props.onDelete).toHaveBeenCalledWith("meta", "Work");
    });

    it("offers no refreshing host, and an empty one says No keys saved", () => {
      keyed({ views: [{ ...meta, profiles: [] }] });
      const section = screen.getByRole("region", { name: "Meta Model API" });
      expect(within(section).getByText("No keys saved").getAttribute("data-slot")).toBe("page-empty");
      expect(section.querySelector("[data-slot=empty]")).toBeNull();
      expect(within(section).queryByRole("button", { name: "Meta Model API actions" })).toBeNull();
    });
  });

  describe("when each window resets", () => {
    // Local times: whether a reset falls inside today is the local calendar's.
    const now = new Date(2026, 10, 5, 10, 0).getTime();
    const today = new Date(2026, 10, 5, 16, 15).getTime();
    const thursday = new Date(2026, 10, 12, 9, 0).getTime() - 24 * HOUR;
    const resets = () => Array.from(document.querySelectorAll('[data-slot="reset-time"]')).map((el) => el.textContent);
    const windows = (...w: UsageReport["windows"]) => ({ "claude-code": [{ profileName: "a@x.com", windows: w }] });

    it("says a clock time inside today and the weekday past it, one under each bar", () => {
      render(
        <AccountsView
          {...props}
          now={now}
          usage={windows(
            { label: "5h", usedPercent: 30, resetsAt: today, periodMs: 5 * HOUR },
            { label: "Weekly", usedPercent: 50, resetsAt: thursday, periodMs: 168 * HOUR },
          )}
        />,
      );
      expect(resets()).toEqual([`Resets ${clockTime(today)}`, `Resets ${dayClockTime(thursday, now)}`]);
      const cells = Array.from(document.querySelectorAll('[data-slot="usage-cell"]'));
      expect(cells[0].querySelector('[data-slot="reset-time"]')).toBeTruthy();
      expect(cells[1].querySelector('[data-slot="reset-time"]')).toBeTruthy();
    });

    it("says nothing for a window that names no reset, or one whose reset passed", () => {
      render(
        <AccountsView
          {...props}
          now={now}
          usage={windows({ label: "5h", usedPercent: 30, periodMs: 5 * HOUR }, { label: "Weekly", usedPercent: 50, resetsAt: now - 1, periodMs: 168 * HOUR })}
        />,
      );
      expect(resets()).toEqual([]);
      expect(screen.queryByText(/^Resets/)).toBeNull();
    });

    it("holds how long until the reset for the hover", async () => {
      await act(async () => {
        await tooltipChunk.load();
        warmTooltips();
      });
      render(<AccountsView {...props} now={now} usage={windows({ label: "5h", usedPercent: 30, resetsAt: now + 2 * HOUR + 10 * 60_000, periodMs: 5 * HOUR })} />);
      const el = document.querySelector('[data-slot="reset-time"]')!;
      fireEvent.pointerEnter(el);
      fireEvent.mouseEnter(el);
      fireEvent.focus(el);
      await waitFor(() => expect(document.querySelector('[data-slot="tooltip-content"]')?.textContent).toBe("in 2h 10m"), { timeout: 2000 });
    });

    it("says Limited in amber with the latest reset once every window is spent", () => {
      render(
        <AccountsView
          {...props}
          now={now}
          usage={windows(
            { label: "5h", usedPercent: 100, resetsAt: today, periodMs: 5 * HOUR },
            { label: "Weekly", usedPercent: 100, resetsAt: thursday, periodMs: 168 * HOUR },
          )}
        />,
      );
      const mark = document.querySelector('[data-slot="status-mark"]') as HTMLElement;
      expect(mark.className).toContain("text-warning");
      expect(mark.querySelector('[data-slot="status-word"]')?.textContent).toBe("Limited");
      expect(mark.querySelector('[data-slot="status-detail"]')?.textContent).toBe(`Resets ${dayClockTime(thursday, now)}`);
      // No glyph: Limited is not Needs you.
      expect(mark.querySelector("svg")).toBeNull();
    });

    it("says Limited alone when what binds it names no time", () => {
      render(<AccountsView {...props} now={now} usage={{ "claude-code": [{ profileName: "a@x.com", windows: [], rateLimit: { provider: "claude" } }] }} />);
      const mark = document.querySelector('[data-slot="status-mark"]') as HTMLElement;
      expect(mark.textContent).toBe("Limited");
    });
  });

  describe("the table", () => {
    it("is one container, every row a table line from 48rem and stacked under it", () => {
      render(<AccountsView {...props} />);
      const page = document.querySelector('[data-slot="accounts"]') as HTMLElement;
      expect(page.className).toContain("@container/accounts");
      const row = screen.getByText("Main").closest('[data-slot="page-row"]') as HTMLElement;
      // Narrow: the actions box unwraps and the columns take a line of their own under the name.
      expect(row.className).toContain("@max-3xl/accounts:[&>[data-slot=item-actions]]:contents");
      const cells = row.querySelector('[data-slot="usage-cells"]') as HTMLElement;
      expect(cells.className).toContain("basis-full");
      expect(cells.className).toContain("ps-5");
      // Wide: back in the line, each column 8.5rem.
      expect(cells.className).toContain("@3xl/accounts:basis-auto");
      const cell = cells.querySelector('[data-slot="usage-cell"]') as HTMLElement;
      expect(cell.className).toContain("flex-1");
      expect(cell.className).toContain("@3xl/accounts:w-34");
    });

    it("lays the same columns in every row of the page: window columns, then Rate, then the controls", () => {
      const meta: ServiceView = {
        id: "meta",
        name: "Meta Model API",
        installed: true,
        canAddAccount: false,
        canSaveCurrent: false,
        switchTargets: [],
        profiles: [{ name: "Work", createdAt: 1, active: false, static: true, kind: "key", accountId: "1607339912" } as KeyProfileView],
      };
      render(
        <AccountsView
          {...props}
          views={[...services(), meta]}
          usage={{ "claude-code": [report], meta: [{ profileName: "Work", windows: [], note: "pay as you go" }] }}
          headroom={{ "claude-code": { "a@x.com": { room: 0.4, ratePerMin: 2 } as never }, meta: { Work: { room: 0.9, ratePerMin: 1 } as never } }}
        />,
      );
      const rowOf = (name: string) => screen.getByText(name).closest('[data-slot="page-row"]') as HTMLElement;
      const main = rowOf("Main").querySelectorAll('[data-slot="usage-cell"]');
      expect(main).toHaveLength(3);
      // The key's words stand in for the two window columns; its switch's place is kept.
      const status = screen.getByText("Pay as you go");
      expect(status.style.getPropertyValue("--span")).toBe("2");
      expect(rowOf("Work").querySelectorAll('[data-slot="usage-cell"]')).toHaveLength(1);
      expect(rowOf("Work").querySelector('[data-slot="account-controls"] > span[aria-hidden]')?.className).toContain("w-8");
    });
  });

  it("renders the page fixture on the table width, the limited account saying so", () => {
    for (const f of PREVIEW_FIXTURES) {
      const { container, unmount } = render(<AccountsPagePreview {...(f.props as unknown as AccountsViewProps)} />);
      expect(container.querySelector('[data-slot="page"]')?.getAttribute("data-width")).toBe("table");
      const burst = screen.getByText("Burst").closest('[data-slot="page-row"]') as HTMLElement;
      expect(burst.querySelector('[data-slot="status-word"]')?.textContent).toBe("Limited");
      unmount();
    }
  });
});

describe("an account row's two facts on a line", () => {
  it("tells the state from its detail by weight and colour, 4px apart, and says the plan as its name then one sentence", () => {
    const DAY = 24 * HOUR;
    props.views[0].profiles[0] = { ...props.views[0].profiles[0], static: true, expiresAt: NOW + 200 * DAY } as never;
    props.usage = { "claude-code": [{ ...report, plan: { name: "Max 20x", monthlyUsd: 200, renewsAt: NOW + 7 * DAY } }] };
    render(<AccountsView {...props} />);
    const row = screen.getAllByRole("switch")[0].closest("[data-slot=page-row]") as HTMLElement;
    const state = within(row).getByText("One-year token");
    expect(state.className).toContain("font-medium");
    const detail = within(row).getByText(/^lapses /);
    expect(detail.className).toContain("text-muted-foreground");
    expect(detail.className).not.toContain("font-medium");
    expect(state.parentElement!.className).toContain("gap-x-1");
    expect(within(row).getByText("Max 20x").className).toContain("font-medium");
    expect(row.querySelector("[data-slot=plan-line]")!.textContent).toMatch(/^Max 20x \$200\/mo, renews /);
    const description = row.querySelector("[data-slot=item-description]")!;
    expect(description.querySelector(".gap-2, .gap-x-2")).toBeNull();
  });
});

describe("AccountsSkeleton", () => {
  it("draws each heading on PageSection's 20px line, 8px above its rows", () => {
    const { container } = render(<AccountsSkeleton />);
    const headings = container.querySelectorAll("[data-slot=heading-skeleton]");
    expect(headings).toHaveLength(3);
    for (const h of headings) {
      expect(h.className).toContain("h-5");
      expect((h.nextElementSibling as HTMLElement).className).toContain("mt-2");
    }
  });
});
