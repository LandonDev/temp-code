/**
 * The labels of harness sync's sets (src/main/server/remote/harnessSet.ts
 * HARNESS_SET), in its order, for the renderer: the Sync row's tooltip names
 * only these, so a status an older build wrote, with its skill sets, shows
 * none of them. Skills come from the skills store now, not from harness sync.
 */
export const HARNESS_SET_LABELS = [
  'Claude commands',
  'Claude agents',
  'Claude hooks',
  'Claude settings',
  'Claude plugins',
  'Codex prompts',
  'Codex config',
  'Codex hooks',
  'Muse settings',
  'Muse hooks'
] as const
