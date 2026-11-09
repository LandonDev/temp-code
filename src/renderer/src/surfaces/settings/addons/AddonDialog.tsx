import { useState } from "react";
import { ADDON_NAME_RE, addonCard, addonProblem } from "@shared/addons";
import type { AddonAuth, AddonRow } from "@shared/contract-addons";
import { DialogFooter, ErrorLine } from "../../../chrome/ConfirmDialog";
import { Field, FieldRow } from "../../../chrome/DialogField";
import { Modal, ModalBody, useModalClose } from "../../../chrome/Modal";
import { ChoiceSelect } from "../../../components/choice-select";
import { ChoiceToggle, type ToggleChoice } from "../../../components/choice-toggle";
import { Input } from "../../../components/ui/input";
import { Textarea } from "../../../components/ui/textarea";
import type { Link } from "../../../lib/connection";
import { refusalWords } from "../../../lib/settingsHome";
import { COMMAND_NO_SIGNIN, NAME_RULE, formOf, inputOf, specOf, type AddonForm, type AddonHosts } from "./addonWords";

type Props = {
  link: Link;
  /** null: a new add-on */
  row: AddonRow | null;
  workspaces: readonly { id: string; name: string }[];
  onClose: () => void;
  /** After the dialog's exit has played: the row the host answered, and whether it is new. */
  onSaved: (row: AddonRow, isNew: boolean) => void;
};

/**
 * Add… and Edit… on Settings → Add-ons: the spec's fields as a form, never
 * pasted JSON. The footer's note is the approval card's words for the
 * transport; Save checks the spec the host's way first (`addonProblem`), and
 * the host's refusal (a taken name, a move between homes, the home offline)
 * is the red line above the footer.
 */
export function AddonDialog(props: Props) {
  // A save in flight holds the dialog: Escape, the backdrop and the close button wait for it.
  const [pending, setPending] = useState(false);
  return (
    <Modal onClose={props.onClose} title={props.row ? `Edit ${props.row.name}` : "New add-on"} size="md" busy={pending}>
      <AddonForm {...props} pending={pending} setPending={setPending} />
    </Modal>
  );
}

/** Code in a field: the mono face one size below the field's 13px. */
const MONO = "font-mono text-xs";

const RUNS: ToggleChoice<AddonForm["transport"]>[] = [
  { value: "stdio", label: "Command" },
  { value: "http", label: "Address" },
];
const HOSTS: ToggleChoice<AddonHosts>[] = [
  { value: "all", label: "Every host" },
  { value: "darwin", label: "Macs only" },
  { value: "linux", label: "Linux only" },
];

function AddonForm({ link, row, workspaces, onClose, onSaved, pending, setPending }: Props & { pending: boolean; setPending: (pending: boolean) => void }) {
  const close = useModalClose();
  const [form, setForm] = useState<AddonForm>(() => formOf(row));
  const [error, setError] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const patch = (next: Partial<AddonForm>) => setForm((cur) => ({ ...cur, ...next }));
  const command = form.transport === "stdio";
  // A thread may have written a command that signs in: it keeps that, with its token variable.
  const commandSignsIn = command && form.auth === "oauth";
  const auths: ToggleChoice<AddonAuth>[] = [
    { value: "none", label: "None" },
    { value: "fields", label: "Key" },
    { value: "oauth", label: "Sign in", ...(command && !commandSignsIn ? { disabled: true, note: COMMAND_NO_SIGNIN } : {}) },
  ];
  const where = [{ value: "", label: "Every workspace" }, ...workspaces.map((w) => ({ value: w.id, label: w.name }))];

  const save = () => {
    const name = form.name.trim();
    if (!ADDON_NAME_RE.test(name)) {
      setNameError(NAME_RULE);
      return;
    }
    setNameError(null);
    const problem = addonProblem(specOf(form), name);
    if (problem) {
      setError(problem.charAt(0).toUpperCase() + problem.slice(1));
      return;
    }
    setError(null);
    setPending(true);
    link.request<{ addon: AddonRow }>("addons.set", { addon: inputOf(form, row) }).then(
      ({ addon }) => {
        setPending(false);
        const done = () => onSaved(addon, row === null);
        if (close) close(done);
        else done();
      },
      (err: unknown) => {
        setPending(false);
        setError(refusalWords(err) || "The host refused it");
      },
    );
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <ModalBody>
        <Field label="Name" error={nameError ?? undefined}>
          <Input autoFocus value={form.name} onChange={(e) => patch({ name: e.target.value })} placeholder="github" spellCheck={false} autoComplete="off" />
        </Field>
        <Field label="Description">
          <Input value={form.description} onChange={(e) => patch({ description: e.target.value })} placeholder="Issues and pull requests" />
        </Field>
        <div className="flex flex-col">
          <FieldRow label="Where">
            <ChoiceSelect label="Where" size="sm" value={form.workspaceId ?? ""} onChange={(v) => patch({ workspaceId: v || null })} options={where} />
          </FieldRow>
          <FieldRow label="Runs">
            <ChoiceToggle label="Runs" value={form.transport} options={RUNS} onChange={(transport) => patch({ transport, ...(transport === "stdio" && form.auth === "oauth" && !form.tokenEnv ? { auth: "none" } : {}) })} />
          </FieldRow>
        </div>
        {command ? (
          <>
            <Field label="Command">
              <Input value={form.command} onChange={(e) => patch({ command: e.target.value })} placeholder="npx" spellCheck={false} autoComplete="off" className={MONO} />
            </Field>
            <Field label="Arguments" hint="One per line">
              <Textarea
                value={form.args}
                onChange={(e) => patch({ args: e.target.value })}
                placeholder={"-y\n@modelcontextprotocol/server-github"}
                spellCheck={false}
                rows={3}
                className={MONO}
              />
            </Field>
            <Field label="Variables" hint="Their values go in the key">
              <Input value={form.env} onChange={(e) => patch({ env: e.target.value })} placeholder="GITHUB_TOKEN" spellCheck={false} autoComplete="off" className={MONO} />
            </Field>
          </>
        ) : (
          <>
            <Field label="Address">
              <Input value={form.url} onChange={(e) => patch({ url: e.target.value })} placeholder="https://mcp.example.com/mcp" spellCheck={false} autoComplete="off" />
            </Field>
            <Field label="Headers" hint="Their values go in the key">
              <Input value={form.headers} onChange={(e) => patch({ headers: e.target.value })} placeholder="X-Api-Key" spellCheck={false} autoComplete="off" className={MONO} />
            </Field>
          </>
        )}
        <div className="flex flex-col">
          <FieldRow label="Sign-in">
            <ChoiceToggle label="Sign-in" value={form.auth} options={auths} onChange={(auth) => patch({ auth })} />
          </FieldRow>
          <FieldRow label="Hosts">
            <ChoiceToggle label="Hosts" value={form.hosts} options={HOSTS} onChange={(hosts) => patch({ hosts })} />
          </FieldRow>
        </div>
        {commandSignsIn ? (
          <Field label="Token variable">
            <Input value={form.tokenEnv} onChange={(e) => patch({ tokenEnv: e.target.value })} spellCheck={false} autoComplete="off" className={MONO} />
          </Field>
        ) : null}
        <ErrorLine error={error} />
      </ModalBody>
      <DialogFooter note={addonCard(specOf(form), { name: form.name }, { workspaceName: null, replaces: false }).input.note} onCancel={onClose} confirmLabel={row ? "Save" : "Add"} pending={pending} />
    </form>
  );
}
