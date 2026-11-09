import { describe, expect, it } from 'vitest'
import { parseMapping } from '../pathMap'
import { MemorySync } from '../remote/memorySync'
import { SKILL_ROOTS, localizeSkillFile, localizeSkillText, mentionedSkills, skillTextMap, textKey, type TextContext } from './skillText'

const MAC = '/Users/landon'
const BOX = '/srv/agents/home'
const WORK = '/srv/agents/work'
// The shipped map's shape: the Mac's checkouts → the box's work root.
const base = parseMapping(JSON.stringify({ roots: { [`${MAC}/IdeaProjects/temp-code`]: `${WORK}/temp-code` }, prefixes: {} }))

/** A host's MemorySync, for its translationFor: the rule memory sync uses both ways. */
const memorySyncOn = (home: string, workRoot: string): MemorySync =>
  new MemorySync({
    environmentId: 'env_x',
    store: { getSetting: () => null, setSetting: () => {} },
    peers: { get: () => undefined, all: () => [] },
    dataDir: '/tmp/unused',
    pathMap: () => base,
    home: () => home,
    workRoot: () => workRoot
  })

const ctx = (over: Partial<TextContext> = {}): TextContext => ({
  home: BOX,
  textMap: skillTextMap({ platform: 'linux', base, peers: [], translate: () => base }),
  viewSkillsDir: '/data/harness/claude/global/skills',
  names: new Set(['alpha', 'beta']),
  ...over
})

describe('skillTextMap', () => {
  it('reads the base map forward off darwin and inverted on the Mac while no peer is heard', () => {
    expect(skillTextMap({ platform: 'linux', base, peers: [], translate: () => ({ roots: {}, prefixes: {} }) })).toEqual(base)
    expect(skillTextMap({ platform: 'darwin', base, peers: [], translate: () => ({ roots: {}, prefixes: {} }) }).roots).toEqual({ [`${WORK}/temp-code`]: `${MAC}/IdeaProjects/temp-code` })
  })

  it('with a heard peer, a checkout the map lacks lands under the box\'s work root on the box and under ~/IdeaProjects on the Mac', () => {
    const onBox = memorySyncOn(BOX, WORK)
    const boxMap = skillTextMap({ platform: 'linux', base, peers: [{ environmentId: 'env_mac', home: MAC, workRoot: `${MAC}/IdeaProjects` }], translate: (h, w) => onBox.translationFor(h, w) })
    expect(localizeSkillText(`cd ${MAC}/IdeaProjects/x && ls ${MAC}/IdeaProjects/temp-code`, ctx({ textMap: boxMap }))).toBe(`cd ${WORK}/x && ls ${WORK}/temp-code`)
    const onMac = memorySyncOn(MAC, `${MAC}/IdeaProjects`)
    const macMap = skillTextMap({ platform: 'darwin', base, peers: [{ environmentId: 'env_box', home: BOX, workRoot: WORK }], translate: (h, w) => onMac.translationFor(h, w) })
    expect(localizeSkillText(`cd ${WORK}/x and ${BOX}/notes`, ctx({ home: MAC, textMap: macMap }))).toBe(`cd ${MAC}/IdeaProjects/x and ${MAC}/notes`)
  })

  it('merges every heard peer\'s map', () => {
    const map = skillTextMap({
      platform: 'linux',
      base,
      peers: [
        { environmentId: 'env_b', home: '/Users/b' },
        { environmentId: 'env_a', home: '/Users/a' }
      ],
      translate: (h) => ({ roots: {}, prefixes: { [h]: BOX } })
    })
    expect(map.prefixes).toEqual({ '/Users/a': BOX, '/Users/b': BOX })
  })
})

describe('localizeSkillText', () => {
  it('leaves text already in this host\'s terms as it is', () => {
    const text = `Run ${WORK}/temp-code/scripts/x.sh; see /data/harness/claude/global/skills/alpha/SKILL.md.`
    expect(localizeSkillText(text, ctx())).toBe(text)
  })

  it('rewrites each root in the absolute, ~, $HOME and ${HOME} forms for a skill of the view, and leaves the others', () => {
    for (const root of SKILL_ROOTS) {
      for (const home of [BOX, '~', '$HOME', '${HOME}']) {
        expect(localizeSkillText(`python3 ${home}/${root}/alpha/scripts/run.py`, ctx())).toBe('python3 /data/harness/claude/global/skills/alpha/scripts/run.py')
        expect(localizeSkillText(`python3 ${home}/${root}/gamma/scripts/run.py`, ctx())).toBe(`python3 ${home}/${root}/gamma/scripts/run.py`)
      }
    }
    // The Mac's spelling is first mapped to this home, then to the view.
    const map = skillTextMap({ platform: 'linux', base, peers: [{ home: MAC }], translate: (h) => ({ roots: {}, prefixes: { [h]: BOX } }) })
    expect(localizeSkillText(`${MAC}/.codex/skills/beta/x`, ctx({ textMap: map }))).toBe('/data/harness/claude/global/skills/beta/x')
  })

  it('takes a name only up to a boundary, and a home only after one', () => {
    for (const after of ['/', ' ', '\n', '"', "'", '`', ')', ']', '']) expect(localizeSkillText(`~/.claude/skills/alpha${after}`, ctx())).toBe(`/data/harness/claude/global/skills/alpha${after}`)
    for (const after of ['-x', 'x', '.md', '_2']) expect(localizeSkillText(`~/.claude/skills/alpha${after}`, ctx())).toBe(`~/.claude/skills/alpha${after}`)
    expect(localizeSkillText(`/opt${BOX}/.claude/skills/alpha/`, ctx())).toBe(`/opt${BOX}/.claude/skills/alpha/`)
    expect(localizeSkillText('a~/.claude/skills/alpha/', ctx())).toBe('a~/.claude/skills/alpha/')
    expect(localizeSkillText(`~/.claude/agents/alpha/`, ctx())).toBe('~/.claude/agents/alpha/')
  })
})

describe('localizeSkillFile', () => {
  const file = (path: string, bytes: Uint8Array | string) => ({ path, bytes: typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes, executable: false })

  it('rewrites only text files whose bytes are UTF-8, keeping a BOM, and the same object when nothing moved', () => {
    const md = file('SKILL.md', '﻿see ~/.claude/skills/alpha/x')
    const out = localizeSkillFile(md, ctx())
    expect(new TextDecoder('utf-8', { ignoreBOM: true }).decode(out.file.bytes)).toBe('﻿see /data/harness/claude/global/skills/alpha/x')
    expect(out.mentions).toEqual(['alpha'])
    const py = file('run.py', 'see ~/.claude/skills/alpha/x')
    expect(localizeSkillFile(py, ctx()).file).toBe(py)
    const bad = file('notes.md', Uint8Array.from([0x7e, 0x2f, 0xff, 0xfe]))
    expect(localizeSkillFile(bad, ctx()).file).toBe(bad)
    const plain = file('notes.md', 'nothing here')
    expect(localizeSkillFile(plain, ctx())).toEqual({ file: plain, mentions: [] })
  })
})

describe('mentionedSkills', () => {
  it('finds every name the second pass could rewrite, sorted, once each, in or out of the view', () => {
    const text = `~/.codex/skills/zeta/a and $HOME/.agents/skills/alpha/b and ${BOX}/.claude/skills/zeta and ~/.claude/plugins/alpha`
    expect(mentionedSkills(text, BOX)).toEqual(['alpha', 'zeta'])
  })
})

describe('textKey', () => {
  it('moves with the map, the home and the view\'s folder', () => {
    const one = textKey(ctx())
    expect(one).toMatch(/^[0-9a-f]{12}$/)
    expect(textKey(ctx())).toBe(one)
    expect(textKey(ctx({ home: '/home/other' }))).not.toBe(one)
    expect(textKey(ctx({ viewSkillsDir: '/data/harness/codex/global/skills' }))).not.toBe(one)
    expect(textKey(ctx({ textMap: { roots: {}, prefixes: { '/Users/x': BOX } } }))).not.toBe(one)
  })
})
