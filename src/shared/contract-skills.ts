import { z } from 'zod'
import { WriterSchema } from './addons'
import { SKILL_HARNESSES, SKILL_MAX_FILES, SKILL_NAME_RE } from './skills'
import { ToolScopeSchema, type StoreHome } from './contract-addons'

export { SKILL_HARNESSES }

/**
 * The skills store over the wire (CLAUDE.md "Add-ons and skills: one store,
 * on the box"). A skill is a folder every CLI reads from a directory the
 * app writes: SKILL.md at its root and the files beside it, kept whole in
 * the store, one copy on the box (remote/storeSync.ts). `skills.list`
 * answers the rows without their files; `skills.get` one skill whole.
 */

const request = <M extends string, P extends z.ZodType>(method: M, params: P) =>
  z.object({ id: z.string(), method: z.literal(method), params })

export const SkillHarnessesSchema = z.union([z.literal('all'), z.array(z.enum(SKILL_HARNESSES)).min(1).max(3)])

export const SkillFileSchema = z
  .object({
    /** posix, relative to the skill folder */
    path: z.string().max(1_024),
    /** exactly one of text (UTF-8) and base64 */
    text: z.string().optional(),
    base64: z.string().optional(),
    executable: z.boolean().optional()
  })
  .refine((f) => (f.text === undefined) !== (f.base64 === undefined), 'a file carries text or base64')
export type SkillFile = z.infer<typeof SkillFileSchema>

export const SkillMetaSchema = z.object({
  id: z.string(),
  name: z.string().regex(SKILL_NAME_RE),
  /** this host's workspace id; null: every workspace */
  workspaceId: z.string().nullable(),
  /** SKILL.md's frontmatter `description` */
  description: z.string(),
  harnesses: SkillHarnessesSchema,
  enabled: z.boolean(),
  /** 1 on create, +1 on every write that changes the digest, harnesses or enabled */
  version: z.number().int(),
  /** skillDigest(files) */
  digest: z.string(),
  bytes: z.number().int(),
  fileCount: z.number().int(),
  addedBy: WriterSchema,
  writtenBy: WriterSchema,
  createdAt: z.number().int(),
  updatedAt: z.number().int()
})
export type SkillMeta = z.infer<typeof SkillMetaSchema>

export const SkillSchema = SkillMetaSchema.extend({ files: z.array(SkillFileSchema) })
export type Skill = z.infer<typeof SkillSchema>

/** What skills.set takes: the whole skill. The host reads the description from SKILL.md and stamps times and writers unless the caller is the sync. */
export const SkillInputSchema = z.object({
  id: z.string().optional(),
  name: z.string().regex(SKILL_NAME_RE),
  workspaceId: z.string().nullable(),
  /** default 'all' */
  harnesses: SkillHarnessesSchema.optional(),
  /** default true */
  enabled: z.boolean().optional(),
  files: z.array(SkillFileSchema).min(1).max(SKILL_MAX_FILES),
  addedBy: WriterSchema.optional(),
  writtenBy: WriterSchema.optional()
})
export type SkillInput = z.infer<typeof SkillInputSchema>

export const SkillRequestSchemas = [
  /** → SkillsList: every scope's rows, and the home of the named scope, as addons.list */
  z.object({ id: z.string(), method: z.literal('skills.list'), params: z.object({ workspaceId: z.string().nullable().optional() }).optional() }),
  /** → { skill: Skill } */
  request('skills.get', z.object({ id: z.string() })),
  /** → { skill: SkillMeta }: forwarded to the home */
  request('skills.set', z.object({ skill: SkillInputSchema })),
  /** → { removed: boolean } */
  request('skills.remove', z.object({ id: z.string() }))
] as const

export interface SkillsList {
  skills: SkillMeta[]
  home: StoreHome
}

// ── the tools threads get: their arguments (skills.ts has their words) ──

export const SkillWriteArgsSchema = z.object({
  name: z.string(),
  /** ["all"] or any of the CLIs; `harnessesFrom` turns it into the row's value */
  harnesses: z.array(z.enum(['all', ...SKILL_HARNESSES])).min(1).max(4).optional(),
  scope: ToolScopeSchema.optional(),
  files: z.array(z.object({ path: z.string().max(1_024), text: z.string(), executable: z.boolean().optional() })).max(SKILL_MAX_FILES).optional(),
  dir: z.string().optional()
})
export const SkillRemoveArgsSchema = z.object({ name: z.string(), scope: ToolScopeSchema.optional() })

/** To every client socket whenever a skill changes. */
export type SkillsPush = { push: 'skills'; skills: SkillMeta[] }
