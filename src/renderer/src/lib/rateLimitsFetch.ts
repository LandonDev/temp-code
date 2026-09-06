import { invoke } from "./native";
import {
  errorRateLimits,
  parseClaudeOAuthUsage,
  unavailableRateLimits,
  type ProviderRateLimits,
} from "./rateLimits";


type ClaudeUsageFetch = {
  status: "ok" | "error" | "unavailable" | string;
  httpStatus?: number | null;
  body?: string | null;
  error?: string | null;
};

export async function fetchClaudeRateLimits(): Promise<ProviderRateLimits> {
  try {
    const result = await invoke<ClaudeUsageFetch>("fetch_claude_usage");
    if (result.status === "ok" && result.body) {
      const parsed = parseClaudeOAuthUsage(result.body);
      if (parsed.session || parsed.weekly) return parsed;
      return {
        ...parsed,
        status: parsed.status === "ok" ? "ok" : parsed.status,
      };
    }
    if (result.status === "unavailable") {
      return unavailableRateLimits(
        "claude",
        result.error?.trim() || "Claude not signed in",
      );
    }
    return errorRateLimits(
      "claude",
      result.error?.trim() || "Claude usage unavailable",
    );
  } catch (error) {
    return errorRateLimits(
      "claude",
      error instanceof Error ? error.message : "Claude usage unavailable",
    );
  }
}

/**
 * Codex usage came from a local `codex app-server` probe. Harness
 * children live on the server now; a server-side usage method is a
 * follow-up, so the footer shows Codex usage as unavailable until then.
 */
export async function fetchCodexRateLimits(): Promise<ProviderRateLimits> {
  return unavailableRateLimits("codex", "Codex usage not available yet");
}
