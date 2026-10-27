import { describe, expect, it } from "vitest";
import { transcriptCodeTheme } from "./transcriptCodeTheme";

const rules = transcriptCodeTheme.settings ?? [];
const ruleFor = (scope: string) =>
  rules.find((r) => (Array.isArray(r.scope) ? r.scope : [r.scope]).includes(scope))?.settings;

describe("transcriptCodeTheme", () => {
  it("colours only with the two inks, never a hex", () => {
    for (const rule of rules) {
      expect(["var(--code-strong)", "var(--code-soft)"]).toContain(rule.settings.foreground);
    }
    expect(JSON.stringify(transcriptCodeTheme)).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });

  it("tells keywords and comments apart by weight and style", () => {
    expect(ruleFor("keyword")?.fontStyle).toBe("bold");
    expect(ruleFor("comment")?.fontStyle).toBe("italic");
    expect(ruleFor("string")?.foreground).toBe("var(--code-soft)");
    expect(ruleFor("entity.name.function")?.fontStyle).toBeUndefined();
  });
});
