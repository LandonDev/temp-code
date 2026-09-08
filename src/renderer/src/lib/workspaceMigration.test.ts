import { beforeEach, describe, expect, it } from "vitest";
import { migrateWorkspaces, planWorkspaceMigration } from "./workspaceMigration";

function mockLocalStorage() {
  const data = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    value: {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => void data.set(key, value),
      removeItem: (key: string) => void data.delete(key),
      clear: () => data.clear(),
      key: (index: number) => [...data.keys()][index] ?? null,
      get length() {
        return data.size;
      },
    },
    configurable: true,
  });
}

describe("planWorkspaceMigration", () => {
  it("dedupes, normalizes, and drops non-projects", () => {
    const plan = planWorkspaceMigration(
      [
        { path: "/home/me/repo/", openedAt: 3 },
        { path: "/", openedAt: 2 },
        { path: "/Applications/X.app/Contents", openedAt: 1 },
      ],
      [
        { path: "/home/me/repo", archivedAt: 1 },
        { path: "/home/me/old", archivedAt: 1 },
      ],
    );
    expect(plan).toEqual(["/home/me/repo", "/home/me/old"]);
  });
});

describe("migrateWorkspaces", () => {
  beforeEach(mockLocalStorage);
  it("creates each folder once, skips rejects, then sets the flag", async () => {
    localStorage.setItem(
      "monocode.recentProjects",
      JSON.stringify([{ path: "/a", openedAt: 1 }, { path: "/b", openedAt: 2 }]),
    );
    const created: string[] = [];
    const create = async (path: string) => {
      if (path === "/b") throw new Error("missing");
      created.push(path);
    };
    await migrateWorkspaces(create);
    expect(created).toEqual(["/a"]);
    await migrateWorkspaces(create);
    expect(created).toEqual(["/a"]);
  });
});
