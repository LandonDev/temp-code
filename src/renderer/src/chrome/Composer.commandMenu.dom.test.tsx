// @vitest-environment jsdom
/**
 * The composer's `/` and `@` menu stays open while a trigger is typed: with
 * nothing to pick it holds one muted "No matches" row, which Escape closes,
 * and Enter still sends the message.
 */
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";

vi.mock("./ComposerBar", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ComposerBar")>()),
  useDraftRow: () => false,
}));
vi.mock("../lib/contextCache", () => ({ useContextReading: () => null }));
vi.mock("../lib/tcserver/slashCommands", () => ({ useSlashCommands: () => [] }));

import { Composer } from "./Composer";
import { commandMenuChunk } from "../surfaces/chunks";

beforeAll(async () => {
  Element.prototype.scrollIntoView = () => {};
  await commandMenuChunk.load();
});
afterEach(cleanup);

const noop = () => {};
const props = (over: Partial<ComponentProps<typeof Composer>> = {}): ComponentProps<typeof Composer> => ({
  focused: false,
  harness: "claude",
  model: "claude:opus-5.5",
  runtimeMode: "supervised",
  executionCwd: "/repo",
  sessionId: "s1",
  onFocus: noop,
  onCwdChange: noop,
  onModelChange: noop,
  onRuntimeModeChange: noop,
  onSubmit: noop,
  ...over,
});

function type(field: HTMLElement, text: string) {
  act(() => {
    field.append(document.createTextNode(text));
    const range = document.createRange();
    range.selectNodeContents(field);
    range.collapse(false);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("the / menu with nothing to pick", () => {
  it("holds one muted No matches row; Escape closes it and Enter still sends", async () => {
    const onSubmit = vi.fn();
    const { container } = render(<Composer {...props({ onSubmit })} />);
    const field = container.querySelector<HTMLElement>("[data-composer-input]")!;
    field.focus();
    type(field, "/zzz");
    await act(async () => {});
    const empty = container.querySelector<HTMLElement>("[data-command-empty]");
    expect(empty?.textContent).toBe("No matches");
    fireEvent.keyDown(field, { key: "Escape" });
    expect(container.querySelector("[data-command-popover]")?.hasAttribute("data-ending-style")).toBe(true);
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});
