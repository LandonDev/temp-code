import { useEffect, useState } from "react";
import type { ProfileView, ServiceId } from "aliax-core/shared/types";
import { Dialog } from "@renderer/components/ui/dialog";
import { Input } from "@renderer/components/ui/input";
import { DialogFooter, ErrorLine, errorText } from "@renderer/chrome/ConfirmDialog";
import { Field, FieldRow } from "@renderer/chrome/DialogField";
import { ModalBody, ModalPanel } from "@renderer/chrome/Modal";
import { ToggleGroup, ToggleGroupItem } from "@renderer/components/ui/toggle-group";
import { ACCOUNT_COLORS, DEFAULT_COLOR } from "@aliax/lib/accounts";

/** An account's nickname and colour; the colour is the row's identity dot. */
export function EditAccountDialog({
  open,
  onOpenChange,
  serviceId,
  profile,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  serviceId: ServiceId;
  profile: ProfileView;
  onSaved: () => void;
}) {
  const [nickname, setNickname] = useState(profile.nickname ?? "");
  const [color, setColor] = useState(profile.color ?? DEFAULT_COLOR);

  useEffect(() => {
    if (!open) return;
    setNickname(profile.nickname ?? "");
    setColor(profile.color ?? DEFAULT_COLOR);
  }, [open, profile.nickname, profile.color]);

  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One save at a time: Enter and a click together write once, and a failure is said.
  const save = async () => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await window.aliax.updateProfile(serviceId, profile.name, { nickname, color });
      onOpenChange(false);
      onSaved();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next || !pending) && onOpenChange(next)}>
      {/* The row hides the email once a nickname exists; the subtitle is where it lives. */}
      <ModalPanel title="Edit account" description={profile.email ?? profile.name} size="sm" busy={pending}>
        <ModalBody>
          <Field label="Nickname">
            <Input
              autoFocus
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void save();
              }}
            />
          </Field>
          <FieldRow label="Colour">
            <ToggleGroup
              size="xs"
              value={[color]}
              onValueChange={(value) => {
                if (value[0]) setColor(value[0]);
              }}
            >
              {ACCOUNT_COLORS.map((c) => (
                <ToggleGroupItem key={c.id} value={c.value} aria-label={c.id}>
                  <span aria-hidden className="size-3.5 rounded-full" style={{ backgroundColor: c.value }} />
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </FieldRow>
          <ErrorLine error={error} />
        </ModalBody>
        <DialogFooter onCancel={() => onOpenChange(false)} confirmLabel="Save" pending={pending} onConfirm={() => void save()} />
      </ModalPanel>
    </Dialog>
  );
}
