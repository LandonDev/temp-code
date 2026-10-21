import { describe, expect, it } from "vitest";
import { createLanguageLoader, grammarFor } from "./highlightLanguages";

function host(initial: string[] = []) {
  const loaded = new Set(initial);
  const loads: string[] = [];
  let fail = false;
  const h = {
    getLoadedLanguages: () => [...loaded],
    loadLanguage: (grammar: unknown) => {
      const name = String(grammar);
      loads.push(name);
      return new Promise<void>((resolve, reject) =>
        setTimeout(() => {
          if (fail) reject(new Error("no chunk"));
          else {
            loaded.add(name);
            resolve();
          }
        }, 1),
      );
    },
  };
  return { h, loads, setFail: (v: boolean) => (fail = v) };
}
const grammars = { typescript: "typescript", bash: "bash", json: "json" };

describe("grammarFor", () => {
  it("resolves aliases and case, and refuses what the transcript does not colour", () => {
    expect(grammarFor("TS")).toBe("typescript");
    expect(grammarFor("sh")).toBe("bash");
    expect(grammarFor("jsonc")).toBe("json");
    expect(grammarFor("brainfuck")).toBeNull();
  });
});

describe("createLanguageLoader", () => {
  it("loads a grammar on first use, once, and answers from the host after", async () => {
    const { h, loads } = host();
    const load = createLanguageLoader(h, grammars);
    const [a, b] = await Promise.all([load("ts"), load("typescript")]);
    expect([a, b]).toEqual(["typescript", "typescript"]);
    expect(loads).toEqual(["typescript"]);
    expect(await load("ts")).toBe("typescript");
    expect(loads).toEqual(["typescript"]);
  });

  it("is plain text for an unknown language or a grammar the bundle lacks, without loading", async () => {
    const { h, loads } = host();
    const load = createLanguageLoader(h, grammars);
    expect(await load("cobol")).toBe("text");
    expect(await load("python")).toBe("text");
    expect(loads).toEqual([]);
  });

  it("a grammar whose chunk fails to land is plain text and tried again next time", async () => {
    const { h, loads, setFail } = host();
    const load = createLanguageLoader(h, grammars);
    setFail(true);
    expect(await load("bash")).toBe("text");
    setFail(false);
    expect(await load("bash")).toBe("bash");
    expect(loads).toEqual(["bash", "bash"]);
  });
});
