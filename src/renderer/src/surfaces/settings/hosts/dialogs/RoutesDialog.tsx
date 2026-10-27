import { useState, type ReactNode } from "react";
import type { SavedEnvironment, SavedRoute } from "@server/shared/contract-remote";
import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@renderer/components/ui/item";
import { DialogFooter, ErrorLine } from "../../../../chrome/ConfirmDialog";
import { Tip } from "../../../../chrome/DialogField";
import { ArrowDownLong, ArrowUpLong, X } from "../../../../chrome/icons";
import { Modal, useModalClose } from "../../../../chrome/Modal";
import { hostErrorText, kindOf, originText } from "../../../../lib/hostConnection";
import { rpc } from "../rpc";

type Props = { env: SavedEnvironment; onClose: () => void; onChanged: () => Promise<void> };

export function RoutesDialog(props: Props) {
  const [pending, setPending] = useState(false);
  return (
    <Modal onClose={props.onClose} busy={pending} title={`Routes to ${props.env.name}`} description="Best first." size="sm">
      <Body {...props} pending={pending} setPending={setPending} />
    </Modal>
  );
}

function Body({ env, onClose, onChanged, pending, setPending }: Props & { pending: boolean; setPending: (on: boolean) => void }) {
  const close = useModalClose();
  const [routes, setRoutes] = useState<SavedRoute[]>(env.routes);
  const [added, setAdded] = useState("");
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
      setPending(false);
      if (close) close(onClose);
      else onClose();
    } catch (err) {
      setError(hostErrorText(err));
      setPending(false);
    }
  };
  return (
    <>
      <div className="flex flex-col gap-4 px-4 py-4">
        <ItemGroup aria-label="Routes">
          {routes.map((route, i) => (
            <Item key={route.url} role="listitem" size="xs" className="px-0">
              <ItemContent className="min-w-0">
                <ItemTitle className="block max-w-full truncate">{originText(route.url)}</ItemTitle>
                <ItemDescription>{route.kind}</ItemDescription>
              </ItemContent>
              <ItemActions className="gap-0.5">
                <RouteAction label="Move up" disabled={i === 0} onClick={() => move(i, i - 1)}>
                  <ArrowUpLong />
                </RouteAction>
                <RouteAction label="Move down" disabled={i === routes.length - 1} onClick={() => move(i, i + 1)}>
                  <ArrowDownLong />
                </RouteAction>
                <RouteAction label="Remove route" disabled={routes.length === 1} onClick={() => setRoutes(routes.filter((_, j) => j !== i))}>
                  <X />
                </RouteAction>
              </ItemActions>
            </Item>
          ))}
        </ItemGroup>
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
            className="flex-1"
            aria-label="New route"
          />
          <Button variant="secondary" onClick={add} disabled={!added.trim()}>
            Add route
          </Button>
        </div>
        <ErrorLine error={error} />
      </div>
      <DialogFooter onCancel={onClose} confirmLabel="Save" pending={pending} onConfirm={() => void save()} disabled={routes.length === 0} />
    </>
  );
}

function RouteAction({ label, disabled, onClick, children }: { label: string; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <Tip label={label}>
      <Button variant="ghost" size="icon-xs" aria-label={label} disabled={disabled} onClick={onClick} className="text-muted-foreground hover:text-foreground">
        {children}
      </Button>
    </Tip>
  );
}
