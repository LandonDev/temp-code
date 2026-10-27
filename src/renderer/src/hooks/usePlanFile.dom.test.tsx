// @vitest-environment jsdom
/** The plan file poll: a bumped revision reads the file again at once (a milestone ticked here). */
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const readFile = vi.hoisted(() => vi.fn(async () => "v1"));
vi.mock("../lib/tcserver/commands", () => ({ readFile }));
vi.mock("../lib/tcserver/projects", () => ({ hostOfCwd: () => "local" }));
vi.mock("./paneVisibility", () => ({ usePaneVisible: () => true }));

import { usePlanFile } from "./usePlanFile";

afterEach(cleanup);

function Doc({ revision }: { revision: number }) {
  return <pre>{usePlanFile("/repo/plan.md", false, undefined, revision)}</pre>;
}

describe("usePlanFile", () => {
  it("reads again on a new revision, without waiting for the idle poll", async () => {
    const view = render(<Doc revision={0} />);
    await act(async () => {});
    expect(view.container.textContent).toBe("v1");
    readFile.mockResolvedValue("v2");
    view.rerender(<Doc revision={1} />);
    await act(async () => {});
    expect(readFile).toHaveBeenCalledTimes(2);
    expect(view.container.textContent).toBe("v2");
  });
});
