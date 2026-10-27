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

function Harness({ onOpenChange, list = accounts }: { onOpenChange: (open: boolean) => void; list?: ProviderAccounts }) {
  const [open, setOpen] = useState(false);
  return (
    <AccountsPopover
      trigger={<button type="button">Pick another account</button>}
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        onOpenChange(next);
      }}
      provider="claude"
      accounts={list}
      scope={scope}
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
    expect(list.textContent).toContain("Auto · picked by model");
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
});
