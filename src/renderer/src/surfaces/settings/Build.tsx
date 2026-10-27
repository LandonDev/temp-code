import { useState } from "react";
import { BuildEditor, takeRequestedBuildScope } from "../../chrome/rail/buildSettings";
import { useWorkspaces } from "../../lib/tcserver/workspaces";
import { Row, Select } from "../settingsBits";

/** One workspace's build command; the Build rail tab deep-links here. */
export function BuildPage() {
  const workspaces = useWorkspaces();
  const [scope, setScope] = useState<string | null>(() => takeRequestedBuildScope() ?? null);
  const selected = workspaces.find((w) => w.id === scope) ?? workspaces[0];
  if (!selected) {
    return <p className="py-4 text-[12px] text-content/40">No workspaces yet.</p>;
  }
  return (
    <>
      {workspaces.length > 1 ? (
        <Row label="Workspace">
          <Select
            label="Build workspace"
            value={selected.id}
            onChange={setScope}
            options={workspaces.map((w) => ({ value: w.id, label: w.name }))}
          />
        </Row>
      ) : null}
      <BuildEditor key={selected.id} workspaceId={selected.id} />
    </>
  );
}
