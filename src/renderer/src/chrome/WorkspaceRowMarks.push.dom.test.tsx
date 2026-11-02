import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sessionStore } from "../lib/tcserver/store";
import { workspaceStore } from "../lib/tcserver/workspaces";
import { FakeMetaLink, wireMeta } from "../test/fakeMetaLink";
import { RailRow } from "./RailRow";
import { useWorkspaceMarks, WorkspaceMarkView } from "./WorkspaceRowMarks";

const flush = () => act(() => new Promise((r) => setTimeout(r, 20)));

describe("the rail's workspace marks and the pushes they do not show", () => {
  let link: FakeMetaLink;
  beforeEach(async () => {
    sessionStore.reset();
    workspaceStore.reset();
    workspaceStore.hydrate([
      {
        environmentId: "local",
        workspaces: [
          { id: "w1", name: "alpha", path: "/alpha", environmentId: "local", createdAt: 1 },
          { id: "w2", name: "beta", path: "/beta", environmentId: "local", createdAt: 1 },
        ],
        projects: [],
      },
    ]);
    link = new FakeMetaLink();
    link.metas = [wireMeta("a", { workspaceId: "w1", cwd: "/alpha" }), wireMeta("b", { workspaceId: "w2", cwd: "/beta", status: "idle" })];
    sessionStore.attach(link);
    await sessionStore.ready();
  });
  afterEach(() => {
    cleanup();
    sessionStore.reset();
    workspaceStore.reset();
  });

  it("re-renders no rail row for 100 pushes no mark shows, and the rail once for a mark that changed", async () => {
    let renders = 0;
    const Rail = () => {
      renders++;
      const marks = useWorkspaceMarks();
      return (
        <>
          {[...marks].map(([path, m]) => (
            <RailRow key={path} label={path} trailing={m.mark ? <WorkspaceMarkView mark={m.mark} /> : null} />
          ))}
        </>
      );
    };
    const { container } = render(<Rail />);
    await flush();
    const first = renders;
    expect(container.querySelector('[data-slot="status-mark"]')?.getAttribute("data-state")).toBe("working");

    // A settled thread elsewhere renamed, and the working thread's live context: nothing a mark shows.
    for (let i = 1; i <= 100; i++) {
      link.push({ push: "session", session: wireMeta("b", { workspaceId: "w2", cwd: "/beta", status: "idle", title: `b ${i}` }) });
      link.push({ push: "session", session: wireMeta("a", { workspaceId: "w1", cwd: "/alpha", context: { tokens: i, window: 1_000_000 } }) });
    }
    await flush();
    expect(renders).toBe(first);

    link.push({ push: "session", session: wireMeta("a", { workspaceId: "w1", cwd: "/alpha", status: "waiting" }) });
    await flush();
    expect(renders).toBe(first + 1);
    expect(container.querySelector('[data-slot="status-mark"]')?.getAttribute("data-state")).toBe("waiting");
  });
});
