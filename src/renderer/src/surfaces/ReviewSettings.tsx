import { useEffect, useState } from "react";
import type { ReviewSettings } from "@server/shared/review";
import { ReviewFields, ReviewSkeleton, loadReviewScope, saveReviewSettings, type ReviewScope } from "../chrome/ReviewFields";
import { PageSection } from "../components/page";
import { Button } from "../components/ui/button";
import { registry } from "../lib/connection";

/**
 * Settings › Reviews: the global set a project follows unless its own
 * dialog overrides it. Saves on every change; the project dialog is where
 * an override is made and removed.
 */
export function ReviewsPage() {
  // Global app settings belong to this machine.
  const environmentId = registry.primary().environmentId;
  const [scope, setScope] = useState<ReviewScope | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Bumped by Retry after a load that failed for good.
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setError(null);
    loadReviewScope(environmentId, null)
      .then((s) => live && setScope(s))
      .catch((err) => live && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      live = false;
    };
  }, [environmentId, attempt]);

  const change = (next: ReviewSettings) => {
    setScope((s) => (s ? { ...s, global: next, settings: next, source: "global" } : s));
    setError(null);
    saveReviewSettings(environmentId, null, next).catch((err) =>
      setError(err instanceof Error ? err.message : String(err)),
    );
  };

  return (
    <PageSection
      action={
        !scope && error ? (
          <Button variant="ghost" size="sm" onClick={() => setAttempt((n) => n + 1)}>
            Retry
          </Button>
        ) : null
      }
    >
      {scope ? <ReviewFields value={scope.settings} onChange={change} environmentId={environmentId} /> : error ? null : <ReviewSkeleton />}
      {error ? <p className="pt-2 text-xs text-destructive">{error}</p> : null}
    </PageSection>
  );
}
