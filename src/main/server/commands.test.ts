import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { configureCommandSkills, listCommands, SYNCED_SKILL_PREFIX } from './commands'
import { expandSlashRefs } from './slash'

const BUCKET = 'dadb678d-4a24-405c-909e-41d7a52007f8_f3651252-cb02-40e8-84fe-64342b30d4e2'

function write(path: string, body: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, body)
}

function skill(name: string, description: string): string {
  return `---\nname: "${name}"\ndescription: "${description}"\n---\n\n# ${name}\n`
}

let root: string
let home: string
let cwdN = 0
const savedHome = process.env.HOME
/** A fresh cwd per call: listCommands caches by provider and cwd. */
const freshCwd = (): string => {
  const cwd = join(root, `project-${cwdN++}`)
  mkdirSync(cwd, { recursive: true })
  return cwd
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'tc-commands-'))
  home = join(root, 'home')

  // Claude: one plain skill, one account-synced bucket the way the CLI lays it out.
  write(join(home, '.claude', 'skills', 'mine', 'SKILL.md'), skill('mine', 'My own skill'))
  const synced = join(home, '.claude', 'skills', 'synced')
  write(join(synced, `.bucket-${BUCKET}`), '')
  const bucket = join(synced, BUCKET)
  write(join(bucket, '.last-complete-round'), 'round sdk-ts')
  write(join(bucket, '.trash', 'gone', 'SKILL.md'), skill('gone', 'Trashed'))
  write(join(bucket, 'pdf', 'SKILL.md'), skill('pdf', 'From the frontmatter'))
  write(join(bucket, 'docx', 'SKILL.md'), skill('docx', 'Docx frontmatter'))
  write(join(bucket, 'no-manifest-row', 'SKILL.md'), skill('frontmatter-name', 'Only frontmatter'))
  write(join(bucket, 'pdf', 'reference', 'deep', 'SKILL.md'), skill('too-deep', 'Never read'))
  write(
    join(bucket, 'manifest.json'),
    JSON.stringify({
      lastUpdated: 1,
      skills: [
        { skillId: 'pdf', name: 'pdf', description: 'PDF from the manifest' },
        { skillId: 'docx', name: 'docx', description: 'Word from the manifest' },
        { skillId: 'not-on-disk', name: 'not-on-disk', description: 'Listed but absent' }
      ]
    })
  )
  // A second bucket with a torn manifest still yields its skills.
  const torn = join(synced, 'other-bucket')
  write(join(torn, 'manifest.json'), '{ "skills": [')
  write(join(torn, 'xlsx', 'SKILL.md'), skill('xlsx', 'Spreadsheets'))

  // Codex: one plain skill, the system skills, and a user skill that shadows one.
  const codex = join(home, '.codex', 'skills')
  write(join(codex, 'mine', 'SKILL.md'), skill('mine', 'Codex user skill'))
  write(join(codex, 'skill-creator', 'SKILL.md'), skill('skill-creator', 'User copy'))
  write(join(codex, '.system', '.codex-system-skills.marker'), '3eadc798bef12c4a')
  write(join(codex, '.system', 'imagegen', 'SKILL.md'), skill('imagegen', 'Make images'))
  write(join(codex, '.system', 'openai-docs', 'SKILL.md'), skill('openai-docs', 'OpenAI docs'))
  write(join(codex, '.system', 'skill-creator', 'SKILL.md'), skill('skill-creator', 'System copy'))
  write(join(codex, '.system', 'imagegen', 'agents', 'nested', 'SKILL.md'), skill('nested', 'Never read'))

  process.env.HOME = home
})

afterAll(async () => {
  if (savedHome === undefined) delete process.env.HOME
  else process.env.HOME = savedHome
  await rm(root, { recursive: true, force: true })
})

describe('listCommands: claude', () => {
  it('lists account-synced skills under the anthropic-skills: prefix', async () => {
    const commands = await listCommands('claude', freshCwd())
    const names = commands.map((c) => c.name)
    expect(names).toEqual(
      [
        'mine',
        `${SYNCED_SKILL_PREFIX}docx`,
        `${SYNCED_SKILL_PREFIX}frontmatter-name`,
        `${SYNCED_SKILL_PREFIX}pdf`,
        `${SYNCED_SKILL_PREFIX}xlsx`
      ].sort((a, b) => a.localeCompare(b))
    )
    expect(commands.every((c) => c.source === 'skill' && c.scope === 'user')).toBe(true)
  })

  it('prefers the manifest description, then the frontmatter', async () => {
    const byName = new Map((await listCommands('claude', freshCwd())).map((c) => [c.name, c]))
    expect(byName.get('anthropic-skills:pdf')?.description).toBe('PDF from the manifest')
    expect(byName.get('anthropic-skills:pdf')?.path).toBe(
      join(home, '.claude', 'skills', 'synced', BUCKET, 'pdf', 'SKILL.md')
    )
    expect(byName.get('anthropic-skills:frontmatter-name')?.description).toBe('Only frontmatter')
    expect(byName.get('anthropic-skills:xlsx')?.description).toBe('Spreadsheets')
  })

  it('skips dot-entries, manifest rows with no files, and anything deeper', async () => {
    const names = (await listCommands('claude', freshCwd())).map((c) => c.name).join(' ')
    expect(names).not.toMatch(/gone|not-on-disk|too-deep|last-complete|bucket-/)
  })

  it('expands a mid-message /anthropic-skills:<name> to the Skill tool', async () => {
    const cwd = freshCwd()
    const out = await expandSlashRefs('claude', cwd, 'make it a /anthropic-skills:pdf please')
    expect(out).toContain('invoke your "anthropic-skills:pdf" skill')
  })
})

describe('listCommands: codex', () => {
  it('lists the .system skills by their plain names', async () => {
    const commands = await listCommands('codex', freshCwd())
    expect(commands.map((c) => c.name)).toEqual(['imagegen', 'mine', 'openai-docs', 'skill-creator'])
    const imagegen = commands.find((c) => c.name === 'imagegen')
    expect(imagegen?.description).toBe('Make images')
    expect(imagegen?.path).toBe(join(home, '.codex', 'skills', '.system', 'imagegen', 'SKILL.md'))
  })

  it("lets the user's own skill shadow a system skill of the same name", async () => {
    const commands = await listCommands('codex', freshCwd())
    expect(commands.find((c) => c.name === 'skill-creator')?.description).toBe('User copy')
  })
})

describe('listCommands: the skills store', () => {
  afterEach(() => configureCommandSkills(null))

  /** A written-out generation's skills folder, as the materializer lays it out. */
  const generation = (name: string, skills: Record<string, string>): string => {
    const dir = join(root, 'harness', name, 'skills')
    for (const [skillName, words] of Object.entries(skills)) write(join(dir, skillName, 'SKILL.md'), skill(skillName, words))
    return dir
  }

  it('lists the store\'s skills from the folder written for the thread\'s workspace, a workspace generation shadowing the global one', async () => {
    const global = generation('claude/global@aaaaaaaaaaaa', { tidy: 'Global tidy' })
    const ws = generation('claude/ws-w1@bbbbbbbbbbbb', { tidy: 'Workspace tidy', deploy: 'Deploy it' })
    const inWs = freshCwd()
    configureCommandSkills({ storeDir: (_p, cwd) => (cwd === inWs ? ws : global), readHome: true })
    const outside = await listCommands('claude', freshCwd())
    expect(outside.find((c) => c.name === 'tidy')).toMatchObject({ description: 'Global tidy', scope: 'user', path: join(global, 'tidy', 'SKILL.md') })
    const inside = await listCommands('claude', inWs)
    expect(inside.find((c) => c.name === 'tidy')?.description).toBe('Workspace tidy')
    expect(inside.find((c) => c.name === 'deploy')).toBeDefined()
  })

  it('with readHome a home-only skill still lists and the store wins a shared name; without it the home\'s plain skills go, the CLI\'s own buckets stay', async () => {
    const dir = generation('claude/global@cccccccccccc', { mine: 'Store copy', fresh: 'Only in the store' })
    const codexDir = generation('codex/global@cccccccccccc', { fresh: 'Codex store' })
    configureCommandSkills({ storeDir: (p) => (p === 'claude' ? dir : codexDir), readHome: true })
    const claude = await listCommands('claude', freshCwd())
    expect(claude.find((c) => c.name === 'mine')?.description).toBe('Store copy')
    expect(claude.map((c) => c.name)).toEqual(expect.arrayContaining(['fresh', `${SYNCED_SKILL_PREFIX}pdf`]))
    const codex = await listCommands('codex', freshCwd())
    expect(codex.map((c) => c.name)).toEqual(['fresh', 'imagegen', 'mine', 'openai-docs', 'skill-creator'])
    configureCommandSkills({ storeDir: (p) => (p === 'claude' ? dir : codexDir), readHome: false })
    const claudeOnly = await listCommands('claude', freshCwd())
    expect(claudeOnly.find((c) => c.name === 'mine')?.description).toBe('Store copy')
    expect(claudeOnly.map((c) => c.name)).toContain(`${SYNCED_SKILL_PREFIX}pdf`)
    const codexOnly = await listCommands('codex', freshCwd())
    // The home's own mine is gone; the .system skills stay.
    expect(codexOnly.map((c) => c.name)).toEqual(['fresh', 'imagegen', 'openai-docs', 'skill-creator'])
    expect(codexOnly.find((c) => c.name === 'skill-creator')?.description).toBe('System copy')
  })

  it('with readHome off (the drivers read only the store) a home-only skill never lists; store skills keep their bare names', async () => {
    const dir = generation('claude/global@ffffffffffff', { tidy: 'Store tidy' })
    configureCommandSkills({ storeDir: () => dir, readHome: false })
    const names = (await listCommands('claude', freshCwd())).map((c) => c.name)
    // The home's mine is not in the store: the CLI never runs it, so the menu never lists it.
    expect(names).not.toContain('mine')
    expect(names).toContain('tidy')
    expect(names).toContain(`${SYNCED_SKILL_PREFIX}pdf`)
  })

  it('gives store skills the prefix the drivers name, and follows a new generation at once', async () => {
    const one = generation('claude/global@dddddddddddd', { first: 'One' })
    const two = generation('claude/global@eeeeeeeeeeee', { first: 'One', second: 'Two' })
    let current = one
    configureCommandSkills({ storeDir: () => current, readHome: false, prefix: 'tc:' })
    const cwd = freshCwd()
    expect((await listCommands('claude', cwd)).map((c) => c.name).filter((n) => n.startsWith('tc:'))).toEqual(['tc:first'])
    current = two
    expect((await listCommands('claude', cwd)).map((c) => c.name).filter((n) => n.startsWith('tc:'))).toEqual(['tc:first', 'tc:second'])
  })
})
