import { useState, type ReactNode } from "react";
import type { SavedEnvironment, SavedRoute } from "@server/shared/contract-remote";
import { DialogFooter, ErrorLine } from "../../../../chrome/ConfirmDialog";
import { ArrowDownLong, ArrowUpLong, X } from "../../../../chrome/icons";
import { Modal } from "../../../../chrome/Modal";
import { hostErrorText, kindOf, originText } from "../../../../lib/hostConnection";
import { Input, SecondaryButton } from "../../../settingsBits";
import { rpc } from "../rpc";

export function RoutesDialog({ env, onClose, onChanged }: { env: SavedEnvironment; onClose: () => void; onChanged: () => Promise<void> }) {
  const [routes, setRoutes] = useState<SavedRoute[]>(env.routes);
  const [added, setAdded] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const move = (from: number, to: number) => {
    if (to < 0 || to >= routes.length) return;
    const next = [...routes];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    setRoutes(next);
  };
  const add = () => {
    const url = added.trim();
    if (!url) return;
    setRoutes([...routes, { url, kind: kindOf(url) }]);
    setAdded("");
  };
  const save = async () => {
    setPending(true);
    setError(null);
    try {
      await rpc("remote.environments.update", { id: env.id, routes });
      await onChanged();
      onClose();
    } catch (err) {
      setError(hostErrorText(err));
      setPending(false);
    }
  };
  return (
    <Modal onClose={onClose} busy={pending} title={`Routes to ${env.name}`} description="Best first. The window connects over the first that works and keeps trying the earlier ones." size="sm">
      <div className="flex flex-col gap-3 px-4 py-3">
        <ol className="flex flex-col">
          {routes.map((route, i) => (
            <li key={route.url} className="flex items-center gap-2 border-b border-content/5 py-2 last:border-b-0">
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12px] text-content">{originText(route.url)}</div>
                <div className="text-[11px] text-content/40">{route.kind}</div>
              </div>
              <IconButton label="Move up" disabled={i === 0} onClick={() => move(i, i - 1)}>
                <ArrowUpLong className="size-3.5" strokeWidth={1.75} />
              </IconButton>
              <IconButton label="Move down" disabled={i === routes.length - 1} onClick={() => move(i, i + 1)}>
                <ArrowDownLong className="size-3.5" strokeWidth={1.75} />
              </IconButton>
              <IconButton label="Remove route" disabled={routes.length === 1} onClick={() => setRoutes(routes.filter((_, j) => j !== i))}>
                <X className="size-3.5" strokeWidth={1.75} />
              </IconButton>
            </li>
          ))}
        </ol>
        <div className="flex items-center gap-2">
          <Input
            value={added}
            onChange={(e) => setAdded(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                add();
              }
            }}
            placeholder="https://host or ws://10.0.0.5:7677"
            spellCheck={false}
            autoComplete="off"
            className="min-w-0 flex-1"
            aria-label="New route"
          />
          <SecondaryButton onClick={add} disabled={!added.trim()}>
            Add route
          </SecondaryButton>
        </div>
        <ErrorLine error={error} />
      </div>
      <DialogFooter onCancel={onClose} confirmLabel="Save" pending={pending} onConfirm={() => void save()} disabled={routes.length === 0} />
    </Modal>
  );
}

function IconButton({ label, disabled, onClick, children }: { label: string; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="pressable grid size-6 shrink-0 place-items-center rounded-md text-content/50 hover:bg-content/10 hover:text-content disabled:cursor-default disabled:opacity-30 disabled:hover:bg-transparent"
    >
      {children}
    </button>
  );
}
