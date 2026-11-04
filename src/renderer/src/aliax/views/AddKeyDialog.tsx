import { useEffect, useRef, useState } from "react";
import { Field } from "@renderer/chrome/DialogField";
import { Button } from "@renderer/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@renderer/components/ui/dialog";
import { Input } from "@renderer/components/ui/input";
import { Spinner } from "@renderer/components/ui/spinner";

export type AddKeyResult = { ok: true; name?: string } | { ok: false; error: string };

/**
 * An API key for a key service (Meta): the key and an optional name, which
 * the main process checks with the provider before it saves anything. The
 * key field is a password field, cleared whenever the dialog closes, so the
 * key is never shown back. One red line under it says why a key was not
 * saved; Add waits for the provider with a spinner.
 */
export function AddKeyDialog({
  open,
  onOpenChange,
  serviceName,
  submit,
  onAdded,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The provider, as the title names it ("Meta"). */
  serviceName: string;
  /** Verify and save; resolves with the saved name or the one line to show. */
  submit: (input: { name?: string; key: string }) => Promise<AddKeyResult>;
  onAdded: (name: string | undefined) => void;
}) {
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  // An answer for an attempt the person closed says nothing.
  const attempt = useRef(0);

  useEffect(() => {
    if (open) return;
    attempt.current++;
    setName("");
    setKey("");
    setError(null);
    setVerifying(false);
  }, [open]);

  const ready = key.trim().length > 0 && !verifying;

  const add = async () => {
    if (!ready) return;
    const n = ++attempt.current;
    setVerifying(true);
    setError(null);
    const result = await submit({ name: name.trim() || undefined, key: key.trim() }).catch(
      (e: Error): AddKeyResult => ({ ok: false, error: e.message || "The key was not saved" }),
    );
    if (n !== attempt.current) return;
    setVerifying(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onOpenChange(false);
    onAdded(result.name);
  };

  const onEnter = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void add();
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Add {serviceName} key</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <Field label="Key" error={error}>
            <Input
              type="password"
              autoFocus
              autoComplete="off"
              spellCheck={false}
              placeholder="LLM_…"
              value={key}
              readOnly={verifying}
              onChange={(e) => {
                setKey(e.target.value);
                if (error) setError(null);
              }}
              onKeyDown={onEnter}
            />
          </Field>
          <Field label="Name">
            <Input value={name} placeholder="Optional" readOnly={verifying} onChange={(e) => setName(e.target.value)} onKeyDown={onEnter} />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!ready} aria-busy={verifying || undefined} onClick={() => void add()}>
            {verifying ? <Spinner className="size-3.5" /> : null}
            Add
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
