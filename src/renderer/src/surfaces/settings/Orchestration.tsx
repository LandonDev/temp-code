import { OrchestrationRulesEditor } from "../../chrome/OrchestrationRules";

/** The global rules; a workspace's override lives on that workspace's page. */
export function OrchestrationPage() {
  return <OrchestrationRulesEditor workspaceId={null} />;
}
