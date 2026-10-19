import { describe, expect, it } from "vitest";
import { crumbsFor } from "./RemoteFolderDialog";

describe("crumbsFor", () => {
  it("walks from the work root down to the folder", () => {
    expect(crumbsFor("/srv/agents/work", "/srv/agents/work/app/api")).toEqual([
      { label: "work", path: "/srv/agents/work" },
      { label: "app", path: "/srv/agents/work/app" },
      { label: "api", path: "/srv/agents/work/app/api" },
    ]);
    expect(crumbsFor("/srv/agents/work/", "/srv/agents/work")).toEqual([{ label: "work", path: "/srv/agents/work" }]);
  });
  it("shows a folder outside the root as one crumb", () => {
    expect(crumbsFor("/srv/agents/work", "/home/agents/tmp")).toEqual([{ label: "/home/agents/tmp", path: "/home/agents/tmp" }]);
  });
});
