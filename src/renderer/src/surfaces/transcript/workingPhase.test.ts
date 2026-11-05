import { describe, expect, it } from "vitest";
import type { Block } from "../../lib/session";
import { waitLine, waitSubject } from "@server/shared/watch";
import { workingPhase } from "./workingPhase";

const CWD = "/r";
const user = (over: Partial<Block> = {}): Block => ({ id: "u", role: "user", text: "go", ...over });
const read = (id: string, path: string, status = "running"): Block => ({
  id,
  role: "tool",
  text: "Read",
  tool: { callId: id, name: "Read", kind: "read", title: "Read", status, input: { file_path: `${CWD}/${path}` } },
});
const bash = (id: string, command: string, status = "running"): Block => ({
  id,
  role: "tool",
  text: "Bash",
  tool: { callId: id, name: "Bash", kind: "execute", title: "Bash", status, input: { command } },
});
const thought = (text: string, streaming = true): Block => ({ id: "t", role: "reasoning", text, streaming });
const prose = (text: string, streaming = true): Block => ({ id: "p", role: "assistant", text, streaming });

describe("workingPhase", () => {
  it("says Sending until the host echoes the person's message", () => {
    expect(workingPhase([user({ pending: true })], "Starting the CLI")).toEqual({ key: "sending", words: "Sending" });
  });

  it("says the host's words while nothing of the turn's own has come, keyed up to the first comma", () => {
    const a = workingPhase([user()], "Waiting for the provider, 25 s");
    const b = workingPhase([user()], "Waiting for the provider, 30 s");
    expect(a).toEqual({ key: "host:Waiting for the provider", words: "Waiting for the provider, 25 s" });
    expect(b.key).toBe(a.key);
    expect(workingPhase([user()], "Starting the CLI").key).toBe("host:Starting the CLI");
    // An empty thought is not the turn's own yet.
    expect(workingPhase([user(), thought("")], "Initializing").key).toBe("host:Initializing");
    // Once the turn has its own, the host's words stop.
    expect(workingPhase([user(), thought("Hm.")], "Waiting for the provider").key).toBe("thought:0");
  });

  it("tells one running call by its verb and object, in the present tense", () => {
    const phase = workingPhase([user(), read("r1", "src/format.ts")], null, { cwd: CWD });
    expect(phase.key).toBe("call:r1");
    expect(phase.words).toBe("Reading format.ts");
    expect(phase.call).toMatchObject({ verb: "Reading", object: "format.ts" });
  });

  it("tells several running calls by the group's present-tense phrase, under one key", () => {
    const phase = workingPhase([user(), read("a", "a.ts"), read("b", "b.ts"), read("c", "c.ts")], null, { cwd: CWD });
    expect(phase.key).toBe("calls");
    expect(phase.words).toMatch(/^Reading/);
    expect(phase.call).toBeUndefined();
  });

  it("leaves settled calls to their rows", () => {
    expect(workingPhase([user(), read("a", "a.ts", "completed")], null, { cwd: CWD }).key).toBe("thinking");
  });

  it("says the thought's newest sentence in place of Thinking, each sentence its own phase, spoken as Thinking", () => {
    const phase = workingPhase([user(), thought("I read the file. Now the tests.")], null);
    expect(phase).toEqual({ key: "thought:1", words: "Now the tests.", spoken: "Thinking", thought: { line: "Now the tests.", key: 1 } });
    // The first sentence growing keeps its key; the next takes a new one once it ends.
    expect(workingPhase([user(), thought("I read the")], null)).toMatchObject({ key: "thought:0", words: "I read the" });
    expect(workingPhase([user(), thought("I read the file.")], null)).toMatchObject({ key: "thought:0", words: "I read the file." });
    expect(workingPhase([user(), thought("I read the file. Now the te")], null).key).toBe("thought:0");
    // Before its first words the thought is Thinking.
    expect(workingPhase([user(), thought("")], null)).toEqual({ key: "thinking", words: "Thinking" });
  });

  it("draws the mark alone while prose streams, and Thinking between steps", () => {
    expect(workingPhase([user(), prose("Here is")], null)).toEqual({ key: "writing", words: "" });
    expect(workingPhase([user(), prose("Done.", false)], null)).toEqual({ key: "thinking", words: "Thinking" });
  });

  it("puts the wait on agents ahead of the calls and the thought", () => {
    const turn = [user(), bash("s", "ls"), thought("Waiting.")];
    expect(workingPhase(turn, null, { waitOn: "Review the perf pass" })).toEqual({
      key: "wait",
      words: "Waiting on Review the perf pass",
      // Drawn like a call: the verb muted, the agent's title in foreground.
      wait: { verb: "Waiting on", object: "Review the perf pass" },
    });
  });

  it("says UI-15's wait words, with the title once it is known and without it before", () => {
    const turn = [user()];
    const titled = workingPhase(turn, null, { waitOn: waitSubject(["c1"], (id) => (id === "c1" ? "Review the perf pass" : undefined)) });
    expect(titled.words).toBe("Waiting on Review the perf pass");
    const untitled = workingPhase(turn, null, { waitOn: waitSubject(["c1"]) });
    expect(untitled).toEqual({ key: "wait", words: "Waiting on a subagent", wait: { verb: "Waiting on", object: "a subagent" } });
    // The words are UI-15's, as the host says them.
    expect(titled.words).toBe(waitLine(["c1"], (id) => (id === "c1" ? "Review the perf pass" : undefined)));
    // The title landing keeps the key: the words change in place, no morph.
    expect(titled.key).toBe(untitled.key);
  });

  it("orders the phases: sending, then the host, then calls, then the thought", () => {
    expect(workingPhase([user(), read("r", "a.ts"), user({ id: "u2", pending: true })], "x").key).toBe("sending");
    expect(workingPhase([user(), read("r", "a.ts"), thought("Then.")], "Waiting", { cwd: CWD }).key).toBe("call:r");
  });
});
