import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(resolve(__dirname, "index.css"), "utf8") + readFileSync(resolve(__dirname, "surfaces/transcript/transcript.css"), "utf8");
const rule = (selector: string) => css.match(new RegExp(`\\n${selector.replace(/[.[\]]/g, "\\$&")} \\{([^}]*)\\}`))?.[1] ?? "";

describe("the motion floor", () => {
  it("lands the send bubble inside the UI budget, on the tokens", () => {
    expect(rule(".bubble-send-flip")).toContain("animation: bubble-send-flip 280ms var(--ease-drawer) both;");
    expect(rule(".bubble-send-in")).toContain("animation: bubble-send-in 280ms var(--ease-drawer) both;");
  });

  it("has no modal or popover-exit keyframes left from the ghost exits", () => {
    expect(css).not.toMatch(/@keyframes (modal-|popover-close|approval-toast)/);
    expect(css).not.toMatch(/\.(modal-panel|modal-backdrop|modal-closing|popover-close|approval-toast)\b/);
  });

  it("keeps a --dur-fast fade on overlays under reduced motion", () => {
    const reduced = css.split("@media (prefers-reduced-motion: reduce)").slice(1).join("");
    expect(reduced).toContain('[data-slot="dialog-content"]');
    expect(reduced).toContain("animation-duration: var(--dur-fast);");
    expect(reduced).toMatch(/\.popover-open \{\s*animation: z-fade-quick var\(--dur-fast\) var\(--ease-out\) both;/);
  });
});
