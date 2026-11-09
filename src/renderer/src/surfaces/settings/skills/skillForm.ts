import { SKILL_HARNESSES, SKILL_MD, type SkillHarness, type SkillHarnesses } from "@shared/skills";
import type { SkillFile } from "@shared/contract-skills";

/**
 * The skill editor's pure parts (Settings → Skills, New skill… and Edit…):
 * a new skill's SKILL.md, the files in the order the list shows them, what a
 * file weighs, the CLIs choice, whether anything changed and the files Save
 * sends. The dialog keeps a draft per text file it edited; every other file
 * passes through as it came.
 */

/** A new skill's one file, its `name:` following the Name field until the person edits it. */
export const skillTemplate = (name: string): string => `---\nname: ${name}\ndescription: \n---\n\n`;

/** SKILL.md first, then the rest by path. */
export function orderFiles<T extends { path: string }>(files: readonly T[]): T[] {
  return [...files].sort((a, b) => (a.path === SKILL_MD ? -1 : b.path === SKILL_MD ? 1 : a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** A file the editor cannot open: the store keeps it as base64. */
export const isBinary = (file: SkillFile): boolean => file.base64 !== undefined;

const encoder = new TextEncoder();
function base64Bytes(b64: string): Uint8Array {
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** Each file's bytes, for `skillProblem`: UTF-8 for text, decoded base64 for the rest. */
export const bytesOf = (files: readonly SkillFile[]): { path: string; bytes: Uint8Array }[] =>
  files.map((f) => ({ path: f.path, bytes: f.base64 !== undefined ? base64Bytes(f.base64) : encoder.encode(f.text ?? "") }));

/** One file's size in bytes. */
export const fileBytes = (file: SkillFile): number => (file.base64 !== undefined ? Math.floor((file.base64.length * 3) / 4) - (file.base64.endsWith("==") ? 2 : file.base64.endsWith("=") ? 1 : 0) : encoder.encode(file.text ?? "").length);

/** What Save sends: each edited text file with its draft, every other file as it came. */
export function filesToSave(files: readonly SkillFile[], drafts: Readonly<Record<string, string>>): SkillFile[] {
  return files.map((f) => (f.base64 === undefined && f.path in drafts ? { ...f, text: drafts[f.path]! } : f));
}

/** The files of a new skill: SKILL.md, from its draft or the template for this name. */
export const newSkillFiles = (name: string, drafts: Readonly<Record<string, string>>): SkillFile[] => [{ path: SKILL_MD, text: drafts[SKILL_MD] ?? skillTemplate(name) }];

/** The CLIs ticked. */
export type CliChoice = Record<SkillHarness, boolean>;

export const choiceOf = (harnesses: SkillHarnesses): CliChoice =>
  Object.fromEntries(SKILL_HARNESSES.map((h) => [h, harnesses === "all" || harnesses.includes(h)])) as CliChoice;

/** All three ticked is `all`, else the ticked ones in order. */
export function harnessesOf(choice: CliChoice): SkillHarnesses {
  const picked = SKILL_HARNESSES.filter((h) => choice[h]);
  return picked.length === SKILL_HARNESSES.length ? "all" : picked;
}

/** Whether a CLI may be unticked: never the last one ticked. */
export const canUntick = (choice: CliChoice, harness: SkillHarness): boolean => !choice[harness] || SKILL_HARNESSES.some((h) => h !== harness && choice[h]);

export const CLI_LABELS: Record<SkillHarness, string> = { claude: "Claude", codex: "Codex", muse: "Muse" };

/** The editor's fields as they stand. */
export interface SkillDraft {
  name: string;
  workspaceId: string | null;
  choice: CliChoice;
  /** text by path, for each text file the person opened and changed */
  drafts: Readonly<Record<string, string>>;
}

/** Whether closing would lose anything: a field moved, or a file's text differs from what was loaded. */
export function isDirty(initial: SkillDraft, now: SkillDraft, files: readonly SkillFile[]): boolean {
  if (now.name !== initial.name || now.workspaceId !== initial.workspaceId) return true;
  if (JSON.stringify(harnessesOf(now.choice)) !== JSON.stringify(harnessesOf(initial.choice))) return true;
  const original = new Map(files.map((f) => [f.path, f.text]));
  return Object.entries(now.drafts).some(([path, text]) => (original.has(path) ? original.get(path) !== text : text !== (initial.drafts[path] ?? "")));
}
