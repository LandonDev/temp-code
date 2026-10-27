import { describe, expect, it } from "vitest";
import { IDLE_STATUS, type EnvironmentStatus } from "./connection/types";
import { capsText, hostErrorText, kindOf, originText, statusText } from "./hostConnection";

const at = (transport: EnvironmentStatus["transport"], extra: Partial<EnvironmentStatus> = {}): EnvironmentStatus => ({ ...IDLE_STATUS, transport, ...extra });

describe("host connection words", () => {
  it("words each transport state, with the retry countdown", () => {
    const now = 1_000_000;
    expect(statusText(at("open", { fresh: true }), now)).toBe("connected");
    expect(statusText(at("open"), now)).toBe("connected, catching up");
    expect(statusText(at("connecting"), now)).toBe("connecting…");
    expect(statusText(at("reconnecting", { nextRetryAt: now + 4200 }), now)).toBe("reconnecting, next try in 5 s");
    expect(statusText(at("reconnecting", { nextRetryAt: now - 1 }), now)).toBe("reconnecting…");
    expect(statusText(at("offline"), now)).toBe("offline");
    expect(statusText(at("unauthorized"), now)).toBe("key refused");
  });
  it("says a connected host is slow to answer, and leaves the other states as they were", () => {
    const now = 1_000_000;
    expect(statusText(at("open", { fresh: true }), now, true)).toBe("connected, slow to answer");
    expect(statusText(at("open"), now, true)).toBe("connected, slow to answer");
    expect(statusText(at("reconnecting", { nextRetryAt: now + 4200 }), now, true)).toBe("reconnecting, next try in 5 s");
    expect(statusText(at("offline"), now, true)).toBe("offline");
  });
  it("names what a key may do beyond reading", () => {
    expect(capsText(["read"])).toBe("read only");
    expect(capsText(["read", "operate", "approve"])).toBe("operate, approve");
    expect(capsText(["admin", "operate", "read", "approve"])).toBe("operate, approve, admin");
  });
  it("shows the main process's detail as the one error line", () => {
    expect(hostErrorText(new Error("unauthorized: https://h refused the pairing code (expired, used, or mistyped)"))).toBe("https://h refused the pairing code (expired, used, or mistyped)");
    expect(hostErrorText(new Error("self: https://h is this machine"))).toBe("That is this machine.");
    expect(hostErrorText(new Error("contract: https://h speaks contract v2 and this app speaks v1; update the app"))).toBe("https://h speaks contract v2 and this app speaks v1; update the app");
    expect(hostErrorText(new Error("not connected"))).toBe("not connected");
  });
  it("classifies routes the way the main process does and shows hosts", () => {
    expect(kindOf("http://127.0.0.1:7677")).toBe("loopback");
    expect(kindOf("ws://192.168.1.20:7677/ws")).toBe("lan");
    expect(kindOf("https://tempcode.example.com")).toBe("tunnel");
    expect(kindOf("garbage")).toBe("tunnel");
    expect(originText("wss://tempcode.example.com/ws")).toBe("tempcode.example.com");
    expect(originText("ws://127.0.0.1:7677/ws")).toBe("127.0.0.1:7677");
  });
});
