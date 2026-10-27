import { describe, expect, it } from "vitest";
import { cn } from "./cn";

describe("cn", () => {
  it("knows the overlay shadow token, so a later shadow replaces it", () => {
    expect(cn("shadow-overlay", "shadow-none")).toBe("shadow-none");
    expect(cn("shadow-none", "shadow-overlay")).toBe("shadow-overlay");
  });

  it("keeps the last of two conflicting utilities", () => {
    expect(cn("p-5", "p-0")).toBe("p-0");
  });
});
