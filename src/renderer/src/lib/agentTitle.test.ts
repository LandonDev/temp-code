import { describe, expect, it } from "vitest";
import { agentTitle } from "./agentTitle";

const titles: Record<string, string> = { a1: "Review the payment flow", thread1: "Auth rewrite" };
const titleOf = (id: string) => titles[id];

describe("agentTitle", () => {
  it("takes the store's title first", () => {
    expect(agentTitle("a1", { titleOf, inputTitle: "Given", stamped: "Stamped", task: "do it" })).toEqual({
      title: "Review the payment flow",
      full: "Review the payment flow",
      named: true,
    });
  });

  it("falls back to the spawn's title, then the report's stamp", () => {
    expect(agentTitle("unknown", { titleOf, inputTitle: " Audit  the gateway ", task: "do it" })).toMatchObject({ title: "Audit the gateway", named: true });
    expect(agentTitle("unknown", { titleOf, stamped: "From the report", task: "do it" })).toMatchObject({ title: "From the report", named: true });
  });

  it("stands in with the task's first line, cut at a word, mentions as titles", () => {
    const long = agentTitle(null, { titleOf, task: "Review only. Do not edit, commit, push, or open a pull request here\nsecond line" });
    expect(long.title).toBe("Review only. Do not edit, commit, push, or open…");
    expect(long.full).toBe("Review only. Do not edit, commit, push, or open a pull request here");
    expect(long.named).toBe(false);
    expect(agentTitle(null, { titleOf, task: "read @thread:thread1 first" }).title).toBe("read @Auth rewrite first");
  });

  it("reads a cross-host id by its bare session id", () => {
    expect(agentTitle("env_mac-1:a1", { titleOf }).title).toBe("Review the payment flow");
  });

  it('says "a subagent" with nothing to go on', () => {
    expect(agentTitle(null, { titleOf })).toEqual({ title: "a subagent", full: "a subagent", named: false });
    expect(agentTitle("unknown", { titleOf, inputTitle: "  ", task: "" })).toMatchObject({ title: "a subagent", named: false });
  });

  it("names a batch entry by its own title, by index", () => {
    const entries = [{ title: "First agent" }, { title: "Second agent" }];
    const spawned = ["x1", "x2"];
    expect(spawned.map((id, i) => agentTitle(id, { titleOf, inputTitle: entries[i]?.title }).title)).toEqual(["First agent", "Second agent"]);
  });
});
