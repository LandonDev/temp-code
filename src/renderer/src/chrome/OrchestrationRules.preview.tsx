import { CATALOG, type ProviderInfo } from "@server/shared/catalog";
import { DEFAULT_RULES, withProbedDefaults, type OrchestrationRules } from "@server/shared/rules";
import type { Link } from "../lib/connection";
import { rulesStore, type RulesCatalog } from "../lib/tcserver/rules";
import { RulesEditor } from "./OrchestrationRules";

/**
 * The global rules editor over two fixed hosts, for `bun run ui:preview
 * src/renderer/src/chrome/OrchestrationRules.preview.tsx#OrchestrationRulesPreview`:
 * a Mac whose Muse Code probe answered four rows, and a box whose probe
 * answered none while the rules it holds name them; then the Mac as it is
 * paired, its rules kept on the box (`macShared`), and the same while the
 * box is out of reach (`macOffline`). Rendered by nothing in the app.
 */

const MUSE_ROWS: ProviderInfo["models"] = [
  { id: "muse-wonder-1.0", label: "Muse Wonder 1.0", reasoning: ["minimal", "low", "medium", "high", "xhigh", "max"], defaultReasoning: "high" },
  { id: "muse-wonder-full-1.0", label: "Muse Wonder Full 1.0", reasoning: ["low", "medium", "high"], defaultReasoning: "high" },
  { id: "muse-spark-1.3", label: "Muse Spark 1.3", reasoning: ["minimal", "low", "medium", "high"], defaultReasoning: "medium" },
  { id: "muse-spark-1.2", label: "Muse Spark 1.2", reasoning: ["low", "medium", "high"], defaultReasoning: "medium" },
];

function catalogWith(muse: ProviderInfo["models"]): RulesCatalog {
  return Object.fromEntries(
    Object.values(CATALOG).map((p) => [p.id, p.id === "muse" ? { ...p, models: muse } : p]),
  ) as RulesCatalog;
}

/** What rules.get answers on a host that probed `muse`. */
function rulesWith(muse: ProviderInfo["models"]): OrchestrationRules {
  const before = CATALOG.muse.models;
  CATALOG.muse.models = muse;
  try {
    return withProbedDefaults(DEFAULT_RULES);
  } finally {
    CATALOG.muse.models = before;
  }
}

const HOSTS: Record<string, { catalog: RulesCatalog; rules: OrchestrationRules; home?: { name: string; online: boolean } }> = {
  mac: { catalog: catalogWith(MUSE_ROWS), rules: rulesWith(MUSE_ROWS) },
  box: { catalog: catalogWith([]), rules: rulesWith(MUSE_ROWS) },
  macShared: { catalog: catalogWith(MUSE_ROWS), rules: rulesWith(MUSE_ROWS), home: { name: "box", online: true } },
  macOffline: { catalog: catalogWith(MUSE_ROWS), rules: rulesWith(MUSE_ROWS), home: { name: "box", online: false } },
};

for (const [environmentId, host] of Object.entries(HOSTS)) {
  const link = {
    environmentId,
    connected: true,
    onOpen: () => () => {},
    request: (method: string) =>
      Promise.resolve(
        method === "catalog.get"
          ? host.catalog
          : method === "rules.get"
            ? { rules: host.rules, overridden: true, home: host.home ?? null }
            : null,
      ),
  } as unknown as Link;
  rulesStore.attach(link);
  await rulesStore.load(environmentId, null);
  await rulesStore.loadCatalog(environmentId);
}

export function OrchestrationRulesPreview({ host }: { host: keyof typeof HOSTS }) {
  return (
    // The page's own column: its sections stack 24px apart in the page's container, as Page lays them.
    <div className="@container/page mx-auto flex max-w-[672px] flex-col gap-6 p-6">
      <RulesEditor environmentId={host} workspaceId={null} />
    </div>
  );
}
