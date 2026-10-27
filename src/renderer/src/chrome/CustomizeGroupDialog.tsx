import { useState } from "react";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "../components/ui/toggle-group";
import { normalizeHex } from "../lib/colorUtils";
import { desktopOnly } from "../lib/nativeWeb";
import { clearProjectLogo, pickImageFile, setProjectLogo } from "../lib/projectLogos";
import { PROJECT_MASCOTS, projectMascot } from "../lib/projectMascots";
import { TAB_GROUP_COLORS } from "../lib/tabGroups";
import { ColorPicker } from "./ColorPicker";
import { DialogFooter, ErrorLine, errorText } from "./ConfirmDialog";
import { Field, FieldRow } from "./DialogField";
import { Pipette } from "./icons";
import { Modal, useModalClose } from "./Modal";
import { ProjectLogoIcon } from "./ProjectLogoIcon";
import { ProjectMascot } from "./ProjectMascot";

/** What the dialog saves; the caller writes each part where it lives. */
export type GroupLook = {
  name: string;
  /** null: the first colour (the default). */
  colorIndex: number | null;
  /** Set: a custom colour, over `colorIndex`. */
  customColor: string | null;
  mascot: string;
};

type Props = {
  environmentId: string;
  groupId: string;
  label: string;
  colorIndex: number | null;
  customColor: string | null;
  /** The colour shown now, the custom picker's starting value. */
  currentColor: string;
  logoPath: string | null;
  /** The project a logo belongs to; null: no logo row. */
  logoProject: string | null;
  mascotName: string | null;
  /** The key the default mascot is hashed from. */
  mascotProject: string;
  onSave: (look: GroupLook) => void;
  /** A logo was set or removed (the caller reloads its logos). */
  onLogoChange?: () => void;
  onClose: () => void;
};

const CUSTOM = "custom";

/**
 * A project's (or tab group's) look in one place: name, logo, colour and
 * mascot as rows, opened from the group menu's Customize…. Nothing applies
 * until Save; Cancel and Escape leave everything as it was. A picked logo
 * is held until Save too, and at /ui (no file dialog) only Remove shows.
 */
export function CustomizeGroupDialog(props: Props) {
  const [pending, setPending] = useState(false);
  return (
    <Modal onClose={props.onClose} busy={pending} title="Customize" size="sm">
      <CustomizeForm {...props} pending={pending} setPending={setPending} />
    </Modal>
  );
}

function CustomizeForm({
  environmentId,
  groupId,
  label,
  colorIndex,
  customColor,
  currentColor,
  logoPath,
  logoProject,
  mascotName,
  mascotProject,
  onSave,
  onLogoChange,
  onClose,
  pending,
  setPending,
}: Props & { pending: boolean; setPending: (on: boolean) => void }) {
  const close = useModalClose();
  const [name, setName] = useState(label);
  const [color, setColor] = useState<string>(customColor != null ? CUSTOM : String(colorIndex ?? 0));
  const [custom, setCustom] = useState(customColor ?? normalizeHex(currentColor));
  const [mascot, setMascot] = useState(projectMascot(mascotProject, mascotName).name);
  // The logo as it will be: kept, a picked file (held until Save), or removed.
  const [logo, setLogo] = useState<{ kind: "keep" } | { kind: "set"; path: string } | { kind: "remove" }>({ kind: "keep" });
  const [error, setError] = useState<string | null>(null);
  const shownLogo = logo.kind === "set" ? logo.path : logo.kind === "remove" ? null : logoPath;

  const choose = desktopOnly(() => {
    void pickImageFile().then((path) => path && setLogo({ kind: "set", path }));
  });

  const save = async () => {
    setPending(true);
    try {
      if (logoProject && logo.kind === "set") await setProjectLogo(environmentId, logoProject, logo.path);
      else if (logoProject && logo.kind === "remove") await clearProjectLogo(environmentId, logoProject);
      if (logo.kind !== "keep") onLogoChange?.();
      const index = color === CUSTOM ? null : Number(color);
      onSave({
        name: name.trim() || label,
        colorIndex: index === 0 ? null : index,
        customColor: color === CUSTOM ? custom : null,
        mascot,
      });
      setPending(false);
      close ? close(onClose) : onClose();
    } catch (err) {
      setError(errorText(err));
      setPending(false);
    }
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="flex flex-col gap-4 px-4 py-4">
        <Field label="Name">
          <Input autoFocus onFocus={(e) => e.currentTarget.select()} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>

        {logoProject ? (
          <FieldRow label="Logo">
            <span className="flex items-center gap-2">
              <span className="grid size-8 place-items-center rounded-lg ring-1 ring-border" data-logo-preview>
                {shownLogo ? (
                  <ProjectLogoIcon path={shownLogo} className="size-5" imageClassName="size-5" />
                ) : (
                  <ProjectMascot project={groupId} name={mascot} className="size-4 text-muted-foreground" />
                )}
              </span>
              {choose ? (
                <Button type="button" variant="secondary" size="sm" onClick={choose}>
                  Choose…
                </Button>
              ) : null}
              {shownLogo ? (
                <Button type="button" variant="ghost" size="sm" onClick={() => setLogo({ kind: "remove" })}>
                  Remove
                </Button>
              ) : null}
            </span>
          </FieldRow>
        ) : null}

        <div className="flex flex-col gap-2">
          <FieldRow label="Colour">
            <ToggleGroup
              value={[color]}
              onValueChange={(next) => next[0] !== undefined && setColor(next[0])}
              spacing={0}
              size="xs"
            >
              {TAB_GROUP_COLORS.map((swatch, index) => (
                <ToggleGroupItem key={swatch} value={String(index)} aria-label={`Colour ${index + 1}`}>
                  <span className="size-3.5 rounded-full" style={{ background: swatch }} />
                </ToggleGroupItem>
              ))}
              <ToggleGroupItem value={CUSTOM} aria-label="Custom colour">
                {color === CUSTOM ? (
                  <span className="size-3.5 rounded-full" style={{ background: custom }} />
                ) : (
                  <Pipette strokeWidth={1.5} />
                )}
              </ToggleGroupItem>
            </ToggleGroup>
          </FieldRow>
          {color === CUSTOM ? <ColorPicker value={custom} onChange={setCustom} /> : null}
        </div>

        <Field label="Mascot">
          <ToggleGroup
            value={[mascot]}
            onValueChange={(next) => next[0] !== undefined && setMascot(next[0])}
            size="sm"
            className="w-full flex-wrap gap-1"
          >
            {PROJECT_MASCOTS.map((each) => (
              <ToggleGroupItem key={each.name} value={each.name} aria-label={`Mascot ${each.name}`}>
                <ProjectMascot project={groupId} name={each.name} className="size-3.5" />
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </Field>
        <ErrorLine error={error} />
      </div>
      <DialogFooter onCancel={onClose} confirmLabel="Save" pending={pending} />
    </form>
  );
}
