import { useEffect, useState, useSyncExternalStore } from "react";
import { HarnessIcon } from "../../chrome/HarnessIcon";
import { PageError, PageRow, PageSection } from "../../components/page";
import { BusyLabel, Button } from "../../components/ui/button";
import { Skeleton } from "../../components/ui/skeleton";
import {
  getHarnessAvailabilitySnapshot,
  harnessInstallCommand,
  isHarnessAvailable,
  probeHarnessAvailability,
  subscribeHarnessAvailability,
} from "../../lib/harness/availability";
import { refreshHarnessCatalogs } from "../../lib/harness/registry";
import { modelsFor } from "../../lib/models";
import { HARNESSES, HARNESS_TITLE, type HarnessId } from "../../lib/session";
import { probeDoctor, type DoctorRow } from "../../lib/tcserver/catalog";
import { registry } from "../../lib/connection";
import { useHostRead } from "../../lib/connection/hostRead";
import { CopyButton } from "./hosts/CopyButton";

/** The agent CLIs this machine can run: one row each, its version and one
 *  control. What the picker lists and the hooks live on Thread defaults. */
export function ProvidersPage() {
  useSyncExternalStore(subscribeHarnessAvailability, getHarnessAvailabilitySnapshot, getHarnessAvailabilitySnapshot);
  const link = registry.primary();
  // Never a row made up from a failure: no answer is the section's error and Retry, not "Not installed".
  const doctor = useHostRead(link, () => probeDoctor(link.environmentId));

  useEffect(() => {
    void probeHarnessAvailability();
  }, []);

  const refreshDoctor = () => {
    void probeHarnessAvailability({ force: true });
    void probeDoctor(link.environmentId, { force: true }).then(doctor.set, () => {});
  };

  return (
    <PageSection>
      {doctor.error && !doctor.value ? (
        <PageError
          action={
            <Button variant="ghost" size="sm" onClick={doctor.retry}>
              Retry
            </Button>
          }
        >
          {doctor.error}
        </PageError>
      ) : (
        HARNESSES.map((harness) => (
          <ProviderRow
            key={harness}
            harness={harness}
            doctor={doctor.value ? (doctor.value[harness] ?? { found: false }) : undefined}
            onUpdated={(row) => {
              doctor.set({ ...(doctor.value ?? {}), [harness]: row });
              refreshDoctor();
            }}
          />
        ))
      )}
    </PageSection>
  );
}

/** "2.1.263 (Claude Code)" → "v2.1.263": the row's title already names the
 *  CLI. "codex-cli 0.153.4" stays as is. */
export function versionLabel(version: string): string {
  const bare = version.replace(/\s*\([^)]*\)\s*$/, "");
  return /^\d/.test(bare) ? `v${bare}` : bare;
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
        {doctor.error ? <span className="block text-warning">{doctor.error}</span> : null}
      </>
    ) : (
      "Not installed"
    );
  const install = doctor && !doctor.found ? harnessInstallCommand(harness) : null;

  return (
    <PageRow
      media={<HarnessIcon harness={harness} className="size-4" />}
      title={title}
      description={description}
      error={updateError ? <span className="whitespace-pre-line">{updateError}</span> : undefined}
    >
      {doctor?.found && UPDATABLE.has(harness) ? (
        <Button variant="secondary" size="sm" onClick={() => void onUpdate()} disabled={updating}>
          <BusyLabel busy={updating} label="Update" />
        </Button>
      ) : install ? (
        <CopyButton text={install} label="Copy install command" />
      ) : null}
    </PageRow>
  );
}
