// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import type { GateNotice } from "@server/shared/gate";
import type { Block } from "../lib/session";
import { GateCard } from "./GateCard";

const block = (gate: GateNotice): Block => ({ id: "n1", role: "system", text: "", gate });

describe("GateCard", () => {
  it("a red typecheck names the branch and the error count, and folds the log under a chevron", () => {
    const log = "src/a.ts(3,1): error TS2322: wrong\nsrc/b.ts(9,2): error TS2345: also wrong\nFound 2 errors in 2 files.";
    const { container } = render(<GateCard block={block({ step: "typecheck", branch: "feature", ok: false, log, at: 1 })} />);
    expect(container.textContent).toContain("Typecheck failed");
    expect(container.textContent).toContain("feature · 2 errors");
    const details = container.querySelector("details")!;
    expect(details).not.toBeNull();
    expect(details.open).toBe(false);
    expect(details.querySelector("summary")?.textContent).toContain("Last 3 lines");
    expect(details.querySelector("pre")?.textContent).toBe(log);
    expect(container.querySelector("button")).toBeNull();
  });

  it("a green run is one quiet line with nothing folded", () => {
    const { container } = render(<GateCard block={block({ step: "gate", branch: "master", ok: true, log: "✓ build 20s", at: 1 })} />);
    expect(container.textContent).toBe("Gate passed · master");
    expect(container.querySelector("details")).toBeNull();
  });

  it("a red gate names the step; a green release names the tag", () => {
    const red = render(<GateCard block={block({ step: "gate", branch: "master", ok: false, log: "✓ typecheck 2s passed\n✗ vitest 40s failed", at: 1 })} />);
    expect(red.container.textContent).toContain("Gate failed · master · at vitest");
    const tagged = render(<GateCard block={block({ step: "release", branch: "master", ok: true, log: "released v277 (tag release-277, package.json 1.0.277)", at: 1 })} />);
    expect(tagged.container.textContent).toBe("Release passed · master · release-277");
  });
});
