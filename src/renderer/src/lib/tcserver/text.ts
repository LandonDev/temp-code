import { gitRangeContext, gitStagedContext } from "../fs";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  formatCommitMessage,
  parseBranchName,
  parseCommitMessage,
  parsePrContent,
  type PrContent,
} from "../gitText";
import { client } from "./client";

/**
 * One-shot text through the server (`text.generate`, a tool-less Claude
 * call): commit messages, PR bodies, branch names. Titles are the
 * server's own job now, so the title hook returns null.
 */
export async function generateText(prompt: string, cwd?: string): Promise<string | null> {
  const { text } = await client.request<{ text: string | null }>("text.generate", {
    prompt,
    ...(cwd && cwd !== "~" ? { cwd } : {}),
  });
  return text;
}

export async function generateServerCommitMessage(cwd: string): Promise<string> {
  const context = await gitStagedContext(cwd);
  const output =
    (await generateText(
      buildCommitMessagePrompt({
        branch: context.branch,
        stagedSummary: context.summary,
        stagedPatch: context.patch,
      }),
      cwd,
    )) ?? "";
  const parsed = parseCommitMessage(output);
  if (parsed) return formatCommitMessage(parsed);
  const snippet = output.trim().replace(/\s+/g, " ").slice(0, 240);
  throw new Error(
    snippet
      ? `Could not generate a commit message. Model replied: ${snippet}`
      : "Could not generate a commit message. The server returned no text.",
  );
}

export async function generateServerPrContent(
  cwd: string,
): Promise<(PrContent & { base: string; head: string }) | null> {
  const range = await gitRangeContext(cwd);
  let parsed: PrContent | null = null;
  try {
    const output = await generateText(
      buildPrContentPrompt({
        baseBranch: range.base,
        headBranch: range.head,
        commitSummary: range.commitSummary,
        diffSummary: range.diffSummary,
        diffPatch: range.diffPatch,
      }),
      cwd,
    );
    parsed = output ? parsePrContent(output) : null;
  } catch (error) {
    console.debug("[monocode] pr content", error);
  }
  const title =
    parsed?.title || range.commitSummary.split(/\r?\n/)[0]?.trim() || `Update ${range.head}`;
  return {
    title,
    body: parsed?.body || range.commitSummary.trim(),
    base: range.base,
    head: range.head,
  };
}

export async function generateServerBranchName(
  cwd: string,
  message: string,
): Promise<string | null> {
  try {
    const output = await generateText(buildBranchNamePrompt(message), cwd);
    return output ? parseBranchName(output) : null;
  } catch (error) {
    console.debug("[monocode] branch name", error);
    return null;
  }
}
