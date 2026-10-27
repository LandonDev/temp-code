// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_INBOX_FILTERS, type InboxFilters } from "../lib/inboxFilters";
import { resetMenus } from "./menuRows";

vi.mock("./ProjectLogoIcon", () => ({ ProjectLogoIcon: () => <svg data-testid="logo" /> }));

import { InboxFiltersMenu } from "./InboxFiltersMenu";

afterEach(cleanup);
beforeEach(() => resetMenus());

function mount(filters: InboxFilters = DEFAULT_INBOX_FILTERS, onChange = vi.fn()) {
  render(
    <InboxFiltersMenu
      trigger={<button type="button">Filters</button>}
      workspaces={[{ id: "w1", name: "temp-code", logoPath: null }]}
      source="github"
      filters={filters}
      onChange={onChange}
    />,
  );
  return onChange;
}

async function open() {
  fireEvent.click(screen.getByRole("button", { name: "Filters" }));
  return screen.findByRole("menu", { name: "Filter inbox" });
}

describe("InboxFiltersMenu", () => {
  it("opens from its trigger with the filters as checked rows, each with a glyph", async () => {
    mount();
    const menu = await open();
    expect(within(menu).getByRole("menuitemcheckbox", { name: "All time" }).getAttribute("aria-checked")).toBe("true");
    expect(within(menu).getByRole("menuitemcheckbox", { name: "Last 7 days" }).getAttribute("aria-checked")).toBe("false");
    for (const row of within(menu).getAllByRole("menuitemcheckbox")) {
      expect(row.querySelector("svg")).toBeTruthy();
    }
    expect(within(menu).queryByRole("menuitem", { name: "Clear filters" })).toBeNull();
  });

  it("a pick changes the filters and leaves the menu open for the next", async () => {
    const onChange = mount();
    const menu = await open();
    fireEvent.click(within(menu).getByRole("menuitemcheckbox", { name: "Last 7 days" }));
    expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_INBOX_FILTERS, time: "7d" });
    fireEvent.click(within(menu).getByRole("menuitemcheckbox", { name: "temp-code" }));
    expect(onChange).toHaveBeenLastCalledWith({ ...DEFAULT_INBOX_FILTERS, hiddenWorkspaceIds: ["w1"] });
    expect(screen.getByRole("menu", { name: "Filter inbox" })).toBeTruthy();
  });

  it("Clear filters resets them; Escape closes", async () => {
    const onChange = mount({ ...DEFAULT_INBOX_FILTERS, time: "today" });
    const menu = await open();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Clear filters" }));
    expect(onChange).toHaveBeenCalledWith(DEFAULT_INBOX_FILTERS);
    await waitFor(() => expect(screen.queryByRole("menu", { name: "Filter inbox" })).toBeNull());
    const again = await open();
    fireEvent.keyDown(again, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu", { name: "Filter inbox" })).toBeNull());
  });
});
