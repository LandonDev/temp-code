import { describe, expect, it } from "vitest";
import { shellTokens, type ShellTone } from "./shellTokens";

const tones = (cmd: string): [string, ShellTone][] =>
  shellTokens(cmd)
    .filter((t) => t.text.trim())
    .map((t) => [t.text.trim(), t.tone]);

describe("shellTokens", () => {
  it("tints each segment's command, the operators, the flags", () => {
    expect(tones("cd x && npx y 2>&1 | tail -1")).toEqual([
      ["cd", "command"],
      ["x", "text"],
      ["&&", "operator"],
      ["npx", "command"],
      ["y", "text"],
      ["2>&1", "operator"],
      ["|", "operator"],
      ["tail", "command"],
      ["-1", "flag"],
    ]);
  });

  it("keeps quoted strings whole, operators inside them too", () => {
    expect(tones(`git commit -m "a && b" ; echo 'x|y'`)).toEqual([
      ["git", "command"],
      ["commit", "text"],
      ["-m", "flag"],
      ['"a && b"', "string"],
      [";", "operator"],
      ["echo", "command"],
      ["'x|y'", "string"],
    ]);
  });

  it("reads a redirect, a subshell and an env prefix", () => {
    expect(tones("FOO=1 node a.js > out.txt")).toEqual([
      ["FOO=1", "text"],
      ["node", "command"],
      ["a.js", "text"],
      [">", "operator"],
      ["out.txt", "text"],
    ]);
    expect(tones("echo $(git rev-parse HEAD)")).toEqual([
      ["echo", "command"],
      ["$(", "operator"],
      ["git", "command"],
      ["rev-parse HEAD", "text"],
      [")", "operator"],
    ]);
  });

  it("starts a new command on a new line, and loses no character", () => {
    const cmd = "ls -la\npwd || true";
    expect(tones(cmd).filter(([, t]) => t === "command").map(([w]) => w)).toEqual(["ls", "pwd", "true"]);
    expect(shellTokens(cmd).map((t) => t.text).join("")).toBe(cmd);
    expect(shellTokens(`echo "unterminated`).map((t) => t.text).join("")).toBe(`echo "unterminated`);
  });
});
