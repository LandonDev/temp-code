// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PaneVisibilityContext } from "../../hooks/paneVisibility";
import { SHIMMER } from "../../lib/ease";

const reduced = vi.hoisted(() => ({ value: false }));
vi.mock("motion/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("motion/react")>();
  return { ...actual, useReducedMotion: () => reduced.value };
});

import { WorkingText } from "./working-text";

// jsdom has no Web Animations: each one is a handle that records its start.
const handles: { cancel: ReturnType<typeof vi.fn>; startTime: number | null }[] = [];
const animate = vi.fn((_frames: Keyframe[], _timing: KeyframeAnimationOptions) => {
  const handle = { cancel: vi.fn(), startTime: null };
  handles.push(handle);
  return handle as unknown as Animation;
});
const hidden = { value: false };
Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden.value });
const css = readFileSync(resolve(__dirname, "../../assets/components.css"), "utf8");

beforeEach(() => {
  Object.defineProperty(Element.prototype, "animate", { configurable: true, value: animate });
});
afterEach(() => {
  cleanup();
  reduced.value = false;
  hidden.value = false;
  handles.length = 0;
  delete (Element.prototype as { animate?: unknown }).animate;
  vi.clearAllMocks();
});

const root = (container: HTMLElement) => container.querySelector("[data-slot=working-text]") as HTMLElement;
const part = (container: HTMLElement, name: string) => container.querySelector(`[data-shimmer=${name}]`) as HTMLElement | null;

describe("WorkingText", () => {
  it("draws its words muted and once, with a foreground copy as a masked band's ::before", () => {
    const { container } = render(<WorkingText>Thinking</WorkingText>);
    expect(root(container).className).toContain("text-muted-foreground");
    expect(root(container).textContent).toBe("Thinking");
    const band = part(container, "band")!;
    expect(band.parentElement?.getAttribute("aria-hidden")).toBe("true");
    expect(band.getAttribute("data-words")).toBe("Thinking");
    expect(band.className).toContain("before:content-[attr(data-words)]");
    expect(band.className).toContain("before:text-foreground");
    expect(band.className).toContain("var(--foreground)");
    expect(band.className).not.toMatch(/#|rgb|oklch/);
  });

  it("takes its copy's words from `words` when the children are not a string", () => {
    const { container } = render(
      <WorkingText words="Reading format.ts">
        Reading <span>format.ts</span>
      </WorkingText>,
    );
    expect(part(container, "band")?.getAttribute("data-words")).toBe("Reading format.ts");
    expect(part(render(<WorkingText><b>x</b></WorkingText>).container, "band")).toBeNull();
  });

  it("moves the band and its copy by two transform animations on SHIMMER's timing, from 0 on the document timeline", () => {
    const { container } = render(<WorkingText>Thinking</WorkingText>);
    expect(animate).toHaveBeenCalledTimes(2);
    expect(animate.mock.contexts[0]).toBe(part(container, "band"));
    expect(animate.mock.calls[0]).toEqual([SHIMMER.band, SHIMMER.timing]);
    expect(animate.mock.contexts[1]).toBe(part(container, "band"));
    expect(animate.mock.calls[1]).toEqual([SHIMMER.copy, { ...SHIMMER.timing, pseudoElement: "::before" }]);
    expect(handles.map((h) => h.startTime)).toEqual([0, 0]);
  });

  it("cancels both on unmount", () => {
    const { unmount } = render(<WorkingText>Thinking</WorkingText>);
    unmount();
    for (const h of handles) expect(h.cancel).toHaveBeenCalledTimes(1);
  });

  it("mounts no overlay under reduced motion, in a hidden pane, or with no Web Animations", () => {
    reduced.value = true;
    expect(part(render(<WorkingText>Thinking</WorkingText>).container, "band")).toBeNull();
    reduced.value = false;
    const parked = render(
      <PaneVisibilityContext.Provider value={false}>
        <WorkingText>Thinking</WorkingText>
      </PaneVisibilityContext.Provider>,
    );
    expect(part(parked.container, "band")).toBeNull();
    delete (Element.prototype as { animate?: unknown }).animate;
    expect(part(render(<WorkingText>Thinking</WorkingText>).container, "band")).toBeNull();
  });

  it("takes the overlay down while the document is hidden", () => {
    const { container } = render(<WorkingText>Thinking</WorkingText>);
    act(() => {
      hidden.value = true;
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(part(container, "band")).toBeNull();
    for (const h of handles) expect(h.cancel).toHaveBeenCalled();
  });

  it("leaves no pulse utility behind", () => {
    expect(css).not.toContain("text-pulse");
  });
});
