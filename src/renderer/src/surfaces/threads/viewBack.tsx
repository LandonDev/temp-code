import { createContext, useContext, useLayoutEffect } from "react";
import { Button } from "../../components/ui/button";
import { Kbd } from "../../components/ui/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../components/ui/tooltip";
import { ChevronLeft } from "../../chrome/icons";

/**
 * Back to the master board, for a child opened in the board's place
 * (master/ChildPane.tsx). A board-type child's view draws its own 36px
 * header (SplitShell's): that header claims Back and leads with it, and
 * ChildPane's own bar steps aside, so the pane has one header and the title
 * once. A chat child, a board-type child whose board has nothing yet, and
 * every child while its rows load keep ChildPane's bar.
 */
export type ViewBack = {
  onBack: () => void;
  /** A view header took Back (true) or let it go (false). */
  claim: (claimed: boolean) => void;
};

export const ViewBackContext = createContext<ViewBack | null>(null);

/** The ghost Back control, in ChildPane's bar or leading a view's header. */
export function BackButton({ onBack }: { onBack: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<Button variant="ghost" size="xs" onClick={onBack} />}>
        <ChevronLeft />
        Back
      </TooltipTrigger>
      <TooltipContent>
        Back to the board <Kbd size="sm">Esc</Kbd>
      </TooltipContent>
    </Tooltip>
  );
}

/** A view header's hold on Back: the onBack to draw while it is mounted
 *  inside a child pane, null anywhere else. Claimed before paint, so the
 *  pane's bar and this header never show together. */
export function useViewBack(): (() => void) | null {
  const back = useContext(ViewBackContext);
  useLayoutEffect(() => {
    if (!back) return;
    back.claim(true);
    return () => back.claim(false);
  }, [back]);
  return back?.onBack ?? null;
}
