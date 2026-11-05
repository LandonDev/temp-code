import { modelsFor } from "../lib/models";

/** `bun run ui:preview chrome/ModelPicker.tsx#ModelList`: the Claude and
 *  Codex tabs' lists with Meta's group, from the built-in rows. */
const base = {
  available: () => true,
  active: 0,
  favorites: [] as string[],
  grouped: true,
  emptyLabel: "No matching models",
  onActive: () => {},
  onPick: () => {},
  onToggleFavorite: () => {},
};

const claude = modelsFor("claude").filter((m) => !m.vendor).slice(0, 3);
const claudeMeta = modelsFor("claude").filter((m) => m.vendor);
const codexMeta = modelsFor("codex").filter((m) => m.vendor);
const gpt = [
  { id: "codex:gpt-6.1-sol", harness: "codex" as const, name: "GPT-6.1 Sol", nativeId: "gpt-6.1-sol" },
  { id: "codex:gpt-5.5", harness: "codex" as const, name: "GPT-5.5", nativeId: "gpt-5.5" },
];

export default [
  { name: "Claude tab", props: { ...base, models: [...claude, ...claudeMeta], currentId: claude[0].id } },
  { name: "Codex tab, Wonder picked", props: { ...base, models: [...gpt, ...codexMeta], currentId: codexMeta[0].id, active: 2 } },
  { name: "Muse Code tab", props: { ...base, models: modelsFor("muse"), currentId: modelsFor("muse")[0].id } },
  { name: "Search: muse", props: { ...base, grouped: false, models: [...claudeMeta, ...codexMeta], currentId: "" } },
];
