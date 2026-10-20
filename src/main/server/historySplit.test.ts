import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, it } from 'vitest'
import { openDb } from './db'
import { RemoteAuth } from './remote/auth'

it('splits an offline copy while keys, cookies, pairings and saved environments still work', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tc-split-proof-'))
  const data = join(root, 'mac')
  execFileSync('mkdir', ['-p', data])
  try {
    // Optional proof against a small dev database; never open either live dir.
    const source = process.env.TC_SPLIT_PROOF_SOURCE
    if (source) {
      if (!/\/temp-code-dev[^/]*\/temp-code\.db$/.test(source))
        throw new Error('proof source must be a dev database')
      const db = new DatabaseSync(source, { readOnly: true })
      try {
        db.prepare('VACUUM INTO ?').run(join(data, 'temp-code.db'))
      } finally {
        db.close()
      }
    }
    const db = openDb(join(data, 'temp-code.db'))
    db.prepare(
      `INSERT INTO sessions
      (id, provider, model, reasoning, agent_type, title, cwd, status, created_at, updated_at)
      VALUES ('split-history', 'claude', 'claude-haiku-5-5', 'low', 'implementer', 'history', ?, 'idle', 1, 1)`
    ).run(root)
    const auth = new RemoteAuth(db)
    const { key, token } = await auth.createKey({
      name: 'split proof',
      audience: 'client',
      caps: ['read'],
      createdBy: 'local'
    })
    const { cookie } = auth.createSession(key.id, ['read'], 'split proof')
    const pairing = auth.createPairing({
      name: 'split pairing',
      audience: 'client',
      caps: ['read'],
      createdBy: 'local'
    })
    const revoked = await auth.createKey({
      name: 'revoked proof',
      audience: 'client',
      caps: ['read'],
      createdBy: 'local'
    })
    auth.revokeKey(revoked.key.id)
    db.prepare('INSERT OR REPLACE INTO settings VALUES (?, ?)').run(
      'remote.publicOrigin',
      'https://mac.example'
    )
    db.prepare('INSERT OR REPLACE INTO settings VALUES (?, ?)').run(
      'remote.environments.env_saved',
      '{"name":"saved"}'
    )
    db.prepare('INSERT OR REPLACE INTO settings VALUES (?, ?)').run('build:old-thread', '{}')
    const tables = ['remote_keys', 'remote_pairings', 'remote_sessions']
    const before = tables.map((t) => db.prepare(`SELECT * FROM ${t} ORDER BY id`).all())
    const keyCount = before[0].length
    db.close()
    const identity = '{"environmentId":"env_split_proof"}\n'
    writeFileSync(join(data, 'environment.json'), identity)
    const output = execFileSync('bash', [resolve('scripts/mac/split-data-dir.sh'), 'split'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        TEMP_CODE_DATA: data,
        TC_BOX_ENV_ID: 'env_abcdefghijklmnopqrstuv',
        TC_BOX_KEY: token
      }
    })
    expect(output).toContain(`remote_keys before=${keyCount} after=${keyCount}`)
    const moved = data + '.moved-' + new Date().toLocaleDateString('en-CA')
    const old = new DatabaseSync(join(moved, 'temp-code.db'), { readOnly: true })
    try {
      expect(old.prepare("SELECT id FROM sessions WHERE id = 'split-history'").get()?.id).toBe(
        'split-history'
      )
    } finally {
      old.close()
    }
    expect(readFileSync(join(data, 'environment.json'), 'utf8')).toBe(identity)
    const fresh = openDb(join(data, 'temp-code.db'))
    try {
      tables.forEach((t, i) =>
        expect(fresh.prepare(`SELECT * FROM ${t} ORDER BY id`).all()).toEqual(before[i])
      )
      expect(fresh.prepare('SELECT count(*) AS n FROM sessions').get()?.n).toBe(0)
      expect(
        fresh
          .prepare('SELECT value FROM settings WHERE key = ?')
          .get('remote.environments.env_saved')?.value
      ).toBe('{"name":"saved"}')
      expect(
        fresh.prepare('SELECT value FROM settings WHERE key = ?').get('remote.publicOrigin')?.value
      ).toBe('https://mac.example')
      expect(
        fresh.prepare('SELECT value FROM settings WHERE key = ?').get('build:old-thread')
      ).toBeUndefined()
      const after = new RemoteAuth(fresh)
      expect((await after.verifyToken(token))?.keyId).toBe(key.id)
      expect(after.verifyCookie(cookie)?.principal.keyId).toBe(key.id)
      expect(await after.verifyToken(revoked.token)).toBeNull()
      expect((await after.exchange(pairing.code, { kind: 'key' })).kind).toBe('key')
    } finally {
      fresh.close()
    }
    console.log(
      `split proof: remote_keys before=${keyCount} after=${keyCount}; bearer, cookie, pending pairing and revoked key checks passed; history empty`
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
