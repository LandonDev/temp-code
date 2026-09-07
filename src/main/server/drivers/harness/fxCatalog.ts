import { homedir } from "node:os";
import type { ModelInfo, Reasoning } from "@shared/catalog";
import { execChild, resolveFxBinary } from "./child";
import {
  mergeFxCatalogModels,
  modelFromFxStatusOutput,
  modelsFromFxOutput,
  type AgentModel,
} from "./fxProtocol";

const REASONING: Reasoning[] = ["low", "medium", "high", "xhigh", "max", "ultra"];

/**
 * `fx models --json` plus `fx status --json` (the second recovers the
 * TUI-selected model the first omits). Null when fx is not installed or
 * lists nothing; F6 merges the result into catalog.get.
 */
export async function probeCatalog(): Promise<{
  label: string;
  models: ModelInfo[];
  defaultModel: string;
} | null> {
  let path: string;
  try {
    ({ path } = await resolveFxBinary());
  } catch {
    return null;
  }
  const cwd = homedir();
  const [modelsOutput, statusOutput] = await Promise.all([
    execChild(path, ["models", "--json"], cwd).catch(() => ""),
    execChild(path, ["status", "--json"], cwd).catch(() => ""),
  ]);
  const active = modelFromFxStatusOutput(statusOutput);
  const models = mergeFxCatalogModels(modelsFromFxOutput(modelsOutput), active).map(toModelInfo);
  if (models.length === 0) return null;
  return {
    label: "fx",
    models,
    defaultModel: active?.nativeId ?? models[0]!.id,
  };
}

/** Web AgentModel → server ModelInfo: native id, effort choices that fit
 *  the server's Reasoning ladder, context window when reported. */
export function toModelInfo(model: AgentModel): ModelInfo {
  const effort = model.settings?.find((setting) => setting.id === "effort");
  const reasoning = (effort?.options ?? [])
    .map((option) => option.value)
    .filter((value): value is Reasoning => (REASONING as string[]).includes(value));
  const defaultReasoning = reasoning.find((value) => value === effort?.value);
  return {
    id: model.nativeId ?? model.id,
    label: model.name,
    reasoning,
    ...(defaultReasoning ? { defaultReasoning } : {}),
    ...(model.contextWindow ? { context: model.contextWindow } : {}),
  };
}
