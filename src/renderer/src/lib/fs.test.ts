import { describe, expect, it } from "vitest";
import { folderPickOn, isCheckoutBlockedByChanges } from "./fs";

describe("folderPickOn", () => {
  it("browses another host over its link, this machine natively, and the page's own host at /ui", () => {
    expect(folderPickOn("env_box", "local", false)).toBe("env_box");
    expect(folderPickOn(undefined, "local", false)).toBeNull();
    expect(folderPickOn("local", "local", false)).toBeNull();
    expect(folderPickOn(undefined, "web", true)).toBe("web");
    expect(folderPickOn("web", "web", true)).toBe("web");
  });
});

describe("isCheckoutBlockedByChanges", () => {
  it("detects git's tracked-file checkout error", () => {
    expect(
      isCheckoutBlockedByChanges(
        "error: Your local changes to the following files would be overwritten by checkout:\n\ta.txt\nPlease commit your changes or stash them before you switch branches.",
      ),
    ).toBe(true);
  });

  it("detects git's untracked-file checkout error", () => {
    expect(
      isCheckoutBlockedByChanges(
        "error: The following untracked working tree files would be overwritten by checkout:\n\tnew.txt\nPlease move or remove them before you switch branches.",
      ),
    ).toBe(true);
  });

  it("detects the mapped app error", () => {
    expect(
      isCheckoutBlockedByChanges(
        "Your local changes would be overwritten. Commit or stash them first.",
      ),
    ).toBe(true);
  });

  it("ignores unrelated git errors", () => {
    expect(isCheckoutBlockedByChanges("Branch missing not found")).toBe(false);
    expect(isCheckoutBlockedByChanges("Not a git repository")).toBe(false);
  });
});
