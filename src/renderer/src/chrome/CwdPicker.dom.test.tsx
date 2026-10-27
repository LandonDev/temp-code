// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetMenus } from "./menuRows";

vi.mock("./ProjectLogoIcon", () => ({ ProjectLogoIcon: () => <svg data-testid="logo" /> }));

import { CwdPicker } from "./CwdPicker";

afterEach(cleanup);
beforeEach(() => resetMenus());

const recents = ["/u/me/a", "/u/me/b", "/u/me/c", "/u/me/d", "/u/me/e", "/u/me/f", "/u/me/g"].map((path, i) => ({ path, openedAt: i }));

function mount(over: Partial<Parameters<typeof CwdPicker>[0]> = {}) {
  const props = { onCwdChange: vi.fn(), onNewTerminal: vi.fn(), onClose: vi.fn() };
  render(<CwdPicker cwd="/u/me/now" recents={recents} {...props} {...over} />);
  return props;
}

async function open() {
  fireEvent.click(screen.getByRole("button", { name: /^Project / }));
  return screen.findByRole("menu", { name: "Project picker" });
}

describe("CwdPicker", () => {
  it("opens on the current project ticked, five recents, More projects and New terminal", async () => {
    mount();
    const menu = await open();
    expect(within(menu).getByText("Current project")).toBeTruthy();
    expect(within(menu).getByRole("menuitemcheckbox", { name: /now/ }).getAttribute("aria-checked")).toBe("true");
    const recent = within(menu).getAllByRole("menuitemcheckbox").filter((row) => row.getAttribute("aria-checked") === "false");
    expect(recent).toHaveLength(5);
    expect(within(menu).getByRole("menuitem", { name: "More projects" })).toBeTruthy();
    expect(within(menu).getByRole("menuitem", { name: /New terminal/ }).querySelector("kbd")).toBeTruthy();
  });

  it("a recent project, one under More projects and New terminal each call their handler", async () => {
    const props = mount();
    let menu = await open();
    fireEvent.click(within(menu).getByRole("menuitemcheckbox", { name: /^b/ }));
    expect(props.onCwdChange).toHaveBeenCalledWith("/u/me/b");
    expect(props.onClose).toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("menu", { name: "Project picker" })).toBeNull());
    menu = await open();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "More projects" }));
    fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: /^g/ }));
    expect(props.onCwdChange).toHaveBeenLastCalledWith("/u/me/g");
    await waitFor(() => expect(screen.queryByRole("menu", { name: "Project picker" })).toBeNull());
    menu = await open();
    fireEvent.click(within(menu).getByRole("menuitem", { name: /New terminal/ }));
    expect(props.onNewTerminal).toHaveBeenCalled();
  });

  it("Escape closes and hands the focus back", async () => {
    const props = mount();
    const menu = await open();
    fireEvent.keyDown(menu, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu", { name: "Project picker" })).toBeNull());
    expect(props.onClose).toHaveBeenCalled();
  });

  it("a disabled picker does not open", () => {
    mount({ enabled: false });
    expect((screen.getByRole("button", { name: /^Project / }) as HTMLButtonElement).disabled).toBe(true);
  });
});
