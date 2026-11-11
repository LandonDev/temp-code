import { useState } from "react";
import type { KeepAwakeStatusWire } from "@server/shared/contract-power";
import { ChoiceSelect } from "../../../components/choice-select";
import { Row } from "./Group";

type Mode = KeepAwakeStatusWire["mode"];

export const KEEP_AWAKE_OPTIONS: { value: Mode; label: string }[] = [
  { value: "while-working", label: "While threads work" },
  { value: "never", label: "Never" },
];

/** This Mac's display kept awake while a thread here or on a linked host is
 *  live (server/keepAwake.ts); "On now" while the hold is taken. */
export function KeepAwakeRow({
  status,
  onSet,
}: {
  status: KeepAwakeStatusWire;
  /** Resolves null once the change landed, else why it did not. */
  onSet: (mode: Mode) => Promise<string | null>;
}) {
  const [error, setError] = useState<string | null>(null);
  return (
    <Row title="Keep awake" description={status.holding ? "On now" : undefined} error={error} data-keep-awake={status.holding ? "holding" : "idle"}>
      <ChoiceSelect
        label="Keep this Mac awake"
        value={status.mode}
        options={KEEP_AWAKE_OPTIONS}
        className="w-44"
        onChange={(mode) => {
          setError(null);
          void onSet(mode).then(setError);
        }}
      />
    </Row>
  );
}
