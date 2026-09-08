import { useCallback, useEffect } from "react";
import type { AppshotDestination } from "@server/shared/appshots";
import {
  refreshAppshotPermissions,
  setAppshotSettings,
  useAppshotPermissions,
  useAppshotSettings,
} from "../lib/appshots";
import { openUrl } from "../lib/native";
import { Heading, Row, SecondaryButton, Segmented, Toggle } from "./settingsBits";

const DESTINATIONS: { value: AppshotDestination; label: string }[] = [
  { value: "automatic", label: "Automatic" },
  { value: "last-chat", label: "Last chat" },
  { value: "new-chat", label: "New chat" },
];

const PANE_URL = "x-apple.systempreferences:com.apple.preference.security?";
const POLL_MS = 5000;

/** Settings › Appshots: the capture toggle, where a shot lands, and the two macOS grants it needs. */
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

  const prompt = useCallback(
    () => void refreshAppshotPermissions(true).catch(() => undefined),
    [],
  );

  if (perms && !perms.available) {
    return (
      <Row
        label="Not available"
        description="Appshots need macOS and the capture helper this build ships with."
      />
    );
  }

  return (
    <>
      <Row label="Capture on double-⌘">
        <Toggle
          label="Capture on double-⌘"
          on={settings.enabled}
          onChange={(on) => {
            setAppshotSettings({ enabled: on });
            // The hotkey monitor hears nothing until Accessibility is granted,
            // so turning the feature on asks for what is missing right away.
            if (on && perms && !(perms.screen && perms.ax)) prompt();
          }}
        />
      </Row>
      <Row
        label="Destination"
        description="Automatic uses the open chat, or a new one when none is open."
      >
        <Segmented
          label="Destination"
          value={settings.destination}
          options={DESTINATIONS}
          onChange={(destination) => setAppshotSettings({ destination })}
        />
      </Row>
      <Row label="Shutter sound">
        <Toggle
          label="Shutter sound"
          on={settings.sound}
          onChange={(sound) => setAppshotSettings({ sound })}
        />
      </Row>

      <Heading title="Permissions" />
      <PermissionRow
        label="Screen Recording"
        description="Captures the window image."
        granted={perms ? perms.screen : null}
        pane="Privacy_ScreenCapture"
        onPrompt={prompt}
      />
      <PermissionRow
        label="Accessibility"
        description="Reads the window's text and hears the double-⌘."
        granted={perms ? perms.ax : null}
        pane="Privacy_Accessibility"
        onPrompt={prompt}
      />
    </>
  );
}

function PermissionRow({
  label,
  description,
  granted,
  pane,
  onPrompt,
}: {
  label: string;
  description: string;
  granted: boolean | null;
  pane: string;
  onPrompt: () => void;
}) {
  return (
    <Row label={label} description={description}>
      <span className="flex items-center gap-1.5 text-[12px] text-content/70">
        {granted === null ? (
          <span className="text-content/35">Checking…</span>
        ) : (
          <>
            <span
              aria-hidden
              className={`size-1.5 rounded-full ${granted ? "bg-success" : "bg-warning"}`}
            />
            {granted ? "Granted" : "Not granted"}
          </>
        )}
      </span>
      {granted === false ? (
        <>
          <SecondaryButton onClick={onPrompt}>Grant</SecondaryButton>
          <SecondaryButton onClick={() => void openUrl(PANE_URL + pane)}>
            System Settings
          </SecondaryButton>
        </>
      ) : null}
    </Row>
  );
}
