import { useState } from "react";
import { OrchestrationRulesEditor } from "../../chrome/OrchestrationRules";
import { ChoiceSelect } from "../../components/choice-select";
import { PageRow, PageSection } from "../../components/page";
import { takeRequestedScope } from "../../lib/tcserver/rules";
import { useWorkspaces } from "../../lib/tcserver/workspaces";

export function OrchestrationPage() {
  const workspaces = useWorkspaces();
  const [scope, setScope] = useState<string | null>(() => takeRequestedScope() ?? null);
  const known = scope === null || workspaces.some((w) => w.id === scope);
  return (
    <>
      {workspaces.length > 0 ? (
        <PageSection>
          <PageRow title="Rules for">
            <ChoiceSelect
              label="Rules for"
              value={known ? (scope ?? "") : ""}
              onChange={(next) => setScope(next || null)}
              options={[{ value: "", label: "Global" }, ...workspaces.map((w) => ({ value: w.id, label: w.name }))]}
            />
          </PageRow>
        </PageSection>
      ) : null}
      <OrchestrationRulesEditor key={scope ?? ""} workspaceId={known ? scope : null} />
    </>
  );
}
