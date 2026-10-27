import { useEffect, useState } from "react";
import type { ReviewSettings } from "@server/shared/review";
import { ReviewFields, ReviewSkeleton, loadReviewScope, saveReviewSettings, type ReviewScope } from "../chrome/ReviewFields";
import { PageSection } from "../components/page";
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
  useEffect(() => {
    let live = true;
    loadReviewScope(environmentId, null)
      .then((s) => live && setScope(s))
      .catch((err) => live && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      live = false;
    };
  }, [environmentId]);

  const change = (next: ReviewSettings) => {
    setScope((s) => (s ? { ...s, global: next, settings: next, source: "global" } : s));
    setError(null);
    saveReviewSettings(environmentId, null, next).catch((err) =>
      setError(err instanceof Error ? err.message : String(err)),
    );
  };

  return (
    <PageSection>
      {scope ? <ReviewFields value={scope.settings} onChange={change} environmentId={environmentId} /> : error ? null : <ReviewSkeleton />}
      {error ? <p className="pt-2 text-[12px] text-destructive">{error}</p> : null}
    </PageSection>
  );
}
