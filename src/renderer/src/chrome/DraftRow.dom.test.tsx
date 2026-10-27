// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./CwdPicker", () => ({ CwdPicker: () => <span data-testid="project" /> }));
vi.mock("./DraftHostPicker", () => ({ DraftHostPicker: () => <span data-testid="host" /> }));
vi.mock("./BranchPicker", () => ({ BranchPicker: () => <span data-testid="branch" /> }));
vi.mock("./ThreadTypeChip", () => ({ ThreadTypeChip: () => <span data-testid="type" /> }));

import { DraftRow } from "./Composer";

afterEach(cleanup);

const row = (draft: boolean) =>
  render(
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
    />,
  );

describe("DraftRow", () => {
  it("holds the project, host, branch and type pickers on a draft", () => {
    row(true);
    for (const id of ["project", "host", "branch", "type"]) expect(screen.getByTestId(id)).toBeTruthy();
  });

  it("is gone after the first message: the branch is changed in the Changes head", () => {
    const { container } = row(false);
    expect(container.querySelector("[data-composer-draft-row]")).toBeNull();
    expect(screen.queryByTestId("branch")).toBeNull();
  });
});
