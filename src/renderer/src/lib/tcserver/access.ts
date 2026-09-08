import type { RuntimeMode } from "../session";
import type { PermissionPolicy } from "./types";

/**
 * MonoCode's access picker ↔ the server's approval policy.
 *
 * | runtime mode        | policy | claude              | codex                           | cursor                       |
 * |---------------------|--------|---------------------|---------------------------------|------------------------------|
 * | supervised          | safe   | default             | untrusted + read-only sandbox   | plan mode                    |
 * | auto-accept-edits   | edits  | acceptEdits         | on-request + workspace-write    | force + sandbox enabled      |
 * | auto                | edits  | acceptEdits         | on-request + workspace-write    | force + sandbox enabled      |
 * | full-access         | auto   | bypassPermissions   | never + danger-full-access      | force + sandbox disabled     |
 *
 * temp-code's server knows three policies (safe / edits / auto) and has no
 * AI-reviewed tier. The picker's `auto` mode is deliberately the edits
 * policy: the model still asks before anything beyond a file edit, which is
 * the closest the server can get to "reviewed" without becoming full access.
 * It therefore reads back as auto-accept-edits.
 */
const TO_POLICY: Record<RuntimeMode, PermissionPolicy> = {
  supervised: "safe",
  "auto-accept-edits": "edits",
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
