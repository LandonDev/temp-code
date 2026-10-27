import { useEffect, useState } from "react";
import type { Capability } from "@server/shared/capabilities";
import type { RemoteAudience } from "@server/shared/contract-remote";
import { INPUT_CLASS } from "../../../settingsBits";
import { CopyButton } from "../CopyButton";

/** The pieces the key and pairing dialogs share. */

export const GRANTABLE: { cap: Capability; label: string }[] = [
  { cap: "operate", label: "Operate" },
  { cap: "approve", label: "Approve" },
  { cap: "admin", label: "Admin" },
];

export const FIELD = "flex flex-col gap-1.5 text-[12px] text-content/50";

export function Countdown({ prefix, at }: { prefix: string; at: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  const left = Math.max(0, Math.round((at - now) / 1000));
  return (
    <>
      {prefix} {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}
    </>
  );
}

export function CapsPicker({
  value,
  audience,
  onChange,
}: {
  value: Capability[];
  audience: RemoteAudience;
  onChange: (caps: Capability[]) => void;
}) {
  return (
    <div className="flex gap-0.5 rounded-md border border-content/10 p-0.5 text-[12px]" role="group" aria-label="Capabilities">
      {GRANTABLE.map(({ cap, label }) => {
        const on = value.includes(cap);
        const blocked = audience === "mcp" && cap !== "operate";
        return (
          <button
            key={cap}
            type="button"
            role="checkbox"
            aria-checked={on}
            disabled={blocked}
            title={blocked ? "Bots never approve or administer" : undefined}
            onClick={() => onChange(on ? value.filter((c) => c !== cap) : [...value, cap])}
            className={`pressable rounded-[4px] px-3 py-1 disabled:cursor-default disabled:opacity-30 ${
              on ? "bg-content/10 text-content" : "text-content/50 hover:text-content"
            }`}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

export function Secret({ label, value }: { label: string; value: string }) {
  return (
    <div className={FIELD}>
      {label}
      <div className="flex items-center gap-1">
        <code className={`${INPUT_CLASS} min-w-0 flex-1 select-all break-all`}>{value}</code>
        <CopyButton text={value} label={`Copy ${label.toLowerCase()}`} />
      </div>
    </div>
  );
}
