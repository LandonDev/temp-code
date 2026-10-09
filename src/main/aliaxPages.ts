import { BrowserWindow, ipcMain, shell } from 'electron'
import { existsSync, renameSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { accounts, adapter, vault, type ActionResult, type ServiceId } from 'aliax-core'
import * as login from './aliax/login'
import { indexAll, indexProgress } from './aliax/stats/indexer'
import { bundle, invalidate } from './aliax/stats/queries'
import { recordUsage } from './aliax/stats/store'
import { ACCOUNT_PROVIDERS, SERVICE_OF, type AccountsSnapshot } from '@shared/accounts'

/**
 * The main-process half of the embedded Aliax pages (Accounts, Stats): the
 * IPC Aliax's own window calls, ported from Aliax src/main/ipc.ts with the
 * same names behind an `aliax:` prefix. Everything that touches the vault,
 * the Keychain or a provider goes through aliax-core exactly as Aliax does,
 * so the invariants in Aliax's CLAUDE.md hold here by construction: identity
 * from credentials (capture/repairProfiles), a switch proven before it is
 * reported (activate verifies), adding never switches (loginStart only
 * saves, except the same-account repair Aliax also makes), and a session is
 * never deleted — only its saved profile.
 *
 * Usage polling is NOT here: the server's AccountsService already polls every
 * account for the gateway and pushes the snapshot the pages read, so a page
 * only ever nudges that one poll.
 */

const asResult = async (fn: () => Promise<ActionResult>): Promise<ActionResult> => {
  try {
    return await fn()
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

let nudge: (() => void) | null = null

/** Per-channel call counts, for the dev-only CDP check that the pages never poll in a storm. */
const calls: Record<string, number> = {}
export const aliaxCallCounts = (): Record<string, number> => ({ ...calls })
const counted = <A extends unknown[], R>(channel: string, fn: (...args: A) => R): ((...args: A) => R) => {
  calls[channel] = 0
  return (...args: A): R => {
    calls[channel]++
    return fn(...args)
  }
}
const handle = <A extends unknown[], R>(
  channel: string,
  fn: (event: Electron.IpcMainInvokeEvent, ...args: A) => R
): void => {
  const f = counted(channel, fn)
  ipcMain.handle(channel, (event, ...args) => f(event, ...(args as A)))
}

/** Every window redraws its Aliax pages; the shared poll rebuilds once. */
export function notifyAccountsChanged(): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('aliax:accounts:changed')
  }
  nudge?.()
}

/**
 * Sign in and store the new account WITHOUT making it live. Adding is a
 * library action; switching stays an explicit, separate choice.
 */
async function loginStart(serviceId: ServiceId, loginHint?: string): Promise<ActionResult> {
  switch (serviceId) {
    case 'claude-code': {
      // One window: signing in gives us the app session, approving gives us the
      // CLI tokens. Both halves, no code to paste. A hint pre-fills the address
      // when an expired account signs itself back in.
      const captured = await login.claudeSignIn(loginHint)
      if (!captured) return { ok: false, error: 'sign-in cancelled' }
      const already = vault.profiles(serviceId).find((p) => p.accountId === captured.accountId)
      // A full sign-in always carries credentials, so this never skips.
      const name = accounts.saveCaptured(serviceId, captured) ?? undefined
      // A token can be revoked ahead of its recorded expiry, where only the
      // failed poll knows the sign-in is dead — read that flag before the
      // cache clear strips it.
      const wasExpired = name ? accounts.reportedExpired(serviceId, name) : false
      accounts.clearUsageCache(serviceId, name)
      const notes = [
        captured.note ?? '',
        already ? 'this account was already saved, so it was refreshed' : ''
      ].filter(Boolean)
      // Re-signing the account the CLI is already on, while its sign-in is dead
      // (token past expiry, or revoked early per the last poll): install the
      // fresh credentials too. The account does not change, so this is a
      // repair, not a switch (invariant 6) — and without it the new tokens are
      // stranded, because the active row offers no Switch button.
      const a = adapter(serviceId)
      const liveId = await a.liveAccountId().catch(() => null)
      if (
        name &&
        liveId === captured.accountId &&
        (wasExpired || (await a.liveCredentialExpired?.().catch(() => false)))
      ) {
        const repaired = await accounts.activate(serviceId, name)
        notes.push(
          repaired.ok
            ? 'CLI sign-in repaired'
            : `saved, but the CLI still holds a dead sign-in (${repaired.error})`
        )
      }
      return { ok: true, name, notes }
    }
    case 'cursor': {
      const captured = await login.cursorLogin()
      const name = accounts.saveCaptured(serviceId, captured) ?? undefined
      accounts.clearUsageCache(serviceId, name)
      return { ok: true, name }
    }
    case 'codex': {
      // The official `codex login` writes auth.json itself, so snapshot the current
      // login first and put it back afterwards to leave the live account untouched.
      const a = adapter(serviceId)
      await accounts.recaptureLive(a).catch(() => {})
      const previous = await a.capture(accounts.extra(serviceId, 'pre-login')).catch(() => null)
      // `codex login` REVOKES the grant sitting in auth.json before signing in
      // (the binary ships login/src/auth/revoke.rs and runs it as logout-first),
      // which is how adding account B used to kill saved account A. Move the
      // file out of its sight; the snapshot and the vault still hold the login.
      const authPath = join(homedir(), '.codex', 'auth.json')
      const stash = `${authPath}.aliax-prelogin`
      if (previous?.blob && existsSync(authPath)) renameSync(authPath, stash)
      try {
        await login.codexLogin()
        return await accounts.capture(serviceId)
      } finally {
        const liveId = await a.liveAccountId().catch(() => null)
        if (previous?.blob && liveId && liveId !== previous.accountId) {
          // Empty target set: write the old credentials back, restart nothing.
          await a
            .activate(previous.blob, accounts.extra(serviceId, 'pre-login'), new Set())
            .catch(() => {})
        } else if (!liveId && existsSync(stash)) {
          // Login failed or was cancelled: put the original file straight back.
          renameSync(stash, authPath)
        }
        // Re-adding the live account keeps the fresh grant instead of the old one.
        rmSync(stash, { force: true })
        accounts.clearUsageCache(serviceId)
      }
    }
  }
}

function loginCancel(serviceId: ServiceId): void {
  if (serviceId === 'claude-code') login.claudeLoginCancel()
  if (serviceId === 'cursor') login.cursorLoginCancel()
  if (serviceId === 'codex') login.codexLoginCancel()
}

/**
 * Every rebuilt snapshot lands in the stats store, whoever polled it: when
 * Aliax holds the gateway our poll only reads its cache, so the core's
 * own sample hook stays quiet here and the pace curves would have holes.
 * recordUsage de-duplicates per (service, account, window, minute).
 */
function recordSnapshot(snapshot: AccountsSnapshot): void {
  for (const p of ACCOUNT_PROVIDERS) {
    for (const r of snapshot.providers[p].reports) {
      for (const w of r.windows) {
        recordUsage(SERVICE_OF[p], r.profileName, w.label, w.usedPercent, w.resetsAt, w.periodMs)
      }
    }
  }
}

export interface AliaxPagesHost {
  nudge(): void
  onChange(listener: (snapshot: AccountsSnapshot) => void): () => void
}

export function registerAliaxPages(server: { accounts: AliaxPagesHost }): void {
  nudge = () => server.accounts.nudge()
  server.accounts.onChange(recordSnapshot)
  vault.ensureColors()
  // Codex rotates its refresh token in place; the vault copy follows every
  // rotation or a later switch would present a revoked one (invariant 18).
  accounts.watchLiveCredentials()
  // Pull in anything new from the CLIs' own logs. Incremental, so this is cheap
  // after the first run; a seeded store only reads what grew since. The store
  // is ours alone (see stats/store.ts), so this never races Aliax's indexer.
  indexAll()
    .then(invalidate)
    .catch(() => {})
  // Relabel any profile whose stored credentials belong to a different account.
  for (const id of ['claude-code', 'codex', 'cursor'] as ServiceId[]) {
    accounts.repairProfiles(id).catch(() => {})
  }

  handle('aliax:services:list', () => accounts.listServices())
  handle('aliax:profiles:capture', (_e, serviceId: ServiceId) =>
    asResult(async () => {
      const result = await accounts.capture(serviceId)
      notifyAccountsChanged()
      return result
    })
  )
  handle('aliax:profiles:activate', (_e, serviceId: ServiceId, name: string) =>
    asResult(async () => {
      const result = await accounts.activate(serviceId, name)
      notifyAccountsChanged()
      return result
    })
  )
  handle('aliax:profiles:delete', (_e, serviceId: ServiceId, name: string) =>
    asResult(async () => {
      vault.deleteProfile(serviceId, name)
      notifyAccountsChanged()
      return { ok: true }
    })
  )
  handle(
    'aliax:profiles:update',
    (_e, serviceId: ServiceId, name: string, patch: { nickname?: string; color?: string }) =>
      asResult(async () => {
        const result = await accounts.updateProfile(serviceId, name, patch)
        notifyAccountsChanged()
        return result
      })
  )
  handle('aliax:login:start', (_e, serviceId: ServiceId, loginHint?: string) =>
    asResult(async () => {
      const result = await loginStart(serviceId, loginHint)
      notifyAccountsChanged()
      return result
    })
  )
  handle('aliax:login:cancel', (_e, serviceId: ServiceId) => loginCancel(serviceId))
  handle('aliax:open:external', (_e, url: string) => {
    // Only ever http(s): never hand an arbitrary scheme to the OS.
    if (/^https?:\/\//.test(String(url))) void shell.openExternal(String(url))
  })
  handle('aliax:stats:get', () => bundle())
  handle('aliax:stats:status', () => {
    const p = indexProgress()
    return { indexing: p.running, filesDone: p.filesDone, filesTotal: p.filesTotal, rows: p.rows }
  })
  handle('aliax:stats:reindex', () =>
    asResult(async () => {
      await indexAll()
      invalidate()
      return { ok: true }
    })
  )
}
