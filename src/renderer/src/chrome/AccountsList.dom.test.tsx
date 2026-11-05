// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { PlanInfo } from "aliax-core/shared/types";
import type { ProviderAccounts } from "@server/shared/accounts";
import { planFacts } from "../aliax/views/accounts/usage";
import { AccountsList } from "./AccountsList";

afterEach(cleanup);

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const now = 10 * DAY;

const base = { pinned: null, owner: "temp-code", reports: [] } as const;

function list(accounts: ProviderAccounts, provider: "claude" | "meta" = "claude") {
  render(<AccountsList provider={provider} accounts={accounts} scope={null} now={now} />);
  return screen.getByRole("listbox", { name: `${provider} accounts` });
}

describe("AccountsList", () => {
  it("draws each window with the page's Progress bar and the page's window names", () => {
    const box = list({
      ...base,
      profiles: [{ name: "a", email: "a@example.com" }],
      reports: [
        {
          profileName: "a",
          windows: [
            { label: "5h", usedPercent: 40, resetsAt: now + 2 * HOUR, periodMs: 5 * HOUR },
            { label: "week", usedPercent: 20, resetsAt: now + 3 * DAY, periodMs: 7 * DAY },
          ],
        },
      ],
    } as unknown as ProviderAccounts);
    expect(box.querySelectorAll("[data-slot=progress]")).toHaveLength(2);
    expect(within(box).getByText("Week")).toBeTruthy();
    expect(within(box).queryByText("week")).toBeNull();
    // Read-only: no button, no detail popover inside the picker.
    expect(within(box).queryByRole("button")).toBeNull();
    // When a window resets is the page's clock time; how long until then is the hover's.
    expect(box.querySelector("[data-slot=reset-time]")!.textContent).toMatch(/^Resets /);
  });

  it("says a duplicate as the page does, never as a word beside the name", () => {
    const box = list({ ...base, profiles: [{ name: "a", email: "a@example.com", duplicate: true }] } as unknown as ProviderAccounts);
    expect(within(box).queryByText("duplicate")).toBeNull();
    expect(within(box).getByText("Same sign-in as another saved account").closest(".text-warning")).toBeTruthy();
  });

  it("says the plan in the page's words and case", () => {
    const plan: PlanInfo = { name: "Max 20x", monthlyUsd: 200, cancelsAt: now + 3 * DAY } as PlanInfo;
    const box = list({ ...base, profiles: [{ name: "a" }], reports: [{ profileName: "a", windows: [], plan, banked: 2 }] } as unknown as ProviderAccounts);
    const facts = box.querySelector("[data-slot=account-facts]")!;
    for (const f of planFacts(plan, 2)) expect(within(facts as HTMLElement).getByText(f.text)).toBeTruthy();
    expect(within(facts as HTMLElement).getByText("Canceled").className).toContain("text-warning");
    expect(facts.textContent).not.toContain("canceled");
  });

  it("says a rate-limited account as Limited with when it lifts, and an empty one in the page's words", () => {
    const box = list({
      ...base,
      profiles: [{ name: "a" }],
      reports: [{ profileName: "a", windows: [], rateLimit: { until: now + 2 * HOUR } }],
    } as unknown as ProviderAccounts);
    expect(within(box).getByText("Limited")).toBeTruthy();
    expect(within(box).queryByText(/Usage rate limited/)).toBeNull();
    expect(within(box).getByText("No usage yet")).toBeTruthy();
    expect(within(box).queryByText("No usage recorded yet")).toBeNull();
  });

  it("insets its rows 12px, on the grid", () => {
    const box = list({ ...base, profiles: [{ name: "a" }] } as unknown as ProviderAccounts);
    const row = within(box).getByRole("option");
    expect(row.className).toContain("px-3");
    expect(row.className).not.toMatch(/\b(px|py|gap)-2\.5\b/);
  });

  it("lists a Meta key with its state and the Rate bar where the gateways saw it, a revoked one in amber", () => {
    const box = list(
      {
        ...base,
        profiles: [
          { name: "Work", createdAt: 1, active: false, static: true, kind: "key" },
          { name: "Old", createdAt: 2, active: false, static: true, kind: "key" },
        ],
        reports: [
          { profileName: "Work", windows: [], note: "pay as you go" },
          { profileName: "Old", windows: [], expired: true, note: "key revoked" },
        ],
        headroom: { Work: { room: 0.8, ratePerMin: 4, seenAt: now } },
      } as unknown as ProviderAccounts,
      "meta",
    );
    const [work, old] = within(box).getAllByRole("option");
    expect(within(box).getAllByRole("progressbar").map((b) => b.getAttribute("aria-label"))).toEqual([expect.stringMatching(/^Rate/)]);
    expect(within(work).getByText("Pay as you go")).toBeTruthy();
    expect(within(old).getByText("Key revoked").className).toContain("text-warning");
  });
});
