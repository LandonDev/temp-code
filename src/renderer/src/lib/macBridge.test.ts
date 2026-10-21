import { describe, expect, it } from "vitest";
import { bridgeableEnvironment, quoteArgv } from "./macBridge";

describe("quoteArgv", () => {
  it("shows argv exactly as a shell would need it typed", () => {
    expect(quoteArgv(["xcrun", "simctl", "list"])).toBe("xcrun simctl list");
    expect(quoteArgv(["/bin/sh", "-c", "echo $HOME; rm -rf x"])).toBe("/bin/sh -c 'echo $HOME; rm -rf x'");
    expect(quoteArgv(["echo", "it's"])).toBe("echo 'it'\\''s'");
    expect(quoteArgv(["a b"])).toBe("'a b'");
  });
});

describe("bridgeableEnvironment", () => {
  it("only another host's threads", () => {
    expect(bridgeableEnvironment("local")).toBe(false);
    expect(bridgeableEnvironment("web")).toBe(false);
    expect(bridgeableEnvironment(undefined)).toBe(false);
    expect(bridgeableEnvironment("env_box")).toBe(true);
  });
});
