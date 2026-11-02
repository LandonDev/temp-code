// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PaneVisibilityContext } from "../../hooks/paneVisibility";

const reduced = vi.hoisted(() => ({ value: false }));
vi.mock("motion/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("motion/react")>();
  return { ...actual, useReducedMotion: () => reduced.value };
});

import { TextPulse } from "./text-pulse";

const hidden = { value: false };
Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden.value });

const css = readFileSync(resolve(__dirname, "../../assets/components.css"), "utf8");
const tokens = readFileSync(resolve(__dirname, "../../index.css"), "utf8");

afterEach(() => {
  cleanup();
  reduced.value = false;
  hidden.value = false;
});

const span = (container: HTMLElement) => container.querySelector("[data-slot=text-pulse]") as HTMLElement;

describe("TextPulse", () => {
  it("is muted text carrying the pulse class", () => {
    const { container } = render(<TextPulse className="shrink-0">Thinking</TextPulse>);
    const el = span(container);
    expect(el.textContent).toBe("Thinking");
    expect(el.className.split(" ")).toEqual(expect.arrayContaining(["text-muted-foreground", "text-pulse", "shrink-0"]));
  });

  it("is still at mount: the pulse waits --delay-pulse (3s), then breathes over --dur-pulse on --ease-breathe", () => {
    const rule = /@utility text-pulse \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
    expect(rule).toContain("animation: text-pulse var(--dur-pulse) var(--ease-breathe) var(--delay-pulse) infinite;");
    expect(rule).toMatch(/prefers-reduced-motion: reduce\)\s*\{\s*animation: none;/);
    expect(tokens).toMatch(/--delay-pulse: 3s;/);
    expect(tokens).toMatch(/--dur-pulse: 2s;/);
    // Opacity only, down to 0.75 at the middle of a breath.
    expect(/@keyframes text-pulse \{([\s\S]*?)\n\}/.exec(css)?.[1]).toMatch(/50% \{\s*opacity: 0\.75;\s*\}/);
  });

  it("is still under reduced motion", () => {
    reduced.value = true;
    const { container } = render(<TextPulse>Thinking</TextPulse>);
    expect(span(container).className).toContain("text-muted-foreground");
    expect(span(container).className).not.toContain("text-pulse");
  });

  it("is still in a hidden pane", () => {
    const { container } = render(
      <PaneVisibilityContext.Provider value={false}>
        <TextPulse>Thinking</TextPulse>
      </PaneVisibilityContext.Provider>,
    );
    expect(span(container).className).not.toContain("text-pulse");
  });

  it("rests while the document is hidden and breathes again once it shows", () => {
    const { container } = render(<TextPulse>Thinking</TextPulse>);
    act(() => {
      hidden.value = true;
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(span(container).className).not.toContain("text-pulse");
    act(() => {
      hidden.value = false;
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(span(container).className).toContain("text-pulse");
  });
});
