import { useEffect, useState } from "react";
import {
  TURN_PASS_OFF,
  passEnabled,
  type TurnPass,
} from "@server/shared/turnpass";
import { client } from "../lib/tcserver/client";
import { Heading, Row, Select, Toggle } from "../surfaces/settingsBits";

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
  build: { label: "Build", hint: "Create a build and say where it landed." },
  commit: { label: "Commit", hint: "Commit the turn's changes to the branch." },
};

export function TurnPassFields({
  value,
  onChange,
  compact = false,
}: {
  value: TurnPass;
  onChange: (next: TurnPass) => void;
  /** Stacked, tighter rows for dialogs; the default is a settings page. */
  compact?: boolean;
}) {
  const commit = (
    <Select
      label="Commit"
      value={value.commit}
      options={COMMIT_OPTIONS}
      onChange={(commit) => onChange({ ...value, commit: commit as TurnPass["commit"] })}
    />
  );
  if (compact) {
    return (
      <div className="flex flex-col gap-2.5">
        <CompactRow {...COPY.verify}>
          <Toggle label="Verify" on={value.verify} onChange={(verify) => onChange({ ...value, verify })} />
        </CompactRow>
        <CompactRow {...COPY.build}>
          <Toggle label="Build" on={value.build} onChange={(build) => onChange({ ...value, build })} />
        </CompactRow>
        <CompactRow {...COPY.commit}>{commit}</CompactRow>
      </div>
    );
  }
  return (
    <>
      <Row label={COPY.verify.label} description={COPY.verify.hint}>
        <Toggle label="Verify" on={value.verify} onChange={(verify) => onChange({ ...value, verify })} />
      </Row>
      <Row label={COPY.build.label} description={COPY.build.hint}>
        <Toggle label="Build" on={value.build} onChange={(build) => onChange({ ...value, build })} />
      </Row>
      <Row label={COPY.commit.label} description={COPY.commit.hint}>
        {commit}
      </Row>
    </>
  );
}

function CompactRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-4">
      <div className="min-w-0 flex-1">
        <div className="text-[12px] font-medium text-content">{label}</div>
        <div className="text-[11px] leading-4 text-content/40">{hint}</div>
      </div>
      {children}
    </div>
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
  const raw = await client.request("turnpass.get", { workspaceId, projectId });
  return parseTurnPass(raw);
}

export async function saveTurnPass(
  workspaceId: string,
  pass: TurnPass | null,
  projectId?: string,
): Promise<void> {
  await client.request("turnpass.set", {
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
    <section>
      <Heading title="Completed turn" />
      <p className="pb-2 text-[12px] leading-relaxed text-content/40">
        After a turn settles, implementation and orchestration threads run these
        before anything queued.
      </p>
      {value ? <TurnPassFields value={value} onChange={change} /> : null}
      {error ? <p className="pt-2 text-[11px] text-danger">{error}</p> : null}
    </section>
  );
}
