import type { ServerPush } from '@shared/contract'
import {
  PUBLISH_OFFER,
  PublishCallerSchema,
  PublishStartParamsSchema,
  PublishStopParamsSchema,
  isPublishPeerMethod,
  type PublishCallParams,
  type PublishPeerMethod,
  type PublishRun
} from '@shared/contract-publish'
import type { Publisher } from '../hostJobs'
import { servePeerCall, type LinkRequest } from './peerCalls'

export interface MacPublishDeps {
  environmentId: string
  environments: () => { id: string; name: string }[]
  link: (id: string) => LinkRequest | null
  publisher: Publisher
  git?: (args: string[], cwd: string) => Promise<string>
  log?: (line: string) => void
}

/** The Mac half of the publish offer; the box has already cut and pushed the release. */
export class MacPublish {
  private active = false
  private connection = -1

  constructor(private readonly deps: MacPublishDeps) {}

  onPeerPush(envId: string, push: ServerPush): boolean {
    if (push.push !== 'peer.call' || !isPublishPeerMethod(push.method)) return false
    const request = this.deps.link(envId)
    if (!request) return true
    void servePeerCall(
      push,
      envId,
      (method, params, ctx) =>
        this.handle(method as PublishPeerMethod, params as PublishCallParams, ctx),
      request,
      this.deps.log
    )
    return true
  }

  async handle(
    method: PublishPeerMethod,
    params: PublishCallParams,
    ctx: { from: string; deadlineAt: number; progress?: (chunk: string) => void }
  ): Promise<PublishRun | { stopped: true }> {
    if (!this.deps.environments().some((env) => env.id === ctx.from))
      throw new Error('this Mac does not know that host')
    const caller = PublishCallerSchema.parse(params?.caller)
    if (caller.environmentId !== ctx.from)
      throw new Error('the call names another host as its caller')
    const publisher = this.deps.publisher
    if (method === 'publish.stop') {
      PublishStopParamsSchema.parse(params)
      publisher.stop()
      return { stopped: true }
    }
    const { args } = PublishStartParamsSchema.parse(params)
    // Hold this slot through the pull, so a second peer cannot move the checkout beneath a job.
    if (this.active || publisher.log.status.phase === 'running')
      throw new Error('a publish is already running')
    this.active = true
    try {
      const cwd = publisher.checkout()
      const git = (argv: string[]): Promise<string> =>
        this.deps.git ? this.deps.git(argv, cwd) : publisher.git(argv, cwd)
      await git(['fetch', 'origin'])
      await git(['pull', '--ff-only', 'origin', args.branch])
      const head = (await git(['rev-parse', 'HEAD'])).trim()
      if (head.toLowerCase() !== args.sha.toLowerCase())
        throw new Error(
          `the Mac's checkout is at ${head.slice(0, 7)} after the pull, not ${args.sha.slice(0, 7)}`
        )
      const version: unknown = (
        JSON.parse(await git(['show', 'HEAD:package.json'])) as { version?: unknown }
      ).version
      if (version !== args.version)
        throw new Error(`the Mac's checkout is at ${String(version)}, not ${args.version}`)

      if (Date.now() >= ctx.deadlineAt) throw new Error('the publish deadline passed')

      let off = (): void => {}
      let timer: NodeJS.Timeout | undefined
      try {
        return await new Promise<PublishRun>((resolve, reject) => {
          const finish = (): void => {
            const { status, text } = publisher.log.snapshot()
            if (status.phase !== 'done') return
            const last = text
              .split(/\r?\n/)
              .map((line) => line.trim())
              .filter(
                (line) => line && !/^== (?:release |exited |stopped \(|stop requested$)/.test(line)
              )
              .at(-1)
            resolve({
              ok: status.exit === 0,
              exit: status.exit,
              version: args.version,
              text:
                status.exit === 0
                  ? `Published ${args.version}`
                  : last || `Publish exited ${status.exit ?? 'without a status'}`
            })
          }
          off = publisher.log.subscribe(this.connection--, (push) => {
            if (push.append) ctx.progress?.(push.append)
            if (push.status.phase === 'done') finish()
          })
          timer = setTimeout(
            () => reject(new Error('the publish deadline passed')),
            Math.max(0, ctx.deadlineAt - Date.now())
          )
          timer.unref()
          void Promise.resolve()
            .then(() => publisher.publish(args.notes, { train: false }))
            .then(finish, reject)
        })
      } finally {
        off()
        clearTimeout(timer)
      }
    } finally {
      this.active = false
    }
  }
}

export const macPublishOffers = (): string[] => [PUBLISH_OFFER]
