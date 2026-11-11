import { openUrl } from "../../lib/native";
import { PageRow } from "../../components/page";
import { Button } from "../../components/ui/button";
import { Skeleton } from "../../components/ui/skeleton";

const PANE_URL = "x-apple.systempreferences:com.apple.preference.security?";

/**
 * One macOS grant on a settings page (Appshots, Computer use): muted
 * Granted, or amber Not granted with Grant… to its System Settings pane;
 * a skeleton while it is not yet known. Never a system prompt.
 */
export function PermissionRow({
  label,
  description,
  granted,
  pane,
}: {
  label: string;
  description: string;
  granted: boolean | null;
  /** the Privacy pane's anchor: Privacy_Accessibility, Privacy_ScreenCapture */
  pane: string;
}) {
  return (
    <PageRow title={label} description={description}>
      {granted === null ? (
        <Skeleton data-testid="permission-skeleton" className="h-3 w-16" />
      ) : granted ? (
        <span className="text-xs text-muted-foreground">Granted</span>
      ) : (
        <>
          <span className="text-xs text-warning">Not granted</span>
          {/* macOS prompts once; after a denial only System Settings can grant it. */}
          <Button variant="secondary" size="sm" aria-label={`Grant ${label} in System Settings`} onClick={() => void openUrl(PANE_URL + pane)}>
            Grant…
          </Button>
        </>
      )}
    </PageRow>
  );
}
