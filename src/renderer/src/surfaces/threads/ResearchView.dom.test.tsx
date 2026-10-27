// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResearchBoard } from "../../lib/threads/researchBoard";
import type { Session } from "../../lib/session";

const docs: Record<string, string> = {};
vi.mock("../../hooks/usePlanFile", () => ({ usePlanFile: (path: string | null) => (path ? (docs[path] ?? null) : null) }));
const metas: Record<string, { status?: string; title?: string; planPath?: string }> = {};
const blocksOf: Record<string, unknown[]> = {};
vi.mock("../../lib/tcserver/store", () => ({
  sessionStore: {
    subscribe: () => () => {},
    onMetaChange: () => () => {},
    metaOf: (id: string) => metas[id] ?? null,
    get: (id: string) => (blocksOf[id] ? { blocks: blocksOf[id] } : null),
  },
}));
let board: ResearchBoard = { angles: [], sources: 0, searches: 0 };
vi.mock("../../lib/threads/researchBoard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/threads/researchBoard")>()),
  foldResearchBoard: () => board,
}));
vi.mock("../AgentMarkdown", () => ({ AgentMarkdown: ({ text }: { text: string }) => <div data-md>{text}</div> }));
vi.mock("./fleet/AgentDetail", () => ({ AgentDetail: () => null }));
vi.mock("./SplitShell", () => ({
  SplitShell: (p: { board: React.ReactNode; title?: React.ReactNode; detail?: React.ReactNode; actions?: React.ReactNode }) => (
    <div>
      <header data-view-header>
        <span>{p.title}</span>
        <span data-detail>{p.detail}</span>
        {p.actions}
      </header>
      {p.board}
    </div>
  ),
}));

import { ResearchView } from "./ResearchView";

const REPORT = "/repo/.temp-code/reports/r1.md";

const session = (over: Partial<Session> = {}): Session =>
  ({
    id: "r1",
    environmentId: "local",
    title: "Why is the build slow?",
    cwd: "/repo",
    planPath: REPORT,
    threadType: "research",
    status: "idle",
    blocks: [],
    thread: { sources: [{}], agents: ["a1", "a2"] },
    ...over,
  }) as unknown as Session;

const props = (s: Session, onOpenFile = vi.fn()) =>
  ({ session: s, renderChat: () => null, onOpenFile, onOpenDiff: () => {} }) as unknown as Parameters<typeof ResearchView>[0];

afterEach(() => {
  cleanup();
  for (const k of Object.keys(docs)) delete docs[k];
  for (const k of Object.keys(metas)) delete metas[k];
  for (const k of Object.keys(blocksOf)) delete blocksOf[k];
});

function seed(): void {
  board = {
    sources: 18,
    searches: 6,
    angles: [
      {
        agentId: "r1",
        label: "",
        queries: [{ query: null, sources: [{ callId: "c0", url: "https://own.dev/x", title: "Own" }] }],
      },
      {
        agentId: "a1",
        label: "Bundler",
        queries: [
          {
            query: "vite cold start",
            sources: [{ callId: "c1", url: "https://www.vitejs.dev/guide", title: "Vite guide", claim: "Pre-bundling is cached" }],
          },
        ],
      },
    ],
  };
  metas.a1 = { status: "running", title: "Bundler angle", planPath: "/repo/.temp-code/reports/a1.md" };
  metas.a2 = { status: "idle", title: "Cache angle" };
  blocksOf.a1 = [{ role: "tool", tool: { name: "WebFetch" } }];
  docs["/repo/.temp-code/reports/a1.md"] = "---\nsummary: Vite caches deps\n---\nbody";
}

describe("the research view", () => {
  it("states the header's facts as separate words, no middle dot, and opens the report", () => {
    seed();
    docs[REPORT] = "---\ntitle: Build speed\nstatus: draft\n---\n";
    const onOpenFile = vi.fn();
    render(<ResearchView {...props(session(), onOpenFile)} />);
    const facts = [...document.querySelectorAll("[data-detail] span")].map((e) => e.textContent);
    expect(facts).toEqual(["1 of 2 angles", "18 sources", "6 searches"]);
    expect((document.querySelector("[data-view-header]") as HTMLElement).textContent).not.toContain("·");
    fireEvent.click(screen.getByRole("button", { name: "Open the report" }));
    expect(onOpenFile).toHaveBeenCalledWith(REPORT);
  });

  it("an unfinished report shows its state and summary; a complete one renders the body", () => {
    docs[REPORT] = "---\ntitle: Build speed\nstatus: draft\nsummary: Three causes so far\n---\nhidden body";
    const view = render(<ResearchView {...props(session({ status: "running" }))} />);
    expect(screen.getByText("Build speed")).toBeTruthy();
    expect(screen.getByText("writing")).toBeTruthy();
    expect(screen.getByText("Three causes so far")).toBeTruthy();
    expect(document.querySelector("[data-md]")).toBeNull();
    view.unmount();
    docs[REPORT] = "---\ntitle: Build speed\nstatus: complete\n---\nthe findings";
    render(<ResearchView {...props(session())} />);
    expect(document.querySelector("[data-md]")?.textContent).toBe("the findings");
    expect(screen.queryByText("writing")).toBeNull();
  });

  it("a live angle shows Working with what it is doing, and its findings open their file", () => {
    seed();
    const onOpenFile = vi.fn();
    render(<ResearchView {...props(session(), onOpenFile)} />);
    const angle = screen.getByRole("button", { name: /Bundler angle/ });
    expect(angle.textContent).toContain("Working");
    expect(angle.textContent).toContain("reading");
    fireEvent.click(screen.getByRole("button", { name: "Vite caches deps" }));
    expect(onOpenFile).toHaveBeenCalledWith("/repo/.temp-code/reports/a1.md");
  });

  it("a source opens its address, shows its host and its claim", () => {
    seed();
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    render(<ResearchView {...props(session())} />);
    const source = screen.getByRole("button", { name: /Vite guide/ });
    expect(source.textContent).toContain("vitejs.dev");
    expect(source.textContent).toContain("Pre-bundling is cached");
    fireEvent.click(source);
    expect(open).toHaveBeenCalledWith("https://www.vitejs.dev/guide", "_blank");
    open.mockRestore();
  });

  it("the root's own research is not a button", () => {
    seed();
    render(<ResearchView {...props(session())} />);
    expect(screen.getByText("Direct research").closest("button")).toBeNull();
  });
});
