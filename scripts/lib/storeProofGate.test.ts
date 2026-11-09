import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const repo = resolve(import.meta.dirname, '../..')
const bun = process.env.BUN_EXEC_PATH ?? 'bun'
const scripts = ['e2e-addons', 'e2e-addon-grants', 'e2e-skills-store']

describe('store proof gate contract', () => {
  it.each(scripts)('%s waits for an absent gate build before it can boot', async (name) => {
    const child = spawn(bun, ['run', `script:${name}`, '--', '--gate'], {
      cwd: repo,
      env: {
        ...process.env,
        TEMP_CODE_SOAK_BUILD_DONE: `/tmp/tc-absent-gate-${process.pid}-${name}`
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let output = ''
    const closed = new Promise<void>((done) => child.once('close', () => done()))
    try {
      await new Promise<void>((done, fail) => {
        const timer = setTimeout(() => fail(new Error(`no build wait: ${output}`)), 10_000)
        const read = (data: Buffer): void => {
          output += data.toString()
          if (output.includes('waiting for the gate build to finish')) {
            clearTimeout(timer)
            done()
          }
        }
        child.stdout.on('data', read)
        child.stderr.on('data', read)
        child.once('error', (err) => {
          clearTimeout(timer)
          fail(err)
        })
        child.once('exit', () => {
          clearTimeout(timer)
          fail(new Error(`exited before the build wait: ${output}`))
        })
      })
      expect(output).not.toMatch(/PASS |FAIL |SKIP |logs /)
    } finally {
      child.kill('SIGTERM')
      await closed
    }
  })

  it('keeps the entire real-HOME Claude lane inside the non-gate branch', () => {
    const file = ts.createSourceFile(
      'e2e-addons.ts',
      readFileSync(resolve(repo, 'scripts/e2e-addons.ts'), 'utf8'),
      ts.ScriptTarget.Latest,
      true
    )
    let found = false
    const visit = (node: ts.Node): void => {
      if (
        ts.isIfStatement(node) &&
        node.expression.getText(file) === 'GATE' &&
        node.elseStatement?.getText(file).includes("mk('claude', true)")
      ) {
        found = true
        expect(node.thenStatement.getText(file)).toContain('SKIP  leg 4:')
        const lane = node.elseStatement.getText(file)
        expect(lane).toContain('launch(claude,')
        expect(lane).toContain("'claude-haiku-5-5'")
        expect(lane).toContain("'session.send'")
      }
      ts.forEachChild(node, visit)
    }
    visit(file)
    expect(found).toBe(true)
  })
})
