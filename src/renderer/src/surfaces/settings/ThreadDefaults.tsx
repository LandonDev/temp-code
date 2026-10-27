import { PlanSettingsEditor } from "../../chrome/PlanSettingsFields";
import { ThreadDefaultsEditor } from "../../chrome/ThreadDefaultsDialog";

/** What a new thread starts with, and what a finished plan's build does. */
export function ThreadDefaultsPage() {
  return (
    <>
      <ThreadDefaultsEditor workspaceId={null} />
      <PlanSettingsEditor />
    </>
  );
}
