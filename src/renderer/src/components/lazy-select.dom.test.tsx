// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccessPicker } from "../chrome/AccessPicker";
import { ThreadTypeChip } from "../chrome/ThreadTypeChip";
import { resetSelects } from "./lazy-select";

/** A select chunk this file can unload: cold until a test loads it. */
const chunk = vi.hoisted(() => ({ module: null as object | null, loads: 0 }));
vi.mock("../surfaces/chunks", () => {
  const load = async () => {
    chunk.loads++;
    const mod = await import("./select-body");
    chunk.module = mod;
    return mod;
  };
  return {
    selectChunk: {
      load,
      preload: () => void load(),
      loaded: () => chunk.module,
      intent: {},
    },
  };
});

beforeEach(() => {
  chunk.module = null;
  chunk.loads = 0;
  resetSelects();
});
afterEach(cleanup);

/** What a trigger shows a person and a screen reader. */
function face(el: HTMLElement) {
  return {
    tag: el.tagName,
    className: el.className,
    role: el.getAttribute("role"),
    expanded: el.getAttribute("aria-expanded"),
    haspopup: el.getAttribute("aria-haspopup"),
    label: el.getAttribute("aria-label"),
    size: el.getAttribute("data-size"),
    slot: el.getAttribute("data-slot"),
    text: el.textContent,
    value: el.querySelector("[data-slot=select-value]")?.className,
    chevron: el.querySelector(":scope > svg")?.getAttribute("class"),
  };
}

describe("lazy-select", () => {
  it("a cold picker draws the real trigger: same box, value slot, chevron and combobox state", async () => {
    const cold = render(<AccessPicker quiet value="supervised" onChange={() => {}} />);
    const coldFace = face(screen.getByRole("combobox"));
    expect(chunk.loads).toBe(0);
    cold.unmount();
    await act(async () => {
      await import("../surfaces/chunks").then((m) => m.selectChunk.load());
    });
    render(<AccessPicker quiet value="supervised" onChange={() => {}} />);
    const real = screen.getByRole("combobox");
    expect(real.id).not.toBe("");
    expect(face(real)).toEqual(coldFace);
  });

  it("the thread type chip's cold trigger matches its real one", async () => {
    const cold = render(<ThreadTypeChip value="planning" onChange={() => {}} />);
    const coldFace = face(screen.getByRole("combobox", { name: "Thread type" }));
    cold.unmount();
    await act(async () => {
      await import("../surfaces/chunks").then((m) => m.selectChunk.load());
    });
    render(<ThreadTypeChip value="planning" onChange={() => {}} />);
    expect(face(screen.getByRole("combobox", { name: "Thread type" }))).toEqual(coldFace);
  });

  it("the pointer entering one cold trigger swaps every picker on screen", async () => {
    render(
      <>
        <ThreadTypeChip value="chat" onChange={() => {}} />
        <AccessPicker value="supervised" onChange={() => {}} />
      </>,
    );
    const [first] = screen.getAllByRole("combobox");
    expect(screen.getAllByRole("combobox").every((el) => el.id === "")).toBe(true);
    await act(async () => {
      fireEvent.pointerEnter(first!);
    });
    await waitFor(() => expect(screen.getAllByRole("combobox").every((el) => el.id !== "")).toBe(true));
  });

  it("a focus loads the chunk but leaves the focused trigger in place", async () => {
    render(<ThreadTypeChip value="chat" onChange={() => {}} />);
    const trigger = screen.getByRole("combobox", { name: "Thread type" });
    await act(async () => {
      trigger.focus();
    });
    await waitFor(() => expect(chunk.module).not.toBeNull());
    expect(screen.getByRole("combobox", { name: "Thread type" })).toBe(trigger);
    expect(document.activeElement).toBe(trigger);
  });

  it("a click on a cold trigger opens the select once it lands; Escape closes it onto the trigger", async () => {
    const onClose = vi.fn();
    render(<AccessPicker value="supervised" onChange={() => {}} onClose={onClose} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("combobox", { name: "Permission mode: Supervised" }));
    });
    expect(await screen.findAllByRole("option")).toHaveLength(3);
    await act(async () => {
      fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    });
    await waitFor(() => expect(screen.queryAllByRole("option")).toHaveLength(0));
    expect(onClose).not.toHaveBeenCalled();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("combobox", { name: "Permission mode: Supervised" })));
  });
});
