// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MenuBar } from "./MenuBar";

afterEach(cleanup);

const openBar = () =>
  act(() => {
    fireEvent.keyDown(window, { key: "Alt" });
    fireEvent.keyUp(window, { key: "Alt" });
  });

describe("MenuBar", () => {
  it("draws no Terminal menu and no terminal rows without their handlers (the page at /ui)", () => {
    render(<MenuBar onNew={() => {}} />);
    openBar();
    expect(screen.queryByText("Terminal")).toBeNull();
    fireEvent.click(screen.getByText("File"));
    expect(screen.queryByText("New Terminal")).toBeNull();
    expect(screen.getByText("New Tab")).toBeTruthy();
  });

  it("keeps the Terminal menu with a handler", () => {
    render(<MenuBar onNew={() => {}} onNewTerminal={() => {}} onToggleTerminal={() => {}} />);
    openBar();
    expect(screen.getByText("Terminal")).toBeTruthy();
  });
});
