// @vitest-environment jsdom
/**
 * The draft row's "Master thread" pick: offered on an unsent chat draft
 * only, absent for any other type and once the thread exists (the caller
 * passes no `master` then), and a click hands the new value back, on the
 * still box before the select chunk lands and on Base UI's after.
 */
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";

vi.mock("./CwdPicker", () => ({ CwdPicker: () => null }));
vi.mock("./DraftHostPicker", () => ({ DraftHostPicker: () => null }));
vi.mock("./BranchPicker", () => ({ BranchPicker: () => null }));
vi.mock("./ThreadTypeChip", () => ({ ThreadTypeChip: () => null }));
vi.mock("./ModelPicker", () => ({ ModelPicker: () => null }));

import { Composer } from "./Composer";
import { resetSelects, warmSelects } from "../components/lazy-select";
import { selectChunk } from "../surfaces/chunks";

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
      sessionId="draft-m"
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
const control = (view: ReturnType<typeof render>) => view.container.querySelector<HTMLElement>("[data-composer-master]");

afterEach(() => {
  cleanup();
  resetSelects();
});

describe("Master thread on a new thread's draft row", () => {
  it("shows on an unsent chat draft and hands a click back", () => {
    const onMasterChange = vi.fn();
    const view = mount({ threadType: "chat", master: false, onMasterChange });
    const label = control(view);
    expect(label?.textContent).toBe("Master thread");
    const box = label!.querySelector<HTMLElement>("[data-slot=checkbox]")!;
    expect(box.getAttribute("aria-checked")).toBe("false");
    act(() => box.click());
    expect(onMasterChange).toHaveBeenCalledWith(true);
  });

  it("the label's words tick it too, and once the chunk lands the box is Base UI's", async () => {
    const onMasterChange = vi.fn();
    const view = mount({ threadType: "chat", master: false, onMasterChange });
    act(() => control(view)!.click());
    expect(onMasterChange).toHaveBeenLastCalledWith(true);
    await act(async () => {
      await selectChunk.load();
      warmSelects();
    });
    const box = control(view)!.querySelector<HTMLElement>("[data-slot=checkbox]")!;
    expect(box.getAttribute("type")).not.toBe("button");
    act(() => box.click());
    expect(onMasterChange).toHaveBeenLastCalledWith(true);
    expect(onMasterChange).toHaveBeenCalledTimes(2);
  });

  it("reads ticked when the draft holds the pick", () => {
    const view = mount({ threadType: "chat", master: true, onMasterChange: noop });
    expect(control(view)!.querySelector("[data-slot=checkbox]")!.getAttribute("aria-checked")).toBe("true");
  });

  it("is absent on a planning draft and once the thread exists", () => {
    expect(control(mount({ threadType: "planning", master: false, onMasterChange: noop }))).toBeNull();
    cleanup();
    expect(control(mount({ threadType: "chat", onMasterChange: noop }))).toBeNull();
  });
});
