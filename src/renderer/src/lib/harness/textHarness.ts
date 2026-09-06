import type { HarnessId } from "../session";
import type { PrContent } from "../gitText";
import {
  generateHarnessCommitMessage,
  generateHarnessPrContent,
  warmupHarnessText,
} from "./registry";

/** Titles, commit messages, and PR text all run through the server's
 *  one-shot Claude call, so the harness that fronts them is always claude. */
export function pickTextHarness(_preferred?: HarnessId): HarnessId {
  return "claude";
}

export function warmupText(cwd: string, preferred?: HarnessId): Promise<void> {
  return warmupHarnessText(pickTextHarness(preferred), cwd);
}

export function generateCommitMessage(
  cwd: string,
  preferred?: HarnessId,
): Promise<string> {
  return generateHarnessCommitMessage(pickTextHarness(preferred), cwd);
}

export function generatePrContent(
  cwd: string,
  preferred?: HarnessId,
): Promise<(PrContent & { base: string; head: string }) | null> {
  return generateHarnessPrContent(pickTextHarness(preferred), cwd);
}
