import { homedir } from "node:os";
import type { ModelInfo, Reasoning } from "@shared/catalog";
import { AcpClient } from "./acp";
import {
  execChild,
  killChild,
  resolveGrokBinary,
  spawnChild,
  unwatchChild,
  watchChild,
} from "./child";
import {
  currentModelId,
  fallbackGrokModels,
  grokAuthMethodId,
  grokSpawnArgs,
  modelsFromGrokModelsOutput,
  modelsFromInitialize,
  modelsFromSessionNew,
  type AgentModel,
} from "./grokProtocol";

/**
 * Ported from src/lib/harness/grokCatalog.ts. The three-tier discovery
 * (ACP probe → `grok models` → hardcoded fallback) is unchanged; the
 * result lands in the server's ModelInfo shape through probeCatalog()
 * instead of the web model store.
 */

const PROBE_ID = "monocode-grok-probe";
const DISCOVERY_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 12_000;
const REASONING: Reasoning[] = ["low", "medium", "high", "xhigh", "max", "ultra"];

const CLIENT_CAPABILITIES = {
  fs: { readTextFile: false, writeTextFile: false },
  terminal: false,
};

type Discovered = { models: AgentModel[]; current?: string };

let inflight: Promise<Discovered> | null = null;

/** The grok provider entry, or null when grok is not installed. */
export async function probeCatalog(): Promise<{
  label: string;
  models: ModelInfo[];
  defaultModel: string;
} | null> {
  try {
    await resolveGrokBinary();
  } catch {
    return null;
  }
  inflight ??= discoverGrokModels().finally(() => {
    inflight = null;
  });
  const { models, current } = await inflight;
  const infos = models.map(toModelInfo);
  const first = infos[0]?.id ?? fallbackGrokModels()[0]!.nativeId!;
  return {
    label: "Grok",
    models: infos,
    defaultModel: current && infos.some((m) => m.id === current) ? current : first,
  };
}

function toModelInfo(model: AgentModel): ModelInfo {
  const effort = model.settings?.find((s) => s.id === "effort");
  const reasoning = (effort?.options ?? [])
    .map((o) => o.value)
    .filter(isReasoning);
  return {
    id: model.nativeId ?? model.id,
    label: model.name,
    reasoning,
    ...(isReasoning(effort?.value) ? { defaultReasoning: effort.value } : {}),
    ...(model.contextWindow ? { context: model.contextWindow } : {}),
  };
}

function isReasoning(value: unknown): value is Reasoning {
  return typeof value === "string" && (REASONING as string[]).includes(value);
}

async function discoverGrokModels(): Promise<Discovered> {
  const fromAcp = await discoverViaAcp().catch((error: unknown) => {
    console.debug("[monocode] grok ACP catalog failed", error);
    return null;
  });
  if (fromAcp && fromAcp.models.length > 0) return fromAcp;
  const fromCli = await discoverViaCli().catch((error: unknown) => {
    console.debug("[monocode] grok CLI catalog failed", error);
    return [];
  });
  if (fromCli.length > 0) return { models: fromCli };
  return { models: fallbackGrokModels() };
}

async function discoverViaAcp(): Promise<Discovered> {
  const { path } = await resolveGrokBinary();
  const cwd = homedir();
  const acp = new AcpClient(PROBE_ID, {
    onRequest: (id) => {
      void acp.respond(id, {}).catch(() => undefined);
    },
  });

  const stop = async () => {
    acp.close();
    unwatchChild(PROBE_ID);
    await killChild(PROBE_ID).catch(() => undefined);
  };

  watchChild(
    PROBE_ID,
    (line) => acp.pushLine(line),
    () => acp.close(new Error("Grok Build probe exited")),
  );

  try {
    await spawnChild(PROBE_ID, path, grokSpawnArgs({ model: "" }), cwd);
    return await withTimeout(DISCOVERY_TIMEOUT_MS, async () => {
      const init = await acp.request(
        "initialize",
        {
          protocolVersion: 1,
          clientCapabilities: CLIENT_CAPABILITIES,
          clientInfo: { name: "monocode", version: "0.1.0" },
        },
        REQUEST_TIMEOUT_MS,
      );
      const fromInit = modelsFromInitialize(init);
      if (fromInit.length > 0) {
        return { models: fromInit, current: currentModelId(init) };
      }

      const methodId = grokAuthMethodId(init);
      if (methodId) {
        await acp
          .request(
            "authenticate",
            { methodId, _meta: { headless: true } },
            REQUEST_TIMEOUT_MS,
          )
          .catch(() => undefined);
      }
      const created = await acp.request(
        "session/new",
        { cwd, mcpServers: [] },
        REQUEST_TIMEOUT_MS,
      );
      return {
        models: modelsFromSessionNew(created),
        current: currentModelId(created),
      };
    }, () => {
      void stop();
    });
  } finally {
    await stop();
  }
}

async function discoverViaCli(): Promise<AgentModel[]> {
  const { path } = await resolveGrokBinary();
  const stdout = await execChild(path, ["models"], homedir());
  return modelsFromGrokModelsOutput(stdout);
}

function withTimeout<T>(
  ms: number,
  run: () => Promise<T>,
  onTimeout: () => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout();
      reject(new Error("Grok Build catalog probe timed out"));
    }, ms);
    run()
      .then(resolve, reject)
      .finally(() => clearTimeout(timer));
  });
}
