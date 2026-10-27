// @vitest-environment jsdom
/**
 * The HTML page viewer: a full-window Dialog, the page filling it, one
 * close button over the page holding focus, no title bar, the title kept
 * for assistive tech only. Escape from inside the page closes it. App's mount point loads it only once a page
 * first opens, so the Dialog stays out of the first paint.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const page = vi.hoisted(() => ({ onEscape: undefined as (() => void) | undefined }));
vi.mock("./HtmlRenderFrame", () => ({
  HtmlRenderDocument: (props: { src: string; title: string; className?: string; onEscape?: () => void }) => {
    page.onEscape = props.onEscape;
    return <iframe data-testid="page" src={props.src} title={props.title} className={props.className} />;
  },
}));
vi.mock("./chunks", () => ({
  htmlRenderChunk: { surface: () => () => <div data-testid="viewer" /> },
}));

import { HtmlRenderOverlay } from "./HtmlRenderOverlay";
import { HtmlRenderViewer } from "./HtmlRenderViewer";
import { closeHtmlRenderOverlay, isHtmlRenderOverlayOpen, openHtmlRenderOverlay } from "./htmlRenderOverlayStore";

const reference = { pageId: "p1", title: "Build times" } as Parameters<typeof openHtmlRenderOverlay>[0];

afterEach(() => {
  act(() => closeHtmlRenderOverlay());
  cleanup();
});

describe("HtmlRenderViewer", () => {
  it("opens from the store with the page, one close button and no title bar", () => {
    render(<HtmlRenderViewer />);
    expect(screen.queryByRole("dialog")).toBeNull();
    act(() => openHtmlRenderOverlay(reference));
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("data-size")).toBe("full");
    // The window less the Dialog's own inset, like the lightbox: no width cap.
    expect(dialog.className).not.toContain("max-w-6xl");
    expect(screen.getByTestId("page").getAttribute("title")).toBe("Build times");
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Close page" })).toBeTruthy();
    // The title names the dialog but is visually hidden: no bar above the page.
    const title = screen.getByRole("heading", { name: "Build times" });
    expect(title.className).toContain("sr-only");
    expect(dialog.getAttribute("aria-labelledby")).toBe(title.id);
  });

  it("the close button and Escape close the store", async () => {
    render(<HtmlRenderViewer />);
    act(() => openHtmlRenderOverlay(reference));
    fireEvent.click(screen.getByRole("button", { name: "Close page" }));
    expect(isHtmlRenderOverlayOpen()).toBe(false);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    act(() => openHtmlRenderOverlay(reference));
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(isHtmlRenderOverlayOpen()).toBe(false);
  });

  it("closes on the page's own Escape", () => {
    render(<HtmlRenderViewer />);
    act(() => openHtmlRenderOverlay(reference));
    act(() => page.onEscape?.());
    expect(isHtmlRenderOverlayOpen()).toBe(false);
  });

  it("opens with focus on Close and gives it back to the opener", async () => {
    render(
      <>
        <button type="button" onClick={() => openHtmlRenderOverlay(reference)}>
          Open page
        </button>
        <HtmlRenderViewer />
      </>,
    );
    const opener = screen.getByRole("button", { name: "Open page" });
    opener.focus();
    fireEvent.click(opener);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close page" })));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });
});

describe("HtmlRenderOverlay", () => {
  it("mounts the viewer only once a page opens, and keeps it for the exit", () => {
    render(<HtmlRenderOverlay />);
    expect(screen.queryByTestId("viewer")).toBeNull();
    act(() => openHtmlRenderOverlay(reference));
    expect(screen.getByTestId("viewer")).toBeTruthy();
    act(() => closeHtmlRenderOverlay());
    expect(screen.getByTestId("viewer")).toBeTruthy();
  });
});
