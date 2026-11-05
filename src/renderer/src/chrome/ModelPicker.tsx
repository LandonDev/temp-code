import { Check, ChevronDown, Search, Star } from "./icons";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { Button } from "../components/ui/button";
import { GroupInput, InputGroup } from "../components/ui/input";
import { Kbd } from "../components/ui/kbd";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/lazy-menus";
import { MENU_ROW } from "../components/ui/menu-row";
import { reveal } from "../components/ui/reveal";
import { Separator } from "../components/ui/separator";
import { ToggleGroup, ToggleGroupItem } from "../components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip";
import { cn } from "../lib/cn";
import { ROW_CONTROL } from "./composerRow";
import {
  allModels,
  coerceModelPickerTab,
  findModel,
  getModelSnapshot,
  getPickerVisibilitySnapshot,
  hasLiveCatalog,
  loadFavoriteModels,
  loadModelPickerTab,
  mergeModelSettings,
  modelsFor,
  resolveModel,
  saveFavoriteModels,
  saveModelPickerTab,
  showProviderInModelPicker,
  stepModelPickerTab,
  subscribeModels,
  subscribePickerVisibility,
  type AgentModel,
  type ModelPickerTab,
} from "../lib/models";
import {
  harnessUnavailableHint,
  hasProbedHarnessAvailability,
  isHarnessAvailable,
  probeHarnessAvailability,
  subscribeHarnessAvailability,
  getHarnessAvailabilitySnapshot,
} from "../lib/harness/availability";
import { refreshHarnessCatalogs } from "../lib/harness/registry";
import { refreshCatalog } from "../lib/tcserver/catalog";
import { registry } from "../lib/connection";
import { useAccounts } from "../stores/accounts";
import {
  HARNESSES,
  HARNESS_LABEL,
  HARNESS_TITLE,
  type HarnessId,
} from "../lib/session";
import { HarnessIcon } from "./HarnessIcon";
import { MOD } from "../lib/platform";
import { OPEN_MODEL_PICKER, type ModelPick, type ModelPickerRequest } from "../lib/modelPickerSignal";
import { effortLabel, ModelSettingsRows, useModelSettings } from "./ModelSettings";

type Props = {
  harness: HarnessId;
  model: string;
  /** The host whose catalog and CLIs the list shows; this machine when absent. */
  environmentId?: string;
  hotkeys?: boolean;
  onChange: (harness: HarnessId, model: string) => void;
  onClose?: () => void;
  /** The model's settings, edited at the menu's foot; absent shows the list alone. */
  settings?: {
    values: Record<string, string>;
    onChange: (settings: Record<string, string>) => void;
  };
  /** The composer's row under the box: 24px, 12px muted (`ROW_CONTROL`). */
  quiet?: boolean;
};

/** Search ladder across every provider: name prefix, name substring, then
 *  "provider name" substring; null is no match. */
export function matchRank(query: string, name: string, providerLabel: string): number | null {
  const q = query.toLowerCase();
  const n = name.toLowerCase();
  if (n.startsWith(q)) return 0;
  if (n.includes(q)) return 1;
  if (`${providerLabel} ${name}`.toLowerCase().includes(q)) return 3;
  return null;
}

export function ModelPicker({
  harness,
  model,
  environmentId,
  hotkeys = false,
  onChange,
  onClose,
  settings,
  quiet = false,
}: Props) {
  const catalogVersion = useSyncExternalStore(
    subscribeModels,
    getModelSnapshot,
    getModelSnapshot,
  );
  const availabilityVersion = useSyncExternalStore(
    subscribeHarnessAvailability,
    getHarnessAvailabilitySnapshot,
    getHarnessAvailabilitySnapshot,
  );
  const visibilityVersion = useSyncExternalStore(
    subscribePickerVisibility,
    getPickerVisibilitySnapshot,
    getPickerVisibilitySnapshot,
  );
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<ModelPickerTab>(() => loadModelPickerTab());
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [favorites, setFavorites] = useState(loadFavoriteModels);
  const search = useRef<HTMLInputElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const current = resolveModel(harness, model, environmentId);
  const modelSettings = useModelSettings(harness, model, environmentId);
  const effort = settings ? effortLabel(modelSettings, settings.values) : null;
  const tabRef = useRef(tab);
  const openRef = useRef(open);
  const lastHotkey = useRef(0);
  const searchRef = useRef(false);

  const available = (id: HarnessId) => isHarnessAvailable(id, environmentId);
  const shownInPicker = (id: HarnessId) =>
    showProviderInModelPicker(
      id,
      available(id),
      hasProbedHarnessAvailability(environmentId),
    );
  // A remote host's lists come over its own link; this machine's through its adapters.
  const remote = environmentId !== undefined && environmentId !== registry.primaryEnvironmentId;
  const refreshLists = (ids: HarnessId[]) =>
    remote ? refreshCatalog(environmentId).catch(() => undefined) : refreshHarnessCatalogs(ids);
  const pickerHarnesses = HARNESSES.filter(shownInPicker);
  const visibleTab = coerceModelPickerTab(tab, shownInPicker);
  if (visibleTab !== tab) {
    setTab(visibleTab);
  }
  tabRef.current = visibleTab;
  openRef.current = open;

  // A pick (or the hotkey closing it) hands focus back to the field through
  // onClose; Escape and an outside press return it to the trigger.
  const toField = useRef(false);
  const dismiss = (restore: boolean) => {
    toField.current = restore && !!onCloseRef.current;
    setOpen(false);
    if (toField.current) onCloseRef.current?.();
  };

  // The request that opened the picker, until it closes: its onPick runs once, after a pick.
  const requested = useRef<((pick: ModelPick) => void) | null>(null);

  const openPicker = (onPick: ((pick: ModelPick) => void) | null = null) => {
    toField.current = false;
    requested.current = onPick;
    setOpen(true);
  };

  // The failure card's "Continue on another model" opens the active composer's picker.
  useEffect(() => {
    if (!hotkeys) return;
    const onRequest = (event: Event) => openPicker((event as CustomEvent<ModelPickerRequest>).detail?.onPick ?? null);
    window.addEventListener(OPEN_MODEL_PICKER, onRequest);
    return () => window.removeEventListener(OPEN_MODEL_PICKER, onRequest);
  }, [hotkeys]);

  const togglePicker = () => {
    if (openRef.current) dismiss(true);
    else openPicker();
  };

  const toggleFromHotkey = () => {
    const now = performance.now();
    if (now - lastHotkey.current < 80) return;
    lastHotkey.current = now;
    togglePicker();
  };

  const selectTab = (next: ModelPickerTab) => {
    setTab(next);
    saveModelPickerTab(next);
  };

  useEffect(() => {
    if (!open) return;
    void probeHarnessAvailability({ environmentId });
    setTab(coerceModelPickerTab(loadModelPickerTab(), shownInPicker));
    setQuery("");
  }, [open]);

  const searching = query.trim().length > 0;

  useEffect(() => {
    if (!open) return;
    if (searching) {
      void refreshLists(pickerHarnesses);
      return;
    }
    if (visibleTab === "favorites") return;
    void refreshLists([visibleTab]);
    // pickerHarnesses is derived from the availability snapshot below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, visibleTab, searching, availabilityVersion]);

  useEffect(() => {
    const inBlockingUi = (target: EventTarget | null) => {
      if (!(target instanceof Element)) return false;
      if (target.closest(".monocode-terminal")) return true;
      return Boolean(
        target.closest(
          "[data-file-picker], [data-branch-picker], [data-command-popover], [data-access-picker], [data-add-menu], [data-slot=select-content]",
        ),
      );
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      const mod = e.metaKey || e.ctrlKey;
      if (
        hotkeys &&
        mod &&
        !e.altKey &&
        !e.shiftKey &&
        (e.key === "." || e.code === "Period")
      ) {
        if (!openRef.current && inBlockingUi(e.target)) return;
        e.preventDefault();
        e.stopPropagation();
        toggleFromHotkey();
        return;
      }
      if (!openRef.current) return;
      if (e.altKey || e.shiftKey) return;
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      if (inBlockingUi(e.target)) return;
      // Search spans every provider, so there is no tab to step.
      if (searchRef.current) return;
      e.preventDefault();
      e.stopPropagation();
      selectTab(
        stepModelPickerTab(
          tabRef.current,
          e.key === "ArrowLeft" ? -1 : 1,
          shownInPicker,
        ),
      );
    };

    const onMenu = () => {
      if (!hotkeys) return;
      if (inBlockingUi(document.activeElement)) return;
      toggleFromHotkey();
    };

    window.addEventListener("keydown", onKey, true);
    window.addEventListener("open_model_picker", onMenu);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("open_model_picker", onMenu);
    };
  }, [hotkeys]);

  searchRef.current = searching;

  // A maker's rows inside a harness (Meta's under Claude and Codex) ride an
  // API key: with none on the thread's host they are left out, so the tabs
  // show only what a send could reach (a Meta model over the subscription is
  // the Muse harness's own row).
  const { snapshot } = useAccounts(environmentId ?? registry.primaryEnvironmentId);
  const keyed = snapshot.providers.meta?.profiles.length > 0;
  const reachable = (item: AgentModel) => shownInPicker(item.harness) && (keyed || !item.vendor);
  const visible = useMemo(() => {
    const needle = query.trim();
    if (!needle) {
      return visibleTab === "favorites"
        ? favorites
            .map((id) => findModel(id))
            .filter(
              (item): item is AgentModel =>
                item != null && reachable(item),
            )
        : tabModels(visibleTab, environmentId).filter(reachable);
    }
    // Typing searches every shown provider: rank ladder, favorites first
    // within a rank, catalog order last.
    return allModels(environmentId)
      .filter(reachable)
      .flatMap((item, order) => {
        const rank = matchRank(
          needle,
          item.name,
          `${HARNESS_TITLE[item.harness]} ${HARNESS_LABEL[item.harness]}`,
        );
        if (rank == null) return [];
        return [{ item, rank: rank * 2 + (favorites.includes(item.id) ? 0 : 1), order }];
      })
      .sort((a, b) => a.rank - b.rank || a.order - b.order)
      .map((row) => row.item);
    // Catalog, install probes, and picker-visibility all feed this list:
    // catalogs land after mount, and hiding a provider must drop its favorites.
  }, [
    visibleTab,
    query,
    favorites,
    environmentId,
    keyed,
    catalogVersion,
    availabilityVersion,
    visibilityVersion,
  ]);

  useEffect(() => {
    if (!open) return;
    const index = visible.findIndex((item) => item.id === current.id);
    setActive(index >= 0 ? index : 0);
  }, [open, visibleTab, query, current.id]);

  useEffect(() => {
    setActive((i) =>
      visible.length === 0 ? 0 : Math.min(i, visible.length - 1),
    );
  }, [visible.length]);

  const pick = (item: AgentModel) => {
    if (!available(item.harness)) return;
    onChange(item.harness, item.id);
    const onPick = requested.current;
    requested.current = null;
    dismiss(true);
    onPick?.({ harness: item.harness, model: item.id, settings: mergeModelSettings(item, settings?.values) });
  };

  const toggleFavorite = (id: string) => {
    setFavorites((prev) => {
      const next = prev.includes(id)
        ? prev.filter((item) => item !== id)
        : [...prev, id];
      saveFavoriteModels(next);
      return next;
    });
  };

  const onSearchKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(visible.length - 1, i + 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const item = visible[active];
      if (item && available(item.harness)) pick(item);
      return;
    }
    const mod = e.metaKey || e.ctrlKey;
    if (mod && !e.altKey && !e.shiftKey && e.key >= "1" && e.key <= "9") {
      e.preventDefault();
      const item = visible[Number(e.key) - 1];
      if (item && available(item.harness)) pick(item);
    }
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) openPicker();
        else dismiss(false);
      }}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <Button
                  variant="ghost"
                  aria-label={`${HARNESS_TITLE[current.harness]} ${current.name}${effort ? ` ${effort}` : ""}`}
                  aria-keyshortcuts={`${MOD}.`}
                  size={quiet ? "xs" : "sm"}
                  // One recipe in every placement (ModelMark's): the logo 6px from the name,
                  // the effort 4px after it, the chevron 8px after the last word. Each gap is
                  // the following element's margin, so a word the composer hides takes its gap with it.
                  className={cn("min-w-0 shrink gap-0 px-2 font-normal", quiet && ROW_CONTROL)}
                />
              }
            />
          }
        >
          <HarnessIcon harness={current.harness} className="size-3.5 shrink-0" />
          {/* In the composer's row the words give way to the icon as the box narrows (ComposerBar). */}
          <span className={cn("ms-1.5 min-w-0 truncate @max-[9rem]/composer-bar:hidden", !quiet && "text-foreground")}>{current.name}</span>
          {effort ? <span className={cn("ms-1 shrink-0 @max-[23rem]/composer-bar:hidden", !quiet && "text-muted-foreground")}>{effort}</span> : null}
          <ChevronDown className="ms-2 size-3 shrink-0 text-muted-foreground" />
        </TooltipTrigger>
        <TooltipContent>
          Model <Kbd>{`${MOD}.`}</Kbd>
        </TooltipContent>
      </Tooltip>
      <PopoverContent
        side="top"
        align="start"
        initialFocus={search}
        finalFocus={() => !toField.current}
        aria-label="Model picker"
        data-model-picker
        className="w-80 gap-0 p-1"
      >
        {searching ? null : (
          <ToggleGroup
            spacing={0}
            size="sm"
            aria-label="Providers"
            value={[visibleTab]}
            onValueChange={(next: unknown[]) => {
              const tab = next[0] as ModelPickerTab | undefined;
              if (tab) selectTab(tab);
            }}
            className="mb-1 w-full"
          >
            <ProviderToggle value="favorites" title="Favorites">
              <Star fill={visibleTab === "favorites" ? "currentColor" : "none"} />
            </ProviderToggle>
            {pickerHarnesses.map((id) => (
              <ProviderToggle key={id} value={id} title={HARNESS_TITLE[id]}>
                <HarnessIcon harness={id} className="size-3.5" />
              </ProviderToggle>
            ))}
          </ToggleGroup>
        )}
        <InputGroup leading={<Search className="size-3.5" />} className="mb-1">
          <GroupInput
            ref={search}
            value={query}
            placeholder="Search models"
            aria-label="Search models"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onSearchKey}
          />
        </InputGroup>
        <ModelList
          available={available}
          models={visible}
          active={active}
          currentId={current.id}
          favorites={favorites}
          grouped={!searching && visibleTab !== "favorites"}
          emptyLabel={
            searching
              ? "No matching models"
              : visibleTab === "favorites"
                ? "No favorite models"
                : !available(visibleTab)
                  ? harnessUnavailableHint(visibleTab)
                  : visibleTab === "codex"
                    ? "Loading Codex models…"
                    : "No matching models"
          }
          onActive={setActive}
          onPick={pick}
          onToggleFavorite={toggleFavorite}
        />
        {settings && modelSettings.length > 0 ? (
          <>
            <Separator className="my-1" />
            <ModelSettingsRows
              harness={harness}
              model={model}
              environmentId={environmentId}
              values={settings.values}
              onChange={settings.onChange}
            />
          </>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

function ProviderToggle({ value, title, children }: { value: ModelPickerTab; title: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<ToggleGroupItem value={value} aria-label={title} className="flex-1" />}>{children}</TooltipTrigger>
      <TooltipContent>{title}</TooltipContent>
    </Tooltip>
  );
}

/** A harness tab's rows. Before its live catalog lands a tab whose built-in
 *  list is only a maker's rows (Codex) reads as loading, not as that list. */
function tabModels(harness: HarnessId, environmentId?: string): AgentModel[] {
  const models = ownThenVendor(modelsFor(harness, environmentId));
  return models.every((m) => m.vendor) && !hasLiveCatalog(harness, environmentId) ? [] : models;
}

/** A harness tab lists its own rows first, then a maker's (catalog `vendor`). */
function ownThenVendor(models: AgentModel[]): AgentModel[] {
  return models.some((m) => m.vendor) ? [...models.filter((m) => !m.vendor), ...models.filter((m) => m.vendor)] : models;
}

/** The heading over a maker's rows in a harness tab. */
const VENDOR_TITLE: Record<NonNullable<AgentModel["vendor"]>, string> = { meta: "Meta" };

/** The menu's list; exported for its static preview (ModelPicker.fixtures.tsx). */
export function ModelList({
  available,
  models,
  active,
  currentId,
  favorites,
  grouped,
  emptyLabel,
  onActive,
  onPick,
  onToggleFavorite,
}: {
  available: (id: HarnessId) => boolean;
  models: AgentModel[];
  active: number;
  currentId: string;
  favorites: string[];
  /** A harness tab: a maker's rows sit under its heading. */
  grouped: boolean;
  emptyLabel: string;
  onActive: (index: number) => void;
  onPick: (model: AgentModel) => void;
  onToggleFavorite: (id: string) => void;
}) {
  const activeRef = useRef<HTMLDivElement>(null);
  const headingId = useId();

  useEffect(() => {
    activeRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [active]);

  if (models.length === 0) {
    return <div className={cn("flex items-center text-muted-foreground", MENU_ROW)}>{emptyLabel}</div>;
  }

  return (
    <div className="max-h-[340px] min-h-0 overflow-x-hidden overflow-y-auto">
      <div role="listbox" aria-label="Models">
        {renderGroups(grouped, models, headingId, (item, index) => {
          const selected = item.id === currentId;
          const highlighted = index === active;
          const favorited = favorites.includes(item.id);
          const disabled = !available(item.harness);
          const shortcut = index < 9 && !disabled ? `${MOD}${index + 1}` : null;
          const row = (
            <div
              key={item.id}
              ref={highlighted ? activeRef : undefined}
              role="option"
              aria-selected={selected}
              aria-disabled={disabled}
              onMouseEnter={() => onActive(index)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                if (!disabled) onPick(item);
              }}
              className={cn(
                // MENU_ROW's box, its 4px of padding dropped so the 24px star keeps the row at 28px.
                "group/model flex cursor-default items-center rounded-lg", MENU_ROW, "py-0",
                disabled ? "text-muted-foreground opacity-60" : highlighted && "bg-muted",
              )}
            >
              {/* No row draws a glyph, so every label starts on one edge; a maker's mark is its group heading's. */}
              <span className="flex min-w-0 flex-1 items-baseline gap-1">
                <span className="min-w-0 truncate">{item.name}</span>
                {/* Out of its tab (search, favorites) a row names its harness: one model is offered under several. */}
                {grouped ? null : <span data-model-harness className="shrink-0 text-xs text-muted-foreground">{HARNESS_TITLE[item.harness]}</span>}
              </span>
              {selected ? <Check className="size-3.5 shrink-0" /> : null}
              {/* A favourite's star stays; any other row's waits on the shared hover reveal. */}
              <span className={cn("flex", !favorited && reveal("model"))}>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={favorited ? "Remove from favorites" : "Add to favorites"}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleFavorite(item.id);
                  }}
                  className={favorited ? "text-foreground" : "text-muted-foreground hover:text-foreground"}
                >
                  <Star fill={favorited ? "currentColor" : "none"} />
                </Button>
              </span>
              {shortcut ? (
                <Kbd size="sm" className="border-transparent bg-transparent text-muted-foreground">
                  {shortcut}
                </Kbd>
              ) : null}
            </div>
          );
          if (!disabled) return row;
          return (
            <Tooltip key={item.id}>
              <TooltipTrigger render={row} />
              <TooltipContent side="right">{harnessUnavailableHint(item.harness)}</TooltipContent>
            </Tooltip>
          );
        })}
      </div>
    </div>
  );
}

/** The rows in order; in a harness tab a maker's rows (they come last,
 *  `ownThenVendor`) sit in a group under its name. Indexes stay the flat
 *  list's, so the keys and the active row read one sequence. */
function renderGroups(
  grouped: boolean,
  models: AgentModel[],
  headingId: string,
  row: (item: AgentModel, index: number) => ReactNode,
): ReactNode {
  const split = grouped ? models.findIndex((m) => m.vendor) : -1;
  if (split < 0) return models.map(row);
  const vendor = models[split].vendor!;
  return (
    <>
      {models.slice(0, split).map(row)}
      <div role="group" aria-labelledby={headingId} data-vendor-group={vendor}>
        <div id={headingId} role="presentation" className="flex items-center gap-2 px-3 pt-2 pb-1 text-[11px] font-medium text-muted-foreground">
          <HarnessIcon harness={vendor} className="size-3 shrink-0" />
          {VENDOR_TITLE[vendor]}
        </div>
        {models.slice(split).map((item, i) => row(item, split + i))}
      </div>
    </>
  );
}
