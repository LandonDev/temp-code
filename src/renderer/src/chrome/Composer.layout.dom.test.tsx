// @vitest-environment jsdom
/**
 * The composer is one row in its box, as Claude's (docs/DESIGN.md "The
 * transcript", docs/LAYOUT.md "Composer"): `+`, the field and Send on the
 * field's bottom line, then the quiet row under the box with the model, the
 * context meter and the permission mode. The empty thread's box and the
 * docked one are one class chain, the first send's FLIP moves the box with
 * its row, and the toast anchor holds the row.
 */
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";

const draftRow = vi.hoisted(() => ({ value: true }));
vi.mock("./ComposerBar", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ComposerBar")>()),
  useDraftRow: () => draftRow.value,
}));
vi.mock("../lib/contextCache", () => ({ useContextReading: () => null }));

import { Composer, clearComposerHandoff, recordComposerHandoff } from "./Composer";
import { ChatFooter } from "../surfaces/threads/chatSlots";
import { EmptySession } from "../surfaces/EmptySession";
import { toastAnchor } from "../lib/toastAnchor";

afterEach(() => {
  cleanup();
  clearComposerHandoff();
  draftRow.value = true;
  vi.restoreAllMocks();
});

const noop = () => {};
const props = (over: Partial<ComponentProps<typeof Composer>> = {}): ComponentProps<typeof Composer> => ({
  focused: false,
  harness: "claude",
  model: "claude:opus-5.5",
  runtimeMode: "supervised",
  executionCwd: "/repo",
  sessionId: "s1",
  context: { used: 84_000, window: 200_000 },
  onFocus: noop,
  onCwdChange: noop,
  onModelChange: noop,
  onRuntimeModeChange: noop,
  onSubmit: noop,
  ...over,
});

const parts = (root: ParentNode) => {
  const composer = root.querySelector<HTMLElement>("[data-composer]")!;
  return {
    composer,
    box: composer.querySelector<HTMLElement>("[data-composer-box]")!,
    row: composer.querySelector<HTMLElement>("[data-composer-row]")!,
    field: composer.querySelector<HTMLElement>("[data-composer-input]")!,
    bar: composer.querySelector<HTMLElement>("[data-composer-bar]")!,
  };
};

const classes = (el: Element) => el.className.split(" ");

/** Which `@max-[Nrem]/composer-bar:hidden` parts of the row are gone at a row width. */
function hiddenAt(bar: HTMLElement, px: number): { el: HTMLElement; rem: number; hidden: boolean }[] {
  return [...bar.querySelectorAll<HTMLElement>("[class*='/composer-bar:hidden']")].map((el) => {
    const rem = Number(/@max-\[(\d+(?:\.\d+)?)rem\]\/composer-bar:hidden/.exec(el.className)![1]);
    return { el, rem, hidden: px < rem * 16 };
  });
}

describe("the box: one row", () => {
  it("holds `+`, the field and Send in that order, on the bottom line, 6px from the sides and 8px from the top and bottom", () => {
    const { box, row, field } = parts(render(<Composer {...props()} />).container);
    expect(row.parentElement).toBe(box);
    expect(classes(row)).toEqual(expect.arrayContaining(["flex", "items-end", "px-1.5", "py-2"]));
    const kids = [...row.children];
    expect(kids).toHaveLength(3);
    expect(kids[0].getAttribute("aria-label")).toBe("Add");
    expect(kids[1]).toBe(field);
    expect(kids[2].getAttribute("aria-label")).toBe("Send");
    // Both controls are 28px; Send is the circle.
    expect(classes(kids[0])).toContain("size-7");
    expect(classes(kids[2])).toEqual(expect.arrayContaining(["size-7", "rounded-full"]));
    // The field's 22px line is centred on their 28px line: 3px above and below.
    expect(classes(field)).toEqual(expect.arrayContaining(["flex-1", "min-w-0", "py-[3px]", "leading-[22px]", "text-sm"]));
    // The box keeps its hairline and 12px corners.
    expect(classes(box)).toEqual(expect.arrayContaining(["rounded-xl", "border", "border-border", "bg-card"]));
  });

  it("the model, the meter and the mode are under the box, never in it", () => {
    const { box, bar } = parts(render(<Composer {...props()} />).container);
    expect(box.contains(bar)).toBe(false);
    expect(box.nextElementSibling).toBe(bar);
    const names = [...bar.querySelectorAll("button, [role=combobox]")].map((el) => el.getAttribute("aria-label"));
    expect(names).toHaveLength(3);
    expect(names[0]).toMatch(/Opus/);
    expect(names.slice(1)).toEqual(["Context 42% full", "Permission mode: Supervised"]);
    expect(within(box).queryByRole("combobox")).toBeNull();
    for (const el of bar.querySelectorAll("button, [role=combobox]")) {
      expect(classes(el)).toEqual(expect.arrayContaining(["text-xs", "text-muted-foreground", "hover:bg-foreground/5"]));
    }
  });

  it("a press on the row's own padding puts the caret in the field", () => {
    const { row, field } = parts(render(<Composer {...props()} />).container);
    fireEvent.mouseDown(row);
    expect(document.activeElement).toBe(field);
  });

  it("a three-line paste grows the field, so the box grows upward over its bottom-aligned controls", () => {
    const { row, field } = parts(render(<Composer {...props()} />).container);
    // 22px a line plus the field's 3px above and below; a pinned height is what is drawn.
    field.getBoundingClientRect = () => {
      const pinned = parseFloat(field.style.height);
      const lines = Math.max((field.textContent ?? "").split("\n").length, field.querySelectorAll("br").length + 1);
      return { height: Number.isFinite(pinned) ? pinned : 6 + 22 * lines } as DOMRect;
    };
    field.focus();
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", {
      value: { getData: (type: string) => (type === "text/plain" ? "one\ntwo\nthree" : ""), files: [], items: [], types: ["text/plain"] },
    });
    act(() => {
      field.dispatchEvent(paste);
    });
    expect(field.style.height).toBe("72px");
    // A pasted jump of more than a line eases; the controls hold the bottom line.
    expect(field.style.transition).toBe("height var(--dur-base) var(--ease-out)");
    expect(classes(row)).toContain("items-end");
    expect(row.lastElementChild!.getAttribute("aria-label")).toBe("Send");
    // Once it lands the box is the browser's to size again: nothing stays pinned for a width change to make stale.
    const done = new Event("transitionend");
    Object.defineProperty(done, "propertyName", { value: "height" });
    act(() => {
      field.dispatchEvent(done);
    });
    expect(field.style.height).toBe("");
    expect(field.style.transition).toBe("");
  });

  it("50 keystrokes read no layout and write no height: the field is the browser's to size", () => {
    const { field } = parts(render(<Composer {...props()} />).container);
    const reads = { rect: 0, offset: 0, scroll: 0, client: 0 };
    field.getBoundingClientRect = () => (reads.rect++, { height: 28 } as DOMRect);
    Object.defineProperty(field, "offsetHeight", { get: () => (reads.offset++, 28) });
    Object.defineProperty(field, "scrollHeight", { get: () => (reads.scroll++, 28) });
    Object.defineProperty(field, "clientWidth", { get: () => (reads.client++, 400) });
    const styles = vi.spyOn(window, "getComputedStyle");
    field.focus();
    for (let i = 0; i < 50; i++) {
      act(() => {
        field.append(document.createTextNode("a"));
        field.dispatchEvent(new Event("input", { bubbles: true }));
      });
    }
    expect(field.textContent!.endsWith("a".repeat(50))).toBe(true);
    expect(reads).toEqual({ rect: 0, offset: 0, scroll: 0, client: 0 });
    expect(styles.mock.calls.filter(([el]) => el === field)).toHaveLength(0);
    expect(field.style.height).toBe("");
    expect(field.className).toContain("max-h-40");
  });
});

describe("the row under the box gives way at a narrow box", () => {
  it("in order: the meter's percent, then the model's effort, then the mode's label, then the model's name", () => {
    const { bar } = parts(render(<Composer {...props({ modelSettings: { effort: "high" } })} />).container);
    const meter = bar.querySelector<HTMLElement>("[data-context-meter]")!;
    const mode = within(bar).getByRole("combobox");
    const model = bar.querySelector<HTMLElement>("[aria-keyshortcuts]")!;
    const rem = (el: Element) => Number(/@max-\[(\d+)rem\]/.exec(el.className)![1]);
    const percent = within(meter).getByText("42%");
    const [name, effort] = [...model.querySelectorAll<HTMLElement>("[class*='/composer-bar:hidden']")];
    const label = within(mode).getByText("Supervised");
    expect([percent, effort, label, name].map(rem)).toEqual([25, 23, 20, 9]);
  });

  it("a 220px box keeps the model's icon and name, the ring and the mode's icon on one row", () => {
    const { bar } = parts(render(<Composer {...props({ modelSettings: { effort: "high" } })} />).container);
    expect(classes(bar)).toEqual(expect.arrayContaining(["@container/composer-bar", "flex", "h-6", "min-w-0"]));
    expect(bar.className).not.toContain("flex-wrap");
    const at220 = hiddenAt(bar, 220);
    const hidden = at220.filter((p) => p.hidden).map((p) => p.el.textContent);
    const kept = at220.filter((p) => !p.hidden).map((p) => p.el.textContent);
    expect(hidden).toEqual(expect.arrayContaining(["42%", "Supervised"]));
    expect(hidden).toHaveLength(3);
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatch(/Opus/);
    // Everything shows on a wide box.
    expect(hiddenAt(bar, 768).every((p) => !p.hidden)).toBe(true);
  });
});

describe("the empty thread and the docked footer", () => {
  it("draw one class chain: the frame, the box, its row, the field and the row under the box", () => {
    const empty = parts(render(<EmptySession composer={<Composer {...props({ sessionId: undefined })} />} />).container);
    draftRow.value = false;
    const docked = parts(
      render(<ChatFooter slots={{ transcript: null, strip: null, composer: <Composer {...props()} /> }} />).container,
    );
    for (const key of ["box", "row", "field", "bar"] as const) {
      expect(empty[key].className).toBe(docked[key].className);
    }
    expect(empty.box.parentElement!.className).toBe(docked.box.parentElement!.className);
  });

  it("the toast anchor is the footer, with the row under the box inside it", () => {
    draftRow.value = false;
    const { container } = render(
      <ChatFooter slots={{ transcript: null, strip: null, composer: <Composer {...props()} />, anchor: true }} />,
    );
    const anchor = toastAnchor()!;
    expect(anchor).toBe(container.querySelector("[data-toast-anchor]"));
    expect(anchor.contains(container.querySelector("[data-composer-bar]"))).toBe(true);
  });

  it("a draft's first send moves the frame, box and row together, by a translate", () => {
    draftRow.value = false;
    recordComposerHandoff("s1", { top: 300, left: 40 });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ top: 700, left: 40 } as DOMRect);
    const { box, bar } = parts(render(<Composer {...props()} />).container);
    const frame = box.parentElement!;
    expect(frame.contains(bar)).toBe(true);
    expect(frame.style.transition).toBe("transform var(--dur-slow) var(--ease-drawer)");
    expect(frame.style.transform).toBe("");
    expect(box.style.transform).toBe("");
  });
});
