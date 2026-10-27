import { useState } from "react";
import { DialogFooter, ErrorLine, errorText } from "../../../chrome/ConfirmDialog";
import { Modal } from "../../../chrome/Modal";
import type { SessionMeta } from "../../../lib/tcserver/types";
import { THREAD_GLYPHS, THREAD_TINTS } from "../threadTypes";
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
  const add = async () => {
    if (picked.size === 0) return;
    setPending(true);
    setError(null);
    try {
      await onAdopt(candidates.filter((c) => picked.has(c.id)));
      onClose();
    } catch (err) {
      setError(errorText(err));
      setPending(false);
    }
  };
  const hosts = new Set(candidates.map((c) => c.environmentId));
  return (
    <Modal onClose={onClose} busy={pending} title="Add existing threads" size="sm">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <ul className="flex max-h-80 flex-col overflow-y-auto px-2 pt-2 pb-1" aria-label="Threads in no batch">
          {candidates.map((c) => {
            const Glyph = c.threadType ? THREAD_GLYPHS[c.threadType] : null;
            const on = picked.has(c.id);
            return (
              <li key={c.id}>
                <label className="flex h-8 cursor-pointer items-center gap-2.5 rounded-md px-2 text-[12px] hover:bg-content/5">
                  <input type="checkbox" checked={on} onChange={() => toggle(c.id)} disabled={pending} className="shrink-0" />
                  <span className="flex w-4 shrink-0 justify-center">
                    {Glyph ? <Glyph className={`size-3.5 ${c.threadType ? THREAD_TINTS[c.threadType] : "text-content/50"}`} strokeWidth={1.75} /> : null}
                  </span>
                  <span className="min-w-0 truncate text-content">{c.title || "Untitled"}</span>
                  <span className="shrink-0 text-content/40">{typeWord(c)}</span>
                  {hosts.size > 1 ? (
                    <span className="ml-auto shrink-0 pl-2 text-content/40" data-host={c.environmentId}>
                      {hostName?.(c.environmentId) ?? c.environmentId}
                    </span>
                  ) : null}
                </label>
              </li>
            );
          })}
        </ul>
        <div className="px-4">
          <ErrorLine error={error} />
        </div>
        <DialogFooter onCancel={onClose} confirmLabel={picked.size > 1 ? `Add ${picked.size}` : "Add"} pending={pending} disabled={picked.size === 0} />
      </form>
    </Modal>
  );
}
