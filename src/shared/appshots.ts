import { z } from 'zod'

/**
 * Appshots (M10): double-tap ⌘ anywhere on macOS → the frontmost window of
 * the app you're in lands in a composer as one appshot attachment —
 * screenshot + the window's accessibility text.
 */

export const AppshotDestinationSchema = z.enum(['automatic', 'last-chat', 'new-chat'])
export type AppshotDestination = z.infer<typeof AppshotDestinationSchema>

export const AppshotSettingsSchema = z.object({
  enabled: z.boolean(),
  destination: AppshotDestinationSchema,
  sound: z.boolean()
})
export type AppshotSettings = z.infer<typeof AppshotSettingsSchema>

export const DEFAULT_APPSHOT_SETTINGS: AppshotSettings = {
  enabled: true,
  destination: 'automatic',
  sound: true
}
