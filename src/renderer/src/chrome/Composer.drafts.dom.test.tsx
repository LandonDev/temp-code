// @vitest-environment jsdom
/**
 * A project's remembered draft keeps what its composer held: text and @
 * chips typed into it come back after the composer unmounts and mounts
 * again, and after localStorage is read again (a relaunch). A sent thread
 * still keeps its text through composerDrafts.
 */
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./CwdPicker", () => ({ CwdPicker: () => null }));
vi.mock("./DraftHostPicker", () => ({ DraftHostPicker: () => null }));
vi.mock("./BranchPicker", () => ({ BranchPicker: () => null }));
vi.mock("./ThreadTypeChip", () => ({ ThreadTypeChip: () => null }));
vi.mock("./ModelPicker", () => ({ ModelPicker: () => null }));

import { Composer } from "./Composer";
import { projectDrafts, type DraftRecord } from "../lib/projectDrafts";
import { saveComposerDraft } from "../lib/composerDrafts";

const record: DraftRecord = {
  id: "draft-1",
  environmentId: "local",
  projectId: "p1",
  workspaceId: "w1",
  cwd: "/work/alpha",
  harness: "claude",
  model: "claude-opus-5-5",
  modelSettings: {},
  runtimeMode: "supervised" as DraftRecord["runtimeMode"],
  threadType: "chat",
  threadRules: null,
  segments: [],
  attachments: [],
  seenAt: 0,
};

function mount(sessionId: string) {
  const view = render(
    <Composer
      focused={false}
      harness="claude"
      model="claude-opus-5-5"
      runtimeMode={"supervised" as DraftRecord["runtimeMode"]}
      executionCwd="/work/alpha"
      cwd="/work/alpha"
      sessionId={sessionId}
      projectId="p1"
      onFocus={() => {}}
      onCwdChange={() => {}}
      onModelChange={() => {}}
      onRuntimeModeChange={() => {}}
      onSubmit={() => {}}
    />,
  );
  const field = view.container.querySelector<HTMLElement>("[data-composer-input]")!;
  return { ...view, field };
}

function type(field: HTMLElement, text: string) {
  act(() => {
    field.append(document.createTextNode(text));
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  localStorage.clear();
  projectDrafts.reload();
});
afterEach(cleanup);

describe("Composer and the project's remembered draft", () => {
  it("brings typed text back after an unmount and after a reload", () => {
    projectDrafts.put("p1", record);
    const first = mount("draft-1");
    type(first.field, "fix the login flow");
    first.unmount();
    expect(projectDrafts.get("p1")!.segments).toEqual([{ text: "fix the login flow" }]);

    const second = mount("draft-1");
    expect(second.field.textContent).toBe("fix the login flow");
    second.unmount();

    projectDrafts.flush();
    projectDrafts.reload();
    const third = mount("draft-1");
    expect(third.field.textContent).toBe("fix the login flow");
  });

  it("restores an @ chip the record holds", () => {
    const chip = { chip: { token: "@src/app.ts", name: "app.ts" } } as never;
    projectDrafts.put("p1", { ...record, segments: [{ text: "look at " }, chip] });
    const view = mount("draft-1");
    expect(view.field.textContent).toContain("look at");
    expect(view.field.querySelector("[data-token=\"@src/app.ts\"]")).not.toBeNull();
    view.unmount();
    expect(projectDrafts.get("p1")!.segments[1]).toEqual(chip);
  });

  it("writes while typing, before any unmount", () => {
    vi.useFakeTimers();
    try {
      projectDrafts.put("p1", record);
      const view = mount("draft-1");
      type(view.field, "half a thought");
      act(() => vi.advanceTimersByTime(400));
      expect(projectDrafts.get("p1")!.segments).toEqual([{ text: "half a thought" }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a sent thread's text in composerDrafts, never in a record", () => {
    saveComposerDraft("thread-9", { segments: [{ text: "follow-up" }], attachments: [] });
    const view = mount("thread-9");
    expect(view.field.textContent).toBe("follow-up");
    type(view.field, " more");
    view.unmount();
    expect(projectDrafts.keyOfDraft("thread-9")).toBeNull();
    const again = mount("thread-9");
    expect(again.field.textContent).toBe("follow-up more");
  });
});
