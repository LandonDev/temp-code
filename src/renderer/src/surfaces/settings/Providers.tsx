import {
  useCallback,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";
import { HarnessIcon } from "../../chrome/HarnessIcon";
import {
  getHarnessAvailabilitySnapshot,
  harnessUnavailableHint,
  isHarnessAvailable,
  probeHarnessAvailability,
  subscribeHarnessAvailability,
} from "../../lib/harness/availability";
import { refreshHarnessCatalogs } from "../../lib/harness/registry";
import {
  defaultModelId,
  getModelSnapshot,
  isPickerProviderVisible,
  loadDefaultModels,
  loadLastModelChoice,
  modelsFor,
  resolveModel,
  saveDefaultModel,
  saveLastModelChoice,
  savePickerProviderVisible,
  subscribeModels,
} from "../../lib/models";
import { HARNESSES, HARNESS_TITLE, type HarnessId } from "../../lib/session";
import { probeDoctor, type Doctor, type DoctorRow } from "../../lib/tcserver/catalog";
import { registry } from "../../lib/connection";
import {
  Row,
  Select,
  SecondaryButton,
  Toggle,
} from "../settingsBits";
import { MatrixSpinner } from "../threads/bits";

export function ProvidersPage() {
  useSyncExternalStore(subscribeModels, getModelSnapshot, getModelSnapshot);
  useSyncExternalStore(
    subscribeHarnessAvailability,
    getHarnessAvailabilitySnapshot,
    getHarnessAvailabilitySnapshot,
  );
  const [choice, setChoice] = useState(loadLastModelChoice);
  const [defaultModels, setDefaultModels] = useState(loadDefaultModels);
  const [doctor, setDoctor] = useState<Doctor | null>(null);

  const refreshDoctor = useCallback((force = false) => {
    void probeHarnessAvailability({ force });
    void probeDoctor(registry.primary().environmentId, { force })
      .then(setDoctor)
      .catch(() => setDoctor({}));
  }, []);

  useEffect(() => {
    refreshDoctor();
  }, [refreshDoctor]);

  const onModelChange = (harness: HarnessId, model: string) => {
    saveDefaultModel(harness, model);
    setDefaultModels((prev) => ({ ...prev, [harness]: model }));
    if (choice?.harness === harness) {
      saveLastModelChoice(harness, model);
      setChoice({ harness, model });
    }
  };

  const onDefault = (harness: HarnessId, model: string) => {
    saveLastModelChoice(harness, model);
    setDefaultModels((prev) => ({ ...prev, [harness]: model }));
    setChoice({ harness, model });
  };

  return (
    <>
      {HARNESSES.map((harness) => (
        <ProviderRow
          key={harness}
          harness={harness}
          doctor={doctor ? (doctor[harness] ?? { found: false }) : undefined}
          onUpdated={(row) => {
            setDoctor((prev) => ({ ...(prev ?? {}), [harness]: row }));
            refreshDoctor(true);
          }}
          selectedModel={
            defaultModels[harness] ??
            (choice?.harness === harness
              ? choice.model
              : defaultModelId(harness))
          }
          isDefault={choice?.harness === harness}
          onDefault={onDefault}
          onModelChange={onModelChange}
        />
      ))}
    </>
  );
}

/** Providers whose CLI the server knows how to update in place. */
/** "2.1.263 (Claude Code)" → "v2.1.263 (Claude Code)"; "codex-cli 0.153.4" stays as is. */
function versionLabel(version: string): string {
  return /^\d/.test(version) ? `v${version}` : version;
}

const UPDATABLE: ReadonlySet<HarnessId> = new Set(["claude", "codex", "cursor"]);

function ProviderRow({
  harness,
  doctor,
  onUpdated,
  selectedModel,
  isDefault,
  onDefault,
  onModelChange,
}: {
  harness: HarnessId;
  /** undefined while the first probe runs */
  doctor: DoctorRow | undefined;
  onUpdated: (row: DoctorRow) => void;
  selectedModel: string;
  isDefault: boolean;
  onDefault: (harness: HarnessId, model: string) => void;
  onModelChange: (harness: HarnessId, model: string) => void;
}) {
  const models = modelsFor(harness);
  const available = isHarnessAvailable(harness);
  const current =
    models.length > 0 ? resolveModel(harness, selectedModel) : null;
  const [inPicker, setInPicker] = useState(() =>
    isPickerProviderVisible(harness),
  );
  const [updating, setUpdating] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);

  useEffect(() => {
    if (!available || models.length > 0) return;
    void refreshHarnessCatalogs([harness]);
  }, [available, harness, models.length]);

  const onPickerVisible = (visible: boolean) => {
    savePickerProviderVisible(harness, visible);
    setInPicker(visible);
  };

  const onUpdate = async () => {
    if (updating) return;
    setUpdating(true);
    setUpdateError(null);
    try {
      const row = await registry.primary().request<DoctorRow>("providers.update", {
        provider: harness,
      });
      onUpdated(row);
      void refreshHarnessCatalogs([harness]);
    } catch (error) {
      setUpdateError(error instanceof Error ? error.message : String(error));
    } finally {
      setUpdating(false);
    }
  };

  const health =
    doctor === undefined ? (
      <span className="text-content/40">Checking…</span>
    ) : doctor.found ? (
      <>
        <span className="flex items-center gap-1.5">
          <span
            aria-hidden
            className={`size-1.5 rounded-full ${doctor.error ? "bg-warning" : "bg-success"}`}
          />
          {doctor.version ? versionLabel(doctor.version) : "Installed"}
          {models.length > 0 ? (
            <span className="text-content/40 tabular-nums">
              · {models.length} {models.length === 1 ? "model" : "models"}
            </span>
          ) : null}
        </span>
        {doctor.path ? (
          <span className="block truncate font-mono text-[11px] text-content/40">
            {doctor.path}
          </span>
        ) : null}
        {doctor.error ? (
          <span className="block text-warning">{doctor.error}</span>
        ) : null}
      </>
    ) : (
      <span className="flex items-center gap-1.5">
        <span aria-hidden className="size-1.5 rounded-full bg-danger" />
        {harnessUnavailableHint(harness)}
      </span>
    );

  return (
    <Row
      label={
        <span className="flex items-center gap-2">
          <HarnessIcon harness={harness} className="size-4 shrink-0" />
          {HARNESS_TITLE[harness]}
        </span>
      }
      description={
        <>
          {health}
          {updateError ? (
            <span className="block whitespace-pre-line text-danger">
              {updateError}
            </span>
          ) : null}
        </>
      }
    >
      {doctor?.found && UPDATABLE.has(harness) ? (
        <SecondaryButton onClick={() => void onUpdate()} disabled={updating}>
          {updating ? <MatrixSpinner cell={1.5} /> : null}
          Update
        </SecondaryButton>
      ) : null}
      {current ? (
        <Select
          label={`${HARNESS_TITLE[harness]} model`}
          value={current.id}
          onChange={(next) => onModelChange(harness, next)}
          options={models.map((item) => ({
            value: item.id,
            label: item.name,
          }))}
        />
      ) : null}
      <SecondaryButton
        onClick={() => current && onDefault(harness, current.id)}
        disabled={isDefault || !current}
      >
        {isDefault ? "Default" : "Use by default"}
      </SecondaryButton>
      {available ? (
        <div className="flex items-center gap-2">
          <span className="text-[12px] text-content/50">Show in picker</span>
          <Toggle
            label={`Show ${HARNESS_TITLE[harness]} in the model picker`}
            on={inPicker}
            onChange={onPickerVisible}
          />
        </div>
      ) : null}
    </Row>
  );
}
