import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { HarnessIcon } from "../../chrome/HarnessIcon";
import { PageRow, PageSection } from "../../components/page";
import { SettingSwitch } from "../../components/setting-switch";
import { Button } from "../../components/ui/button";
import { Skeleton } from "../../components/ui/skeleton";
import { Spinner } from "../../components/ui/spinner";
import {
  getHarnessAvailabilitySnapshot,
  harnessUnavailableHint,
  isHarnessAvailable,
  probeHarnessAvailability,
  subscribeHarnessAvailability,
} from "../../lib/harness/availability";
import { refreshHarnessCatalogs } from "../../lib/harness/registry";
import { isPickerProviderVisible, modelsFor, savePickerProviderVisible } from "../../lib/models";
import { HARNESSES, HARNESS_TITLE, type HarnessId } from "../../lib/session";
import { loadClaudeHooks, saveClaudeHooks } from "../../lib/settings";
import { probeDoctor, type Doctor, type DoctorRow } from "../../lib/tcserver/catalog";
import { registry } from "../../lib/connection";

export function ProvidersPage() {
  useSyncExternalStore(subscribeHarnessAvailability, getHarnessAvailabilitySnapshot, getHarnessAvailabilitySnapshot);
  const [doctor, setDoctor] = useState<Doctor | null>(null);
  const [claudeHooks, setClaudeHooks] = useState(loadClaudeHooks);

  const refreshDoctor = useCallback((force = false) => {
    void probeHarnessAvailability({ force });
    void probeDoctor(registry.primary().environmentId, { force })
      .then(setDoctor)
      .catch(() => setDoctor({}));
  }, []);

  useEffect(() => {
    refreshDoctor();
  }, [refreshDoctor]);

  return (
    <>
      <PageSection>
        {HARNESSES.map((harness) => (
          <ProviderRow
            key={harness}
            harness={harness}
            doctor={doctor ? (doctor[harness] ?? { found: false }) : undefined}
            onUpdated={(row) => {
              setDoctor((prev) => ({ ...(prev ?? {}), [harness]: row }));
              refreshDoctor(true);
            }}
          />
        ))}
      </PageSection>
      <PageSection title="Claude Code">
        <PageRow title="Run settings.json hooks" description="The hooks from your settings.json files run from the next turn.">
          <SettingSwitch
            label="Run settings.json hooks"
            on={claudeHooks}
            onChange={(on) => {
              saveClaudeHooks(on);
              setClaudeHooks(on);
            }}
          />
        </PageRow>
      </PageSection>
    </>
  );
}

/** "2.1.263 (Claude Code)" → "v2.1.263 (Claude Code)"; "codex-cli 0.153.4" stays as is. */
export function versionLabel(version: string): string {
  return /^\d/.test(version) ? `v${version}` : version;
}

/** Providers whose CLI the server knows how to update in place. */
const UPDATABLE: ReadonlySet<HarnessId> = new Set(["claude", "codex", "cursor"]);

function ProviderRow({
  harness,
  doctor,
  onUpdated,
}: {
  harness: HarnessId;
  /** undefined while the first probe runs */
  doctor: DoctorRow | undefined;
  onUpdated: (row: DoctorRow) => void;
}) {
  const title = HARNESS_TITLE[harness];
  const available = isHarnessAvailable(harness);
  const modelCount = modelsFor(harness).length;
  const [inPicker, setInPicker] = useState(() => isPickerProviderVisible(harness));
  const [updating, setUpdating] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);

  // The picker lists a CLI's models once its catalog is in.
  useEffect(() => {
    if (!available || modelCount > 0) return;
    void refreshHarnessCatalogs([harness]);
  }, [available, harness, modelCount]);

  const onUpdate = async () => {
    if (updating) return;
    setUpdating(true);
    setUpdateError(null);
    try {
      const row = await registry.primary().request<DoctorRow>("providers.update", { provider: harness });
      onUpdated(row);
      void refreshHarnessCatalogs([harness]);
    } catch (error) {
      setUpdateError(error instanceof Error ? error.message : String(error));
    } finally {
      setUpdating(false);
    }
  };

  const description =
    doctor === undefined ? (
      <Skeleton aria-label="Checking" className="mt-1 h-3 w-48" />
    ) : doctor.found ? (
      <>
        <span className="block">{doctor.version ? versionLabel(doctor.version) : "Installed"}</span>
        {doctor.path ? <span className="block truncate font-mono text-[11px]">{doctor.path}</span> : null}
        {doctor.error ? <span className="block text-warning">{doctor.error}</span> : null}
      </>
    ) : (
      // The hint already says it is not found and how to install it.
      harnessUnavailableHint(harness)
    );

  return (
    <PageRow
      media={<HarnessIcon harness={harness} className="size-4" />}
      title={title}
      description={description}
      error={updateError ? <span className="whitespace-pre-line">{updateError}</span> : undefined}
    >
      {doctor?.found && UPDATABLE.has(harness) ? (
        <Button variant="secondary" size="sm" onClick={() => void onUpdate()} disabled={updating}>
          {updating ? <Spinner className="size-3.5" /> : null}
          Update
        </Button>
      ) : null}
      {available ? (
        <>
          <span className="ml-2 text-xs text-muted-foreground">Show in picker</span>
          <SettingSwitch
            label={`Show ${title} in the model picker`}
            on={inPicker}
            onChange={(visible) => {
              savePickerProviderVisible(harness, visible);
              setInPicker(visible);
            }}
          />
        </>
      ) : null}
    </PageRow>
  );
}
