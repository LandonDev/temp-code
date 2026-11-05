import { useState } from "react";
import {
  TURN_PASS_OFF,
  passEnabled,
  type TurnPass,
} from "@server/shared/turnpass";
import { linkOfWorkspace } from "../lib/tcserver/projects";
import { useHostRead } from "../lib/connection/hostRead";
import type { Link } from "../lib/connection";
import { Button } from "../components/ui/button";
import { ChoiceSelect } from "../components/choice-select";
import { PageError, PageRow, PageRowsSkeleton, PageSection } from "../components/page";
import { SettingSwitch } from "../components/setting-switch";

/**
 * The "completed turn" pass: what an implementation or orchestration thread
 * does after a turn settles and before anything queued. Stored per workspace
 * (`turnpass.set`), with a per-project override the project dialogs edit.
 */

export const COMMIT_OPTIONS: { value: TurnPass["commit"]; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "commit", label: "Commit" },
  { value: "push", label: "Commit & push" },
];

const COPY = {
  verify: { label: "Checks", hint: "Run the project's checks and fix what fails." },
  // Not "Build": the workspace page's Build section means the command.
  build: { label: "Fresh build", hint: "Create a build and say where it landed." },
  commit: { label: "Commit", hint: "Commit the turn's changes to the branch." },
};

export function TurnPassFields({
  value,
  onChange,
  compact = false,
}: {
  value: TurnPass;
  onChange: (next: TurnPass) => void;
  /** Small pickers, for dialogs. */
  compact?: boolean;
}) {
  const commit = (
    <ChoiceSelect
      label="Commit"
      size={compact ? "sm" : "default"}
      value={value.commit}
      options={COMMIT_OPTIONS}
      onChange={(commit) => onChange({ ...value, commit })}
    />
  );
  return (
    <>
      <PageRow title={COPY.verify.label} description={COPY.verify.hint}>
        <SettingSwitch label={COPY.verify.label} on={value.verify} onChange={(verify) => onChange({ ...value, verify })} />
      </PageRow>
      <PageRow title={COPY.build.label} description={COPY.build.hint}>
        <SettingSwitch label={COPY.build.label} on={value.build} onChange={(build) => onChange({ ...value, build })} />
      </PageRow>
      <PageRow title={COPY.commit.label} description={COPY.commit.hint}>
        {commit}
      </PageRow>
    </>
  );
}

export function parseTurnPass(raw: unknown): TurnPass | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const commit = COMMIT_OPTIONS.some((o) => o.value === r.commit)
    ? (r.commit as TurnPass["commit"])
    : "off";
  return { verify: r.verify === true, build: r.build === true, commit };
}

export async function loadTurnPass(
  workspaceId: string,
  projectId?: string,
): Promise<TurnPass | null> {
  const raw = await linkOfWorkspace(workspaceId).request("turnpass.get", { workspaceId, projectId });
  return parseTurnPass(raw);
}

export async function saveTurnPass(
  workspaceId: string,
  pass: TurnPass | null,
  projectId?: string,
): Promise<void> {
  await linkOfWorkspace(workspaceId).request("turnpass.set", {
    workspaceId,
    projectId,
    pass: pass && passEnabled(pass) ? pass : null,
  });
}

/** The three rows TurnPassFields draws, in their shape. */
const TURN_PASS_SKELETON = [
  { description: true, control: "switch" },
  { description: true, control: "switch" },
  { description: true },
] as const;

/** The workspace's host link, or null while the catalog does not know it yet. */
function linkOrNull(workspaceId: string): Link | null {
  try {
    return linkOfWorkspace(workspaceId);
  } catch {
    return null;
  }
}

/** Settings-page group for one workspace's pass; saves on every change.
 *  No answer from the host is the section's error and Retry. */
export function TurnPassEditor({ workspaceId }: { workspaceId: string }) {
  const read = useHostRead(
    linkOrNull(workspaceId),
    async () => (await loadTurnPass(workspaceId)) ?? TURN_PASS_OFF,
    workspaceId,
  );
  const value = read.value;
  const [error, setError] = useState<string | null>(null);

  const change = (next: TurnPass) => {
    // A refusal puts back the value the host still holds, under its red line.
    const held = value;
    read.set(next);
    setError(null);
    saveTurnPass(workspaceId, next).catch((err) => {
      if (held) read.set(held);
      setError(err instanceof Error ? err.message : String(err));
    });
  };

  return (
    <PageSection
      title="Completed turn"
      action={
        !value && read.error ? (
          <Button variant="ghost" size="sm" onClick={read.retry}>
            Retry
          </Button>
        ) : null
      }
    >
      {value ? (
        <TurnPassFields value={value} onChange={change} />
      ) : read.error ? (
        <PageError>{read.error}</PageError>
      ) : (
        <PageRowsSkeleton rows={TURN_PASS_SKELETON} />
      )}
      {value && error ? <PageError>{error}</PageError> : null}
    </PageSection>
  );
}
