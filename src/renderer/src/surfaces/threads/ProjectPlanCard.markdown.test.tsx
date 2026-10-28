// @vitest-environment jsdom
/**
 * A milestone's scope on the real streamdown pipeline (the dom project stubs
 * streamdown out, so this runs in the node project, like
 * AgentMarkdown.prose.test.tsx): its markdown renders, `code` as code.
 */
import "../../test/domSetup";

import { cleanup, fireEvent, render } from "@testing-library/react";
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

  it("opens a file the scope names, as the plan's own text does", () => {
    const onOpenFile = vi.fn();
    const doc = "# Acme\n\n## Milestones\n\n### [ ] 1. Ship\n- Scope: start in `src/store.ts`\n";
    const { container } = render(<MilestoneList doc={doc} projectId="p1" cwd="/repo" onOpenFile={onOpenFile} />);
    const code = container.querySelector('[data-milestone-scope] code[role="link"]')!;
    fireEvent.click(code);
    expect(onOpenFile).toHaveBeenCalled();
    expect(String(onOpenFile.mock.calls[0][0])).toContain("store.ts");
  });
});

describe("MilestoneList fields", () => {
  const doc =
    "# Acme\n\n## Milestones\n\n### [ ] 1. Ship\n- Scope: land it\n- Dependencies: the `store` slice\n- Done when: `bun test` passes on `main`\n";

  it("renders Done when's inline code as code after its label, with no literal backtick", () => {
    const { container } = render(<MilestoneList doc={doc} projectId="p1" />);
    const field = container.querySelector('[data-milestone-field="done-when"]')!;
    expect([...field.querySelectorAll("code")].map((c) => c.textContent)).toEqual(["bun test", "main"]);
    expect(field.textContent).not.toContain("`");
    expect(field.textContent).toMatch(/^Done when bun test passes on main/);
  });

  it("renders Depends on the same way", () => {
    const { container } = render(<MilestoneList doc={doc} projectId="p1" />);
    const field = container.querySelector('[data-milestone-field="dependencies"]')!;
    expect(field.querySelector("code")?.textContent).toBe("store");
    expect(field.textContent).not.toContain("`");
    expect(field.textContent).toMatch(/^Depends on the store slice/);
  });
});
