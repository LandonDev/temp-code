import { BatchStepKindSchema, stepsProblem, type BatchStepKind, type BatchStepSpec } from "@server/shared/contract-batch";

/**
 * Editing the batch's step list in the rules dialog, pure: the kinds a
 * person may add with their words, the default name of a built-in kind,
 * a fresh id, and the moves on the list. The master writes the list with
 * `batch_rules`; this is the person's hand on the same list.
 */

export const KIND_LABEL: Record<BatchStepKind, string> = {
  land: "Merge the branches",
  gate: "Gate the merged tree",
  release: "Release",
  publish: "Publish the Mac release",
  deploy: "Deploy to the box",
  shell: "Shell command",
};

/** The add menu's choices, in the contract's order. */
export const KIND_CHOICES: { value: BatchStepKind; label: string }[] = BatchStepKindSchema.options.map((value) => ({ value, label: KIND_LABEL[value] }));

/** The kinds the list may still take: one of each built-in kind, any number of shell steps. */
export function addableKinds(steps: readonly Pick<BatchStepSpec, "kind">[]): { value: BatchStepKind; label: string }[] {
  const taken = new Set(steps.map((s) => s.kind));
  return KIND_CHOICES.filter((c) => c.value === "shell" || !taken.has(c.value));
}

/** What a built-in step is called until the person renames it; a shell step is named by hand. */
export function defaultName(kind: BatchStepKind): string {
  if (kind === "shell") return "";
  return KIND_LABEL[kind].split(" ")[0];
}

/** The muted word after a step's name: its kind, or a shell step's command. */
export function stepLine(spec: Pick<BatchStepSpec, "kind" | "run">): string {
  return spec.kind === "shell" ? (spec.run?.trim() || "no command") : KIND_LABEL[spec.kind];
}

/** An id no step in the list has: the kind, then kind-2, kind-3. */
export function newStepId(kind: BatchStepKind, steps: readonly Pick<BatchStepSpec, "id">[]): string {
  const taken = new Set(steps.map((s) => s.id));
  if (!taken.has(kind)) return kind;
  for (let n = 2; ; n++) if (!taken.has(`${kind}-${n}`)) return `${kind}-${n}`;
}

export type ShellDraft = { name: string; run: string; cwd?: string };

export function addStep(steps: readonly BatchStepSpec[], kind: BatchStepKind, shell?: ShellDraft): BatchStepSpec[] {
  const id = newStepId(kind, steps);
  const step: BatchStepSpec =
    kind === "shell"
      ? { id, kind, name: shell?.name.trim() ?? "", run: shell?.run.trim() ?? "", ...(shell?.cwd?.trim() ? { cwd: shell.cwd.trim() } : {}) }
      : { id, kind, name: defaultName(kind) };
  return [...steps, step];
}

export function moveStep(steps: readonly BatchStepSpec[], index: number, by: -1 | 1): BatchStepSpec[] {
  const to = index + by;
  if (index < 0 || index >= steps.length || to < 0 || to >= steps.length) return [...steps];
  const next = [...steps];
  [next[index], next[to]] = [next[to], next[index]];
  return next;
}

export function removeStep(steps: readonly BatchStepSpec[], index: number): BatchStepSpec[] {
  return steps.filter((_, i) => i !== index);
}

export function renameStep(steps: readonly BatchStepSpec[], index: number, name: string): BatchStepSpec[] {
  return steps.map((s, i) => (i === index ? { ...s, name } : s));
}

/** Save is allowed: every step has a name, and the list passes the contract's own check
 *  (ids unique, one of each built-in kind, a command on every shell step). */
export function stepsValid(steps: readonly BatchStepSpec[]): boolean {
  return steps.every((s) => s.name.trim().length > 0) && stepsProblem(steps) === null;
}

/** A shell draft the Add button takes: a name and a command. */
export function shellDraftValid(draft: ShellDraft): boolean {
  return draft.name.trim().length > 0 && draft.run.trim().length > 0;
}
