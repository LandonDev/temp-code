import { useEffect, useState } from 'react'
import { Check } from 'lucide-react'
import type { ProfileView, ServiceId } from 'aliax-core/shared/types'
import { Button } from '@aliax/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@aliax/components/ui/dialog'
import { Input } from '@aliax/components/ui/input'
import { Label } from '@aliax/components/ui/label'
import { ACCOUNT_COLORS, DEFAULT_COLOR } from '@aliax/lib/accounts'

export function EditAccountDialog({
  open,
  onOpenChange,
  serviceId,
  profile,
  onSaved
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  serviceId: ServiceId
  profile: ProfileView
  onSaved: () => void
}) {
  const [nickname, setNickname] = useState(profile.nickname ?? '')
  const [color, setColor] = useState(profile.color ?? DEFAULT_COLOR)

  useEffect(() => {
    if (!open) return
    setNickname(profile.nickname ?? '')
    setColor(profile.color ?? DEFAULT_COLOR)
  }, [open, profile.nickname, profile.color])

  const save = async () => {
    await window.aliax.updateProfile(serviceId, profile.name, { nickname, color })
    onOpenChange(false)
    onSaved()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Edit account</DialogTitle>
          {/* The row hides the email once a nickname exists; this is where it lives. */}
          <DialogDescription>{profile.email ?? profile.name}</DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="nickname">Nickname</Label>
            <Input
              id="nickname"
              autoFocus
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && save()}
              placeholder={profile.email ?? profile.name}
            />
          </div>

          <div className="space-y-2">
            <Label>Color</Label>
            <div className="flex items-center gap-2">
              {ACCOUNT_COLORS.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  aria-label={c.id}
                  aria-pressed={color === c.value}
                  onClick={() => setColor(c.value)}
                  style={{ backgroundColor: c.value }}
                  className="grid size-8 place-items-center rounded-lg text-zinc-900 outline-none transition-transform focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-popover active:scale-[0.96]"
                >
                  {color === c.value && <Check className="size-4" strokeWidth={3} />}
                </button>
              ))}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
