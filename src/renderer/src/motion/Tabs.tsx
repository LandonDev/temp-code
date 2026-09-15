import { motion, MotionConfig, useReducedMotion } from "motion/react";
import {
  createContext,
  useCallback,
  useContext,
  useId,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { SPRING_LAYOUT } from "../lib/ease";
import { cn } from "./cn";

/**
 * Tabs whose active indicator glides between triggers as one shared-layout
 * element. The layout id is minted per <Tabs> and projection is scoped to
 * the wrapper, so two tab strips on screen never trade indicators and a
 * scrolled container never replays its offset as movement. `glide` off
 * withdraws the shared layout id, so a strip mid-swap mounts no measuring
 * layout; `generation` mints a fresh id once it settles, so the indicator
 * never resumes from a snapshot of a chip that is gone.
 */

type Variant = "pill" | "underline" | "segment" | "soft";

type Ctx = {
  value: string;
  setValue: (v: string) => void;
  layoutId: string | undefined;
  variant: Variant;
};

const TabsCtx = createContext<Ctx | null>(null);

function useTabs(): Ctx {
  const ctx = useContext(TabsCtx);
  if (!ctx) throw new Error("Tabs.* must be used inside <Tabs>");
  return ctx;
}

export function Tabs({
  defaultValue,
  value,
  onValueChange,
  variant = "pill",
  glide = true,
  generation = 0,
  children,
  className,
}: {
  defaultValue?: string;
  value?: string;
  onValueChange?: (v: string) => void;
  variant?: Variant;
  glide?: boolean;
  generation?: number;
  children: ReactNode;
  className?: string;
}) {
  const [internal, setInternal] = useState(defaultValue ?? "");
  const id = useId();
  const layoutId = glide ? `${id}-${generation}` : undefined;
  const reduce = useReducedMotion();
  const controlled = value !== undefined;
  const current = controlled ? value : internal;
  const setValue = useCallback(
    (v: string) => {
      if (!controlled) setInternal(v);
      onValueChange?.(v);
    },
    [controlled, onValueChange],
  );
  const contextValue = useMemo(
    () => ({ value: current, setValue, layoutId, variant }),
    [current, layoutId, setValue, variant],
  );
  return (
    <MotionConfig transition={reduce ? { duration: 0 } : SPRING_LAYOUT}>
      <TabsCtx.Provider value={contextValue}>
        <motion.div layoutRoot className={className}>
          {children}
        </motion.div>
      </TabsCtx.Provider>
    </MotionConfig>
  );
}

const listClasses: Record<Variant, string> = {
  pill: "inline-flex items-center gap-1 rounded-full bg-content/6 p-1",
  underline: "inline-flex items-center gap-1 border-b border-content/10",
  segment: "inline-flex items-center gap-0 rounded-lg bg-content/6 p-0.5",
  soft: "inline-flex items-center gap-0.5",
};

export function TabsList({ children, className }: { children: ReactNode; className?: string }) {
  const { variant } = useTabs();
  return (
    <div role="tablist" className={cn(listClasses[variant], className)}>
      {children}
    </div>
  );
}

export function TabsTrigger({
  value,
  children,
  className,
  indicatorClassName,
}: {
  value: string;
  children: ReactNode;
  className?: string;
  indicatorClassName?: string;
}) {
  const { value: current, setValue, layoutId, variant } = useTabs();
  const active = current === value;

  if (variant === "underline") {
    return (
      <button
        type="button"
        role="tab"
        aria-selected={active}
        onClick={() => setValue(value)}
        className={cn(
          "relative isolate -mb-px inline-flex items-center px-3 pb-2 pt-1 text-[13px] font-medium transition-colors",
          active ? "text-content" : "text-content/50 hover:text-content",
          className,
        )}
      >
        {children}
        {active ? (
          <motion.span
            key={layoutId}
            layoutId={layoutId}
            className={cn("absolute -bottom-px left-0 right-0 h-px bg-content", indicatorClassName)}
          />
        ) : null}
      </button>
    );
  }

  if (variant === "soft") {
    // Quiet chip tabs: the active one carries a soft wash that swaps in
    // 120 ms, never a measured glide, so ⌘1..9 and ⌘] cost no layout.
    // Pointer taps commit on down; click is keyboard-only.
    return (
      <div className="relative">
        <button
          type="button"
          role="tab"
          aria-selected={active}
          onPointerDown={() => setValue(value)}
          onClick={() => {
            if (current !== value) setValue(value);
          }}
          className={cn(
            "relative inline-flex items-center justify-center whitespace-nowrap rounded-md px-2.5 py-1 text-[13px] outline-none transition-colors",
            active
              ? cn("bg-content/10 text-content", indicatorClassName)
              : "text-content/50 hover:bg-content/5 hover:text-content active:bg-content/10",
            className,
          )}
        >
          {children}
        </button>
      </div>
    );
  }

  const radius = variant === "pill" ? "rounded-full" : "rounded-md";
  return (
    <div className="relative">
      {active ? (
        <motion.span
          key={layoutId}
          layoutId={layoutId}
          style={{ borderRadius: variant === "pill" ? 9999 : 8 }}
          className={cn("absolute inset-0 bg-content", radius, indicatorClassName)}
        />
      ) : null}
      <button
        type="button"
        role="tab"
        aria-selected={active}
        onClick={() => setValue(value)}
        className={cn(
          "relative z-10 inline-flex items-center justify-center whitespace-nowrap bg-transparent px-3.5 py-1.5 text-[13px] font-medium outline-none transition-colors",
          active ? "text-background-base" : "text-content/50 hover:text-content",
          radius,
          className,
        )}
      >
        {children}
      </button>
    </div>
  );
}
