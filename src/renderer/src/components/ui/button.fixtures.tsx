// Fixtures for `bun run ui:preview src/renderer/src/components/ui/button.tsx#Button`,
// one button each; `button.fixtures.tsx#ButtonGallery` draws every variant at
// every size in each state, and the split pairs. A static page cannot hover,
// so the held and open states stand in through data-pressed and aria-expanded
// (the raise lifts on aria-expanded as it does on hover).
import type { ComponentProps } from "react";
import { ChevronDown, Plus } from "../../chrome/icons";
import { Button } from "./button";

type Variant = NonNullable<ComponentProps<typeof Button>["variant"]>;
const VARIANTS: Variant[] = ["default", "secondary", "destructive", "ghost", "outline", "link"];

const STATES = [
  { name: "rest", props: {} },
  { name: "pressed", props: { "data-pressed": "" } },
  { name: "open", props: { "aria-expanded": true } },
  { name: "disabled", props: { disabled: true } },
] as const;

export default VARIANTS.flatMap((variant) =>
  STATES.map((state) => ({ name: `${variant}, ${state.name}`, props: { variant, children: "Save", ...state.props } })),
);

function Row({ variant, state }: { variant: Variant; state: (typeof STATES)[number] }) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-28 text-xs text-muted-foreground">
        {variant}, {state.name}
      </span>
      <Button variant={variant} {...state.props}>
        Save
      </Button>
      <Button variant={variant} size="sm" {...state.props}>
        Sync now
      </Button>
      <Button variant={variant} size="xs" {...state.props}>
        Allow
      </Button>
      <Button variant={variant} size="icon-sm" aria-label="Add" {...state.props}>
        <Plus />
      </Button>
      <Button variant={variant} size="icon-sm" rounded aria-label="Send" {...state.props}>
        <Plus />
      </Button>
    </div>
  );
}

export function ButtonGallery() {
  return (
    <div className="flex flex-col gap-3 p-4">
      {VARIANTS.flatMap((variant) => STATES.map((state) => <Row key={`${variant}-${state.name}`} variant={variant} state={state} />))}
      <div className="flex items-center gap-3 pt-2">
        <span className="w-28 text-xs text-muted-foreground">split pairs</span>
        <span className="flex">
          <Button size="sm" className="rounded-r-none">
            Commit
          </Button>
          <Button size="icon-sm" aria-label="Commit options" className="rounded-l-none border-l border-primary-foreground/15">
            <ChevronDown />
          </Button>
        </span>
        <span className="flex">
          <Button variant="secondary" size="xs" className="rounded-r-none">
            Continue
          </Button>
          <Button variant="secondary" size="icon-xs" aria-label="Continue on another model" className="rounded-l-none border-l border-border">
            <ChevronDown />
          </Button>
        </span>
      </div>
      <div className="flex w-72 pt-2">
        <Button className="w-full">Start build</Button>
      </div>
    </div>
  );
}
