import { useEffect, useId, useState } from "react";
import type { ProfileView, ServiceId } from "aliax-core/shared/types";
import { Button } from "@renderer/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@renderer/components/ui/dialog";
import { Input } from "@renderer/components/ui/input";
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
  const nicknameId = useId();
  const colourId = useId();

  useEffect(() => {
    if (!open) return;
    setNickname(profile.nickname ?? "");
    setColor(profile.color ?? DEFAULT_COLOR);
  }, [open, profile.nickname, profile.color]);

  const save = async () => {
    await window.aliax.updateProfile(serviceId, profile.name, { nickname, color });
    onOpenChange(false);
    onSaved();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Edit account</DialogTitle>
          {/* The row hides the email once a nickname exists; this is where it lives. */}
          <DialogDescription>{profile.email ?? profile.name}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label htmlFor={nicknameId} className="text-xs font-medium text-muted-foreground">
              Nickname
            </label>
            <Input
              id={nicknameId}
              autoFocus
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void save();
              }}
              placeholder={profile.email ?? profile.name}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <span id={colourId} className="text-xs font-medium text-muted-foreground">
              Colour
            </span>
            <ToggleGroup
              aria-labelledby={colourId}
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
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void save()}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
