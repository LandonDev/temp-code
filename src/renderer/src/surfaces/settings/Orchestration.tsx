import { useState } from "react";
import { OrchestrationRulesEditor } from "../../chrome/OrchestrationRules";
import { takeRequestedScope } from "../../lib/tcserver/rules";
import { useWorkspaces } from "../../lib/tcserver/workspaces";
import { Row, Select } from "../settingsBits";

export function OrchestrationPage() {
  const workspaces = useWorkspaces();
  const [scope, setScope] = useState<string | null>(() => takeRequestedScope() ?? null);
  const known = scope === null || workspaces.some((w) => w.id === scope);
  return (
    <>
      {workspaces.length > 0 ? (
        <Row label="Scope" description="The global rules, or one workspace's override of them.">
          <Select
            label="Rules scope"
            value={known ? (scope ?? "") : ""}
            onChange={(next) => setScope(next || null)}
            options={[
              { value: "", label: "Global" },
              ...workspaces.map((w) => ({ value: w.id, label: w.name })),
            ]}
          />
        </Row>
      ) : null}
      <OrchestrationRulesEditor key={scope ?? ""} workspaceId={known ? scope : null} />
    </>
  );
}
