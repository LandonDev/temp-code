import { useEffect, useState } from "react";
import { MAX_RUNNING_LIMIT } from "@server/shared/threadCap";
import { registry } from "../lib/connection";
import { saveThreadCap, useThreadCap } from "../lib/tcserver/threadCap";
import { Input, Row } from "./settingsBits";

/**
 * Settings → General: the host's running cap (threads.maxRunning). A
 * thread that opted into the queue (a master's child, or `queue: true`)
 * waits as Queued past this many root threads in a turn and starts when
 * a slot frees; 0 is no limit. The field commits on blur or Enter.
 */
export function ThreadCapRow() {
  const environmentId = registry.primary().environmentId;
  const cap = useThreadCap(environmentId);
  const [error, setError] = useState<string | null>(null);
  if (cap === undefined) return null;
  const commit = (n: number) => {
    setError(null);
    saveThreadCap(environmentId, n).catch((err) => setError(err instanceof Error ? err.message : String(err)));
  };
  return (
    <Row
      label="Run at most this many threads at once"
      description={error ?? "A queued thread starts when a slot frees. 0 is no limit."}
    >
      <CapField value={cap} onCommit={commit} />
    </Row>
  );
}

function CapField({ value, onCommit }: { value: number; onCommit: (n: number) => void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = () => {
    const n = Number(text.trim());
    if (Number.isInteger(n) && n >= 0 && n <= MAX_RUNNING_LIMIT && n !== value) onCommit(n);
    else setText(String(value));
  };
  return (
    <Input
      aria-label="Threads at once"
      inputMode="numeric"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") setText(String(value));
      }}
      className="w-12 text-right tabular-nums"
    />
  );
}
