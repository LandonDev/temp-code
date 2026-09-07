import { describe, expect, it } from "vitest";
import { fileRefTarget } from "./fileRef";

describe("fileRefTarget", () => {
  it("strips a line suffix and keeps absolute paths", () => {
    expect(fileRefTarget("/p/src/a.ts:12:3")).toEqual({ clean: "/p/src/a.ts", abs: "/p/src/a.ts", name: "a.ts" });
  });
  it("resolves relative paths against the cwd", () => {
    expect(fileRefTarget("./src/a.ts:4", "/p/")).toMatchObject({ abs: "/p/src/a.ts", name: "a.ts" });
    expect(fileRefTarget("src/a.ts")).toMatchObject({ abs: null, clean: "src/a.ts" });
    expect(fileRefTarget("~/x.ts", "/p")).toMatchObject({ abs: null, name: "x.ts" });
  });
});
