import type { ClientRequest } from '@shared/contract'
import type { Store } from './db'
import type { SessionRegistry } from './sessions'
import type { Notes } from './notes'
import type { ProjectLogos } from './projectLogos'
import type { AccountsService } from './accounts'
import { searchProject } from './search'
import { generateText } from './drivers/title'

interface Context {
  store: Store
  registry: SessionRegistry
  notes: Notes
  logos: ProjectLogos
  accounts: AccountsService
}
export async function handleM3a(
  req: ClientRequest,
  ctx: Context
): Promise<{ handled: true; result: unknown } | { handled: false }> {
  const done = (result: unknown = null): { handled: true; result: unknown } => ({
    handled: true,
    result
  })
  switch (req.method) {
    case 'session.pin':
      ctx.registry.setPinned(req.params.sessionId, req.params.pinned)
      return done()
    case 'text.generate':
      return done({ text: await generateText(req.params.prompt, { cwd: req.params.cwd }) })
    case 'workspace.getSnapshot':
      return done(ctx.store.getWorkspaceSnapshot(req.params?.window))
    case 'workspace.setSnapshot':
      ctx.store.setWorkspaceSnapshot(req.params.snapshot, req.params.window)
      return done()
    case 'notes.list':
      return done(ctx.notes.list())
    case 'notes.get':
      return done(ctx.notes.get(req.params.id))
    case 'notes.upsert':
      return done(ctx.notes.upsert(req.params.note))
    case 'notes.delete':
      ctx.notes.delete(req.params.id)
      return done()
    case 'search.project':
      return done(await searchProject(req.params.options))
    case 'session.search':
      return done(ctx.store.searchEvents(req.params))
    case 'projectLogo.save':
      return done(await ctx.logos.save(req.params.projectPath, req.params.sourcePath))
    case 'projectLogo.remove':
      await ctx.logos.remove(req.params.projectPath)
      return done()
    case 'accounts.list':
      return done(await ctx.accounts.list())
    case 'accounts.refresh':
      return done(await ctx.accounts.refresh(req.params.provider))
    default:
      return { handled: false }
  }
}
