import { useState } from "react";
import { grantFieldNames } from "@shared/addons";
import type { AddonGrantView } from "@shared/contract-addonGrants";
import type { AddonRow } from "@shared/contract-addons";
import { DialogFooter, ErrorLine } from "../../../chrome/ConfirmDialog";
import { Field } from "../../../chrome/DialogField";
import { Modal, ModalBody, useModalClose } from "../../../chrome/Modal";
import { BusyLabel, Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import type { Link } from "../../../lib/connection";
import { refusalWords } from "../../../lib/settingsHome";

type Props = {
  link: Link;
  row: AddonRow;
  /** the add-on's grant as read; null when nothing is saved */
  grant: AddonGrantView | null;
  onClose: () => void;
};

/**
 * Add key… / Change key… for an add-on whose spec names values: one password
 * field per name, a saved one showing "Saved" and never its value. Save sends
 * the typed names alone; Clear empties every value and keeps a sign-in
 * (Sign out on the row's menu drops that). The values live in this dialog's
 * state only: closing it unmounts them, and nothing logs them.
 */
type Pending = "save" | "clear" | null;

export function AddonKeyDialog(props: Props) {
  const anySaved = props.grant?.fields.some((f) => f.set) ?? false;
  // A save or Clear in flight holds the dialog: Escape, the backdrop and the close button wait for it.
  const [pending, setPending] = useState<Pending>(null);
  return (
    <Modal onClose={props.onClose} title={anySaved ? "Change key" : "Add key"} description={props.row.name} size="sm" busy={pending !== null}>
      <KeyForm {...props} anySaved={anySaved} pending={pending} setPending={setPending} />
    </Modal>
  );
}

function KeyForm({ link, row, grant, onClose, anySaved, pending, setPending }: Props & { anySaved: boolean; pending: Pending; setPending: (pending: Pending) => void }) {
  const close = useModalClose();
  const names = grantFieldNames(row.spec);
  const saved = new Set(grant?.fields.filter((f) => f.set).map((f) => f.name));
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const typed = Object.fromEntries(Object.entries(values).filter(([, v]) => v.length > 0));

  const send = (fields: Record<string, string | null>, which: "save" | "clear") => {
    setError(null);
    setPending(which);
    link.request("addons.grant.setFields", { id: row.id, fields }).then(
      () => {
        setPending(null);
        if (close) close(onClose);
        else onClose();
      },
      (err: unknown) => {
        setPending(null);
        setError(refusalWords(err) || "The key was not saved");
      },
    );
  };
  const save = () => {
    if (Object.keys(typed).length > 0 && !pending) send(typed, "save");
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <ModalBody>
        {names.map((name, i) => (
          <Field key={name} label={name}>
            <Input
              type="password"
              autoFocus={i === 0}
              autoComplete="off"
              spellCheck={false}
              placeholder={saved.has(name) ? "Saved" : undefined}
              value={values[name] ?? ""}
              readOnly={pending !== null}
              onChange={(e) => {
                const value = e.target.value;
                setValues((cur) => ({ ...cur, [name]: value }));
                if (error) setError(null);
              }}
            />
          </Field>
        ))}
        <ErrorLine error={error} />
      </ModalBody>
      <DialogFooter
        start={
          anySaved ? (
            <Button
              type="button"
              variant="ghost"
              className="text-muted-foreground hover:text-destructive"
              disabled={pending !== null}
              onClick={() => send(Object.fromEntries(names.map((name) => [name, null])), "clear")}
            >
              <BusyLabel busy={pending === "clear"} label="Clear" />
            </Button>
          ) : null
        }
        onCancel={onClose}
        confirmLabel="Save"
        pending={pending === "save"}
        busy={pending === "clear"}
        disabled={Object.keys(typed).length === 0}
      />
    </form>
  );
}
