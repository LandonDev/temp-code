// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { useRovingList } from "./useRovingList";

/** A page list's keyboard: one tab stop, ↑↓ from the field or a row, Home
 *  and End on a row, the ends held, the selected row scrolled into view. */

const scrolled: string[] = [];
beforeAll(() => {
  Element.prototype.scrollIntoView = function (this: HTMLElement) {
    scrolled.push(this.dataset.rovingKey ?? "");
  };
});
afterEach(() => {
  cleanup();
  scrolled.length = 0;
});

function List({ keys, initial = null, onSelect }: { keys: string[]; initial?: string | null; onSelect?: (key: string) => void }) {
  const [selected, setSelected] = useState<string | null>(initial);
  const roving = useRovingList({
    keys,
    selected,
    onSelect: (key) => {
      onSelect?.(key);
      setSelected(key);
    },
  });
  return (
    <div>
      <input aria-label="Filter" onKeyDown={roving.onFieldKeyDown} />
      <ul ref={roving.listRef}>
        {keys.map((key) => (
          <li key={key}>
            <button
              type="button"
              data-roving-key={key}
              aria-current={key === selected ? "true" : undefined}
              tabIndex={roving.tabIndexOf(key)}
              onKeyDown={roving.onRowKeyDown}
              onClick={() => setSelected(key)}
            >
              {key}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

const current = () => document.querySelector('[aria-current="true"]')?.textContent ?? null;
const stops = () => [...document.querySelectorAll<HTMLElement>("[data-roving-key]")].filter((el) => el.tabIndex === 0).map((el) => el.textContent);
const key = async (target: Element, k: string) => {
  await act(async () => {
    fireEvent.keyDown(target, { key: k });
  });
};

describe("useRovingList", () => {
  it("makes the first row the one tab stop while nothing is selected, then the selected row", async () => {
    render(<List keys={["a", "b", "c"]} />);
    expect(stops()).toEqual(["a"]);
    await key(screen.getByLabelText("Filter"), "ArrowDown");
    expect(current()).toBe("a");
    expect(stops()).toEqual(["a"]);
    await key(screen.getByLabelText("Filter"), "ArrowDown");
    expect(stops()).toEqual(["b"]);
  });

  it("selects as a click would from the field, keeps focus there and scrolls the row into view", async () => {
    const onSelect = vi.fn();
    render(<List keys={["a", "b", "c"]} initial="a" onSelect={onSelect} />);
    const field = screen.getByLabelText("Filter");
    field.focus();
    await key(field, "ArrowDown");
    expect(onSelect).toHaveBeenCalledWith("b");
    expect(current()).toBe("b");
    expect(document.activeElement).toBe(field);
    expect(scrolled).toEqual(["b"]);
  });

  it("moves focus with the selection on a row, holds the ends, and takes Home and End", async () => {
    render(<List keys={["a", "b", "c"]} initial="a" />);
    const row = (k: string) => document.querySelector<HTMLElement>(`[data-roving-key="${k}"]`)!;
    row("a").focus();
    await key(row("a"), "ArrowUp");
    expect(current()).toBe("a");
    await key(row("a"), "End");
    expect(current()).toBe("c");
    expect(document.activeElement).toBe(row("c"));
    await key(row("c"), "ArrowDown");
    expect(current()).toBe("c");
    await key(row("c"), "Home");
    expect(current()).toBe("a");
    expect(document.activeElement).toBe(row("a"));
  });

  it("leaves Home and End to the field, and other keys alone", async () => {
    render(<List keys={["a", "b"]} initial="b" />);
    const field = screen.getByLabelText("Filter");
    await key(field, "Home");
    await key(field, "Enter");
    expect(current()).toBe("b");
  });
});
