import { useEffect, useMemo, useRef, useState } from 'react'
import type { ModelInfo, ProviderId } from '@shared/catalog'
import { useApp } from '../../state/store'
import { cn } from '../../lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { GHOST_TRIGGER } from '../ui/menu'
import { ProviderMark } from './bits'
import { ZIcon } from './zicon'

/**
 * The cross-provider model picker (t3 ModelPickerContent, the one Zeron
 * copies): an icons-only provider rail on the left with a favorites star on
 * top, a search box over the model list on the right. Rows are two lines —
 * model name over provider mark + name — with a ⌘N jump chip and a star
 * toggle trailing. Searching hides the rail and spans every provider.
 */

interface RowData {
  provider: ProviderId
  providerLabel: string
  model: ModelInfo
}

/** 0 = label prefix, 1 = label substring, +2 when only the provider+label hit. */
function matchRank(query: string, label: string, providerLabel: string): number | null {
  const q = query.toLowerCase()
  const l = label.toLowerCase()
  if (l.startsWith(q)) return 0
  if (l.includes(q)) return 1
  if (`${providerLabel} ${label}`.toLowerCase().includes(q)) return 3
  return null
}

export function ModelPicker({
  provider,
  model,
  onPick
}: {
  provider: ProviderId
  model: string
  onPick: (provider: ProviderId, model: string) => void
}): React.JSX.Element | null {
  const catalog = useApp((s) => s.catalog)
  const favorites = useApp((s) => s.favoriteModels)
  const toggleFavorite = useApp((s) => s.toggleFavoriteModel)

  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [rail, setRail] = useState<'favorites' | ProviderId>(provider)
  const [active, setActive] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  const isFav = (p: ProviderId, id: string): boolean => favorites.includes(`${p}:${id}`)

  const providers = useMemo(() => (catalog ? Object.values(catalog) : []), [catalog])

  // The visible rows, flat and in render order — keyboard nav, ⌘N jumps,
  // Enter and the render walk the same list (Zeron visible_model_rows).
  const rows = useMemo<RowData[]>(() => {
    const all: RowData[] = providers.flatMap((p) =>
      p.models.map((m) => ({ provider: p.id, providerLabel: p.label, model: m }))
    )
    const q = query.trim()
    if (q) {
      // Rank ladder + favorite boost + input order (t3 modelPickerSearch).
      return all
        .map((row, ix) => {
          const rank = matchRank(q, row.model.label, row.providerLabel)
          return rank === null
            ? null
            : { row, key: [rank, isFav(row.provider, row.model.id) ? 0 : 1, ix] as const }
        })
        .filter((x) => x !== null)
        .sort((a, b) => a.key[0] - b.key[0] || a.key[1] - b.key[1] || a.key[2] - b.key[2])
        .map((x) => x.row)
    }
    if (rail === 'favorites') return all.filter((r) => isFav(r.provider, r.model.id))
    const scoped = all.filter((r) => r.provider === rail)
    return [
      ...scoped.filter((r) => isFav(r.provider, r.model.id)),
      ...scoped.filter((r) => !isFav(r.provider, r.model.id))
    ]
    // eslint-disable-next-line react-hooks/exhaustive-deps -- isFav derives from favorites
  }, [providers, query, rail, favorites])

  const searching = query.trim() !== ''
  const favoritesView = !searching && rail === 'favorites'

  const openPicker = (next: boolean): void => {
    setOpen(next)
    if (!next) return
    setQuery('')
    // Favorites view when stars exist (t3's initial selection), else the
    // current provider; the highlight starts on the selected row.
    const startRail = favorites.length > 0 ? 'favorites' : provider
    setRail(startRail)
    const visible =
      startRail === 'favorites'
        ? providers
            .flatMap((p) => p.models.map((m) => ({ p: p.id, id: m.id })))
            .filter((r) => isFav(r.p, r.id))
        : (catalog?.[provider].models ?? []).map((m) => ({ p: provider, id: m.id }))
    const at = visible.findIndex((r) => r.p === provider && r.id === model)
    setActive(Math.max(0, at))
  }

  const pick = (row: RowData | undefined): void => {
    if (!row) return
    onPick(row.provider, row.model.id)
    setOpen(false)
  }

  useEffect(() => {
    listRef.current?.querySelector('[data-active=true]')?.scrollIntoView({ block: 'nearest' })
  }, [active])

  if (!catalog) return null
  const current = catalog[provider].models.find((m) => m.id === model)

  return (
    <Popover open={open} onOpenChange={openPicker}>
      <PopoverTrigger aria-label="Model" className={cn(GHOST_TRIGGER, 'h-6 gap-1.5 px-1.5')}>
        <ProviderMark provider={provider} size={13} />
        {current?.label ?? model}
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="flex h-[346px] w-80 flex-row gap-0 overflow-hidden p-0"
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            if (rows.length) {
              setActive((a) => (a + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length)
            }
            return
          }
          if (e.key === 'Enter') {
            e.preventDefault()
            pick(rows[active])
            return
          }
          // ⌘1…⌘9 jump-picks the Nth visible row (t3 modelPickerKeys).
          if (e.metaKey && e.key >= '1' && e.key <= '9') {
            e.preventDefault()
            pick(rows[Number(e.key) - 1])
          }
        }}
      >
        {/* rail: favorites star, divider, one brand mark per provider —
            hidden while a search is live (the query spans everything) */}
        {!searching && (
          <div className="flex w-11 shrink-0 flex-col gap-1 p-1">
            <RailTab
              label="Favorites"
              viewed={favoritesView}
              onClick={() => {
                setRail('favorites')
                setActive(0)
              }}
            >
              <ZIcon
                name="star-bold"
                size={16}
                className={favoritesView ? 'text-foreground' : 'text-muted-foreground/75'}
              />
            </RailTab>
            <div className="-mx-1 my-px h-px bg-hairline" />
            {providers.map((p) => (
              <RailTab
                key={p.id}
                label={p.label}
                viewed={!favoritesView && rail === p.id}
                onClick={() => {
                  setRail(p.id)
                  setActive(0)
                }}
              >
                <ProviderMark
                  provider={p.id}
                  size={17}
                  className={cn(
                    p.id !== 'claude' &&
                      (rail === p.id && !favoritesView
                        ? 'text-foreground'
                        : 'text-muted-foreground')
                  )}
                />
              </RailTab>
            ))}
          </div>
        )}

        {/* pane: a whisper of wash lifts it off the rail */}
        <div
          className={cn(
            'flex min-w-0 flex-1 flex-col bg-foreground/[0.02]',
            !searching && 'border-l border-hairline'
          )}
        >
          <div className="flex h-[46px] shrink-0 items-center gap-2 border-b border-hairline px-2.5">
            <ZIcon name="magnifer" size={14} className="text-muted-foreground/70" />
            <input
              autoFocus
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                setActive(0)
              }}
              placeholder="Search models…"
              aria-label="Search models"
              className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-faint"
            />
          </div>
          <div ref={listRef} className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-1.5">
            {rows.length === 0 ? (
              <div className="px-2 py-6 text-center text-xs text-muted-foreground/60">
                {searching ? 'No models found' : "No starred models yet — hit a row's star"}
              </div>
            ) : (
              rows.map((row, ix) => {
                const selected = row.provider === provider && row.model.id === model
                const fav = isFav(row.provider, row.model.id)
                return (
                  <div
                    key={`${row.provider}:${row.model.id}`}
                    data-active={ix === active}
                    role="option"
                    aria-selected={selected}
                    onMouseMove={() => setActive(ix)}
                    onClick={() => pick(row)}
                    className={cn(
                      'flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5',
                      // ONE moving highlight: hover moves the keyboard cursor;
                      // selection is the distinct stronger treatment.
                      selected
                        ? 'bg-accent ring-1 ring-foreground/10'
                        : ix === active && 'bg-accent/60'
                    )}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12.5px] font-medium">
                        {row.model.label}
                      </span>
                      <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground/70">
                        <ProviderMark
                          provider={row.provider}
                          size={11}
                          className={cn(row.provider !== 'claude' && 'text-muted-foreground/70')}
                        />
                        {row.providerLabel}
                      </span>
                    </span>
                    {ix < 9 && (
                      <kbd className="shrink-0 rounded border border-border px-1 text-[10px] tabular-nums text-muted-foreground/50">
                        ⌘{ix + 1}
                      </kbd>
                    )}
                    <button
                      aria-label={fav ? 'Unstar model' : 'Star model'}
                      onClick={(e) => {
                        e.stopPropagation()
                        toggleFavorite(row.provider, row.model.id)
                      }}
                      className="flex size-[22px] shrink-0 items-center justify-center rounded-md transition-colors hover:bg-foreground/8"
                    >
                      <ZIcon
                        name={fav ? 'star-bold' : 'star'}
                        size={13}
                        className={fav ? 'text-warning' : 'text-muted-foreground/45'}
                      />
                    </button>
                  </div>
                )
              })
            )}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}

/** A 36px square rail tab; the viewed one wears a 3px violet half-capsule
 *  hugging the rail's right edge (t3 SELECTED_INDICATOR_CLASS). */
function RailTab({
  label,
  viewed,
  onClick,
  children
}: {
  label: string
  viewed: boolean
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        'relative flex size-9 items-center justify-center rounded-lg transition-colors',
        !viewed && 'hover:bg-foreground/6'
      )}
    >
      {children}
      {viewed && <span className="absolute -right-1 top-2 h-5 w-[3px] rounded-l-full bg-violet" />}
    </button>
  )
}
