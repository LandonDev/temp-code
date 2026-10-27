import { useCallback, useEffect } from "react";
import type { AppshotDestination } from "@server/shared/appshots";
import {
  refreshAppshotPermissions,
  setAppshotSettings,
  useAppshotPermissions,
  useAppshotSettings,
} from "../lib/appshots";
import { openUrl } from "../lib/native";
import { ChoiceSelect, type Choice } from "../components/choice-select";
import { PageRow, PageSection } from "../components/page";
import { SettingSwitch } from "../components/setting-switch";
import { Button } from "../components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import { Skeleton } from "../components/ui/skeleton";

const DESTINATIONS: Choice<AppshotDestination>[] = [
  { value: "automatic", label: "Automatic" },
  { value: "last-chat", label: "Last chat" },
  { value: "new-chat", label: "New chat" },
];

const PANE_URL = "x-apple.systempreferences:com.apple.preference.security?";
const POLL_MS = 5000;

/** Settings › Appshots: the capture switch, where a shot lands, and the two macOS grants it needs. */
export function AppshotsPage() {
  const settings = useAppshotSettings();
  const perms = useAppshotPermissions();

  // Grants flip in System Settings, outside our window: poll while the page
  // is open, and again the moment the window comes back.
  useEffect(() => {
    const tick = () => void refreshAppshotPermissions().catch(() => undefined);
    tick();
    const timer = window.setInterval(tick, POLL_MS);
    window.addEventListener("focus", tick);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", tick);
    };
  }, []);

  const prompt = useCallback(() => void refreshAppshotPermissions(true).catch(() => undefined), []);

  if (perms && !perms.available) {
    return (
      <Empty className="py-10">
        <EmptyHeader>
          <EmptyTitle>Appshots need macOS</EmptyTitle>
          <EmptyDescription>This build has no capture helper.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <>
      <PageSection>
        <PageRow title="Capture on double-⌘">
          <SettingSwitch
            label="Capture on double-⌘"
            on={settings.enabled}
            onChange={(on) => {
              setAppshotSettings({ enabled: on });
              // The hotkey monitor hears nothing until Accessibility is granted,
              // so turning the feature on asks for what is missing right away.
              if (on && perms && !(perms.screen && perms.ax)) prompt();
            }}
          />
        </PageRow>
        <PageRow title="Destination" description="Automatic uses the open chat, else a new one.">
          <ChoiceSelect
            label="Destination"
            value={settings.destination}
            options={DESTINATIONS}
            onChange={(destination) => setAppshotSettings({ destination })}
          />
        </PageRow>
        <PageRow title="Shutter sound">
          <SettingSwitch label="Shutter sound" on={settings.sound} onChange={(sound) => setAppshotSettings({ sound })} />
        </PageRow>
      </PageSection>

      <PageSection title="Permissions">
        <PermissionRow
          label="Screen Recording"
          description="Captures the window image."
          granted={perms ? perms.screen : null}
          pane="Privacy_ScreenCapture"
          />
        <PermissionRow
          label="Accessibility"
          description="Reads the window's text and hears the double-⌘."
          granted={perms ? perms.ax : null}
          pane="Privacy_Accessibility"
          />
      </PageSection>
    </>
  );
}

function PermissionRow({
  label,
  description,
  granted,
  pane,
}: {
  label: string;
  description: string;
  granted: boolean | null;
  pane: string;
}) {
  return (
    <PageRow title={label} description={description}>
      {granted === null ? (
        <Skeleton data-testid="permission-skeleton" className="h-3 w-16" />
      ) : granted ? (
        <span className="text-[12px] text-muted-foreground">Granted</span>
      ) : (
        <>
          <span className="text-[12px] text-warning">Not granted</span>
          {/* macOS prompts once; after a denial only System Settings can grant it. */}
          <Button variant="secondary" size="sm" aria-label={`Grant ${label} in System Settings`} onClick={() => void openUrl(PANE_URL + pane)}>
            Grant…
          </Button>
        </>
      )}
    </PageRow>
  );
}
