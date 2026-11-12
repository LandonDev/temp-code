// @vitest-environment jsdom
/** Keeps the preview fixtures honest: each one draws, and says what its name says. */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import fixtures from "./ComputerView.fixtures";
import { ComputerStates } from "./ComputerView.preview";

afterEach(cleanup);

const named = (start: string) => fixtures.find((f) => f.name.startsWith(start))!;

describe("the Computer section's fixtures", () => {
  it("covers the plan's states, each under its own name", () => {
    const numbers = new Set(fixtures.map((f) => Number(/^(\d+)/.exec(f.name)![1])));
    // 25 is the cue, the header and the Settings row, which have preview pages of their own
    expect([...numbers].sort((a, b) => a - b)).toEqual(Array.from({ length: 24 }, (_, i) => i + 1));
    expect(new Set(fixtures.map((f) => f.name)).size).toBe(fixtures.length);
  });

  it("every fixture draws in a 260px and a 480px panel under the panel's header", () => {
    const { container } = render(<ComputerStates />);
    const figures = [...container.querySelectorAll("figure")];
    expect(figures).toHaveLength(fixtures.length);
    for (const [i, figure] of figures.entries()) {
      const panes = [...figure.querySelectorAll<HTMLElement>('[data-slot="computer-section"]')];
      expect(panes.length, fixtures[i].name).toBe((fixtures[i].widths ?? [260, 480]).length);
      expect(figure.querySelectorAll('[role="tablist"]').length, fixtures[i].name).toBe(panes.length);
    }
    // the narrow header is compact, the wide one is not
    const lists = [...figures[0].querySelectorAll('[role="tablist"]')];
    expect(lists.map((l) => l.getAttribute("data-compact"))).toEqual(["true", null]);
  });

  it("the live fixtures have a session row and a live box; the settled ones neither", () => {
    const draw = (start: string) => render(<ComputerStates from={fixtures.indexOf(named(start))} to={fixtures.indexOf(named(start)) + 1} />).container;
    const acting = draw("1.");
    expect(acting.querySelector('[data-slot="computer-session"]')!.textContent).toBe("Untitled in TextEdit");
    expect(acting.querySelector('[data-face="live"]')!.getAttribute("aria-label")).toBe("Live view of Untitled in TextEdit");
    expect(acting.querySelector('[data-slot="click-mark"]')).not.toBeNull();
    expect(acting.querySelector('[data-slot="step-running"]')!.textContent).toBe("ClickingSave");
    cleanup();
    const done = draw("13.");
    expect(done.querySelector('[data-slot="computer-session"]')).toBeNull();
    expect(done.querySelector('[data-face="picture"]')).not.toBeNull();
    // one titled heading, the subagent's, in each of the two panes
    expect([...done.querySelectorAll('[data-slot="step-heading"]')].map((h) => h.textContent!.replace(/\d+:\d+.*/, "").trim()).filter(Boolean)).toEqual(["Fill in the order form", "Fill in the order form"]);
    cleanup();
    const pinned = draw("9.");
    expect(pinned.querySelector('[data-slot="go-live"]')).not.toBeNull();
    expect(pinned.querySelector('[data-slot="computer-section"]')!.hasAttribute("data-following")).toBe(false);
    cleanup();
    const password = draw("21.");
    expect(password.querySelector('[data-slot="step-detail"]')!.textContent).toContain("a password");
    cleanup();
    const short = draw("23.");
    expect(short.querySelectorAll('[data-slot="computer-section"]')).toHaveLength(1);
  });

  it("the failed batch reads in the host's own words: done for the step that ran, asked for the two that did not", () => {
    const { container } = render(<ComputerStates from={fixtures.indexOf(named("11."))} to={fixtures.indexOf(named("11.")) + 1} />);
    const pane = container.querySelector('[data-slot="computer-section"]')!;
    const rows = [...pane.querySelectorAll('[data-slot="step"]')].slice(0, 3);
    expect(rows.map((r) => r.querySelector("button")!.textContent)).toEqual(["Press⌘Return", "Typeinto Subject", "ClickedTo in Mail"]);
    expect(rows.map((r) => r.querySelector('[data-slot="step-glyph"]')!.getAttribute("data-mark"))).toEqual(["not-run", "failed", null]);
    const open = pane.querySelector('[data-slot="step"][data-open]')!;
    expect(open.querySelector('[data-slot="step-why"]')!.textContent).toBe("The element was gone");
    expect(open.querySelector('[data-slot="step-detail"]')!.textContent).toContain("6 characters");
    expect(pane.querySelector('[data-slot="computer-line"]')!.textContent).toBe("After the steps that ran");
  });

  it("a pinned step that kept nothing holds the box, and a failed read leads the steps that are there", () => {
    const at = (start: string) => render(<ComputerStates from={fixtures.indexOf(named(start))} to={fixtures.indexOf(named(start)) + 1} />).container;
    const none = at("17.").querySelector<HTMLElement>('[data-face="none"]')!;
    expect(none.style.height).toBe("198px");
    expect(none.textContent).toBe("This picture is no longer kept");
    cleanup();
    const failed = at("24d.").querySelector('[data-slot="computer-steps"]')!;
    expect(failed.firstElementChild!.getAttribute("data-slot")).toBe("steps-failed");
    expect(failed.querySelectorAll('[data-slot="step"]').length).toBeGreaterThan(0);
  });
});
