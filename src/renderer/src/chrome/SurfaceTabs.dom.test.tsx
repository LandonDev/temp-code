// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { FilePaneTab } from "../lib/layout";
import { SurfaceTabs } from "./SurfaceTabs";

const file = (id: string, path: string, extra: Partial<FilePaneTab> = {}): FilePaneTab => ({
  id,
  path,
  cwd: "/repo",
  ...extra,
});

const APP = file("app", "/repo/src/app.ts");
const STORE = file("store", "/repo/src/store.ts");
const REVIEW = file("review", "/repo/src/diff.ts", { review: true });

function strip(overrides: Partial<Parameters<typeof SurfaceTabs>[0]> = {}) {
  const props = {
    files: [APP, STORE, REVIEW],
    activeFileId: "app",
    dirtyFileIds: new Set<string>(),
    fileErrorCounts: new Map<string, number>(),
    onSelectFile: vi.fn(),
    onCloseFile: vi.fn(),
    onReorder: vi.fn(),
    ...overrides,
  };
  render(<SurfaceTabs {...props} />);
  return props;
}

const tab = (name: string) => screen.getByRole("tab", { name: new RegExp(name) });
const wrapperOf = (name: string) => tab(name).parentElement as HTMLElement;

beforeAll(() => {
  // jsdom has no layout; the strip scrolls its active tab into view.
  Element.prototype.scrollIntoView ??= () => {};
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
});
afterEach(cleanup);

describe("SurfaceTabs", () => {
  it("marks the active tab selected and no other", () => {
    strip();
    expect(tab("app.ts").getAttribute("aria-selected")).toBe("true");
    expect(tab("store.ts").getAttribute("aria-selected")).toBe("false");
  });

  it("shows a dirty tab's dot, and its close button on hover", () => {
    strip({ dirtyFileIds: new Set(["store"]) });
    expect(screen.getByRole("img", { name: "Unsaved changes" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Close store.ts" })).toBeNull();

    fireEvent.mouseEnter(wrapperOf("store.ts"));
    expect(screen.getByRole("button", { name: "Close store.ts" })).toBeTruthy();
    expect(screen.queryByRole("img", { name: "Unsaved changes" })).toBeNull();

    fireEvent.mouseLeave(wrapperOf("store.ts"));
    expect(screen.getByRole("img", { name: "Unsaved changes" })).toBeTruthy();
  });

  it("offers close on the active tab without a hover", () => {
    strip();
    expect(screen.getByRole("button", { name: "Close app.ts" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Close store.ts" })).toBeNull();
  });

  it("keeps the dirty dot on the active tab until it is hovered", () => {
    strip({ dirtyFileIds: new Set(["app"]) });
    expect(screen.getByRole("img", { name: "Unsaved changes" })).toBeTruthy();
    fireEvent.mouseEnter(wrapperOf("app.ts"));
    expect(screen.getByRole("button", { name: "Close app.ts" })).toBeTruthy();
  });

  it("calls onClose from the close button without selecting the tab", () => {
    const props = strip();
    fireEvent.mouseEnter(wrapperOf("store.ts"));
    const close = screen.getByRole("button", { name: "Close store.ts" });
    fireEvent.pointerDown(close, { button: 0 });
    fireEvent.click(close);
    expect(props.onCloseFile).toHaveBeenCalledWith("store");
    expect(props.onSelectFile).not.toHaveBeenCalled();
  });

  it("selects a tab on press", () => {
    const props = strip();
    fireEvent.pointerDown(tab("store.ts"), { button: 0 });
    expect(props.onSelectFile).toHaveBeenCalledWith("store");
  });

  it("prints no change counts in any tab", () => {
    strip({ files: [APP, STORE, REVIEW] });
    for (const el of screen.getAllByRole("tab")) {
      expect(el.textContent).not.toMatch(/[+−-]\d/);
    }
  });

  it("sets a review tab's name in italic", () => {
    strip();
    const name = screen.getByText(/^diff\.ts/);
    expect(name.className).toMatch(/\bitalic\b/);
    expect(screen.getByText("app.ts").className).not.toMatch(/\bitalic\b/);
  });

  it("uses no title attributes for its hover labels", () => {
    const { container } = render(
      <SurfaceTabs
        files={[APP, STORE]}
        activeFileId="app"
        dirtyFileIds={new Set(["store"])}
        fileErrorCounts={new Map([["app", 2]])}
        onSelectFile={() => {}}
        onCloseFile={() => {}}
        onReorder={() => {}}
        onPaneDragStart={() => {}}
      />,
    );
    expect(container.querySelector("[title]")).toBeNull();
  });
});
