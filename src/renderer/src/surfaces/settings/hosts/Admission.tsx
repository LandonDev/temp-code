import { useEffect, useState } from "react";
import type { AdmissionState } from "@server/shared/contract-admission";
import { Button } from "../../../components/ui/button";
import { Skeleton } from "../../../components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../../components/ui/tooltip";
import { errorText } from "../../../chrome/ConfirmDialog";
import { registry, useEnvironmentStatus } from "../../../lib/connection";
import { CommitField } from "./CommitField";
import { Facts } from "./Facts";
import { Row } from "./Group";
import { budgetParts, runningParts } from "./parts";

/**
 * A host's Running threads row (src/main/server/admission.ts): how many
 * harnesses run of its cap and how many wait, the memory the default cap is
 * sized from, and the cap (pinned here, or the host's default as the
 * field's placeholder). A host not connected, or one that does not answer
 * admission.get (an older build), has no row.
 */

const POLL_MS = 5000;

export function HostAdmission({ environmentId }: { environmentId: string }) {
  const status = useEnvironmentStatus(environmentId);
  const connected = status.transport === "open";
  const admin = status.lastHello?.caps.includes("admin") ?? false;
  const [state, setState] = useState<AdmissionState | null | "none">(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!connected) return;
    let live = true;
    const load = async (): Promise<void> => {
      try {
        const next = await registry.link(environmentId)!.request<AdmissionState>("admission.get", {});
        if (live) setState(next);
      } catch {
        if (live) setState("none");
      }
    };
    void load();
    const t = window.setInterval(() => void load(), POLL_MS);
    return () => {
      live = false;
      window.clearInterval(t);
    };
  }, [connected, environmentId]);

  const pin = async (cap: number | null): Promise<void> => {
    setError(null);
    try {
      setState(await registry.link(environmentId)!.request<AdmissionState>("admission.set", { cap }));
    } catch (err) {
      setError(errorText(err));
    }
  };

  if (!connected || state === "none") return null;
  if (!state) {
    return (
      <Row title="Running threads" data-admission={environmentId}>
        <Skeleton className="h-8 w-20" />
      </Row>
    );
  }
  return (
    <Row
      title="Running threads"
      data-admission={environmentId}
      description={
        // What the default cap is sized from is a hover away, not a line.
        <Tooltip>
          <TooltipTrigger render={<span tabIndex={0} className="cursor-default rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring" />}>
            <Facts parts={runningParts(state)} />
          </TooltipTrigger>
          <TooltipContent>
            <Facts parts={budgetParts(state)} />
          </TooltipContent>
        </Tooltip>
      }
      error={error}
    >
      {state.pinned !== null && admin ? (
        <Button variant="link" size="xs" className="text-muted-foreground" onClick={() => void pin(null)}>
          Use default
        </Button>
      ) : null}
      <CommitField
        kind="int"
        aria-label="Running cap"
        value={state.pinned}
        min={1}
        max={10_000}
        placeholder={String(state.default)}
        disabled={!admin}
        onCommit={(cap) => cap !== null && void pin(cap)}
      />
    </Row>
  );
}
