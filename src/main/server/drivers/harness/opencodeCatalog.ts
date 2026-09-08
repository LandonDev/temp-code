import { homedir } from "node:os";
import type { ModelInfo, Reasoning } from "@shared/catalog";
import { execChild, resolveOpenCodeBinary } from "./child";
import {
  compareSemver,
  inferDefaultAgent,
  inferDefaultVariant,
  KNOWN_HIDDEN_AGENTS,
  MINIMUM_OPENCODE_VERSION,
  parseOpenCodeVersion,
  titleCaseSlug,
} from "./opencodeProtocol";

/**
 * Model inventory from the opencode CLI (`opencode models --verbose`,
 * `opencode agent list`), not from a server. Parsers copied from
 * src/lib/harness/opencodeCatalog.ts; probeCatalog() replaces the web
 * refresh and feeds the server's merged catalog. The engine reads the
 * last probe through modelVariants()/modelContextWindow() to pick a
 * variant for the session's reasoning level and size the context meter.
 */

const SLUG_LINE_RE = /^(\S+\/\S+)\s*$/;
const AGENT_HEADER_RE = /^(.+)\s+\((\S+)\)\s*$/;
const REASONING_LADDER: Reasoning[] = ["low", "medium", "high", "xhigh", "max", "ultra"];

type OpenCodeModelJson = {
  id?: string;
  name?: string;
  variants?: Record<string, unknown>;
  limit?: { context?: number; input?: number; output?: number };
};

type ParsedProvider = {
  id: string;
  name: string;
  models: Record<string, OpenCodeModelJson>;
};

export type OpenCodeAgent = {
  name: string;
  mode: string;
  hidden: boolean;
};

/** Same shape the web AgentModel had, minus the harness tag, so the
 *  parser tests port unchanged. */
export type OpenCodeModelSetting = {
  id: "variant" | "agent";
  label: string;
  kind: "select";
  value: string;
  options: Array<{ value: string; label: string }>;
};

export type OpenCodeCatalogModel = {
  id: string;
  name: string;
  nativeId: string;
  settings?: OpenCodeModelSetting[];
  contextWindow?: number;
};

export type OpenCodeCatalog = {
  label: string;
  models: ModelInfo[];
  defaultModel: string;
};

let inflight: Promise<OpenCodeCatalog | null> | null = null;
const lastProbe = new Map<string, OpenCodeCatalogModel>();

/**
 * The opencode provider entry for the merged catalog; null when opencode
 * is not installed or its inventory cannot be read. Concurrent callers
 * share one CLI run.
 */
export function probeCatalog(): Promise<OpenCodeCatalog | null> {
  if (inflight) return inflight;
  inflight = discoverOpenCodeModels()
    .then((models) => {
      if (models.length === 0) return null;
      lastProbe.clear();
      for (const model of models) lastProbe.set(model.nativeId, model);
      return {
        label: "OpenCode",
        models: models.map(toModelInfo),
        defaultModel: models[0]!.nativeId,
      };
    })
    .catch(() => null)
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** Variant names a probed model accepts (empty when unknown or none). */
export function modelVariants(nativeId: string): string[] {
  const setting = lastProbe.get(nativeId)?.settings?.find((s) => s.id === "variant");
  return setting?.options.map((o) => o.value) ?? [];
}

export function modelContextWindow(nativeId: string): number | undefined {
  return lastProbe.get(nativeId)?.contextWindow;
}

/** Test seam: seed what a probe would have found. */
export function setProbedModels(models: OpenCodeCatalogModel[]): void {
  lastProbe.clear();
  for (const model of models) lastProbe.set(model.nativeId, model);
}

function toModelInfo(model: OpenCodeCatalogModel): ModelInfo {
  const variant = model.settings?.find((s) => s.id === "variant");
  const reasoning = (variant?.options ?? [])
    .map((o) => o.value)
    .filter((v): v is Reasoning => (REASONING_LADDER as string[]).includes(v));
  const defaultReasoning = reasoning.find((r) => r === variant?.value);
  return {
    id: model.nativeId,
    label: model.name,
    reasoning,
    ...(defaultReasoning ? { defaultReasoning } : {}),
    ...(model.contextWindow ? { context: model.contextWindow } : {}),
  };
}

async function discoverOpenCodeModels(): Promise<OpenCodeCatalogModel[]> {
  const { path } = await resolveOpenCodeBinary();
  const cwd = homedir();
  const versionOut = await execChild(path, ["--version"], cwd);
  const version = parseOpenCodeVersion(versionOut);
  if (!version) {
    throw new Error(
      `Unable to determine OpenCode version. MonoCode requires v${MINIMUM_OPENCODE_VERSION} or newer.`,
    );
  }
  if (compareSemver(version, MINIMUM_OPENCODE_VERSION) < 0) {
    throw new Error(
      `OpenCode v${version} is too old. Upgrade to v${MINIMUM_OPENCODE_VERSION} or newer.`,
    );
  }

  const modelsOut = await execChild(path, ["models", "--verbose"], cwd);
  const parsed = parseModelsCliOutput(modelsOut);
  let agents: OpenCodeAgent[] = [];
  try {
    const agentsOut = await execChild(path, ["agent", "list"], cwd);
    agents = parseAgentListCliOutput(agentsOut);
  } catch {
    // no agent list: models still work with opencode's default agent
  }
  return flattenOpenCodeModels(parsed, agents);
}

export function parseModelsCliOutput(stdout: string): {
  providers: Map<string, ParsedProvider>;
  connected: string[];
} {
  const providers = new Map<string, ParsedProvider>();
  const lines = stdout.split("\n");
  let currentSlug: string | null = null;
  const jsonLines: string[] = [];

  const flushModel = () => {
    if (currentSlug === null || jsonLines.length === 0) {
      currentSlug = null;
      jsonLines.length = 0;
      return;
    }
    const jsonStr = jsonLines.join("\n").trim();
    if (jsonStr.length > 0) {
      try {
        const model = JSON.parse(jsonStr) as OpenCodeModelJson;
        const separator = currentSlug.indexOf("/");
        if (separator > 0) {
          const providerID = currentSlug.slice(0, separator);
          const modelID = currentSlug.slice(separator + 1);
          let provider = providers.get(providerID);
          if (!provider) {
            provider = { id: providerID, name: providerID, models: {} };
            providers.set(providerID, provider);
          }
          provider.models[modelID] = model;
        }
      } catch {
        // Skip unparseable model JSON
      }
    }
    currentSlug = null;
    jsonLines.length = 0;
  };

  for (const line of lines) {
    const slugMatch = line.trimStart().startsWith("{")
      ? null
      : SLUG_LINE_RE.exec(line);
    if (slugMatch) {
      flushModel();
      currentSlug = slugMatch[1]!;
    } else if (currentSlug !== null) {
      jsonLines.push(line);
    }
  }
  flushModel();
  return { providers, connected: [...providers.keys()] };
}

export function parseAgentListCliOutput(stdout: string): OpenCodeAgent[] {
  const agents: OpenCodeAgent[] = [];
  const lines = stdout.split("\n");
  let currentHeader: { name: string; mode: string } | null = null;
  const blockLines: string[] = [];

  const flushAgent = () => {
    if (currentHeader === null) {
      currentHeader = null;
      blockLines.length = 0;
      return;
    }
    agents.push({
      name: currentHeader.name,
      mode: currentHeader.mode,
      hidden: KNOWN_HIDDEN_AGENTS.has(currentHeader.name),
    });
    currentHeader = null;
    blockLines.length = 0;
  };

  for (const line of lines) {
    const match = AGENT_HEADER_RE.exec(line);
    if (match) {
      flushAgent();
      currentHeader = { name: match[1]!, mode: match[2]! };
    } else if (currentHeader !== null) {
      blockLines.push(line);
    }
  }
  flushAgent();
  return agents;
}

export function flattenOpenCodeModels(
  parsed: { providers: Map<string, ParsedProvider>; connected: string[] },
  agents: OpenCodeAgent[],
): OpenCodeCatalogModel[] {
  const connected = new Set(parsed.connected);
  const primaryAgents = agents.filter(
    (agent) => !agent.hidden && (agent.mode === "primary" || agent.mode === "all"),
  );
  const models: OpenCodeCatalogModel[] = [];
  for (const provider of parsed.providers.values()) {
    if (!connected.has(provider.id)) continue;
    for (const [modelId, model] of Object.entries(provider.models)) {
      const name = model.name?.trim() || titleCaseSlug(modelId);
      const nativeId = `${provider.id}/${model.id ?? modelId}`;
      const contextWindow = model.limit?.context;
      models.push({
        id: `opencode:${nativeId}`,
        name,
        nativeId,
        settings: openCodeModelSettings(provider.id, model, primaryAgents),
        ...(contextWindow && contextWindow > 0 ? { contextWindow } : {}),
      });
    }
  }
  return models.sort((left, right) => left.name.localeCompare(right.name));
}

function openCodeModelSettings(
  providerID: string,
  model: OpenCodeModelJson,
  agents: OpenCodeAgent[],
): OpenCodeModelSetting[] | undefined {
  const settings: OpenCodeModelSetting[] = [];
  const variantValues = Object.keys(model.variants ?? {});
  if (variantValues.length > 0) {
    const defaultVariant = inferDefaultVariant(providerID, variantValues);
    const options = variantValues.map((value) => ({
      value,
      label: titleCaseSlug(value),
    }));
    settings.push({
      id: "variant",
      label: "Variant",
      kind: "select",
      value: defaultVariant ?? options[0]!.value,
      options,
    });
  }
  if (agents.length > 0) {
    const defaultAgent = inferDefaultAgent(agents);
    settings.push({
      id: "agent",
      label: "Agent",
      kind: "select",
      value: defaultAgent ?? agents[0]!.name,
      options: agents.map((agent) => ({
        value: agent.name,
        label: titleCaseSlug(agent.name),
      })),
    });
  }
  return settings.length > 0 ? settings : undefined;
}
