// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderAccounts } from "@server/shared/accounts";
import type { AccountScope } from "../lib/accountScope";
import { AccountsPopover } from "./AccountsPopover";
import { resetMenus } from "./menuRows";

afterEach(cleanup);
beforeEach(() => resetMenus());

const accounts = {
  pinned: null,
  owner: "temp-code",
  profiles: [
    { name: "a", email: "a@example.com" },
    { name: "b", email: "b@example.com" },
  ],
  reports: [],
} as unknown as ProviderAccounts;

const scope: AccountScope = { provider: "claude", inherited: null, current: "b", shown: "b" };

function Harness({
  onOpenChange,
  list = accounts,
  provider = "claude",
  at = scope,
}: {
  onOpenChange: (open: boolean) => void;
  list?: ProviderAccounts;
  provider?: "claude" | "meta";
  at?: AccountScope;
}) {
  const [open, setOpen] = useState(false);
  return (
    <AccountsPopover
      trigger={<button type="button">Pick another account</button>}
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        onOpenChange(next);
      }}
      provider={provider}
      accounts={list}
      scope={at}
      now={0}
    />
  );
}

describe("AccountsPopover", () => {
  it("opens from its trigger on the accounts, the one in use selected; Escape closes", async () => {
    const onOpenChange = vi.fn();
    render(<Harness onOpenChange={onOpenChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Pick another account" }));
    expect(onOpenChange).toHaveBeenCalledWith(true);
    const list = await screen.findByRole("listbox", { name: "claude accounts" });
    const options = within(list).getAllByRole("option");
    expect(options.map((o) => o.getAttribute("aria-selected"))).toEqual(["false", "true"]);
    expect(list.textContent).toContain("Auto, picked by model");
    fireEvent.keyDown(list, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("listbox", { name: "claude accounts" })).toBeNull());
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });
});

describe("an account row's lines", () => {
  it("sets two facts on one line apart by margin, never a middle dot", async () => {
    const DAY = 86_400_000;
    const withPlan = {
      ...accounts,
      reports: [
        {
          profileName: "a",
          windows: [],
          plan: { name: "Max 20x", monthlyUsd: 200, cancelsAt: 3 * DAY },
          rateLimit: { until: 2 * 3_600_000 },
        },
      ],
    } as unknown as ProviderAccounts;
    render(<Harness onOpenChange={() => {}} list={withPlan} />);
    fireEvent.click(screen.getByRole("button", { name: "Pick another account" }));
    const list = await screen.findByRole("listbox", { name: "claude accounts" });
    const row = within(list).getAllByRole("option")[0];
    const plan = within(row).getByText("Max 20x").parentElement!;
    expect(Array.from(plan.children, (c) => c.textContent)).toEqual(["Max 20x", "$200/mo", "canceled", expect.stringMatching(/^ends /)]);
    expect(plan.className).toContain("gap-2");
    expect(within(plan).getByText("canceled").className).toContain("text-warning");
    const limited = within(row).getByText("Usage rate limited").parentElement!;
    expect(limited.children).toHaveLength(2);
    expect(limited.children[1].textContent).toMatch(/ left$/);
    expect(row.textContent).not.toContain("·");
  });

  it("says a window's refill once, the countdown, and leaves the moment to the hover", async () => {
    const list = {
      ...accounts,
      reports: [{ profileName: "a", windows: [{ label: "5h", usedPercent: 40, resetsAt: 2 * 3_600_000 + 90_000, periodMs: 5 * 3_600_000 }] }],
    } as unknown as ProviderAccounts;
    render(<Harness onOpenChange={() => {}} list={list} />);
    fireEvent.click(screen.getByRole("button", { name: "Pick another account" }));
    const listbox = await screen.findByRole("listbox", { name: "claude accounts" });
    const cell = listbox.querySelector("[data-cell]")!;
    expect(cell.textContent).toContain("in 2h 1m");
    expect(cell.textContent).not.toMatch(/AM|PM/);
  });
});

describe("a Meta thread's keys", () => {
  it("lists the keys with no usage bars, the headroom bar where the gateways saw a key, and a revoked one in amber", async () => {
    const keys = {
      pinned: null,
      owner: "temp-code",
      profiles: [
        { name: "Work", createdAt: 1, active: false, static: true, kind: "key" },
        { name: "Old", createdAt: 2, active: false, static: true, kind: "key" },
      ],
      reports: [
        { profileName: "Work", windows: [], note: "pay as you go" },
        { profileName: "Old", windows: [], expired: true, note: "key revoked" },
      ],
      headroom: { Work: { room: 0.8, ratePerMin: 4, seenAt: 0 } },
    } as unknown as ProviderAccounts;
    const metaScope: AccountScope = { provider: "meta", inherited: null, current: "Work", shown: "Work" };
    render(<Harness onOpenChange={() => {}} list={keys} provider="meta" at={metaScope} />);
    fireEvent.click(screen.getByRole("button", { name: "Pick another account" }));
    const list = await screen.findByRole("listbox", { name: "meta accounts" });
    const [work, old] = within(list).getAllByRole("option");
    expect(work.getAttribute("aria-selected")).toBe("true");
    expect(within(list).getAllByRole("progressbar").map((b) => b.getAttribute("aria-label"))).toEqual([expect.stringMatching(/^Headroom/)]);
    expect(within(work).queryByText(/pay as you go|Usage unavailable|Session expired/i)).toBeNull();
    expect(within(old).getByText("Key revoked").parentElement!.className).toContain("text-warning");
    expect(list.textContent).not.toContain("sign in again");
  });
});


describe("a window's colour", () => {
  it("is the Accounts page's: room muted, running low amber, never green or red", async () => {
    const HOUR = 3_600_000;
    const list = {
      ...accounts,
      reports: [
        { profileName: "a", windows: [{ label: "5h", usedPercent: 97, resetsAt: 4 * HOUR, periodMs: 5 * HOUR }] },
        { profileName: "b", windows: [{ label: "5h", usedPercent: 10, resetsAt: 4 * HOUR, periodMs: 5 * HOUR }] },
      ],
    } as unknown as ProviderAccounts;
    render(<Harness onOpenChange={() => {}} list={list} />);
    fireEvent.click(screen.getByRole("button", { name: "Pick another account" }));
    const listbox = await screen.findByRole("listbox", { name: "claude accounts" });
    const picker = listbox.closest("[data-account-picker]") ?? listbox;
    expect(picker.querySelector(".text-danger, .bg-danger, .text-success, .bg-success, .text-destructive, .bg-destructive")).toBeNull();
    const [low, roomy] = within(listbox).getAllByRole("option");
    expect(within(low).getByText("3%").className).toContain("text-warning");
    expect(within(roomy).getByText("90%").className).toContain("text-muted-foreground");
  });
});
