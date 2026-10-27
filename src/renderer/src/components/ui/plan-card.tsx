import { CircleDashed, Minus, MoreHorizontal } from "@renderer/chrome/icons";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@renderer/lib/cn";
import { Button } from "./button";
import { Kbd, KbdGroup } from "./kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip";

/**
 * A plan an agent asks to run: a title, a line of description, the to-dos
 * (three shown, the rest behind "N more"), Approve with ⌘⏎, and an
 * optional countdown to auto-approve that one click cancels.
 */
export type PlanStep = { label: string; done?: boolean };

const REVEAL = "duration-(--dur-slow) ease-(--ease-out) motion-reduce:transition-none";

function PlanStepRow({ step, first, collapsible, expanded }: { step: PlanStep; first: boolean; collapsible: boolean; expanded: boolean }) {
  const row = (
    <div className={cn("flex items-center gap-2.5 text-[13px]", !first && "pt-1.5")}>
      <CircleDashed aria-hidden className={cn("size-4 shrink-0", step.done ? "text-foreground" : "text-muted-foreground/50")} />
      <span className={cn("truncate", step.done ? "text-foreground" : "text-muted-foreground")}>{step.label}</span>
    </div>
  );
  if (!collapsible) return <li>{row}</li>;
  return (
    <li inert={!expanded} className={cn("grid transition-[grid-template-rows]", REVEAL)} style={{ gridTemplateRows: expanded ? "1fr" : "0fr" }}>
      <div className="min-h-0 overflow-hidden">{row}</div>
    </li>
  );
}

const SWAP = "col-start-1 row-start-1 transition-[opacity,translate,filter] duration-(--dur-base) ease-(--ease-out) motion-reduce:transition-none motion-reduce:translate-y-0 motion-reduce:blur-none";

function MoreToggle({ hidden, expanded, onToggle }: { hidden: number; expanded: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      className="flex w-full items-center gap-2.5 rounded-md text-start text-[13px] text-muted-foreground outline-none transition-[color] duration-(--dur-fast) hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
    >
      <span aria-hidden className="grid size-4 shrink-0 place-items-center text-muted-foreground/50">
        <MoreHorizontal className={cn("size-4", SWAP, expanded ? "scale-90 opacity-0" : "scale-100 opacity-100")} />
        <Minus className={cn("size-4", SWAP, expanded ? "scale-100 opacity-100" : "scale-90 opacity-0")} />
      </span>
      <span className="grid">
        <span className={cn(SWAP, expanded ? "-translate-y-1 opacity-0 blur-[2px]" : "translate-y-0 opacity-100 blur-none")} aria-hidden={expanded}>
          {hidden} more
        </span>
        <span className={cn(SWAP, expanded ? "translate-y-0 opacity-100 blur-none" : "translate-y-1 opacity-0 blur-[2px]")} aria-hidden={!expanded}>
          Show less
        </span>
      </span>
    </button>
  );
}

const BANDS = ["text-success", "text-warning", "text-destructive"] as const;

function CountdownRing({ left, total, onCancel }: { left: number; total: number; onCancel?: () => void }) {
  const RADIUS = 7;
  const circumference = 2 * Math.PI * RADIUS;
  const remaining = total <= 0 ? 0 : Math.max(0, Math.min(1, left / total));
  const band = BANDS[Math.min(BANDS.length - 1, Math.floor((1 - remaining) * BANDS.length))];
  const ring = (
    <svg aria-hidden viewBox="0 0 18 18" className={cn("size-[18px] -rotate-90 transition-colors duration-(--dur-slow) ease-(--ease-out) motion-reduce:transition-none", band)}>
      <circle cx="9" cy="9" r={RADIUS} fill="none" stroke="currentColor" strokeWidth="1.5" opacity={0.25} />
      <circle cx="9" cy="9" r={RADIUS} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeDasharray={circumference} strokeDashoffset={circumference * (1 - remaining)} className="transition-[stroke-dashoffset] duration-(--dur-drawer) ease-(--ease-out) motion-reduce:transition-none" />
    </svg>
  );
  if (!onCancel) return <span className="grid shrink-0">{ring}</span>;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label="Cancel auto approval"
            onClick={onCancel}
            className="relative grid size-[18px] shrink-0 place-items-center rounded-full outline-none transition-[scale] duration-(--dur-base) ease-(--ease-out) after:absolute after:-inset-[11px] after:content-[''] hover:opacity-70 focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.96] motion-reduce:transition-none"
          />
        }
      >
        {ring}
      </TooltipTrigger>
      <TooltipContent>Cancel</TooltipContent>
    </Tooltip>
  );
}

export function PlanCard({
  icon,
  title,
  description,
  steps,
  visibleSteps = 3,
  autoApproveIn,
  onApprove,
  onAutoApprove,
  onCancelAutoApprove,
  onView,
  approveLabel = "Approve",
  viewLabel = "View plan",
  hideLabel = "Hide plan",
  className,
}: {
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  steps: Array<PlanStep>;
  visibleSteps?: number;
  autoApproveIn?: number;
  onApprove?: () => void;
  onAutoApprove?: () => void;
  onCancelAutoApprove?: () => void;
  onView?: () => void;
  approveLabel?: string;
  viewLabel?: string;
  hideLabel?: string;
  className?: string;
}) {
  const hidden = Math.max(0, steps.length - visibleSteps);
  const [expanded, setExpanded] = useState(false);
  const [left, setLeft] = useState(autoApproveIn ?? 0);
  const [clock, setClock] = useState<"running" | "leaving" | "off">("running");

  const approve = useRef(onApprove);
  approve.current = onApprove;
  const expire = useRef(onAutoApprove ?? onApprove);
  expire.current = onAutoApprove ?? onApprove;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return;
      event.preventDefault();
      approve.current?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (autoApproveIn === undefined || clock !== "running") return;
    setLeft(autoApproveIn);
    const id = window.setInterval(() => {
      setLeft((seconds) => {
        if (seconds > 1) return seconds - 1;
        window.clearInterval(id);
        expire.current?.();
        return 0;
      });
    }, 1000);
    return () => window.clearInterval(id);
  }, [autoApproveIn, clock]);

  const view = () => {
    if (hidden === 0) {
      onView?.();
      return;
    }
    if (!expanded) onView?.();
    setExpanded((open) => !open);
  };

  const cancelAutoApprove = () => {
    setClock("leaving");
    onCancelAutoApprove?.();
    window.setTimeout(() => setClock("off"), 200);
  };

  return (
    <div data-slot="plan-card" className={cn("w-full max-w-lg rounded-xl border border-border bg-card p-4 text-card-foreground", className)}>
      <div className="flex items-center gap-2.5">
        {icon ? <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground [&_svg]:size-4">{icon}</span> : null}
        <h3 className="text-sm font-semibold tracking-tight">{title}</h3>
      </div>
      {description ? <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">{description}</p> : null}

      <div className="mt-3 rounded-lg bg-muted/60 p-3">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-medium">To-dos</span>
          <span className="ms-auto pe-1 text-xs text-muted-foreground tabular-nums">{steps.length}</span>
        </div>
        <ul className="mt-2">
          {steps.map((step, index) => (
            <PlanStepRow key={step.label} step={step} first={index === 0} collapsible={index >= visibleSteps} expanded={expanded} />
          ))}
          {hidden > 0 ? (
            <li className="pt-1.5">
              <MoreToggle hidden={hidden} expanded={expanded} onToggle={() => setExpanded((open) => !open)} />
            </li>
          ) : null}
        </ul>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {autoApproveIn === undefined || clock === "off" ? null : (
          <span aria-live="polite" className={cn("flex items-center gap-2 text-xs text-muted-foreground transition-[opacity,translate] duration-(--dur-base) ease-(--ease-out) motion-reduce:transition-none", clock === "leaving" && "translate-y-1 opacity-0")}>
            <CountdownRing left={left} total={autoApproveIn} onCancel={clock === "running" ? cancelAutoApprove : undefined} />
            <span>
              Auto-approve in <span className="tabular-nums">{left}</span>s
            </span>
          </span>
        )}
        <span className="ms-auto flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={view} aria-expanded={hidden > 0 ? expanded : undefined}>
            {hidden > 0 && expanded ? hideLabel : viewLabel}
          </Button>
          <Button size="sm" onClick={onApprove}>
            {approveLabel}
            <KbdGroup className="ms-0.5">
              <Kbd size="sm" className="justify-center border-transparent bg-background/15 text-current">
                ⌘
              </Kbd>
              <Kbd size="sm" className="justify-center border-transparent bg-background/15 text-current">
                ⏎
              </Kbd>
            </KbdGroup>
          </Button>
        </span>
      </div>
    </div>
  );
}
