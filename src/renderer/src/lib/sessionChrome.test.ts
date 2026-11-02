import { describe, expect, it } from "vitest";
import { sameSessionChrome, type Block, type Session } from "./session";

const user: Block = { id: "u1", role: "user", text: "Go" };
const answer = (text: string): Block => ({ id: "a1", role: "assistant", text });
const base = { id: "s", title: "T", harness: "claude", status: "running", busy: true, busySince: 1 } as unknown as Session;
const at = (blocks: Block[], extra: Partial<Session> = {}): Session => ({ ...base, ...extra, blocks });

describe("sameSessionChrome", () => {
  it("reads a streamed delta as the same session", () => {
    expect(sameSessionChrome(at([user, answer("Hel")]), at([user, answer("Hello")]))).toBe(true);
  });

  it("reads any other field as a change", () => {
    expect(sameSessionChrome(at([user]), at([user], { status: "idle" }))).toBe(false);
    expect(sameSessionChrome(at([user]), at([user], { activity: "Reading" }))).toBe(false);
  });

  it("reads a new message from the person as a change: the turn clock may start from it", () => {
    const next: Block = { id: "u2", role: "user", text: "And" };
    expect(sameSessionChrome(at([user, answer("Hi")]), at([user, answer("Hi"), next]))).toBe(false);
  });

  it("reads a field that appeared or left as a change", () => {
    expect(sameSessionChrome(at([user]), at([user], { sentAt: 5 }))).toBe(false);
    expect(sameSessionChrome(at([user], { sentAt: 5 }), at([user]))).toBe(false);
  });
});
