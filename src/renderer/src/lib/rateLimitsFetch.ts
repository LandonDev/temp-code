import { invoke } from "./native";
import {
  errorRateLimits,
  parseClaudeOAuthUsage,
  parseCodexUsageBody,
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

/** Codex usage from the CLI's login on the server; unavailable hides the chip. */
export async function fetchCodexRateLimits(): Promise<ProviderRateLimits> {
  try {
    const result = await invoke<ClaudeUsageFetch>("fetch_codex_usage");
    if (result.status === "ok" && result.body) {
      return parseCodexUsageBody(result.body);
    }
    if (result.status === "unavailable") {
      return unavailableRateLimits(
        "codex",
        result.error?.trim() || "Codex not signed in",
      );
    }
    return errorRateLimits(
      "codex",
      result.error?.trim() || "Codex usage unavailable",
    );
  } catch (error) {
    return errorRateLimits(
      "codex",
      error instanceof Error ? error.message : "Codex usage unavailable",
    );
  }
}
