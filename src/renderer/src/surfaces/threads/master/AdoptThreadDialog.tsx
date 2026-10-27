import { useState } from "react";
import { Checkbox } from "@renderer/components/ui/checkbox";
import { Item, ItemContent, ItemGroup, ItemMedia, ItemTitle } from "@renderer/components/ui/item";
import { ScrollArea } from "@renderer/components/ui/scroll-area";
import { DialogFooter, ErrorLine, errorText } from "../../../chrome/ConfirmDialog";
import { Modal, useModalClose } from "../../../chrome/Modal";
import type { SessionMeta } from "../../../lib/tcserver/types";
import { THREAD_GLYPHS } from "../threadTypes";
import { typeWord } from "./useMasterModel";

/**
 * "Add existing threads": the project's root threads, on any host, that
 * are in no batch, one checkbox row each with the type's glyph, the title,
 * the type word and, when the candidates span hosts, the host's name. Add
 * is `batch.adopt`; the rows arrive on the board from the push.
 */
export function AdoptThreadDialog({
  candidates,
  hostName,
  onClose,
  onAdopt,
}: {
  candidates: readonly SessionMeta[];
  /** A host's name by id; the name shows only when the candidates span more than one host. */
  hostName?: (environmentId: string) => string;
  onClose: () => void;
  onAdopt: (threads: SessionMeta[]) => Promise<void>;
}) {
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set());
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toggle = (id: string) => {
    const next = new Set(picked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setPicked(next);
  };
  const add = async (close: ((then: () => void) => void) | null) => {
    if (picked.size === 0) return;
    setPending(true);
    setError(null);
    try {
      await onAdopt(candidates.filter((c) => picked.has(c.id)));
      setPending(false);
      if (close) close(onClose);
      else onClose();
    } catch (err) {
      setError(errorText(err));
      setPending(false);
    }
  };
  const hosts = new Set(candidates.map((c) => c.environmentId));
  return (
    <Modal onClose={onClose} busy={pending} title="Add existing threads" size="md">
      <AdoptBody
        candidates={candidates}
        picked={picked}
        toggle={toggle}
        pending={pending}
        error={error}
        spansHosts={hosts.size > 1}
        hostName={hostName}
        onClose={onClose}
        onAdd={add}
      />
    </Modal>
  );
}

function AdoptBody({
  candidates,
  picked,
  toggle,
  pending,
  error,
  spansHosts,
  hostName,
  onClose,
  onAdd,
}: {
  candidates: readonly SessionMeta[];
  picked: ReadonlySet<string>;
  toggle: (id: string) => void;
  pending: boolean;
  error: string | null;
  spansHosts: boolean;
  hostName?: (environmentId: string) => string;
  onClose: () => void;
  onAdd: (close: ((then: () => void) => void) | null) => Promise<void>;
}) {
  const close = useModalClose();
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void onAdd(close);
      }}
    >
      <div className="flex flex-col gap-2 px-4 py-4">
        <ScrollArea className="-mx-2 max-h-80 [&>[data-slot=scroll-area-viewport]]:max-h-80">
          <ItemGroup aria-label="Threads in no batch">
            {candidates.map((c) => {
              const Glyph = c.threadType ? THREAD_GLYPHS[c.threadType] : null;
              return (
                <Item key={c.id} size="xs" role="listitem" render={<label />} className="hover:bg-foreground/5 has-aria-disabled:hover:bg-transparent">
                  <ItemMedia>
                    <Checkbox checked={picked.has(c.id)} onCheckedChange={() => toggle(c.id)} disabled={pending} />
                  </ItemMedia>
                  <ItemMedia className="w-4 text-muted-foreground">{Glyph ? <Glyph className="size-3.5" strokeWidth={1.75} /> : null}</ItemMedia>
                  <ItemContent className="min-w-0 flex-row items-baseline gap-2 group-data-[size=xs]/item:gap-2">
                    <ItemTitle className="min-w-0 font-normal">
                      <span className="truncate">{c.title || "Untitled"}</span>
                    </ItemTitle>
                    <span className="shrink-0 text-xs text-muted-foreground">{typeWord(c)}</span>
                  </ItemContent>
                  {spansHosts ? (
                    <span className="shrink-0 text-xs text-muted-foreground" data-host={c.environmentId}>
                      {hostName?.(c.environmentId) ?? c.environmentId}
                    </span>
                  ) : null}
                </Item>
              );
            })}
          </ItemGroup>
        </ScrollArea>
        <ErrorLine error={error} />
      </div>
      <DialogFooter onCancel={onClose} confirmLabel={picked.size > 1 ? `Add ${picked.size}` : "Add"} pending={pending} disabled={picked.size === 0} />
    </form>
  );
}
