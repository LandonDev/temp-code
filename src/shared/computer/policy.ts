/**
 * The confirmations policy of computer use (docs/computer-protocol.md "The
 * model's words"): the kinds of act the person approves first, which of them
 * the person's own words may pre-approve, and the card's title. The model
 * flags an act with `confirm: { kind, what }` on `computer_act` or
 * `computer_batch`; the host then asks in every permission mode. `password`
 * is the host's own kind: it asks before text goes into a password field,
 * whatever the model flagged.
 */
import { z } from 'zod'

export const CONFIRM_KINDS = [
  'delete',
  'send',
  'pay',
  'subscribe',
  'account',
  'access',
  'install',
  'captcha',
  'security',
  'medical',
  'sign_in',
  'site_permission',
  'warning',
  'upload',
  'files',
  'personal_data'
] as const
export type ConfirmKind = (typeof CONFIRM_KINDS)[number]

/** The model's kinds and the host's own. */
export const HOST_CONFIRM_KINDS = [...CONFIRM_KINDS, 'password'] as const
export type HostConfirmKind = (typeof HOST_CONFIRM_KINDS)[number]

export interface ConfirmKindInfo {
  /** the card's word for it: `Send in Mail: …` */
  label: string
  /** the person's own words may pre-approve it; a kind that may not is flagged even when asked for */
  preApprovable: boolean
  /** how the prompt names it among the kinds */
  word: string
}

export const CONFIRM_KIND_INFO: Readonly<Record<HostConfirmKind, ConfirmKindInfo>> = {
  delete: { label: 'Delete', preApprovable: false, word: 'deleting' },
  send: { label: 'Send', preApprovable: false, word: 'sending' },
  pay: { label: 'Pay', preApprovable: false, word: 'paying' },
  subscribe: { label: 'Subscribe', preApprovable: false, word: 'subscribing' },
  account: { label: 'Change an account', preApprovable: false, word: 'account' },
  access: { label: 'Change who has access', preApprovable: false, word: 'access' },
  install: { label: 'Install', preApprovable: false, word: 'installing' },
  captcha: { label: 'Answer a CAPTCHA', preApprovable: false, word: 'CAPTCHA' },
  security: { label: 'Change a security setting', preApprovable: false, word: 'security' },
  medical: { label: 'Act on medical care', preApprovable: false, word: 'medical' },
  sign_in: { label: 'Sign in', preApprovable: true, word: 'signing in' },
  site_permission: { label: 'Allow a site permission', preApprovable: true, word: 'site permissions' },
  warning: { label: 'Accept a warning', preApprovable: true, word: 'warnings' },
  upload: { label: 'Upload', preApprovable: true, word: 'uploads' },
  files: { label: 'Move or rename files', preApprovable: true, word: 'file moves' },
  personal_data: { label: 'Share personal data', preApprovable: true, word: 'personal data' },
  password: { label: 'Type into a password field', preApprovable: false, word: 'passwords' }
}

/** What a flag says happens and to whom, in one line. */
export const CONFIRM_WHAT_MAX = 200

/** The flag on `computer_act` and `computer_batch`; undescribed here, descriptions.ts gives the tools described copies. */
export const ConfirmSchema = z.object({
  kind: z.enum(CONFIRM_KINDS),
  what: z.string().min(1).max(CONFIRM_WHAT_MAX)
})
export type Confirm = z.infer<typeof ConfirmSchema>

/** What a card asks for: a model's flag, or the host's own password rule. */
export interface ConfirmNeed {
  kind: HostConfirmKind
  what: string
}

/** The card's input carries the kind's label beside the model's words. */
export function confirmInput(need: ConfirmNeed): { kind: HostConfirmKind; label: string; what: string } {
  return { kind: need.kind, label: CONFIRM_KIND_INFO[need.kind].label, what: need.what }
}

/** A card title at most this long keeps the step's words in brackets. */
export const CONFIRM_TITLE_MAX = 160

/**
 * `Send in Mail: Reply to Ana accepting Friday's lunch (click button "Send")`:
 * the kind's label, the app, the model's words, then the step's own words
 * while the whole fits CONFIRM_TITLE_MAX.
 */
export function confirmTitle(need: ConfirmNeed, app: string, steps?: string): string {
  const head = `${CONFIRM_KIND_INFO[need.kind].label} in ${app}: ${need.what}`
  const whole = steps ? `${head} (${steps})` : head
  return whole.length <= CONFIRM_TITLE_MAX ? whole : head
}
