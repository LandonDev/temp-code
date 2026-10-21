import { useEffect, useMemo, useRef, useState } from "react";
import { approvedLadder, type OrchestrationRules } from "@server/shared/rules";
import type { ProviderId, Reasoning } from "@server/shared/catalog";
import { GHOST, PRIMARY, ErrorLine, errorText } from "../../../chrome/ConfirmDialog";
import { Modal } from "../../../chrome/Modal";
import { ModelPicker } from "../../../chrome/ModelPicker";
import { useEnvironments } from "../../../lib/connection/status";
import { mergeModelSettings, nativeModelId, resolveModel } from "../../../lib/models";
import { pairOf, pairWorkspaces, partnersOf } from "../../../lib/projectPairs";
import type { HarnessId } from "../../../lib/session";
import { startThread } from "../../../lib/tcserver/commands";
import { useRulesScope } from "../../../lib/tcserver/rules";
import type { ProjectMeta, SessionMeta, ThreadType } from "../../../lib/tcserver/types";
import { useProjects, useWorkspaces } from "../../../lib/tcserver/workspaces";
import { Segmented, Select } from "../../settingsBits";
import { MatrixSpinner, THREAD_LABELS } from "../bits";

/**
 * "Add a thread to <batch>" (docs/LAYOUT.md "Master"): one sheet for a
 * child's whole identity — type, model, effort, context, host and the
 * sibling it waits for — and its brief. Add creates the thread on the
 * chosen host with the master's id and sends the brief as its first
 * message, the way the composer starts a thread; the row then appears in
 * Queued or Running from the host's push, nothing optimistic.
 */

const TYPES: ThreadType[] = ["implementation", "planning", "orchestration", "research", "project-plan"];
const NO_AFTER = "";
const TEXTAREA =
  "min-h-[4.5rem] w-full resize-y rounded-lg border border-content/10 bg-content/5 px-2.5 py-2 font-sans text-[12px] leading-5 text-content outline-none placeholder:text-content/40 focus:border-content/20 disabled:cursor-default disabled:opacity-40";

export type AddThreadMaster = Pick<
  SessionMeta,
  "id" | "environmentId" | "title" | "cwd" | "projectId" | "workspaceId" | "provider" | "model" | "reasoning" | "context1m"
>;

export type HostChoice = {
  id: string;
  name: string;
  /** The project to create under on that host, or the cwd when only the folder is paired; null when the host has no copy. */
  target: { projectId: string } | { cwd: string } | null;
};

/** The hosts the add sheet offers, this host first: the master's own
 *  project at home, and on every other host the paired copy (the same
 *  GitHub repo, else the same folder name; lib/projectPairs.ts). */
export function hostChoices(
  master: Pick<AddThreadMaster, "environmentId" | "cwd" | "projectId">,
  environments: readonly { id: string; name: string }[],
  workspaces: Parameters<typeof pairWorkspaces>[0],
  projects: readonly Pick<ProjectMeta, "id" | "environmentId" | "cwd">[],
): HostChoice[] {
  const pairs = pairWorkspaces(workspaces);
  const home = pairOf(pairs, master.environmentId, master.cwd);
  const partners = home ? partnersOf(pairs, master.environmentId, master.cwd) : [];
  const ordered = [...environments].sort((a, b) =>
    a.id === master.environmentId ? -1 : b.id === master.environmentId ? 1 : 0,
  );
  return ordered
    .filter((env) => env.id !== "web")
    .map((env) => {
      if (env.id === master.environmentId) {
        return { id: env.id, name: env.name, target: master.projectId ? { projectId: master.projectId } : { cwd: master.cwd } };
      }
      const partner = partners.find((p) => p.environmentId === env.id);
      if (!partner) return { id: env.id, name: env.name, target: null };
      const project = projects.find((p) => p.environmentId === env.id && p.cwd.replace(/\/+$/, "") === partner.cwd);
      return { id: env.id, name: env.name, target: project ? { projectId: project.id } : { cwd: partner.cwd } };
    });
}

/** The effort steps the sheet offers: the model's ladder cut to what the
 *  policy approves (an unknown policy leaves the ladder whole). */
export function effortChoices(
  rules: OrchestrationRules | undefined,
  harness: HarnessId,
  model: string,
  environmentId: string,
): Reasoning[] {
  const ladder = (resolveModel(harness, model, environmentId).settings ?? [])
    .find((s) => s.id === "effort")
    ?.options.map((o) => o.value as Reasoning) ?? [];
  if (!rules) return ladder;
  const approved = approvedLadder(rules, harness as ProviderId, nativeModelId(model));
  const cut = ladder.filter((r) => approved.includes(r));
  return cut.length > 0 ? cut : ladder;
}

export function AddThreadDialog({
  master,
  siblings,
  onClose,
  onAdded,
}: {
  master: AddThreadMaster;
  /** The batch's other children, for After. */
  siblings: readonly Pick<SessionMeta, "id" | "title">[];
  onClose: () => void;
  onAdded?: (meta: SessionMeta) => void;
}) {
  const [type, setType] = useState<ThreadType>("implementation");
  const [choice, setChoice] = useState<{ harness: HarnessId; model: string }>({
    harness: master.provider as HarnessId,
    model: master.model,
  });
  const [host, setHost] = useState(master.environmentId);
  const [settings, setSettings] = useState<Record<string, string>>(() =>
    mergeModelSettings(resolveModel(choice.harness, choice.model, master.environmentId), {
      effort: master.reasoning,
      context: master.context1m ? "1m" : "200k",
    }),
  );
  const [after, setAfter] = useState(NO_AFTER);
  const [brief, setBrief] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const briefRef = useRef<HTMLTextAreaElement>(null);

  const environments = useEnvironments();
  const workspaces = useWorkspaces();
  const projects = useProjects();
  const hosts = useMemo(
    () => hostChoices(master, environments, workspaces, projects),
    [master, environments, workspaces, projects],
  );
  const { scope } = useRulesScope(master.environmentId, master.workspaceId ?? null);
  const efforts = effortChoices(scope?.rules, choice.harness, choice.model, host);
  const contexts = (resolveModel(choice.harness, choice.model, host).settings ?? []).find((s) => s.id === "context")
    ?.options;
  const effort = efforts.includes(settings.effort as Reasoning) ? settings.effort : efforts[0];

  useEffect(() => {
    briefRef.current?.focus();
  }, []);

  const target = hosts.find((h) => h.id === host)?.target ?? null;
  const canAdd = brief.trim().length > 0 && !!target && !pending;

  const add = async () => {
    if (!canAdd || !target) return;
    setPending(true);
    setError(null);
    try {
      const meta = await startThread(
        {
          environmentId: host,
          threadType: type,
          provider: choice.harness,
          model: nativeModelId(choice.model),
          reasoning: effort,
          context1m: contexts ? settings.context === "1m" : undefined,
          ...target,
          masterId: master.id,
          ...(after ? { after } : {}),
          queue: true,
        },
        brief.trim(),
      );
      onAdded?.(meta);
      onClose();
    } catch (err) {
      setError(errorText(err));
      setPending(false);
    }
  };

  return (
    <Modal onClose={onClose} busy={pending} title={`Add a thread to ${master.title || "the batch"}`} size="md">
      <form
        className="flex flex-col gap-3 px-4 pt-2 pb-3"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <div className="grid grid-cols-[84px_1fr] items-center gap-x-3 gap-y-2.5 text-[12px]">
          <Label>Type</Label>
          <div className="min-w-0 overflow-x-auto">
            <Segmented
              label="Type"
              value={type}
              options={TYPES.map((t) => ({ value: t, label: THREAD_LABELS[t] }))}
              onChange={setType}
            />
          </div>

          <Label>Model</Label>
          <div className="-ml-1 flex min-w-0 items-center" data-model-picker>
            <ModelPicker
              harness={choice.harness}
              model={choice.model}
              environmentId={host}
              onChange={(h, m) => {
                setChoice({ harness: h, model: m });
                setSettings(mergeModelSettings(resolveModel(h, m, host), settings));
              }}
            />
          </div>

          {efforts.length > 0 ? (
            <>
              <Label>Effort</Label>
              <div className="min-w-0">
                <Segmented
                  label="Effort"
                  value={effort}
                  options={efforts.map((r) => ({ value: r, label: r }))}
                  onChange={(r) => setSettings({ ...settings, effort: r })}
                />
              </div>
            </>
          ) : null}

          {contexts ? (
            <>
              <Label>Context</Label>
              <div className="min-w-0">
                <Segmented
                  label="Context"
                  value={settings.context === "1m" ? "1m" : "200k"}
                  options={contexts.map((o) => ({ value: o.value, label: o.label }))}
                  onChange={(c) => setSettings({ ...settings, context: c })}
                />
              </div>
            </>
          ) : null}

          {hosts.length > 1 ? (
            <>
              <Label>Host</Label>
              <div role="radiogroup" aria-label="Host" className="flex gap-0.5 rounded-md border border-content/10 p-0.5 text-[12px]">
                {hosts.map((h) => (
                  <button
                    key={h.id}
                    type="button"
                    role="radio"
                    aria-checked={host === h.id}
                    disabled={!h.target}
                    title={h.target ? undefined : `No copy of the project on ${h.name}`}
                    onClick={() => setHost(h.id)}
                    className={`pressable rounded-[4px] px-3 py-1 disabled:cursor-default disabled:opacity-40 ${
                      host === h.id ? "bg-content/10 text-content" : "text-content/50 hover:text-content"
                    }`}
                  >
                    {h.name}
                  </button>
                ))}
              </div>
            </>
          ) : null}

          <Label>After</Label>
          <Select
            label="After"
            value={after}
            className="max-w-full"
            options={[
              { value: NO_AFTER, label: "Start when a slot frees" },
              ...siblings.map((s) => ({ value: s.id, label: s.title || "Untitled" })),
            ]}
            onChange={setAfter}
          />

          <Label className="self-start pt-2">Brief</Label>
          <textarea
            ref={briefRef}
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            aria-label="Brief"
            placeholder="What this thread should do, and what done looks like."
            disabled={pending}
            className={TEXTAREA}
          />
        </div>
        <ErrorLine error={error} />
        <div className="flex items-center gap-2">
          <span className="min-w-0 truncate text-[11px] text-content/40">
            Starts with the project rules · no gate, the batch runs it once
          </span>
          <span className="flex-1" />
          <button type="button" onClick={onClose} disabled={pending} className={GHOST}>
            Cancel
          </button>
          <button type="submit" disabled={!canAdd} className={PRIMARY}>
            {pending ? <MatrixSpinner cell={2} /> : null}
            Add
          </button>
        </div>
      </form>
    </Modal>
  );
}

function Label({ children, className = "" }: { children: string; className?: string }) {
  return <span className={`text-content/50 ${className}`}>{children}</span>;
}
