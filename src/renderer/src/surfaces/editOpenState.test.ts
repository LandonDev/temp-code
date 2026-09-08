import { beforeEach, describe, expect, it } from "vitest";
import type { Block } from "../lib/session";
import { editOpenKey, getEditOpen, setEditOpen } from "./editOpenState";

const KEY = "temp-code.editOpen";

class MemoryStorage {
  private map = new Map<string, string>();
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, v);
  }
}

describe("edit open state", () => {
  beforeEach(() => {
    (globalThis as { localStorage?: unknown }).localStorage = new MemoryStorage();
  });
  it("keys by session and call, falling back to the block id", () => {
    const withCall = { id: "b", tool: { callId: "c" } } as unknown as Block;
    const noCall = { id: "b" } as unknown as Block;
    expect(editOpenKey("s", withCall)).toBe("s:c");
    expect(editOpenKey(undefined, noCall)).toBe("-:b");
  });
  it("remembers a toggle and writes it through to storage", () => {
    expect(getEditOpen("s:x")).toBeUndefined();
    setEditOpen("s:x", false);
    expect(getEditOpen("s:x")).toBe(false);
    const raw = (globalThis as { localStorage: MemoryStorage }).localStorage.getItem(KEY);
    expect(JSON.parse(raw ?? "{}")).toMatchObject({ "s:x": false });
  });
});
