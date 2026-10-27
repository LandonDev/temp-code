// @vitest-environment jsdom
/**
 * A milestone's scope on the real streamdown pipeline (the dom project stubs
 * streamdown out, so this runs in the node project, like
 * AgentMarkdown.prose.test.tsx): its markdown renders, `code` as code.
 */
import "../../test/domSetup";

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/highlight", () => ({ highlight: () => Promise.resolve(null), highlightCached: () => undefined }));
vi.mock("../FileRefMenu", () => ({ FileRefMenu: ({ children }: { children: unknown }) => children }));
vi.mock("../../lib/projectPlan", () => ({ tickMilestone: vi.fn() }));

import { MilestoneList } from "./ProjectPlanCard";

afterEach(cleanup);

describe("MilestoneList scope", () => {
  it("renders the scope's inline code as code, never as raw backticks", () => {
    const doc = "# Acme\n\n## Milestones\n\n### [ ] 1. Ship\n- Scope: land it on `main` first\n";
    const { container } = render(<MilestoneList doc={doc} projectId="p1" />);
    const scope = container.querySelector("[data-milestone-scope]")!;
    expect(scope.querySelector("code")?.textContent).toBe("main");
    expect(scope.textContent).not.toContain("`");
  });
});
