/* A9 (closing lines and code blocks): the transcript's icon buttons. */
import { useState, type ComponentProps, type ReactNode } from "react";
import { Button } from "@renderer/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip";
import { cn } from "@renderer/lib/cn";

/**
 * A ghost icon button with its name in a tooltip, for row and header
 * actions. `armed={false}` renders the bare button: a row whose actions
 * stay hidden until hover arms the tooltip on its first hover, so a long
 * settled transcript mounts no tooltip roots (and no per-mount ids in the
 * markup the parse cache compares).
 */
export function IconAction({
  label,
  children,
  className,
  armed = true,
  ...rest
}: Omit<ComponentProps<typeof Button>, "children"> & {
  label: string;
  children: ReactNode;
  armed?: boolean;
}) {
  const button = (
    <Button
      {...rest}
      variant="ghost"
      size="icon-xs"
      aria-label={label}
      className={cn("text-muted-foreground hover:text-foreground aria-expanded:text-foreground", className)}
    />
  );
  if (!armed) return <Button {...button.props}>{children}</Button>;
  return (
    <Tooltip>
      <TooltipTrigger render={button}>{children}</TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/** Arms a hover group's tooltips when the pointer first enters it. Not on
 *  focus: arming swaps the button's element, which would drop the focus;
 *  a keyboard reader has the button's name. */
export function useArmOnIntent(): [boolean, { onPointerEnter: () => void }] {
  const [armed, setArmed] = useState(false);
  return [armed, { onPointerEnter: () => setArmed(true) }];
}
