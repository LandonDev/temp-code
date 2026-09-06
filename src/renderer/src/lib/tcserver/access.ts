import type { RuntimeMode } from "../session";
import type { PermissionPolicy } from "./types";

/**
 * MonoCode's access picker ↔ the server's approval policy.
 *
 * | runtime mode        | policy | claude              | codex                           | cursor                       |
 * |---------------------|--------|---------------------|---------------------------------|------------------------------|
 * | supervised          | safe   | default             | untrusted + read-only sandbox   | plan mode                    |
 * | auto-accept-edits   | edits  | acceptEdits         | on-request + workspace-write    | force + sandbox enabled      |
 * | auto                | review | auto (AI-reviewed)  | same as edits (approximation)   | same as edits (approximation)|
 * | full-access         | auto   | bypassPermissions   | never + danger-full-access      | force + sandbox disabled     |
 */
const TO_POLICY: Record<RuntimeMode, PermissionPolicy> = {
  supervised: "safe",
  "auto-accept-edits": "edits",
  // temp-code's server has no `review` policy: the AI-reviewed mode runs
  // as the edits policy until M4 maps access explicitly.
  auto: "edits",
  "full-access": "auto",
};

const TO_MODE: Record<PermissionPolicy, RuntimeMode> = {
  safe: "supervised",
  edits: "auto-accept-edits",
  auto: "full-access",
};

export function policyForMode(mode: RuntimeMode): PermissionPolicy {
  return TO_POLICY[mode];
}

export function modeForPolicy(policy: PermissionPolicy): RuntimeMode {
  return TO_MODE[policy] ?? "supervised";
}
