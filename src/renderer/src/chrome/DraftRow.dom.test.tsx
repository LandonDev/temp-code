// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./CwdPicker", () => ({ CwdPicker: () => <span data-testid="project" /> }));
vi.mock("./DraftHostPicker", () => ({ DraftHostPicker: () => <span data-testid="host" /> }));
vi.mock("./BranchPicker", () => ({ BranchPicker: () => <span data-testid="branch" /> }));
vi.mock("./ThreadTypeChip", () => ({ ThreadTypeChip: () => <span data-testid="type" /> }));

import { DraftRow, clearComposerHandoff, flipFrom, peekComposerHandoff, recordComposerHandoff } from "./Composer";

afterEach(cleanup);

const rowEl = (draft: boolean) => (
    <DraftRow
      draft={draft}
      cwd="/u/me/app"
      recents={[]}
      enabled
      busy={false}
      sessionId="s1"
      threadType="chat"
      onCwdChange={() => {}}
      onThreadTypeChange={() => {}}
      onClose={() => {}}
    />
);
const row = (draft: boolean) => render(rowEl(draft));

describe("DraftRow", () => {
  it("holds the project, host, branch and type pickers on a draft", () => {
    row(true);
    for (const id of ["project", "host", "branch", "type"]) expect(screen.getByTestId(id)).toBeTruthy();
  });

  it("folds away on the first message (a Collapsible), its pickers held until the fold is done", async () => {
    const view = row(true);
    const draftRow = view.container.querySelector("[data-composer-draft-row]")!;
    expect(draftRow.closest('[data-slot="collapsible-content"]')).toBeTruthy();
    view.rerender(rowEl(false));
    await waitFor(() => expect(view.container.querySelector("[data-composer-draft-row]")).toBeNull());
  });

  it("is gone after the first message: the branch is changed in the Changes head", () => {
    const { container } = row(false);
    expect(container.querySelector("[data-composer-draft-row]")).toBeNull();
    expect(screen.queryByTestId("branch")).toBeNull();
  });
});

describe("a draft's first send hands the box over", () => {
  afterEach(() => clearComposerHandoff());

  it("the composer that mounts for the thread within a second reads where the box stood, once cleared", () => {
    recordComposerHandoff("s1", { top: 300, left: 40 }, 1_000);
    expect(peekComposerHandoff("s1", 1_500)).toMatchObject({ top: 300, left: 40 });
    expect(peekComposerHandoff("s2", 1_500)).toBeNull();
    expect(peekComposerHandoff("s1", 2_001)).toBeNull();
    const taken = peekComposerHandoff("s1", 1_500)!;
    clearComposerHandoff(taken);
    expect(peekComposerHandoff("s1", 1_500)).toBeNull();
  });

  it("a box already where it stood keeps its rect: no transform, no transition", () => {
    const box = document.createElement("div");
    box.getBoundingClientRect = () => ({ top: 300, left: 40 }) as DOMRect;
    expect(flipFrom(box, { top: 300, left: 40 })).toBe(false);
    expect(box.style.transform).toBe("");
    expect(box.style.transition).toBe("");
  });

  it("a box that moved glides from where it stood: a translate on the drawer curve, cleared at its end", () => {
    const box = document.createElement("div");
    box.getBoundingClientRect = () => ({ top: 700, left: 40 }) as DOMRect;
    expect(flipFrom(box, { top: 300, left: 40 })).toBe(true);
    expect(box.style.transition).toBe("transform var(--dur-slow) var(--ease-drawer)");
    expect(box.style.transform).toBe("");
    const end = new Event("transitionend");
    Object.defineProperty(end, "propertyName", { value: "transform" });
    box.dispatchEvent(end);
    expect(box.style.transition).toBe("");
  });
});
