import { z } from 'zod'

// Deploy and publish from the app (docs/box.md "Updating" → "Deploy from the
// app"; CLAUDE.md "Releases"). Two jobs, one per host kind, each pressed by
// the user in Settings → Hosts and streamed back as a log:
//
//  - `deploy` on the box: `host.deploy {ref}` drops the ref into the
//    root-owned trigger directory (`/run/temp-code/deploy/request`), where
//    temp-code-deploy.path starts box-update as root; the app only writes
//    the request and reads the log and exit files. Admin: the Mac calls it
//    over the box's link.
//  - `publish` on the Mac: `host.publish {notes}` runs the local train
//    (`bun scripts/release.ts "…"`) and `bun run release:publish` in the
//    checkout the `release.checkout` setting names. Local only: it signs and
//    uploads from this machine's Keychain, and no key ever reaches it.
//
// `host.log {job}` answers the whole log so far and subscribes the calling
// socket to `host-log` pushes until it closes; after the box restarts into
// the new build (dropping the link), the renderer calls it again and gets
// the log from the start.

export const HOST_JOBS = ['deploy', 'publish'] as const
export type HostJob = (typeof HOST_JOBS)[number]
export const HostJobSchema = z.enum(HOST_JOBS)

/** What the trigger accepts: master or a published tag. The runner on the box checks the same. */
export const DEPLOY_REF = /^(master|v1\.0\.\d+)$/
export const DeployRefSchema = z.string().regex(DEPLOY_REF, 'master or a v1.0.N tag only')

/** Where a job is: nothing yet since boot, the request dropped and not yet
 *  picked up, running, or finished with its exit status. */
export type HostJobPhase = 'idle' | 'pending' | 'running' | 'done'

export interface HostJobStatus {
  job: HostJob
  phase: HostJobPhase
  /** The ref (deploy) or the version (publish) the run is for. */
  target: string | null
  startedAt: number | null
  finishedAt: number | null
  /** The exit status once done; 0 is success. */
  exit: number | null
  /** The deploy job cannot be stopped once the trigger has it; the publish job can. */
  stoppable: boolean
}

/** → `host.deployStatus`: the box's side of the button. */
export interface DeployStatus extends HostJobStatus {
  job: 'deploy'
  /** The trigger directory exists and this process can write a request there. */
  installed: boolean
  /** What to run once when it is not: the install line the refusal names too. */
  installHint: string
  /** The version this host runs now (its package.json). */
  version: string
}

/** → `host.publishStatus`: the Mac's side of the button. */
export interface PublishStatus extends HostJobStatus {
  job: 'publish'
  /** The `release.checkout` setting, expanded. */
  checkout: string
  /** The checkout is a git repository the status could be read from; the other fields are null when not. */
  readable: boolean
  branch: string | null
  dirty: boolean
  /** package.json's 1.0.N at HEAD. */
  version: string | null
  /** package.json's 1.0.N at origin/master (what the box deploys), else HEAD's. */
  masterVersion: string | null
  /** The newest v1.0.* tag in the checkout: the last version published. */
  publishedVersion: string | null
  /** Commit subjects since that tag, newest first, each cut to its first clause. */
  commits: string[]
  /** The one-line notes the field is prefilled with. */
  notes: string
  /** Why a publish would be refused right now, or null. */
  refusal: string | null
}

export type HostLogPush = {
  push: 'host-log'
  job: HostJob
  /** Text to append; absent on a status-only push. */
  append?: string
  /** The log started over (a new run): drop what was shown before appending. */
  reset?: boolean
  status: HostJobStatus
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
const request = <M extends string, P extends z.ZodType>(method: M, params: P) =>
  z.object({ id: z.string(), method: z.literal(method), params })

export const HostRequestSchemas = [
  /** → DeployStatus. Admin: the box's, read over its link. */
  request('host.deployStatus', z.object({}).optional()),
  /** → DeployStatus once the request is dropped. Refuses a run in progress or a missing trigger. */
  request('host.deploy', z.object({ ref: DeployRefSchema })),
  /** → PublishStatus. Local only. */
  request('host.publishStatus', z.object({}).optional()),
  /** → PublishStatus once the scripts are running. Refuses a dirty tree, a branch other than master, a published version, or a run in progress. */
  request('host.publish', z.object({ notes: z.string().min(1).max(2000) })),
  /** → PublishStatus; kills the running scripts (the whole process group). */
  request('host.publishStop', z.object({}).optional()),
  /** → PublishStatus; sets `release.checkout` (empty puts back the default). */
  request('host.releaseCheckout.set', z.object({ checkout: z.string().max(1024) })),
  /** → { text, status }: the log so far, and this socket hears `host-log` for the job from now on. */
  request('host.log', z.object({ job: HostJobSchema }))
] as const
