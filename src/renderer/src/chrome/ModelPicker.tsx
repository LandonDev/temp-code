import { Check, ChevronDown, Search, Star } from "./icons";
import {
  useEffect,
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
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/popover";
import { ScrollArea } from "../components/ui/scroll-area";
import { Separator } from "../components/ui/separator";
import { ToggleGroup, ToggleGroupItem } from "../components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip";
import { cn } from "../lib/cn";
import {
  allModels,
  coerceModelPickerTab,
  findModel,
  getModelSnapshot,
  getPickerVisibilitySnapshot,
  loadFavoriteModels,
  loadModelPickerTab,
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
import {
  HARNESSES,
  HARNESS_LABEL,
  HARNESS_TITLE,
  type HarnessId,
} from "../lib/session";
import { HarnessIcon } from "./HarnessIcon";
import { MOD } from "../lib/platform";
import { OPEN_MODEL_PICKER } from "../lib/modelPickerSignal";
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

  const openPicker = () => {
    toField.current = false;
    setOpen(true);
  };

  // The failure card's "Pick another model" opens the active composer's picker.
  useEffect(() => {
    if (!hotkeys) return;
    const onRequest = () => openPicker();
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

  const visible = useMemo(() => {
    const needle = query.trim();
    if (!needle) {
      return visibleTab === "favorites"
        ? favorites
            .map((id) => findModel(id))
            .filter(
              (item): item is AgentModel =>
                item != null && shownInPicker(item.harness),
            )
        : modelsFor(visibleTab, environmentId);
    }
    // Typing searches every shown provider: rank ladder, favorites first
    // within a rank, catalog order last.
    return allModels(environmentId)
      .filter((item) => shownInPicker(item.harness))
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
    dismiss(true);
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
                  size="sm"
                  aria-label={`${HARNESS_TITLE[current.harness]} ${current.name}${effort ? ` ${effort}` : ""}`}
                  aria-keyshortcuts={`${MOD}.`}
                  className="min-w-0 shrink gap-1.5 px-2 font-normal"
                />
              }
            />
          }
        >
          <HarnessIcon harness={current.harness} className="size-3.5 shrink-0" />
          {/* In the composer's bar the words give way to the icon as the box narrows (ComposerBar). */}
          <span className="min-w-0 truncate text-foreground @max-[13rem]/composer-bar:hidden">{current.name}</span>
          {effort ? <span className="ms-1 shrink-0 text-muted-foreground @max-[24rem]/composer-bar:hidden">{effort}</span> : null}
          <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
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

function ModelList({
  available,
  models,
  active,
  currentId,
  favorites,
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
  emptyLabel: string;
  onActive: (index: number) => void;
  onPick: (model: AgentModel) => void;
  onToggleFavorite: (id: string) => void;
}) {
  const activeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    activeRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [active]);

  if (models.length === 0) {
    return <div className="px-2 py-1.5 text-xs text-muted-foreground">{emptyLabel}</div>;
  }

  return (
    <ScrollArea className="min-h-0 [&>[data-slot=scroll-area-viewport]]:max-h-[340px]">
      <div role="listbox" aria-label="Models">
        {models.map((item, index) => {
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
                "group/model flex h-7 cursor-default items-center gap-1.5 rounded-md px-2 text-[13px]",
                disabled ? "text-muted-foreground opacity-60" : highlighted && "bg-muted",
              )}
            >
              <span className="min-w-0 flex-1 truncate">{item.name}</span>
              {selected ? <Check className="size-3.5 shrink-0" /> : null}
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={favorited ? "Remove from favorites" : "Add to favorites"}
                onMouseDown={(e) => e.preventDefault()}
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleFavorite(item.id);
                }}
                className={cn(
                  "text-muted-foreground hover:text-foreground focus-visible:opacity-100",
                  favorited ? "text-foreground" : "opacity-0 group-hover/model:opacity-100",
                )}
              >
                <Star fill={favorited ? "currentColor" : "none"} />
              </Button>
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
    </ScrollArea>
  );
}
