import { beforeEach, describe, expect, it } from "vitest";
import { mockChild } from "./fxChildMock";

const fake = {
  installed: true,
  models: "",
  status: "",
};

mockChild({
  resolveFxBinary: async () => {
    if (!fake.installed) throw new Error("fx not found");
    return { path: "/fake/fx" };
  },
  execChild: async (_cmd: string, args: string[]) => {
    if (args[0] === "models") return fake.models;
    if (args[0] === "status") return fake.status;
    return "";
  },
});

const { probeCatalog, toModelInfo } = await import("./fxCatalog");

describe("fx catalog", () => {
  beforeEach(() => {
    fake.installed = true;
    fake.models = "";
    fake.status = "";
  });

  it("returns null when fx is not installed", async () => {
    fake.installed = false;
    expect(await probeCatalog()).toBeNull();
  });

  it("lists models by native id and prefers the status model as default", async () => {
    fake.models = JSON.stringify({
      models: [
        { id: "openai/gpt-5.2", name: "GPT-5.2", contextWindow: 400000, effortOptions: ["auto", "low", "high"], effort: "high" },
        "zai/glm-4.7",
      ],
    });
    fake.status = JSON.stringify({ kind: "status", model: "zai/glm-5.2" });
    const probed = await probeCatalog();
    expect(probed?.label).toBe("fx");
    expect(probed?.defaultModel).toBe("zai/glm-5.2");
    expect(probed?.models).toEqual([
      { id: "openai/gpt-5.2", label: "GPT-5.2", reasoning: ["low", "high"], defaultReasoning: "high", context: 400000 },
      { id: "zai/glm-4.7", label: "zai/glm-4.7", reasoning: [] },
      { id: "zai/glm-5.2", label: "zai/glm-5.2", reasoning: [] },
    ]);
  });

  it("maps a bare model without settings", () => {
    expect(toModelInfo({ id: "fx:a/b", harness: "fx", name: "B", nativeId: "a/b" })).toEqual({
      id: "a/b",
      label: "B",
      reasoning: [],
    });
  });
});
