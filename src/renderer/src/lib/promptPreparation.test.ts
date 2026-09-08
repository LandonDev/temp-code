import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ applyNotesToTurn: vi.fn() }));
vi.mock("./notes", () => ({ applyNotesToTurn: mocks.applyNotesToTurn }));

import { preparePrompt } from "./promptPreparation";

describe("preparePrompt", () => {
  it("only folds notes in; skills and mentions are the server's", async () => {
    mocks.applyNotesToTurn.mockResolvedValue("with notes");
    await expect(preparePrompt("hello /review @App.tsx")).resolves.toBe("with notes");
    expect(mocks.applyNotesToTurn).toHaveBeenCalledWith("hello /review @App.tsx");
  });
});
