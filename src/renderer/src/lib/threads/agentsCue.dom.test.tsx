// @vitest-environment jsdom
/**
 * The agents cue's hook on the real store: it renders its consumer only
 * for a change in the root's tree, keeps an equal answer the same object,
 * and answers nothing for a subagent.
 */
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sessionStore } from "../tcserver/store";
import { FakeMetaLink, wireMeta } from "../../test/fakeMetaLink";
import { useAgentsCue, type AgentsCue } from "./agents";

const flush = () => act(() => new Promise((r) => setTimeout(r, 20)));

describe("useAgentsCue", () => {
  let link: FakeMetaLink;
  let renders: (AgentsCue | null)[];
  function Probe({ id }: { id: string | null }) {
    renders.push(useAgentsCue(id));
    return null;
  }

  beforeEach(async () => {
    sessionStore.reset();
    renders = [];
    link = new FakeMetaLink();
    link.metas = [
      wireMeta("root", { status: "watching" }),
      wireMeta("kid", { parentId: "root", status: "running" }),
      wireMeta("grandkid", { parentId: "kid", status: "queued" }),
      wireMeta("elsewhere"),
    ];
    sessionStore.attach(link);
    await sessionStore.ready();
  });
  afterEach(() => {
    cleanup();
    sessionStore.reset();
  });

  it("reads the tree, and renders nothing for a push of another thread", async () => {
    render(<Probe id="root" />);
    await flush();
    expect(renders.at(-1)).toMatchObject({ state: "working", still: false, label: "2 agents", line: "Agents: 1 working, 1 queued" });
    const before = renders.length;
    for (let i = 1; i <= 50; i++) link.push({ push: "session", session: wireMeta("elsewhere", { title: `Elsewhere ${i}` }) });
    await flush();
    expect(renders.length).toBe(before);
  });

  it("renders once for a child's change, with the new cue", async () => {
    render(<Probe id="root" />);
    await flush();
    const before = renders.length;
    link.push({ push: "session", session: wireMeta("kid", { parentId: "root", status: "waiting" }) });
    await flush();
    expect(renders.length).toBe(before + 1);
    expect(renders.at(-1)).toMatchObject({ state: "waiting", line: "Agents: 1 needs you, 1 queued" });
  });

  it("keeps an equal answer the same object", async () => {
    render(<Probe id="root" />);
    await flush();
    const first = renders.at(-1);
    link.push({ push: "session", session: wireMeta("grandkid", { parentId: "kid", status: "queued", title: "Renamed" }) });
    await flush();
    expect(renders.at(-1)).toBe(first);
  });

  it("follows an archive: the archived child leaves the count", async () => {
    render(<Probe id="root" />);
    await flush();
    link.push({ push: "session", session: wireMeta("grandkid", { parentId: "kid", status: "queued", archived: true }) });
    await flush();
    expect(renders.at(-1)?.label).toBe("1 agent");
  });

  it("draws working still while the root's own turn runs", async () => {
    render(<Probe id="root" />);
    await flush();
    link.push({ push: "session", session: wireMeta("root", { status: "running" }) });
    await flush();
    expect(renders.at(-1)?.still).toBe(true);
  });

  it("answers nothing for a subagent, an unknown id or no id", async () => {
    render(
      <>
        <Probe id="kid" />
        <Probe id="nobody" />
        <Probe id={null} />
      </>,
    );
    await flush();
    expect(renders.every((r) => r === null)).toBe(true);
  });
});
