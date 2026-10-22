import { describe, expect, it } from "vitest";
import { hostForPath, openFailureText } from "./pathHost";

const primary = "local";

describe("hostForPath", () => {
  it("a path under a catalog root opens on that root's host", () => {
    expect(hostForPath({ owners: ["env_box"], primary })).toBe("env_box");
    expect(hostForPath({ owners: ["env_box"], threadHost: "env_box", primary })).toBe("env_box");
  });

  it("a Mac project's file a box thread named opens on the Mac", () => {
    expect(hostForPath({ owners: [primary], threadHost: "env_box", primary })).toBe(primary);
  });

  it("a path outside every root opens on the thread's host, not this machine", () => {
    expect(hostForPath({ owners: [], threadHost: "env_box", primary })).toBe("env_box");
  });

  it("a path no thread named and no root holds is one the person opened here", () => {
    expect(hostForPath({ owners: [], primary })).toBe(primary);
  });

  it("two hosts holding the same root: the thread's host wins", () => {
    expect(hostForPath({ owners: [primary, "env_box"], threadHost: "env_box", primary })).toBe("env_box");
    expect(hostForPath({ owners: [primary, "env_box"], primary })).toBe(primary);
  });
});

describe("openFailureText", () => {
  it("a missing file says where it is missing from", () => {
    const message = "/tmp/shot.png: ENOENT: no such file or directory, stat '/tmp/shot.png'";
    expect(openFailureText(message, "The box")).toBe("No such file on The box.");
    expect(openFailureText(message, null)).toBe("No such file.");
  });

  it("every other failure keeps the host's words", () => {
    expect(openFailureText("Binary files cannot be edited.", "The box")).toBe("Binary files cannot be edited.");
  });
});
