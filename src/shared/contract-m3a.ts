import { z } from 'zod'

export const NoteIdSchema = z.string().regex(/^[A-Za-z0-9_-]+$/, 'Invalid note id')
export const NoteUpsertSchema = z.object({
  id: NoteIdSchema,
  title: z.string(),
  body: z.string(),
  sourceSessionId: z.union([NoteIdSchema, z.literal('')]).optional(),
  sourceCwd: z.string().optional()
})
export type NoteUpsert = z.infer<typeof NoteUpsertSchema>
export interface Note extends NoteUpsert {
  slug: string
  createdAt: number
  updatedAt: number
}
export const ProjectSearchOptionsSchema = z.object({
  cwd: z.string(),
  query: z.string(),
  caseSensitive: z.boolean().optional(),
  wholeWord: z.boolean().optional(),
  regex: z.boolean().optional(),
  include: z.string().optional(),
  exclude: z.string().optional()
})
export type ProjectSearchOptions = z.infer<typeof ProjectSearchOptionsSchema>
export interface ProjectSearchMatch {
  path: string
  relative: string
  line: number
  column: number
  preview: string
}
export interface ProjectSearchResult {
  matches: ProjectSearchMatch[]
  truncated: boolean
}
export const WorkspaceSnapshotSchema = z.record(z.string(), z.json())
export type WorkspaceSnapshot = z.infer<typeof WorkspaceSnapshotSchema>
export interface ClaudeUsageFetch {
  status: 'ok' | 'error' | 'unavailable'
  httpStatus: number | null
  body: string | null
  error: string | null
}
export interface TextGenerateResult {
  text: string | null
}

export const M3aRequestSchemas = [
  z.object({
    id: z.string(),
    method: z.literal('session.pin'),
    params: z.object({ sessionId: z.string(), pinned: z.boolean() })
  }),
  z.object({
    id: z.string(),
    method: z.literal('text.generate'),
    params: z.object({ prompt: z.string(), cwd: z.string().optional() })
  }),
  z.object({ id: z.string(), method: z.literal('workspace.getSnapshot') }),
  z.object({
    id: z.string(),
    method: z.literal('workspace.setSnapshot'),
    params: z.object({ snapshot: WorkspaceSnapshotSchema })
  }),
  z.object({ id: z.string(), method: z.literal('notes.list') }),
  z.object({
    id: z.string(),
    method: z.literal('notes.get'),
    params: z.object({ id: NoteIdSchema })
  }),
  z.object({
    id: z.string(),
    method: z.literal('notes.upsert'),
    params: z.object({ note: NoteUpsertSchema })
  }),
  z.object({
    id: z.string(),
    method: z.literal('notes.delete'),
    params: z.object({ id: NoteIdSchema })
  }),
  z.object({
    id: z.string(),
    method: z.literal('search.project'),
    params: z.object({ options: ProjectSearchOptionsSchema })
  }),
  z.object({
    id: z.string(),
    method: z.literal('projectLogo.save'),
    params: z.object({ projectPath: z.string(), sourcePath: z.string() })
  }),
  z.object({
    id: z.string(),
    method: z.literal('projectLogo.remove'),
    params: z.object({ projectPath: z.string() })
  }),
  z.object({ id: z.string(), method: z.literal('rateLimits.claudeUsage') }),
  z.object({ id: z.string(), method: z.literal('rateLimits.codexUsage') })
] as const
