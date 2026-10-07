// @vitest-environment jsdom
import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HTML_RENDER_MAX_HEIGHT } from "@shared/htmlRender";
import { SCHEME_CHANGE_EVENT } from "../lib/appearance";
import { HtmlRenderRow } from "./HtmlRenderFrame";

const reference = {
  sessionId: "sess",
  pageId: "page1234567890ab",
  title: "Chart",
  height: HTML_RENDER_MAX_HEIGHT,
  heights: [
    [320, 500],
    [864, 410],
  ] as const,
};

const sizeChanged = (height: number) => ({
  jsonrpc: "2.0",
  method: "ui/notifications/size-changed",
  params: { height },
});

afterEach(() => {
  document.documentElement.classList.remove("theme-light");
});

describe("HtmlRenderRow", () => {
  it("mounts a sandboxed frame at the measured height for the column, never same-origin", () => {
    const { container } = render(<HtmlRenderRow reference={reference} />);
    const frame = container.querySelector("iframe")!;
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts allow-forms");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-same-origin");
    expect(frame.getAttribute("src")).toMatch(/^tempcode-asset:\/\/page\/sess\/page1234567890ab\.html#tc-theme=/);
    expect(frame.getAttribute("title")).toBe("Chart");
    const box = container.firstElementChild as HTMLElement;
    expect(box.style.height).toBe("410px");
  });

  it("follows a size-changed message from its own window and ignores one from elsewhere", () => {
    const { container } = render(<HtmlRenderRow reference={reference} />);
    const frame = container.querySelector("iframe")!;
    const box = container.firstElementChild as HTMLElement;
    act(() => {
      window.dispatchEvent(new MessageEvent("message", { data: sizeChanged(777), source: window }));
    });
    expect(box.style.height).toBe("410px");
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", { data: sizeChanged(777), source: frame.contentWindow }),
      );
    });
    expect(box.style.height).toBe("777px");
  });

  it("posts the theme into the page on a scheme change and keeps the src", () => {
    const { container } = render(<HtmlRenderRow reference={reference} />);
    const frame = container.querySelector("iframe")!;
    const src = frame.getAttribute("src");
    const post = vi.spyOn(frame.contentWindow!, "postMessage");
    act(() => {
      document.documentElement.classList.add("theme-light");
      window.dispatchEvent(new CustomEvent(SCHEME_CHANGE_EVENT, { detail: "light" }));
    });
    expect(post).toHaveBeenCalled();
    const message = post.mock.calls.at(-1)![0] as { method: string; params: { theme: string } };
    expect(message.method).toBe("ui/notifications/host-context-changed");
    expect(message.params.theme).toBe("light");
    expect(frame.getAttribute("src")).toBe(src);
  });
});
