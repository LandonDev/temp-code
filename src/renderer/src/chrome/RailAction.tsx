import type { IconComponent } from "./icons";

type Props = {
  label: string;
  icon: IconComponent;
  onClick?: () => void;
  active?: boolean;
  dot?: boolean;
  shortcut?: string;
  ariaLabel?: string;
};

const ROW =
  "pressable relative flex h-7 w-full items-center gap-2 rounded-md px-2 text-left disabled:cursor-default disabled:opacity-40";
const TONE = {
  active: "bg-content/10 text-content",
  idle: "text-content/50 hover:bg-content/5 hover:text-content",
};

/** A left-rail row: an icon, a 12px label and an optional dot or shortcut. */
export function RailAction({ label, icon: Icon, onClick, active = false, dot = false, shortcut, ariaLabel }: Props) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      aria-label={ariaLabel ?? label}
      className={`${ROW} ${active ? TONE.active : TONE.idle}`}
    >
      <Icon className="size-3.5 shrink-0" strokeWidth={1.75} />
      <span className="min-w-0 flex-1 truncate text-[12px] leading-none">{label}</span>
      {dot ? (
        <span aria-hidden className="size-2 shrink-0 rounded-full bg-accent" />
      ) : shortcut ? (
        <span aria-hidden className="shrink-0 text-[11px] text-content/40">
          {shortcut}
        </span>
      ) : null}
    </button>
  );
}

/** The search row shares the action row's shape; it only reads as a field by its label. */
export function RailSearch(props: Omit<Props, "dot">) {
  return <RailAction {...props} />;
}
