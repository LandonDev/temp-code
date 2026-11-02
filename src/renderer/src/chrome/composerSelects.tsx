import { useRef } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip";
import { PICKER_RUNTIME_MODES, RUNTIME_MODE_HINT, RUNTIME_MODE_LABEL, shownRuntimeMode, type RuntimeMode } from "../lib/session";
import type { ThreadType } from "../lib/tcserver/types";
import { THREAD_HINTS, THREAD_LABELS, THREAD_TYPES } from "../surfaces/threads/threadTypes";
import { TypeGlyph } from "../surfaces/threads/TypeGlyph";
import { ACCESS_ICONS, AccessValue, accessTriggerClass, type AccessPickerProps } from "./AccessPicker";
import { ROW_SELECT_TRIGGER, type RowSelectProps } from "./ModelSettings";
import { THREAD_TYPE_TRIGGER, ThreadTypeValue, type ThreadTypeChipProps } from "./ThreadTypeChip";

/**
 * The composer's selects on Base UI's select, in the select chunk
 * (surfaces/chunks.ts `selectChunk`, components/select-body.ts). Their
 * light wrappers (AccessPicker, ThreadTypeChip, ModelSettings' RowSelect)
 * draw the same trigger until this lands; `defaultOpen` opens one whose
 * cold trigger was clicked.
 */

type Opens = { defaultOpen?: boolean };

const ACCESS_ITEMS = PICKER_RUNTIME_MODES.map((mode) => ({ value: mode, label: RUNTIME_MODE_LABEL[mode] }));

export function AccessPickerSelect({ value: stored, onChange, onClose, quiet = false, defaultOpen }: AccessPickerProps & Opens) {
  const value = shownRuntimeMode(stored);
  const toField = useRef(false);
  return (
    <Select
      items={ACCESS_ITEMS}
      value={value}
      defaultOpen={defaultOpen}
      onValueChange={(next) => {
        if (next !== null && next !== value) onChange(next as RuntimeMode);
      }}
      onOpenChange={(open, details) => {
        toField.current = !open && details.reason === "item-press" && !!onClose;
        if (toField.current) onClose?.();
      }}
    >
      <Tooltip>
        <TooltipTrigger
          render={<SelectTrigger size="sm" aria-label={`Permission mode: ${RUNTIME_MODE_LABEL[value]}`} className={accessTriggerClass(quiet)} />}
        >
          <SelectValue>
            <AccessValue value={value} />
          </SelectValue>
        </TooltipTrigger>
        <TooltipContent>Permission mode: {RUNTIME_MODE_LABEL[value]}</TooltipContent>
      </Tooltip>
      {/* After a pick the composer takes the focus back itself, so the trigger must not. */}
      <SelectContent
        side="top"
        align="end"
        alignItemWithTrigger={false}
        data-access-picker
        finalFocus={() => !toField.current}
        className="w-72 p-1"
      >
        {PICKER_RUNTIME_MODES.map((mode) => {
          const ModeIcon = ACCESS_ICONS[mode];
          return (
            <SelectItem key={mode} value={mode} label={RUNTIME_MODE_LABEL[mode]} className="items-start py-1.5">
              <ModeIcon className="mt-0.5 size-3.5 text-muted-foreground" />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span>{RUNTIME_MODE_LABEL[mode]}</span>
                <span className="whitespace-normal text-xs text-muted-foreground">{RUNTIME_MODE_HINT[mode]}</span>
              </span>
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}

const TYPE_ITEMS = THREAD_TYPES.map((type) => ({ value: type, label: THREAD_LABELS[type] }));

export function ThreadTypeSelect({ value, onChange, onClose, defaultOpen }: ThreadTypeChipProps & Opens) {
  return (
    <Select
      items={TYPE_ITEMS}
      value={value}
      defaultOpen={defaultOpen}
      onValueChange={(next) => {
        if (next !== null && next !== value) onChange(next as ThreadType);
      }}
      onOpenChange={(open) => {
        if (!open) onClose?.();
      }}
    >
      <SelectTrigger size="sm" aria-label="Thread type" data-thread-type-picker className={THREAD_TYPE_TRIGGER}>
        <SelectValue>
          <ThreadTypeValue value={value} />
        </SelectValue>
      </SelectTrigger>
      {/* The composer takes the focus back itself, so the trigger must not. */}
      <SelectContent align="start" data-thread-type-picker finalFocus={onClose ? false : undefined} className="w-72 p-1">
        {THREAD_TYPES.map((type) => (
          <SelectItem key={type} value={type} label={THREAD_LABELS[type]} className="items-start py-1.5">
            <TypeGlyph type={type} className="mt-0.5 size-3.5" />
            <span className="flex min-w-0 flex-col gap-0.5">
              <span>{THREAD_LABELS[type]}</span>
              <span className="whitespace-normal text-xs text-muted-foreground">{THREAD_HINTS[type]}</span>
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function SettingSelect({ label, value, options, onChange, defaultOpen }: RowSelectProps & Opens) {
  return (
    <Select
      items={options}
      value={value}
      defaultOpen={defaultOpen}
      onValueChange={(next) => {
        if (next !== null && next !== value) onChange(next as string);
      }}
    >
      <SelectTrigger size="sm" aria-label={label} className={ROW_SELECT_TRIGGER}>
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
