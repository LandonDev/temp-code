import { z } from 'zod'

// The Mac bridge's remember rules (docs/box.md "The Mac bridge: what a box
// thread may touch on the Mac", "Remembered approvals"). The person at the
// Mac answers a command's card with Allow and one of these, and later
// commands of the same thread that the rule covers start without a prompt:
//
//  - 'exact'   the same argv (or command string) in the same cwd
//  - 'folder'  any command whose cwd is under this folder
//  - 'program' any command whose program (argv[0], or a simple command
//              string's first word, path stripped) is this one, in any cwd
//  - 'thread'  every command from this thread
//
// A command on the always-ask list (macBridgeRules.ts ALWAYS_ASK) or one
// naming a credential path asks every time under every rule. Rules live in
// the Mac's memory only, per (host, thread), and end with the app, with the
// thread (the renderer forgets a removed thread's rules) or when forgotten.

export const MacRememberSchema = z.enum(['exact', 'folder', 'program', 'thread'])
export type MacRemember = z.infer<typeof MacRememberSchema>

/** What `macBridge.decide` takes as remember: true is the old checkbox (a read's folder, a run's exact command). */
export const MacDecideRememberSchema = z.union([z.boolean(), MacRememberSchema])
export type MacDecideRemember = z.infer<typeof MacDecideRememberSchema>

/** One remembered approval, as the thread's "Mac approvals" list shows it. */
export interface MacBridgeRule {
  id: string
  environmentId: string
  hostName: string
  sessionId: string
  threadTitle: string
  /** 'read-folder': reads under `folder`; the rest are commands. */
  kind: 'read-folder' | MacRemember
  /** read-folder and folder: the folder. */
  folder?: string
  /** program: the program's bare name. */
  program?: string
  /** exact: the command as shown on its card, and its cwd. */
  argv?: string[]
  command?: string
  cwd?: string
  createdAt: number
  /** Commands this rule let through without a prompt. */
  uses: number
}

/** What a run card offers beyond exact and thread; absent fields are not offered. */
export interface MacRunRememberOffer {
  /** The cwd, when it is narrower than the home directory. */
  folder?: string
  /** The program, for argv or a simple command string; never a shell or a wrapper like env. */
  program?: string
  /** Set when the command asks every time whatever is remembered: why (e.g. "sudo"). */
  alwaysAsk?: string
}

const request = <M extends string, P extends z.ZodType>(method: M, params: P) =>
  z.object({ id: z.string(), method: z.literal(method), params })
const sessionId = z.string().min(1).max(200)

export const MacBridgeRulesRequestSchemas = [
  /** → MacBridgeRule[], oldest first. No sessionId: every thread's. */
  request('macBridge.rules.list', z.object({ sessionId: sessionId.optional() }).optional()),
  /** → MacBridgeRule[] left for that thread. No ruleId: forget all of the thread's. */
  request(
    'macBridge.rules.forget',
    z.object({ sessionId, ruleId: z.string().min(1).max(100).optional() })
  )
] as const
