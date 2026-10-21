// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { defaultProjectHost, loadProjectHosts, newThreadMember, rememberProjectHost } from "./projectHostChoice";

describe("defaultProjectHost", () => {
  it("takes the remembered host when the project is there, else this machine, else the first", () => {
    expect(defaultProjectHost(["local", "box"], "box", "local")).toBe("box");
    expect(defaultProjectHost(["local", "box"], "mini", "local")).toBe("local");
    expect(defaultProjectHost(["local", "box"], undefined, "local")).toBe("local");
    expect(defaultProjectHost(["box", "mini"], undefined, "local")).toBe("box");
    expect(defaultProjectHost([], undefined, "local")).toBeUndefined();
  });
});

describe("the remembered hosts", () => {
  beforeEach(() => localStorage.clear());
  it("round-trips per project key and ignores a broken store", () => {
    expect(loadProjectHosts()).toEqual({});
    rememberProjectHost("/srv/agents/work/temp-code", "box");
    rememberProjectHost("/srv/agents/work/site", "local");
    expect(loadProjectHosts()).toEqual({ "/srv/agents/work/temp-code": "box", "/srv/agents/work/site": "local" });
    localStorage.setItem("monocode.projectHosts", "{nope");
    expect(loadProjectHosts()).toEqual({});
  });
  it("picks the member on the default host for a new thread", () => {
    const members = [
      { id: "m", environmentId: "local" },
      { id: "b", environmentId: "box" },
    ];
    expect(newThreadMember(members, "k", "local")?.id).toBe("m");
    rememberProjectHost("k", "box");
    expect(newThreadMember(members, "k", "local")?.id).toBe("b");
    expect(newThreadMember(members, "other", "local")?.id).toBe("m");
  });
});
