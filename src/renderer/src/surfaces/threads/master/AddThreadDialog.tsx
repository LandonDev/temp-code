import { useEffect, useMemo, useState } from "react";
import type { Reasoning } from "@server/shared/catalog";
import { DialogFooter, ErrorLine, errorText } from "../../../chrome/ConfirmDialog";
import { Modal, useModalClose } from "../../../chrome/Modal";
import { FieldRow } from "../../../chrome/DialogField";
import { ModelPicker } from "../../../chrome/ModelPicker";
import { useEnvironments, useEnvironmentStatuses } from "../../../lib/connection/status";
import { mergeModelSettings, nativeModelId, resolveModel } from "../../../lib/models";
import { pairOf, pairWorkspaces, partnersOf } from "../../../lib/projectPairs";
import type { HarnessId } from "../../../lib/session";
import { startThread } from "../../../lib/tcserver/commands";
import type { ProjectMeta, SessionMeta, ThreadType, WorkspaceMeta } from "../../../lib/tcserver/types";
import type { EnsureLinkedArgs } from "@server/shared/projectLinks";
import { copiesOf, ensureLinkedArgs, ensureLinkedOn, probeOf, rememberLinkHost, type CopyProbe } from "../../../lib/projectHostChoice";
import { useProjects, useWorkspaces } from "../../../lib/tcserver/workspaces";
import { ChoiceSelect } from "../../../components/choice-select";
import { ChoiceToggle } from "../../../components/choice-toggle";
import { Textarea } from "../../../components/ui/textarea";
import { THREAD_LABELS } from "../threadTypes";
import { linkedHosts } from "./boardActions";

/**
 * "Add a thread to <batch>" (docs/LAYOUT.md "Master"): the brief first,
 * then one FieldRow per choice (type, model, effort, context, host, after),
 * the label at the row's start and the control at its end.
 * One column at the dialog's medium width, nothing scrolls. Every catalog
 * model is offered with its own effort ladder and context choices. Add
 * creates the thread on the chosen host with the master's id and sends
 * the brief as its first message; the row then arrives from the push.
 */

const TYPES: ThreadType[] = ["implementation", "planning", "orchestration", "research", "project-plan"];
const NO_AFTER = "";

export type AddThreadMaster = Pick<
  SessionMeta,
  "id" | "environmentId" | "title" | "cwd" | "projectId" | "workspaceId" | "provider" | "model" | "reasoning" | "context1m"
>;

export type HostChoice = {
  id: string;
  name: string;
  /** The project to create under on that host, the cwd when only the folder
   *  is paired, or the link facts `project.ensureLinked` makes the host's
   *  copy from; null when the host can have no copy. */
  target: { projectId: string } | { cwd: string } | { ensure: Omit<EnsureLinkedArgs, "dryRun"> } | null;
};

/** The hosts the add sheet offers (`environments` is the linked set,
 *  `linkedHosts`), this host first: the master's own project at home, and
 *  on every other host its linked copy (CLAUDE.md "One project across
 *  hosts"), or, when that host has none yet, the facts to make one. A
 *  project the linker has not stamped yet falls back to the paired folder
 *  (the same GitHub repo, else the same folder name; lib/projectPairs.ts). */
export function hostChoices(
  master: Pick<AddThreadMaster, "environmentId" | "cwd" | "projectId">,
  environments: readonly { id: string; name: string }[],
  workspaces: readonly WorkspaceMeta[],
  projects: readonly ProjectMeta[],
): HostChoice[] {
  const own = master.projectId ? projects.find((p) => p.id === master.projectId && p.environmentId === master.environmentId) : undefined;
  const linkId = own?.linkId;
  const ensure = own ? ensureLinkedArgs(own, workspaces.find((w) => w.id === own.workspaceId && w.environmentId === own.environmentId)) : null;
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
      if (linkId) {
        const copy = copiesOf(projects, linkId).find((p) => p.environmentId === env.id);
        return { id: env.id, name: env.name, target: copy ? { projectId: copy.id } : ensure ? { ensure } : null };
      }
      const partner = partners.find((p) => p.environmentId === env.id);
      if (!partner) return { id: env.id, name: env.name, target: null };
      const project = projects.find((p) => p.environmentId === env.id && p.cwd.replace(/\/+$/, "") === partner.cwd);
      return { id: env.id, name: env.name, target: project ? { projectId: project.id } : { cwd: partner.cwd } };
    });
}

/** The model's own effort ladder, whole: no policy cuts it for a thread. */
export function effortChoices(harness: HarnessId, model: string, environmentId: string): { value: Reasoning; label: string }[] {
  return (
    (resolveModel(harness, model, environmentId).settings ?? [])
      .find((s) => s.id === "effort")
      ?.options.map((o) => ({ value: o.value as Reasoning, label: o.label })) ?? []
  );
}

type AddThreadProps = {
  master: AddThreadMaster;
  /** The batch's other children, for After. */
  siblings: readonly Pick<SessionMeta, "id" | "title">[];
  onClose: () => void;
  onAdded?: (meta: SessionMeta) => void;
};

export function AddThreadDialog(props: AddThreadProps) {
  const [pending, setPending] = useState(false);
  return (
    <Modal onClose={props.onClose} busy={pending} title={`Add a thread to ${props.master.title || "the batch"}`} size="md">
      <AddThreadForm {...props} pending={pending} setPending={setPending} />
    </Modal>
  );
}

function AddThreadForm({
  master,
  siblings,
  onClose,
  onAdded,
  pending,
  setPending,
}: AddThreadProps & { pending: boolean; setPending: (pending: boolean) => void }) {
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
  const [error, setError] = useState<string | null>(null);
  const close = useModalClose();

  const environments = useEnvironments();
  const statuses = useEnvironmentStatuses();
  const workspaces = useWorkspaces();
  const projects = useProjects();
  const hosts = useMemo(
    () => hostChoices(master, linkedHosts(environments, (id) => statuses.get(id), master), workspaces, projects),
    [master, environments, statuses, workspaces, projects],
  );
  const efforts = effortChoices(choice.harness, choice.model, host);
  const contexts = (resolveModel(choice.harness, choice.model, host).settings ?? []).find((s) => s.id === "context")?.options;
  const effort = efforts.some((e) => e.value === settings.effort) ? (settings.effort as Reasoning) : efforts[0]?.value;

  // A host with no copy yet is asked once whether it can take one (a dry run);
  // one with no checkout stays disabled with its note.
  const [probes, setProbes] = useState<ReadonlyMap<string, CopyProbe>>(new Map());
  const ensureKey = hosts.flatMap((h) => (h.target && "ensure" in h.target ? [h.id] : [])).join(",");
  useEffect(() => {
    let live = true;
    for (const h of hosts) {
      if (!h.target || !("ensure" in h.target)) continue;
      ensureLinkedOn(h.id, h.target.ensure, true).then(
        (result) => live && setProbes((prev) => new Map(prev).set(h.id, probeOf(result))),
        (err: unknown) => live && setProbes((prev) => new Map(prev).set(h.id, { state: "none", note: errorText(err) })),
      );
    }
    return () => {
      live = false;
    };
    // The hosts list is rebuilt with every catalog push; the set needing a dry run is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ensureKey]);
  const usable = (h: HostChoice) => !!h.target && (!("ensure" in h.target) || probes.get(h.id)?.state === "ready");
  const noteOf = (h: HostChoice): string | undefined => {
    if (!h.target) return `No copy of the project on ${h.name}`;
    const probe = probes.get(h.id);
    return "ensure" in h.target && probe?.state === "none" ? probe.note : undefined;
  };

  const chosen = hosts.find((h) => h.id === host);
  const target = chosen && usable(chosen) ? chosen.target : null;
  const canAdd = brief.trim().length > 0 && !!target && !pending;

  const add = async () => {
    if (!canAdd || !target) return;
    setPending(true);
    setError(null);
    try {
      // A host with no copy yet gets one first, then the thread starts in it.
      let place: { projectId: string } | { cwd: string };
      if ("ensure" in target) {
        const made = await ensureLinkedOn(host, target.ensure);
        if (!made.project) throw new Error(made.note ?? `No copy of the project on ${chosen?.name ?? host}`);
        place = { projectId: made.project.id };
        rememberLinkHost(target.ensure.projectLinkId, host);
      } else place = target;
      const meta = await startThread(
        {
          environmentId: host,
          threadType: type,
          provider: choice.harness,
          model: nativeModelId(choice.model),
          reasoning: effort,
          context1m: contexts ? settings.context === "1m" : undefined,
          ...place,
          masterId: master.id,
          startedBy: master.id,
          ...(after ? { after } : {}),
          queue: true,
        },
        brief.trim(),
      );
      onAdded?.(meta);
      if (close) close(onClose);
      else onClose();
    } catch (err) {
      setError(errorText(err));
      setPending(false);
    }
  };

  const hostOptions = hosts.map((h) => ({ value: h.id, label: h.name, disabled: !usable(h), note: noteOf(h) }));

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void add();
      }}
    >
      {/* The rows carry their own 8px, so the brief and the rows sit 16px apart. */}
      <div className="flex flex-col gap-2 px-5 pt-4 pb-2">
        <Textarea
          autoFocus
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && e.metaKey) {
              e.preventDefault();
              void add();
            }
          }}
          aria-label="Brief"
          placeholder="What this thread should do, and what done looks like."
          disabled={pending}
          className="min-h-24 max-h-60 resize-none"
        />
        <div className="flex flex-col">
          <FieldRow label="Type">
            <ChoiceToggle label="Type" value={type} options={TYPES.map((t) => ({ value: t, label: THREAD_LABELS[t] }))} onChange={setType} />
          </FieldRow>
          <FieldRow label="Model">
            <span className="flex items-center" data-model-picker>
              <ModelPicker
                harness={choice.harness}
                model={choice.model}
                environmentId={host}
                onChange={(h, m) => {
                  setChoice({ harness: h, model: m });
                  setSettings(mergeModelSettings(resolveModel(h, m, host), settings));
                }}
              />
            </span>
          </FieldRow>
          {efforts.length > 0 && effort ? (
            <FieldRow label="Effort">
              <ChoiceToggle label="Effort" value={effort} options={efforts} onChange={(r) => setSettings({ ...settings, effort: r })} />
            </FieldRow>
          ) : null}
          {contexts ? (
            <FieldRow label="Context">
              <ChoiceToggle
                label="Context"
                value={settings.context === "1m" ? "1m" : "200k"}
                options={contexts.map((o) => ({ value: o.value, label: o.label }))}
                onChange={(c) => setSettings({ ...settings, context: c })}
              />
            </FieldRow>
          ) : null}
          {hosts.length > 1 ? (
            <FieldRow label="Host">
              <ChoiceToggle label="Host" value={host} options={hostOptions} onChange={setHost} />
            </FieldRow>
          ) : null}
          <FieldRow label="After">
            <ChoiceSelect
              label="After"
              size="sm"
              value={after}
              className="max-w-60"
              options={[{ value: NO_AFTER, label: "Nothing, start now" }, ...siblings.map((s) => ({ value: s.id, label: s.title || "Untitled" }))]}
              onChange={setAfter}
            />
          </FieldRow>
        </div>
        <ErrorLine error={error} />
      </div>
      <DialogFooter onCancel={onClose} confirmLabel="Add" pending={pending} disabled={!canAdd} />
    </form>
  );
}
