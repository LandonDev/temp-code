// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Composer } from "./Composer";

afterEach(cleanup);

const noop = () => {};
const mount = (onGesture: () => void, onFocus: () => void = noop) =>
  render(
    <Composer
      focused
      harness="claude"
      model="claude-haiku-5-5"
      runtimeMode="supervised"
      executionCwd="/repo"
      sessionId="s1"
      onFocus={onFocus}
      onGesture={onGesture}
      onCwdChange={noop}
      onModelChange={noop}
      onRuntimeModeChange={noop}
      onSubmit={noop}
    />,
  );

/**
 * Boot on focus (Stability 3): the composer tells its owner about the
 * person's own pointer or keystroke in it, never about a programmatic focus
 * (a tab's activation focuses the composer and must boot nothing).
 */
describe("Composer's gesture", () => {
  it("a pointer down inside the composer is a gesture", () => {
    const onGesture = vi.fn();
    const view = mount(onGesture);
    fireEvent.pointerDown(view.container.querySelector("[data-composer-box]")!);
    expect(onGesture).toHaveBeenCalledTimes(1);
  });

  it("a programmatic focus of the field is no gesture, though it still focuses the pane", () => {
    const onGesture = vi.fn();
    const onFocus = vi.fn();
    const view = mount(onGesture, onFocus);
    const field = view.container.querySelector<HTMLElement>("[contenteditable]")!;
    field.focus();
    fireEvent.focus(field);
    expect(onFocus).toHaveBeenCalled();
    expect(onGesture).not.toHaveBeenCalled();
  });

  it("typing into the field is a gesture", () => {
    const onGesture = vi.fn();
    const view = mount(onGesture);
    const field = view.container.querySelector<HTMLElement>("[contenteditable]")!;
    field.textContent = "h";
    fireEvent.input(field);
    expect(onGesture).toHaveBeenCalled();
  });
});
