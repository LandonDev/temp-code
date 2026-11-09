import { describe, expect, it } from "vitest";
import { homeNote, readHome, refusalWords } from "./settingsHome";

describe("settingsHome", () => {
  it("says where the copy lives, and blocks while that host is offline", () => {
    expect(homeNote(null)).toEqual({ note: undefined, blocked: false });
    expect(homeNote({ name: "box", online: true })).toEqual({ note: "Saved on box", blocked: false });
    expect(homeNote({ name: "box", online: false })).toEqual({ note: "box is offline", blocked: true });
    expect(readHome({ name: "box", online: 1 })).toBeNull();
  });

  it("words a refusal without its prefix, first letter raised", () => {
    expect(refusalWords(new Error("refused: an add-on named github already exists there"))).toBe("An add-on named github already exists there");
    expect(refusalWords(new Error("The host did not answer"))).toBe("The host did not answer");
    expect(refusalWords(undefined)).toBe("");
  });
});
