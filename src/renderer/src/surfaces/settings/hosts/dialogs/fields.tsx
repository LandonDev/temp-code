import { useEffect, useState } from "react";
import type { Capability } from "@server/shared/capabilities";
import type { RemoteAudience } from "@server/shared/contract-remote";
import { Input } from "@renderer/components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@renderer/components/ui/toggle-group";
import { Field } from "../../../../chrome/DialogField";
import { Tip } from "../../../../components/tip";
import { CopyButton } from "../CopyButton";

/** The pieces the key and pairing dialogs share. */

export const GRANTABLE: { cap: Capability; label: string }[] = [
  { cap: "operate", label: "Operate" },
  { cap: "approve", label: "Approve" },
  { cap: "admin", label: "Admin" },
];

const BOT_BLOCKED = "Bots never approve or administer";

/** "Read, operate": every key reads; the rest in the picker's order. */
export function grantText(caps: readonly Capability[]): string {
  return ["Read", ...GRANTABLE.filter(({ cap }) => caps.includes(cap)).map(({ label }) => label.toLowerCase())].join(", ");
}

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

/** What a key may do beyond reading: independent toggles. A bot is held to
 *  operate; the caps it may never hold are off, with the reason on hover. */
export function CapsPicker({
  value,
  audience,
  onChange,
  "aria-labelledby": labelledBy,
}: {
  value: Capability[];
  audience: RemoteAudience;
  onChange: (caps: Capability[]) => void;
  "aria-labelledby"?: string;
}) {
  return (
    <ToggleGroup
      multiple
      size="sm"
      value={value}
      onValueChange={(next) => onChange(GRANTABLE.map(({ cap }) => cap).filter((cap) => next.includes(cap)))}
      aria-labelledby={labelledBy}
      aria-label={labelledBy ? undefined : "Capabilities"}
    >
      {GRANTABLE.map(({ cap, label }) => {
        const blocked = audience === "mcp" && cap !== "operate";
        const item = (
          <ToggleGroupItem key={cap} value={cap} disabled={blocked}>
            {label}
          </ToggleGroupItem>
        );
        // A disabled button takes no pointer events: the tooltip rides a wrapper.
        return blocked ? (
          <Tip key={cap} label={BOT_BLOCKED}>
            <span className="inline-flex">{item}</span>
          </Tip>
        ) : (
          item
        );
      })}
    </ToggleGroup>
  );
}

/** A value shown once (a key, a link): a labelled field, read-only in the
 *  mono face, the copy button beside it. */
export function Secret({ label, value }: { label: string; value: string }) {
  return (
    <Field label={label}>
      <SecretValue label={label} value={value} />
    </Field>
  );
}

/** Secret's control: takes the id and hint wiring its `Field` hands it. */
function SecretValue({
  value,
  label,
  id,
  "aria-describedby": describedBy,
}: {
  value: string;
  label: string;
  id?: string;
  "aria-describedby"?: string;
}) {
  return (
    <div className="flex items-center gap-1">
      <Input
        id={id}
        aria-describedby={describedBy}
        readOnly
        value={value}
        spellCheck={false}
        onFocus={(e) => e.currentTarget.select()}
        className="flex-1 font-mono text-xs"
      />
      <CopyButton text={value} label={`Copy ${label.toLowerCase()}`} />
    </div>
  );
}
