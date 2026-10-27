import { useEffect, useState } from "react";
import { Button } from "../../../components/ui/button";
import { ConfirmDialog, errorText } from "../../../chrome/ConfirmDialog";
import { LOCAL_ENVIRONMENT_ID, useEnvironmentStatus } from "../../../lib/connection";
import { useDeployDrift } from "../../../lib/deployDrift";
import { deployConfirmText, deployRowParts } from "../../../lib/hostJobCard";
import {
  refreshDeployStatus,
  refreshPublishStatus,
  setReleaseCheckout,
  startDeploy,
  startPublish,
  useDeployStatuses,
  usePublishStatus,
  watchJob,
} from "../../../lib/hostJobs";
import { CommitField } from "./CommitField";
import { PublishDialog } from "./dialogs/PublishDialog";
import { Facts } from "./Facts";
import { Group, Row } from "./Group";
import { JobLog } from "./JobLog";
import { publishParts } from "./parts";

/**
 * Deploy and publish (docs/box.md "Deploy from the app"; CLAUDE.md
 * "Releases"), each in its host's section: a paired host's Deploy row with
 * "Deploy master…" (the confirm names the versions), and this Mac's Release
 * group with "Publish Mac release…". A job's log folds open under its row.
 */

const POLL_MS = 5000;

/** Every paired host's deploy status and this Mac's publish status, every 5 s while the page shows; a job still running is followed. */
export function useJobPolling(hostIds: readonly string[], publish: boolean): void {
  const ids = hostIds.join(",");
  useEffect(() => {
    const list = ids ? ids.split(",") : [];
    const refresh = (): void => {
      for (const id of list) void refreshDeployStatus(id);
      if (publish) void refreshPublishStatus();
    };
    refresh();
    const t = window.setInterval(refresh, POLL_MS);
    return () => window.clearInterval(t);
  }, [ids, publish]);
  const deploy = useDeployStatuses();
  const status = usePublishStatus();
  useEffect(() => {
    for (const [id, s] of Object.entries(deploy)) {
      if (s && (s.phase === "pending" || s.phase === "running")) watchJob(id, "deploy");
    }
    if (status && (status.phase === "pending" || status.phase === "running")) watchJob(LOCAL_ENVIRONMENT_ID, "publish");
  }, [deploy, status]);
}

/** A paired host's Deploy row and its log. Nothing until the host answers the deploy status. */
export function HostDeploy({ environmentId, name }: { environmentId: string; name: string }) {
  const status = useEnvironmentStatus(environmentId);
  const deploy = useDeployStatuses()[environmentId] ?? null;
  const publish = usePublishStatus();
  // The drift mark's numbers (the host's hello against master's release.json) are the confirm's too.
  const drift = useDeployDrift(environmentId);
  const deployed = drift.deployedVersion ?? deploy?.version ?? null;
  const master = drift.masterVersion ?? publish?.masterVersion ?? null;
  const [confirm, setConfirm] = useState(false);
  const connected = status.transport === "open";
  // A deploy restarts the host: its log stays on screen while the link is down.
  if (!connected) return <JobLog environmentId={environmentId} job="deploy" hostName={name} />;
  if (!deploy) return null;
  const busy = deploy.phase === "pending" || deploy.phase === "running";
  const parts = deployRowParts({ installed: deploy.installed, version: deployed, masterVersion: master, connected, phase: deploy.phase });
  return (
    <>
      <Row
        title="Deploy"
        data-deploy-row={environmentId}
        description={
          <>
            <Facts parts={parts} />
            {!deploy.installed ? <span className="block">Run {deploy.installHint} once from the Mac checkout</span> : null}
          </>
        }
      >
        <Button variant="secondary" size="sm" disabled={!deploy.installed || busy} onClick={() => setConfirm(true)}>
          Deploy master…
        </Button>
      </Row>
      <JobLog environmentId={environmentId} job="deploy" hostName={name} />
      {confirm ? (
        <ConfirmDialog
          title={`Deploy master to ${name}`}
          body={deployConfirmText(name, deployed, master)}
          confirmLabel="Deploy"
          onCancel={() => setConfirm(false)}
          onConfirm={async () => {
            await startDeploy(environmentId, "master");
            setConfirm(false);
          }}
        />
      ) : null}
    </>
  );
}

/** This Mac's Release group: what HEAD is in the release checkout, the checkout itself, Publish, and its log. */
export function LocalRelease() {
  const publish = usePublishStatus();
  const [dialog, setDialog] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = publish?.phase === "running" || publish?.phase === "pending";
  return (
    <Group title="Release">
      <Row title="Publish" description={<Facts parts={publishParts(publish)} />} error={error}>
        <CommitField
          aria-label="Release checkout"
          value={publish?.checkout ?? ""}
          placeholder="~/IdeaProjects/temp-code"
          className="w-56"
          onCommit={(checkout) => void setReleaseCheckout(checkout).catch((e) => setError(errorText(e)))}
        />
        <Button variant="secondary" size="sm" disabled={!publish || !publish.readable || busy} onClick={() => setDialog(true)}>
          Publish Mac release…
        </Button>
      </Row>
      <JobLog environmentId={LOCAL_ENVIRONMENT_ID} job="publish" hostName="This Mac" />
      {dialog && publish ? (
        <PublishDialog
          notes={publish.notes}
          line={[...publishParts(publish), publish.checkout].join(", ")}
          refusal={publish.refusal}
          onClose={() => setDialog(false)}
          onPublish={async (notes) => {
            await startPublish(notes);
            setDialog(false);
          }}
        />
      ) : null}
    </Group>
  );
}
