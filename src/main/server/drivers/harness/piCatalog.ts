import { homedir } from "node:os";
import type { ModelInfo, Reasoning } from "@shared/catalog";
import { killChild, spawnChild, unwatchChild, watchChild } from "./child";
import { PiRpc } from "./piClient";
import { OMP_FLAVOR, PI_FLAVOR, type PiFlavor } from "./piFlavor";
import {
  asRecord,
  buildPiSpawnArgs,
  modelsFromRpcData,
  piNativeId,
  stringField,
  type AgentModel,
} from "./piProtocol";

const DISCOVERY_TIMEOUT_MS = 45_000;

/** Pi's thinking ladder, less `off`/`minimal`, which the shared enum lacks. */
const PI_REASONING: Reasoning[] = ["low", "medium", "high", "xhigh", "max"];

type Probe = { models: AgentModel[]; current?: string };

const inflight = new Map<string, Promise<Probe>>();

function discover(flavor: PiFlavor, path: string): Promise<Probe> {
  const running = inflight.get(flavor.id);
  if (running) return running;
  const run = discoverModels(flavor, path).finally(() => {
    inflight.delete(flavor.id);
  });
  inflight.set(flavor.id, run);
  return run;
}

/** Disposable `pi --mode rpc --no-session --no-extensions` in $HOME:
 *  `get_state` for the model pi would pick on its own, then
 *  `get_available_models`. Torn down either way. */
async function discoverModels(flavor: PiFlavor, path: string): Promise<Probe> {
  const probeId = flavor.probeChildId;
  const rpc = new PiRpc(probeId, () => undefined, flavor.label);

  const stop = async () => {
    rpc.close();
    unwatchChild(probeId);
    await killChild(probeId).catch(() => undefined);
  };

  watchChild(
    probeId,
    (line) => rpc.pushLine(line),
    () => rpc.close(new Error(`${flavor.label} catalog probe exited`)),
  );

  try {
    await spawnChild(
      probeId,
      path,
      buildPiSpawnArgs(flavor, { noSession: true, noExtensions: true }),
      homedir(),
    );
    const state = await rpc
      .request({ type: "get_state" }, DISCOVERY_TIMEOUT_MS)
      .catch(() => null);
    const response = await rpc.request(
      { type: "get_available_models" },
      DISCOVERY_TIMEOUT_MS,
    );
    const model = asRecord(asRecord(state?.data)?.model);
    const provider = stringField(model, "provider");
    const modelId = stringField(model, "id");
    return {
      models: modelsFromRpcData(flavor, response.data),
      current: provider && modelId ? piNativeId(provider, modelId) : undefined,
    };
  } finally {
    await stop();
  }
}

/** Server ModelInfo keyed by the native `provider/modelId` — what
 *  session.model holds and what `--model` takes. */
function toModelInfo(model: AgentModel): ModelInfo {
  const reasoning = model.settings?.some((s) => s.id === "thinking") ?? false;
  return {
    id: model.nativeId ?? model.id,
    label: model.name,
    reasoning: reasoning ? PI_REASONING : [],
    ...(reasoning ? { defaultReasoning: "medium" as const } : {}),
    ...(model.contextWindow ? { context: model.contextWindow } : {}),
  };
}

/** Live model list for a flavor; null when its binary is not installed.
 *  Probe failures on an installed binary throw. */
export async function probeCatalog(
  flavor: "pi" | "omp",
): Promise<{ label: string; models: ModelInfo[]; defaultModel: string } | null> {
  const f = flavor === "pi" ? PI_FLAVOR : OMP_FLAVOR;
  let path: string;
  try {
    ({ path } = await f.resolveBinary());
  } catch {
    return null;
  }
  const { models, current } = await discover(f, path);
  const infos = models.map(toModelInfo);
  const defaultModel =
    current && infos.some((m) => m.id === current) ? current : (infos[0]?.id ?? "");
  return { label: f.label, models: infos, defaultModel };
}
