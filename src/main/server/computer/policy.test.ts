import { describe, expect, it } from 'vitest'
import type { AppInfo, ComputerAction, ComputerError } from '@shared/computer/protocol'
import { ElementBook } from './elements'
import {
  LAUNCH_REGISTER_MS,
  REFUSED_LAUNCH_BUNDLES,
  TEMPCODE_BUNDLE_ID,
  TargetResolver,
  passwordTarget,
  refusedLaunch,
  refusedOpenItem,
  refusedTarget,
  textTargetProblem,
  type AppsSource
} from './policy'

const app = (name: string, pid: number, bundleId: string | null = `com.example.${name.toLowerCase().replace(/ /g, '')}`): AppInfo => ({
  name,
  pid,
  bundleId,
  active: false,
  hidden: false
})

class NotFound extends Error {
  constructor(readonly data: ComputerError) {
    super(data.message)
  }
}

/** A Mac with these apps running and these installed; launch adds one, showing in the list after `registerAfter` lists. */
function mac(running: AppInfo[], installed: AppInfo[] = [], registerAfter = 0) {
  const live = [...running]
  const log: string[] = []
  let pending: { app: AppInfo; lists: number } | null = null
  const src: AppsSource = {
    list: async () => {
      log.push('list')
      if (pending && pending.lists-- <= 0) {
        live.push(pending.app)
        pending = null
      }
      return [...live]
    },
    launch: async (q) => {
      log.push(`launch ${q}`)
      const hit = [...live, ...installed].find((a) => a.name.toLowerCase() === q.toLowerCase() || a.bundleId?.toLowerCase() === q.toLowerCase())
      if (!hit) throw new NotFound({ kind: 'app_not_found', message: 'no such app', candidates: installed.map((a) => a.name) })
      if (!live.includes(hit)) pending = { app: hit, lists: registerAfter }
      return { pid: hit.pid, launched: !live.includes(hit) }
    },
    sleep: async () => undefined
  }
  return { src, log, live }
}
const dataOf = (e: unknown): ComputerError | null => (e instanceof NotFound ? e.data : null)

describe('resolveTarget', () => {
  it('takes a running app by bundle id, then by name, from one cached list', async () => {
    const r = new TargetResolver()
    const m = mac([app('Mail', 10, 'com.apple.mail'), app('TextEdit', 11, 'com.apple.TextEdit')])
    expect(await r.resolve('com.apple.TextEdit', m.src, dataOf)).toEqual({ app: { pid: 11, bundleId: 'com.apple.TextEdit', name: 'TextEdit' } })
    expect(await r.resolve('mail', m.src, dataOf)).toEqual({ app: { pid: 10, bundleId: 'com.apple.mail', name: 'Mail' } })
    expect(m.log).toEqual(['list'])
    r.invalidate()
    await r.resolve('Mail', m.src, dataOf)
    expect(m.log).toEqual(['list', 'list'])
  })

  it('launches an installed app and pins the pid it answered from a fresh list', async () => {
    const r = new TargetResolver()
    const m = mac([], [app('Preview', 30, 'com.apple.Preview')], 2)
    expect(await r.resolve('Preview', m.src, dataOf)).toEqual({ app: { pid: 30, bundleId: 'com.apple.Preview', name: 'Preview' } })
    expect(m.log).toEqual(['list', 'launch Preview', 'list', 'list', 'list'])
  })

  it('launches Preview, not the running Preview Beta a prefix would have taken', async () => {
    const r = new TargetResolver()
    const m = mac([app('Preview Beta', 40)], [app('Preview', 30, 'com.apple.Preview')])
    expect(await r.resolve('Preview', m.src, dataOf)).toEqual({ app: { pid: 30, bundleId: 'com.apple.Preview', name: 'Preview' } })
  })

  it('takes a unique prefix only after launch found nothing', async () => {
    const r = new TargetResolver()
    const m = mac([app('Xcode', 50), app('Mail', 10)])
    expect(await r.resolve('Xco', m.src, dataOf)).toEqual({ app: { pid: 50, bundleId: 'com.example.xcode', name: 'Xcode' } })
    expect(m.log).toEqual(['list', 'launch Xco'])
  })

  it('an ambiguous prefix answers app_not_found with its candidates, and nothing more is sent', async () => {
    const r = new TargetResolver()
    const m = mac([app('Xcode', 50), app('Xcode-beta', 51)])
    expect(await r.resolve('Xcod', m.src, dataOf)).toEqual({ line: 'no app matches "Xcod"; close names: Xcode, Xcode-beta (computer_apps lists them all)' })
  })

  it('refuses a launched pid that never shows in the list', async () => {
    const r = new TargetResolver()
    const m = mac([], [app('Ghost', 60)], 1_000)
    const out = await r.resolve('Ghost', m.src, dataOf)
    expect(out).toEqual({ line: "couldn't check which app this is, so nothing was sent; try the call again" })
    expect(m.log.filter((l) => l === 'list').length).toBe(LAUNCH_REGISTER_MS / 100 + 2)
  })

  it('passes on an error that is not app_not_found', async () => {
    const r = new TargetResolver()
    const src: AppsSource = { list: async () => [], launch: async () => Promise.reject(new Error('down')), sleep: async () => undefined }
    await expect(r.resolve('X', src, dataOf)).rejects.toThrow('down')
  })
})

describe('refusedTarget', () => {
  it('refuses reads and acts on TempCode itself, by pid and by the installed bundle id', () => {
    expect(refusedTarget({ pid: 7, bundleId: 'com.github.Electron' }, 'read', 7)).toBe("TempCode's own window is off limits to computer use")
    expect(refusedTarget({ pid: 8, bundleId: TEMPCODE_BUNDLE_ID }, 'read', 7)).toBe("TempCode's own window is off limits to computer use")
    expect(refusedTarget({ pid: 8, bundleId: 'com.github.Electron' }, 'act', 7)).toBeNull()
  })

  it("refuses acts, not reads, on the system's password and Touch ID prompts", () => {
    for (const bundleId of ['com.apple.SecurityAgent', 'com.apple.LocalAuthentication.UIAgent']) {
      expect(refusedTarget({ pid: 9, bundleId }, 'act', 7)).toBe("macOS's password and Touch ID prompts are the person's to answer")
      expect(refusedTarget({ pid: 9, bundleId }, 'read', 7)).toBeNull()
    }
  })

  it('refuses computer_apps { launch } of a refused app', () => {
    expect(refusedLaunch('TempCode')).toMatch(/^TempCode's own window/)
    expect(refusedLaunch(TEMPCODE_BUNDLE_ID)).toMatch(/^TempCode's own window/)
    expect(refusedLaunch('com.apple.securityagent')).toMatch(/^macOS's password/)
    expect(refusedLaunch('TextEdit')).toBeNull()
  })
})

const read = (text: string): ElementBook => {
  const book = new ElementBook()
  book.apply(text, 'full')
  return book
}
const LOGIN = 'app "Safari" · window "Sign in" · 800×600 · focused [3]\n[1] window "Sign in"\n  [2] input "Email"\n  [3] password "Password" focused\n  [4] button "Sign in"'
const NO_FOCUS = LOGIN.replace(' · focused [3]', '').replace(' focused', '')
const PLAIN = 'app "Safari" · window "Search" · 800×600\n[1] window "Search"\n  [2] input "Search"'

describe('passwordTarget', () => {
  const type = (element?: number): ComputerAction => ({ action: 'type', text: 'x', ...(element ? { element } : {}) }) as ComputerAction

  it('asks for a step into a password element, named or focused', () => {
    expect(passwordTarget([type(3)], read(LOGIN))).toEqual({ kind: 'password', what: '' })
    expect(passwordTarget([type()], read(LOGIN))).toEqual({ kind: 'password', what: '' })
    expect(passwordTarget([{ action: 'set_value', element: 3, value: 'x' } as ComputerAction], read(LOGIN))).not.toBeNull()
    expect(passwordTarget([type(2)], read(LOGIN))).toBeNull()
  })

  it('with no focused element, asks when the window shows a password field and not otherwise', () => {
    expect(passwordTarget([type()], read(NO_FOCUS))).not.toBeNull()
    expect(passwordTarget([type()], read(PLAIN))).toBeNull()
    expect(passwordTarget([{ action: 'left_click', element: 3 } as ComputerAction], read(LOGIN))).toBeNull()
    expect(passwordTarget([type()], undefined)).toBeNull()
  })
})

describe('textTargetProblem', () => {
  it('refuses type or paste without element after another input step, and accepts it first', () => {
    const click = { action: 'left_click', element: 2 } as ComputerAction
    expect(textTargetProblem([click, { action: 'type', text: 'x' } as ComputerAction])).toMatch(/type and paste after another action name their element/)
    expect(textTargetProblem([click, { action: 'paste', text: 'x' } as ComputerAction])).not.toBeNull()
    expect(textTargetProblem([{ action: 'type', text: 'x' } as ComputerAction, click])).toBeNull()
    expect(textTargetProblem([{ action: 'screenshot' } as ComputerAction, { action: 'type', text: 'x' } as ComputerAction])).toBeNull()
    expect(textTargetProblem([click, { action: 'type', text: 'x', element: 3 } as ComputerAction])).toBeNull()
  })
})

describe('the front guard at the resolver (§23)', () => {
  it("keeps a launch's front report beside the app when it came forward, and drops one that did not", async () => {
    const front = { raised: true, restored: 'restored' as const, ms: 140 }
    const withFront = (raised: boolean): AppsSource => ({
      list: async () => [app('Preview', 30, 'com.apple.Preview')],
      launch: async () => ({ pid: 30, launched: true, front: raised ? front : { raised: false } }),
      sleep: async () => undefined
    })
    const pinned = { pid: 30, bundleId: 'com.apple.Preview', name: 'Preview' }
    expect(await new TargetResolver().resolve('Prev', withFront(true), dataOf)).toEqual({ app: pinned, front })
    expect(await new TargetResolver().resolve('Prev', withFront(false), dataOf)).toEqual({ app: pinned })
  })

  it('names the app in front from the cached list, or nothing when none is cached', async () => {
    const r = new TargetResolver()
    expect(r.activeName()).toBeNull()
    await r.resolve('Mail', { list: async () => [app('Mail', 10), { ...app('Safari', 12), active: true }], launch: async () => ({ pid: 0, launched: false }), sleep: async () => undefined }, dataOf)
    expect(r.activeName()).toBe('Safari')
    r.invalidate()
    expect(r.activeName()).toBeNull()
  })

  it('sends TempCode and the prompts as the bundles no launch may touch', () => {
    expect(REFUSED_LAUNCH_BUNDLES).toEqual([TEMPCODE_BUNDLE_ID, 'com.apple.SecurityAgent', 'com.apple.LocalAuthentication.UIAgent'])
  })

  it('opens web pages, file URLs and absolute paths, and refuses every other scheme before the card', () => {
    for (const ok of ['https://example.com', 'http://localhost:5173/a', 'file:///tmp/a.txt', '/Users/me/report.pdf', '/tmp/folder/'])
      expect(refusedOpenItem(ok), ok).toBeNull()
    for (const bad of ['ftp://x.test/a', 'javascript:alert(1)', 'mailto:a@b.c', 'ssh://box', 'report.pdf', '~/a.txt'])
      expect(refusedOpenItem(bad), bad).toBe('only http, https and file items open; give a web page, a file or a folder')
  })
})
