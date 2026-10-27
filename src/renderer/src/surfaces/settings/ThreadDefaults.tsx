import { PlanSettingsEditor } from "../../chrome/PlanSettingsFields";
import { ThreadDefaultsEditor } from "../../chrome/ThreadDefaultsDialog";
import { ClaudeHooksSection, PickerSection } from "./PickerSettings";

/** What a new thread starts with, what a finished plan's build does, and what the model picker lists. */
export function ThreadDefaultsPage() {
  return (
    <>
      <ThreadDefaultsEditor workspaceId={null} />
      <PlanSettingsEditor />
      <PickerSection />
      <ClaudeHooksSection />
    </>
  );
}
