import { describe, expect, it } from "vitest";
import { COPIED_MS } from "./clipboard";
import { COPIED_MS as CODE_BLOCK_COPIED_MS } from "../surfaces/CodeBlock";

describe("COPIED_MS", () => {
  it("is one beat for every Copy control, the code block's included", () => {
    expect(COPIED_MS).toBe(1200);
    expect(CODE_BLOCK_COPIED_MS).toBe(COPIED_MS);
  });
});
