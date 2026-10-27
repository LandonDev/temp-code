import { useEffect, useState } from "react";
import {
  TURN_PASS_OFF,
  passEnabled,
  type TurnPass,
} from "@server/shared/turnpass";
import { linkOfWorkspace } from "../lib/tcserver/projects";
import { ChoiceSelect } from "../components/choice-select";
import { PageRow, PageRowsSkeleton, PageSection } from "../components/page";
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
  verify: { label: "Verify", hint: "Run the project's checks and fix what fails." },
  // Not "Build": the workspace page's Build section means the command.
  build: { label: "Make a build", hint: "Create a build and say where it landed." },
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
        <SettingSwitch label="Verify" on={value.verify} onChange={(verify) => onChange({ ...value, verify })} />
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

/** Settings-page group for one workspace's pass; saves on every change. */
export function TurnPassEditor({ workspaceId }: { workspaceId: string }) {
  const [value, setValue] = useState<TurnPass | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setValue(null);
    loadTurnPass(workspaceId)
      .then((pass) => live && setValue(pass ?? TURN_PASS_OFF))
      .catch((err) => live && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      live = false;
    };
  }, [workspaceId]);

  const change = (next: TurnPass) => {
    setValue(next);
    setError(null);
    saveTurnPass(workspaceId, next).catch((err) =>
      setError(err instanceof Error ? err.message : String(err)),
    );
  };

  return (
    <PageSection title="Completed turn">
      {value ? <TurnPassFields value={value} onChange={change} /> : error ? null : <PageRowsSkeleton rows={3} />}
      {error ? <p className="pt-2 text-xs text-destructive">{error}</p> : null}
    </PageSection>
  );
}
