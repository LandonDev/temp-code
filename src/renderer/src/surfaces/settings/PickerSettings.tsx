import { useState } from "react";
import { HarnessIcon } from "../../chrome/HarnessIcon";
import { Button } from "../../components/ui/button";
import { PageError, PageRow, PageRowsSkeleton, PageSection } from "../../components/page";
import { SettingSwitch } from "../../components/setting-switch";
import { registry } from "../../lib/connection";
import { useHostRead } from "../../lib/connection/hostRead";
import { readHarnessAvailability } from "../../lib/harness/availability";
import { isPickerProviderVisible, savePickerProviderVisible } from "../../lib/models";
import { HARNESSES, HARNESS_TITLE, type HarnessId } from "../../lib/session";
import { loadClaudeHooks, saveClaudeHooks } from "../../lib/settings";

/** Which installed CLIs the model picker lists, on Settings › Thread defaults. */
export function PickerSection() {
  const link = registry.primary();
  // The page's read (docs/DESIGN.md "A page…"): a failure says so with Retry, never "no CLI installed".
  const read = useHostRead(link, () => readHarnessAvailability({ environmentId: link.environmentId }));
  const availability = read.value;
  if (!availability && read.error) {
    return (
      <PageSection
        title="Model picker"
        action={
          <Button variant="ghost" size="sm" onClick={read.retry}>
            Retry
          </Button>
        }
      >
        <PageError>{read.error}</PageError>
      </PageSection>
    );
  }
  // Its rows in their shape until the host answers, so the sections under it never move down.
  if (!availability) {
    return (
      <PageSection title="Model picker">
        <PageRowsSkeleton rows={2} media control="switch" />
      </PageSection>
    );
  }
  const installed = HARNESSES.filter((harness) => availability[harness]);
  if (installed.length === 0) return null;
  return (
    <PageSection title="Model picker">
      {installed.map((harness) => (
        <PickerRow key={harness} harness={harness} />
      ))}
    </PageSection>
  );
}

function PickerRow({ harness }: { harness: HarnessId }) {
  const title = HARNESS_TITLE[harness];
  const [visible, setVisible] = useState(() => isPickerProviderVisible(harness));
  return (
    <PageRow media={<HarnessIcon harness={harness} className="size-4" />} title={title}>
      <SettingSwitch
        label={`Show ${title} in the model picker`}
        on={visible}
        onChange={(next) => {
          savePickerProviderVisible(harness, next);
          setVisible(next);
        }}
      />
    </PageRow>
  );
}

/** Whether Claude threads run the hooks from the person's settings.json files. */
export function ClaudeHooksSection() {
  const [on, setOn] = useState(loadClaudeHooks);
  return (
    <PageSection title="Claude Code">
      <PageRow title="settings.json hooks" description="The hooks from your settings.json files run from the next turn.">
        <SettingSwitch
          label="settings.json hooks"
          on={on}
          onChange={(next) => {
            saveClaudeHooks(next);
            setOn(next);
          }}
        />
      </PageRow>
    </PageSection>
  );
}
