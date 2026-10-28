import { useMemo, useSyncExternalStore, type ReactNode } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Switch } from "../components/ui/switch";
import { getModelSnapshot, resolveModel, subscribeModels, type ModelSetting } from "../lib/models";
import type { HarnessId } from "../lib/session";
import { speedChoices, speedOf, withSpeed, type Speed } from "../lib/speed";

type Props = {
  harness: HarnessId;
  model: string;
  /** The host whose catalog names the model's settings; this machine when absent. */
  environmentId?: string;
  values: Record<string, string>;
  onChange: (settings: Record<string, string>) => void;
};

/** Settings in the order the rows stand; speed tiers fold into one row. */
const ORDER = ["effort", "context", "variant", "agent", "reasoning", "thinking"];
const SPEED_IDS = new Set(["fast", "ultrafast"]);

/** The current model's settings, sorted, from the live catalog. */
export function useModelSettings(harness: HarnessId, model: string, environmentId?: string): ModelSetting[] {
  const version = useSyncExternalStore(subscribeModels, getModelSnapshot, getModelSnapshot);
  return useMemo(() => {
    void version;
    const list = resolveModel(harness, model, environmentId).settings ?? [];
    const rank = (s: ModelSetting) => (ORDER.indexOf(s.id) < 0 ? 99 : ORDER.indexOf(s.id));
    return [...list].sort((a, b) => rank(a) - rank(b));
  }, [version, environmentId, harness, model]);
}

/** The label of the effort the next turn runs at, for the model button. */
export function effortLabel(settings: readonly ModelSetting[], values: Record<string, string>): string | null {
  const effort = settings.find((s) => s.id === "effort");
  if (!effort) return null;
  const value = values.effort ?? effort.value;
  return effort.options.find((o) => o.value === value)?.label ?? null;
}

/**
 * The model menu's foot: one 32px row per setting of the current model,
 * the label on the left and its control on the right. Effort, Context,
 * Speed when the model carries a tier, then any other setting a harness's
 * catalog sends. How full the window is lives in the composer's context
 * meter, not here.
 */
export function ModelSettingsRows({ harness, model, environmentId, values, onChange }: Props) {
  const settings = useModelSettings(harness, model, environmentId);
  const speeds = speedChoices(settings);
  if (settings.length === 0) return null;
  const set = (id: string, value: string) => onChange({ ...values, [id]: value });
  const rows = settings.filter((s) => !SPEED_IDS.has(s.id));
  return (
    <div data-model-settings-rows className="flex flex-col">
      {rows.map((setting) => (
        <SettingRow key={setting.id} label={setting.label}>
          {setting.kind === "toggle" ? (
            <Switch
              aria-label={setting.label}
              checked={(values[setting.id] ?? setting.value) === "true"}
              onCheckedChange={(on) => set(setting.id, on ? "true" : "false")}
            />
          ) : (
            <RowSelect
              label={setting.label}
              value={values[setting.id] ?? setting.value}
              options={setting.options}
              onChange={(value) => set(setting.id, value)}
            />
          )}
        </SettingRow>
      ))}
      {speeds.length ? (
        <SettingRow label="Speed">
          <RowSelect
            label="Speed"
            value={speedOf(values)}
            options={speeds}
            onChange={(speed) => onChange(withSpeed(values, speed as Speed, speeds))}
          />
        </SettingRow>
      ) : null}
    </div>
  );
}

function SettingRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex h-8 items-center gap-2 px-2">
      <span className="text-[13px] text-muted-foreground">{label}</span>
      <span className="ms-auto flex items-center">{children}</span>
    </div>
  );
}

function RowSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <Select
      items={options}
      value={value}
      onValueChange={(next) => {
        if (next !== null && next !== value) onChange(next as string);
      }}
    >
      <SelectTrigger size="sm" aria-label={label} className="border-transparent hover:bg-foreground/7 data-popup-open:bg-foreground/7 [&>svg]:size-3">
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="end" className="min-w-28 p-1">
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
