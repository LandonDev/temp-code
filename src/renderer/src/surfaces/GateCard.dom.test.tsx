// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { GateNotice } from "@server/shared/gate";
import type { Block } from "../lib/session";
import { GateCard } from "./GateCard";

const block = (gate: GateNotice): Block => ({ id: "n1", role: "system", text: "", gate });
/** The lead and each detail, as the line's separate spans read them. */
const parts = (container: HTMLElement) =>
  [...container.querySelectorAll('[data-slot="notice-line"] > div > div > span')].map((s) => s.textContent);

afterEach(cleanup);

describe("GateCard", () => {
  it("a red typecheck names the branch and the error count, its log behind the caret", () => {
    const log = "src/a.ts(3,1): error TS2322: wrong\nsrc/b.ts(9,2): error TS2345: also wrong\nFound 2 errors in 2 files.";
    const { container } = render(<GateCard block={block({ step: "typecheck", branch: "feature", ok: false, log, at: 1 })} />);
    expect(parts(container)).toEqual(["Typecheck failed", "feature", "2 errors"]);
    expect(container.querySelector('[data-state="failed"]')).not.toBeNull();
    expect(container.textContent).not.toMatch(/[·|•]/);
    expect(container.querySelector("pre")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show the log" }));
    expect(container.querySelector("pre")?.textContent).toBe(log);
  });

  it("a green run is one quiet line with nothing to open", () => {
    const { container } = render(<GateCard block={block({ step: "gate", branch: "master", ok: true, log: "✓ build 20s", at: 1 })} />);
    expect(parts(container)).toEqual(["Gate passed", "master"]);
    expect(container.querySelector("button")).toBeNull();
  });

  it("a red gate names the step; a green release names the tag", () => {
    const red = render(<GateCard block={block({ step: "gate", branch: "master", ok: false, log: "✓ typecheck 2s passed\n✗ vitest 40s failed", at: 1 })} />);
    expect(parts(red.container).slice(0, 3)).toEqual(["Gate failed", "master", "at vitest"]);
    red.unmount();
    const tagged = render(<GateCard block={block({ step: "release", branch: "master", ok: true, log: "released v277 (tag release-277, package.json 1.0.277)", at: 1 })} />);
    expect(parts(tagged.container)).toEqual(["Release passed", "master", "release-277"]);
  });

  it("says a red gate's reason once on its line, the log folded behind the caret", () => {
    const { container } = render(<GateCard block={block({ step: "gate", branch: "master", ok: false, log: "✓ typecheck 2s passed\n✗ vitest 40s failed", at: 1 })} />);
    expect((container.textContent ?? "").split("at vitest")).toHaveLength(2);
    expect(container.querySelector("pre")).toBeNull();
  });

  it("a gate that never ran names its log's last line, as does a red release", () => {
    const missing = render(
      <GateCard block={block({ step: "gate", branch: "master", ok: false, log: '$ bun scripts/gate.ts\nerror: Module not found "scripts/gate.ts"', at: 1 })} />,
    );
    expect(parts(missing.container).slice(0, 3)).toEqual(["Gate failed", "master", 'error: Module not found "scripts/gate.ts"']);
    missing.unmount();
    const release = render(<GateCard block={block({ step: "release", branch: "master", ok: false, log: "tree is dirty", at: 1 })} />);
    expect(parts(release.container).slice(0, 3)).toEqual(["Release failed", "master", "tree is dirty"]);
  });
});
