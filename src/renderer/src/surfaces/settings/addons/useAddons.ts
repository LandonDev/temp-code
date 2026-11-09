import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import type { AddonGrantView } from "@shared/contract-addonGrants";
import type { AddonRow, AddonsList, AddonStatus, StoreHome } from "@shared/contract-addons";
import type { Link } from "../../../lib/connection";
import { useHostRead } from "../../../lib/connection/hostRead";
import { useEnvironmentStatuses } from "../../../lib/connection/status";

export interface AddonsPageData {
  /** sorted by name, then the global row before a workspace's */
  addons: AddonRow[];
  status: Record<string, AddonStatus>;
  /** the every-workspace scope's home */
  home: StoreHome;
  /** undefined while addons.grant.list waits; null when it failed (`grantsError` says why) */
  grants: Map<string, AddonGrantView> | null | undefined;
}

export const byNameThenScope = <T extends { name: string; workspaceId: string | null }>(a: T, b: T): number =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : a.workspaceId === b.workspaceId ? 0 : a.workspaceId === null ? -1 : b.workspaceId === null ? 1 : a.workspaceId < b.workspaceId ? -1 : 1;

type GrantsAnswer = { grants: AddonGrantView[] };

/**
 * A host link coming or going may move where the copy can be written: the
 * page asks again so its home note says so (RulesEditor's rule). Skips the
 * first run, the page's own first read.
 */
export function useAskAgainOnLinks(retry: () => void): void {
  const statuses = useEnvironmentStatuses();
  const linkStates = [...statuses.values()].map((s) => s.transport).join();
  const seen = useRef(linkStates);
  useEffect(() => {
    if (seen.current === linkStates) return;
    seen.current = linkStates;
    retry();
  }, [linkStates, retry]);
}

/**
 * Settings → Add-ons' reads: `addons.list` (the rows, this host's status of
 * each and the home), and apart from it `addons.grant.list`, so a grant the
 * page has not read is never shown as nothing saved. The `addons`,
 * `addon-status` and `addon-grants` pushes fold into what was read; a push
 * before the first answer is dropped, since the answer holds it. Each push
 * computes from a ref written before `set`, so two pushes before a render
 * both land.
 */
export function useAddonsPage(link: Link) {
  const main = useHostRead<AddonsList>(link, () => link.request<AddonsList>("addons.list", { workspaceId: null }));
  const grantsRead = useHostRead<GrantsAnswer>(link, () => link.request<GrantsAnswer>("addons.grant.list", {}));
  const mainRef = useRef(main.value);
  const grantsRef = useRef(grantsRead.value);
  useLayoutEffect(() => {
    mainRef.current = main.value;
  }, [main.value]);
  useLayoutEffect(() => {
    grantsRef.current = grantsRead.value;
  }, [grantsRead.value]);

  const { set: setMain, retry } = main;
  const { set: setGrants } = grantsRead;
  const putMain = useCallback(
    (next: AddonsList) => {
      mainRef.current = next;
      setMain(next);
    },
    [setMain],
  );

  useEffect(
    () =>
      link.onPush((push) => {
        if (push.push === "addons") {
          if (mainRef.current) putMain({ ...mainRef.current, addons: push.addons });
        } else if (push.push === "addon-status") {
          // The whole map (storeRpc's storePushes), so a removed add-on's status leaves with it.
          if (mainRef.current) putMain({ ...mainRef.current, status: push.status });
        } else if (push.push === "addon-grants") {
          if (grantsRef.current) {
            grantsRef.current = { grants: push.grants };
            setGrants(grantsRef.current);
          }
        }
      }),
    [link, putMain, setGrants],
  );
  useAskAgainOnLinks(retry);

  const replaceRow = useCallback(
    (row: AddonRow) => {
      const cur = mainRef.current;
      if (!cur) return;
      const rest = cur.addons.filter((r) => r.id !== row.id);
      putMain({ ...cur, addons: [...rest, row] });
    },
    [putMain],
  );
  const dropRow = useCallback(
    (id: string) => {
      const cur = mainRef.current;
      if (cur) putMain({ ...cur, addons: cur.addons.filter((r) => r.id !== id) });
    },
    [putMain],
  );

  const value = main.value;
  const grantList = grantsRead.value?.grants;
  const grantsFailed = grantsRead.value === undefined && grantsRead.error !== null;
  const grants = useMemo(() => (grantList ? new Map(grantList.map((g) => [g.addonId, g])) : grantsFailed ? null : undefined), [grantList, grantsFailed]);
  const addons = useMemo(() => (value ? [...value.addons].sort(byNameThenScope) : []), [value]);
  const data: AddonsPageData | undefined = value ? { addons, status: value.status, home: value.home, grants } : undefined;
  return {
    data,
    error: main.error,
    retry,
    grantsError: grantsFailed ? grantsRead.error : null,
    retryGrants: grantsRead.retry,
    replaceRow,
    dropRow,
  };
}
