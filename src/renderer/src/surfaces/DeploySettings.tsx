import { useEffect, useRef, useState, type ReactNode } from "react";
import { ConfirmDialog, DialogFooter, ErrorLine, errorText } from "../chrome/ConfirmDialog";
import { DeployDriftMark } from "../chrome/DeployDrift";
import { Modal } from "../chrome/Modal";
import { LOCAL_ENVIRONMENT_ID, WEB_ENVIRONMENT_ID } from "../lib/connection/registry";
import { useEnvironmentStatus, useEnvironments } from "../lib/connection";
import { useDeployDrift } from "../lib/deployDrift";
import { deployConfirmText, deployRowLine, hostJobCard } from "../lib/hostJobCard";
import {
  dismissJob,
  refreshDeployStatus,
  refreshPublishStatus,
  setReleaseCheckout,
  startDeploy,
  startPublish,
  stopPublish,
  useDeployStatuses,
  useHostJob,
  usePublishStatus,
  watchJob,
} from "../lib/hostJobs";
import { isWebMode } from "../lib/nativeWeb";
import { Heading, INPUT_CLASS, Input, Row, SecondaryButton } from "./settingsBits";
import { MatrixSpinner } from "./threads/bits";

/**
 * Settings → Remote access → Deploy and publish (docs/box.md "Updating" →
 * "Deploy from the app"; CLAUDE.md "Releases"). One row per saved host with
 * "Deploy master to the box" (a confirm names the versions), and this Mac's
 * row with "Publish Mac release" (the notes prefilled from the commits since
 * the last v1.0.* tag, the checkout editable). A running job is one log
 * card under the rows: the last 40 lines, following, Stop for the publish,
 * and the box's own word that it cannot be stopped mid-way.
 */

const POLL_MS = 5000;

export function DeploySettings(): ReactNode {
  const environments = useEnvironments();
  const hosts = environments.filter((e) => e.id !== LOCAL_ENVIRONMENT_ID && e.id !== WEB_ENVIRONMENT_ID);
  const deploy = useDeployStatuses();
  const publish = usePublishStatus();
  const web = isWebMode();
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<
    { kind: "deploy"; environmentId: string; name: string; deployed: string | null; master: string | null } | { kind: "publish" } | null
  >(null);

  const hostIds = hosts.map((h) => h.id).join(",");
  useEffect(() => {
    const ids = hostIds ? hostIds.split(",") : [];
    const refresh = (): void => {
      for (const id of ids) void refreshDeployStatus(id);
      if (!web) void refreshPublishStatus();
    };
    refresh();
    const t = window.setInterval(refresh, POLL_MS);
    return () => window.clearInterval(t);
  }, [hostIds, web]);
  // A job still running when the pane opens (or the box restarted into it) shows its card.
  useEffect(() => {
    for (const [id, s] of Object.entries(deploy)) {
      if (s && (s.phase === "pending" || s.phase === "running")) watchJob(id, "deploy");
    }
    if (publish && (publish.phase === "pending" || publish.phase === "running")) watchJob(LOCAL_ENVIRONMENT_ID, "publish");
  }, [deploy, publish]);

  const masterVersion = publish?.masterVersion ?? null;
  if (hosts.length === 0 && web) return null;

  return (
    <>
      <Heading title="Deploy and publish" />
      <p className="pb-2 text-[12px] leading-relaxed text-content/50">
        {"What used to be typed into a terminal, still pressed by you: a host rebuilds master from GitHub and restarts, " +
          "and this Mac cuts and uploads a release the installed app updates to. The log streams here."}
      </p>
      {hosts.map((host) => (
        <HostRow
          key={host.id}
          environmentId={host.id}
          name={host.name}
          masterVersion={masterVersion}
          onDeploy={(deployed, master) => setDialog({ kind: "deploy", environmentId: host.id, name: host.name, deployed, master })}
        />
      ))}
      {!web ? (
        <Row
          label="This Mac"
          description={publishLine(publish)}
        >
          <CheckoutField key={publish?.checkout ?? ""} value={publish?.checkout ?? ""} onCommit={(checkout) => void setReleaseCheckout(checkout).catch((e) => setError(errorText(e)))} />
          <SecondaryButton
            disabled={!publish || !publish.readable || publish.phase === "running" || publish.phase === "pending"}
            onClick={() => setDialog({ kind: "publish" })}
          >
            Publish Mac release
          </SecondaryButton>
        </Row>
      ) : null}
      <ErrorLine error={error} />
      {hosts.map((host) => (
        <JobCard key={`${host.id}:deploy`} environmentId={host.id} job="deploy" hostName={host.name} />
      ))}
      {!web ? <JobCard environmentId={LOCAL_ENVIRONMENT_ID} job="publish" hostName="This Mac" /> : null}

      {dialog?.kind === "deploy" ? (
        <ConfirmDialog
          title={`Deploy master to ${dialog.name}`}
          body={deployConfirmText(dialog.name, dialog.deployed, dialog.master)}
          confirmLabel="Deploy"
          onCancel={() => setDialog(null)}
          onConfirm={async () => {
            await startDeploy(dialog.environmentId, "master");
            setDialog(null);
          }}
        />
      ) : null}
      {dialog?.kind === "publish" && publish ? (
        <PublishDialog
          notes={publish.notes}
          line={publishLine(publish)}
          refusal={publish.refusal}
          onClose={() => setDialog(null)}
          onPublish={async (notes) => {
            await startPublish(notes);
            setDialog(null);
          }}
        />
      ) : null}
    </>
  );
}

function publishLine(p: ReturnType<typeof usePublishStatus>): string {
  if (!p) return "Publishes the next release from this Mac.";
  if (!p.readable) return p.refusal ?? `${p.checkout} is not readable.`;
  const head = p.version ? `v${p.version}` : "HEAD";
  const last = p.publishedVersion ? ` · last published v${p.publishedVersion}` : "";
  const branch = p.branch && p.branch !== "master" ? ` · on ${p.branch}, not master` : "";
  const dirty = p.dirty ? " · uncommitted changes" : "";
  return `${head} in ${p.checkout}${last}${branch}${dirty}`;
}

function HostRow({
  environmentId,
  name,
  masterVersion,
  onDeploy,
}: {
  environmentId: string;
  name: string;
  /** origin/master's version in the release checkout, when the drift watcher has none. */
  masterVersion: string | null;
  onDeploy: (deployed: string | null, master: string | null) => void;
}): ReactNode {
  const status = useEnvironmentStatus(environmentId);
  const deploy = useDeployStatuses()[environmentId] ?? null;
  // The drift mark's numbers (the host's hello against master's release.json) are the confirm's too.
  const drift = useDeployDrift(environmentId);
  const deployed = drift.deployedVersion ?? deploy?.version ?? null;
  const master = drift.masterVersion ?? masterVersion;
  const connected = status.transport === "open";
  const line = deploy
    ? deployRowLine({ installed: deploy.installed, version: deployed, masterVersion: master, connected, phase: deploy.phase })
    : connected
      ? "This host does not answer the deploy status: it runs an older build, or the key is not admin."
      : "Not connected right now.";
  const busy = deploy?.phase === "pending" || deploy?.phase === "running";
  return (
    <Row
      label={name}
      description={deploy && !deploy.installed && connected ? `${line} Run ${deploy.installHint} once from the Mac checkout.` : line}
    >
      <DeployDriftMark environmentId={environmentId} />
      <SecondaryButton disabled={!connected || !deploy || !deploy.installed || busy} onClick={() => onDeploy(deployed, master)}>
        Deploy master to the box
      </SecondaryButton>
    </Row>
  );
}

function CheckoutField({ value, onCommit }: { value: string; onCommit: (value: string) => void }): ReactNode {
  // Keyed on the value by the caller: a change from the host remounts it with the new text.
  const [text, setText] = useState(value);
  return (
    <Input
      aria-label="Release checkout"
      value={text}
      placeholder="~/IdeaProjects/temp-code"
      spellCheck={false}
      autoComplete="off"
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        if (text.trim() !== value) onCommit(text.trim());
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
      className="w-56"
    />
  );
}

function PublishDialog({
  notes: initial,
  line,
  refusal,
  onClose,
  onPublish,
}: {
  notes: string;
  line: string;
  refusal: string | null;
  onClose: () => void;
  onPublish: (notes: string) => Promise<void>;
}): ReactNode {
  const [notes, setNotes] = useState(initial);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (): Promise<void> => {
    setPending(true);
    setError(null);
    try {
      await onPublish(notes.trim());
    } catch (err) {
      setError(errorText(err));
      setPending(false);
    }
  };
  return (
    <Modal onClose={onClose} busy={pending} title="Publish Mac release" size="sm">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="flex flex-col gap-3 px-4 py-3">
          <p className="text-[12px] leading-snug text-content/50">{line}</p>
          <label className="flex flex-col gap-1.5 text-[12px] text-content/50">
            Release notes
            <textarea
              value={notes}
              autoFocus
              rows={4}
              spellCheck={false}
              onChange={(e) => setNotes(e.target.value)}
              className={`${INPUT_CLASS} resize-none leading-relaxed`}
            />
          </label>
          <p className="text-[11px] leading-4 text-content/40">
            Runs the local train (typecheck, tests, build, tag), then signs, notarizes and uploads to GitHub. The installed app offers it on its next check.
          </p>
          <ErrorLine error={error ?? refusal} />
        </div>
        <DialogFooter onCancel={onClose} confirmLabel="Publish" pending={pending} disabled={!notes.trim() || !!refusal} />
      </form>
    </Modal>
  );
}

function JobCard({ environmentId, job, hostName }: { environmentId: string; job: "deploy" | "publish"; hostName: string }): ReactNode {
  const entry = useHostJob(environmentId, job);
  const status = useEnvironmentStatus(environmentId);
  const deployed = useDeployStatuses()[environmentId]?.version ?? null;
  const [error, setError] = useState<string | null>(null);
  const pre = useRef<HTMLPreElement>(null);
  const follow = useRef(true);
  const text = entry?.text ?? "";
  useEffect(() => {
    const el = pre.current;
    if (el && follow.current) el.scrollTop = el.scrollHeight;
  }, [text]);
  if (!entry) return null;
  const card = hostJobCard({ job, status: entry.status, text, hostName, linkUp: status.transport === "open", deployedVersion: deployed });
  if (!card.visible) return null;
  const running = card.phase === "pending" || card.phase === "running";
  return (
    <section aria-label={card.title} className="mt-3 overflow-hidden rounded-lg border border-content/10">
      <div className="flex items-center gap-3 border-b border-content/5 px-3 py-2">
        {running ? <MatrixSpinner cell={1.5} /> : null}
        <span className="truncate text-[12px] font-medium text-content">{card.title}</span>
        {card.note ? <span className="min-w-0 truncate text-[12px] text-content/40">{card.note}</span> : null}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {card.stoppable ? (
            <SecondaryButton danger onClick={() => void stopPublish().catch((e) => setError(errorText(e)))}>
              Stop
            </SecondaryButton>
          ) : null}
          {!running ? <SecondaryButton onClick={() => dismissJob(environmentId, job)}>Dismiss</SecondaryButton> : null}
        </div>
      </div>
      <pre
        ref={pre}
        onScroll={(e) => {
          const el = e.currentTarget;
          follow.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 8;
        }}
        className="max-h-72 overflow-auto whitespace-pre-wrap break-words bg-content/[0.03] px-3 py-2 font-mono text-[11px] leading-4 text-content/70"
      >
        {card.lines.length ? card.lines.join("\n") : running ? "Waiting for output…" : ""}
      </pre>
      {card.ending ? (
        <div className={`border-t border-content/5 px-3 py-2 text-[12px] ${card.ending.failed ? "text-danger" : "text-content"}`}>{card.ending.text}</div>
      ) : null}
      <ErrorLine error={error} />
    </section>
  );
}
