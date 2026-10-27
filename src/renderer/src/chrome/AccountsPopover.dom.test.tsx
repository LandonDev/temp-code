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

function Harness({ onOpenChange }: { onOpenChange: (open: boolean) => void }) {
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
      accounts={accounts}
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
