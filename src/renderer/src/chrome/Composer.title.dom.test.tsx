// @vitest-environment jsdom
/**
 * The draft row's name field: on an unsent draft of any type, absent once
 * the thread exists (the caller passes no `draftTitle` then), one line of at
 * most 80 characters, each keystroke handed back, Enter and Escape back to
 * the message field.
 */
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";

vi.mock("./CwdPicker", () => ({ CwdPicker: () => null }));
vi.mock("./DraftHostPicker", () => ({ DraftHostPicker: () => null }));
vi.mock("./BranchPicker", () => ({ BranchPicker: () => null }));
vi.mock("./ThreadTypeChip", () => ({ ThreadTypeChip: () => null }));
vi.mock("./ModelPicker", () => ({ ModelPicker: () => null }));

import { Composer } from "./Composer";

const noop = () => {};
function mount(over: Partial<ComponentProps<typeof Composer>>) {
  return render(
    <Composer
      focused={false}
      harness="claude"
      model="claude-opus-5-5"
      runtimeMode="supervised"
      executionCwd="/work/alpha"
      cwd="/work/alpha"
      sessionId="draft-t"
      onFocus={noop}
      onCwdChange={noop}
      onModelChange={noop}
      onRuntimeModeChange={noop}
      onSubmit={noop}
      onThreadTypeChange={noop}
      {...over}
    />,
  );
}
const field = (view: ReturnType<typeof render>) => view.container.querySelector<HTMLInputElement>("[data-composer-title]");

afterEach(cleanup);

describe("Naming a new thread in the draft row", () => {
  it("shows on an unsent draft with the draft's name, and hands each change back", () => {
    const onDraftTitleChange = vi.fn();
    const view = mount({ threadType: "planning", draftTitle: "Gateway", onDraftTitleChange });
    const input = field(view)!;
    expect(input.placeholder).toBe("Name this thread");
    expect(input.getAttribute("aria-label")).toBe("Thread name");
    expect(input.value).toBe("Gateway");
    fireEvent.change(input, { target: { value: "Gateway audit" } });
    expect(onDraftTitleChange).toHaveBeenLastCalledWith("Gateway audit");
  });

  it("holds 80 characters on one line", () => {
    const onDraftTitleChange = vi.fn();
    const input = field(mount({ threadType: "chat", draftTitle: "", onDraftTitleChange }))!;
    expect(input.maxLength).toBe(80);
    // A text input drops line breaks from what it is given.
    expect(input.type).toBe("text");
    fireEvent.change(input, { target: { value: "one\ntwo" } });
    expect(onDraftTitleChange.mock.lastCall?.[0]).not.toContain("\n");
  });

  it("Enter and Escape go back to the message field", () => {
    const view = mount({ threadType: "chat", draftTitle: "Gateway", onDraftTitleChange: noop });
    const input = field(view)!;
    for (const key of ["Enter", "Escape"]) {
      act(() => input.focus());
      fireEvent.keyDown(input, { key });
      expect(document.activeElement).not.toBe(input);
    }
  });

  it("is absent once the thread exists", () => {
    expect(field(mount({ threadType: "chat", onDraftTitleChange: noop }))).toBeNull();
  });
});
