import { addonProblem, type Writer } from '@shared/addons'
import { allows, principalCaps, type Principal } from '@shared/capabilities'
import type { ClientRequest } from '@shared/contract'
import type { AddonInput, AddonRow, AddonsList, AddonsPush, AddonStatusPush, AddonToolsAnswer, StoreHome } from '@shared/contract-addons'
import type { Skill, SkillInput, SkillMeta, SkillsList, SkillsPush } from '@shared/contract-skills'
import { skillProblem } from '@shared/skills'
import type { AddonStore } from './addonStore'
import { fileBytes, type SkillStore } from './skillStore'
import type { StoreWrite } from './remote/storeSync'

/**
 * The `addons.*` and `skills.*` handlers (CLAUDE.md "Add-ons and skills:
 * one store, on the box"), kept out of index.ts's switch so they test
 * without a server. A write is stamped with its writer (a person: the local
 * socket, or the remote key's name); writers the request carries are kept
 * only for an admin caller, which is how the Mac's sync keeps a row's
 * writers on the box. A write to a scope the box holds goes there
 * (StoreSync.forward); one to this host's own scope lands here.
 */

export const STORE_METHODS = ['addons.list', 'addons.set', 'addons.remove', 'addons.tools', 'skills.list', 'skills.get', 'skills.set', 'skills.remove'] as const
export type StoreMethod = (typeof STORE_METHODS)[number]
type MethodAndParams<T> = T extends { method: unknown; params?: unknown } ? Pick<T, 'method' | 'params'> : never
/** One of the eight requests, without its id: each method keeps its own params. */
export type StoreRequest = MethodAndParams<Extract<ClientRequest, { method: StoreMethod }>>
export const isStoreMethod = (method: string): method is StoreMethod => (STORE_METHODS as readonly string[]).includes(method)

export interface StoreRpcDeps {
  addons: AddonStore
  skills: SkillStore
  /** Null on a host with no peer links to follow: every write lands here. */
  sync: { forward(method: StoreWrite, params: unknown, workspaceId: string | null): Promise<boolean>; homeFor(workspaceId: string | null): StoreHome } | null
  /** An add-on removed here (not by a follow): the home deletes its grant profile (the add-on OAuth build wires it). */
  onAddonRemoved?: (id: string) => void
}

export type StorePush = AddonsPush | AddonStatusPush | SkillsPush
/** A follow writes many rows at once: the pushes of one burst go out once, this long after its first change. */
export const STORE_PUSH_MS = 50

/**
 * The `addons`, `addon-status` and `skills` pushes, each the whole list,
 * once per burst of changes, to every listener (each client socket). The
 * Mac's link hears the box's and follows (remote/storeSync.ts).
 */
export function storePushes(addons: AddonStore, skills: SkillStore, delayMs = STORE_PUSH_MS) {
  const listeners = new Set<(push: StorePush) => void>()
  const dirty = new Set<StorePush['push']>()
  let timer: NodeJS.Timeout | null = null
  const flush = (): void => {
    timer = null
    const kinds = [...dirty]
    dirty.clear()
    for (const kind of kinds) {
      const push: StorePush =
        kind === 'addons' ? { push: 'addons', addons: addons.list() } : kind === 'skills' ? { push: 'skills', skills: skills.list() } : { push: 'addon-status', status: addons.status() }
      for (const fn of listeners) fn(push)
    }
  }
  const mark = (kind: StorePush['push']) => (): void => {
    dirty.add(kind)
    timer ??= setTimeout(flush, delayMs)
    timer.unref?.()
  }
  const offs = [addons.onChange(mark('addons')), addons.onStatus(mark('addon-status')), skills.onChange(mark('skills'))]
  return {
    onPush(fn: (push: StorePush) => void): () => void {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    close(): void {
      for (const off of offs) off()
      if (timer) clearTimeout(timer)
      timer = null
      listeners.clear()
    }
  }
}

/** A person's write: the local socket is "You", a remote key its name. */
export const writerOf = (principal: Principal): Writer => (principal.kind === 'local' ? { kind: 'person' } : { kind: 'person', key: principal.name })

export function storeRpc(deps: StoreRpcDeps) {
  const { addons, skills, sync } = deps
  const forward = (method: StoreWrite, params: unknown, workspaceId: string | null): Promise<boolean> =>
    sync ? sync.forward(method, params, workspaceId) : Promise.resolve(false)
  const home = (workspaceId: string | null | undefined): StoreHome => sync?.homeFor(workspaceId ?? null) ?? null

  /** The writers a write carries: the request's own for an admin caller, else the caller as a person. */
  const stamp = <T extends { addedBy?: Writer; writtenBy?: Writer }>(input: T, principal: Principal): { input: T; writer: Writer } => {
    const writer = writerOf(principal)
    const keep = allows(principalCaps(principal), 'admin')
    return { input: { ...input, addedBy: (keep && input.addedBy) || writer, writtenBy: (keep && input.writtenBy) || writer }, writer }
  }

  /** A write routes by the scope it lands in, so a row may not move between the box's copy and this host's own: the follow would undo it. */
  const sameHome = (from: { workspaceId: string | null } | null, to: string | null, name: string): void => {
    if (!from || from.workspaceId === to || (home(from.workspaceId)?.name ?? null) === (home(to)?.name ?? null)) return
    throw new Error(`refused: ${name} cannot move between the box's copy and this host's own; remove it and add it again`)
  }

  async function setAddon(raw: AddonInput, principal: Principal): Promise<{ addon: AddonRow }> {
    const problem = addonProblem(raw.spec, raw.name)
    if (problem) throw new Error(`refused: ${problem}`)
    sameHome(raw.id ? addons.get(raw.id) : null, raw.workspaceId, raw.name)
    const { input, writer } = stamp(raw, principal)
    if (await forward('addons.set', { addon: input }, input.workspaceId)) {
      const row = (input.id && addons.get(input.id)) || addons.byName(input.workspaceId, input.name)
      if (!row) throw new Error(`the add-on ${input.name} did not come back from the home`)
      return { addon: row }
    }
    return { addon: addons.set(input, writer) }
  }

  async function setSkill(raw: SkillInput, principal: Principal): Promise<{ skill: SkillMeta }> {
    const problem = skillProblem(raw.name, raw.files.map((f) => ({ path: f.path, bytes: fileBytes(f) })))
    if (problem) throw new Error(`refused: ${problem}`)
    sameHome(raw.id ? skills.meta(raw.id) : null, raw.workspaceId, raw.name)
    const { input, writer } = stamp(raw, principal)
    if (await forward('skills.set', { skill: input }, input.workspaceId)) {
      const meta = (input.id && skills.meta(input.id)) || skills.byName(input.workspaceId, input.name)
      if (!meta) throw new Error(`the skill ${input.name} did not come back from the home`)
      return { skill: meta }
    }
    return { skill: skills.set(input, writer) }
  }

  async function handle(req: StoreRequest, principal: Principal): Promise<unknown> {
    switch (req.method) {
      case 'addons.list':
        return { addons: addons.list(), status: addons.status(), home: home(req.params?.workspaceId) } satisfies AddonsList
      case 'addons.set':
        return setAddon(req.params.addon, principal)
      case 'addons.remove': {
        const row = addons.get(req.params.id)
        if (!row) return { removed: false }
        if (await forward('addons.remove', { id: row.id }, row.workspaceId)) return { removed: true }
        const removed = addons.remove(row.id)
        if (removed) deps.onAddonRemoved?.(row.id)
        return { removed }
      }
      case 'addons.tools': {
        const cached = addons.tools(req.params.id)
        return { tools: cached?.tools ?? [], fetchedAt: cached?.fetchedAt ?? null } satisfies AddonToolsAnswer
      }
      case 'skills.list':
        return { skills: skills.list(), home: home(req.params?.workspaceId) } satisfies SkillsList
      case 'skills.get': {
        const skill = skills.get(req.params.id)
        if (!skill) throw new Error(`unknown skill: ${req.params.id}`)
        return { skill } satisfies { skill: Skill }
      }
      case 'skills.set':
        return setSkill(req.params.skill, principal)
      case 'skills.remove': {
        const meta = skills.meta(req.params.id)
        if (!meta) return { removed: false }
        if (await forward('skills.remove', { id: meta.id }, meta.workspaceId)) return { removed: true }
        return { removed: skills.remove(meta.id) }
      }
    }
  }

  return { handle }
}
