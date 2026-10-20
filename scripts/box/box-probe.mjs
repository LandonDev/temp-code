#!/usr/bin/env node
// Prints only public hello metadata and counts; credentials stay in memory.
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
const [port, version, contractRaw] = process.argv.slice(2)
const contract = Number(contractRaw)
const data = process.env.TEMP_CODE_USER_DATA || '/srv/agents/temp-code-data'
const origin = `http://127.0.0.1:${port}`
const local = (method, params = {}) =>
  JSON.parse(
    execFileSync('/usr/local/bin/tc-local', [method, JSON.stringify(params)], {
      encoding: 'utf8',
      timeout: 15000,
      // session.list of the whole history is several MB pretty-printed;
      // the 1 MB default throws ENOBUFS.
      maxBuffer: 256 * 1024 * 1024
    })
  )
const assert = (ok, label) => {
  if (!ok) throw Error(label)
}
async function socket(url, method, params, expected) {
  return await new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    let hello
    const timer = setTimeout(() => {
      ws.close()
      reject(Error('socket timeout'))
    }, 10000)
    const fail = (message) => {
      clearTimeout(timer)
      ws.close()
      reject(Error(message))
    }
    ws.addEventListener('error', () => fail('socket error'))
    ws.addEventListener('open', () => ws.send(JSON.stringify({ id: 'probe', method, params })))
    ws.addEventListener('message', (event) => {
      const frame = JSON.parse(String(event.data))
      if (frame.push === 'hello') hello = frame
      if (frame.id !== 'probe') return
      if (
        !hello ||
        hello.contract !== expected.contract ||
        hello.environmentId !== expected.environmentId ||
        !frame.ok
      )
        return fail('hello/contract/RPC mismatch')
      clearTimeout(timer)
      resolve({ hello, result: frame.result })
      ws.close()
    })
  })
}
const health = await fetch(`${origin}/healthz`, { signal: AbortSignal.timeout(5000) })
assert(health.ok && (await health.text()) === 'ok', 'healthz')
const hello = await (
  await fetch(`${origin}/api/hello`, { signal: AbortSignal.timeout(5000) })
).json()
// An anonymous hello carries the id and the contract only (R2 L2); the
// version comes with an accepted key and is checked once the probe has one.
assert(hello.contract === contract, 'contract mismatch')
assert(/^env_[\w-]{22}$/.test(hello.environmentId), 'environment id')
let known
const marker = JSON.parse(readFileSync(`${data}/server.json`))
const localResult = await socket(`ws://127.0.0.1:${marker.port}/`, 'workspace.list', {}, hello)
assert(localResult.hello.caps.includes('admin'), 'local socket must be admin')
const sessions = local('session.list')
assert(Array.isArray(sessions), 'tc-local session.list must return an array')
// Also traverse the real remote bearer/ticket socket, then revoke the probe
// key so successful or failed probes never leave a lasting admin credential.
const pairing = local('remote.pairings.create', {
  name: 'box-update probe',
  audience: 'client',
  caps: ['read']
})
let keyId
try {
  const response = await fetch(`${origin}/api/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: pairing.code, kind: 'key', name: 'box-update probe' }),
    signal: AbortSignal.timeout(5000)
  })
  const key = await response.json()
  keyId = key.keyId
  assert(response.ok && typeof key.key === 'string', 'pairing')
  known = await (
    await fetch(`${origin}/api/hello`, { headers: { authorization: `Bearer ${key.key}` }, signal: AbortSignal.timeout(5000) })
  ).json()
  assert(known.version === version && known.contract === contract && known.key?.id === keyId, 'version or contract mismatch')
  const ticketResponse = await fetch(`${origin}/api/ticket`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key.key}` },
    signal: AbortSignal.timeout(5000)
  })
  const ticket = await ticketResponse.json()
  assert(ticketResponse.ok && typeof ticket.ticket === 'string', 'ticket')
  await socket(`ws://127.0.0.1:${port}/ws?ticket=${ticket.ticket}`, 'session.list', {}, hello)
} finally {
  if (keyId) local('remote.keys.revoke', { id: keyId })
  local('remote.pairings.revoke', { id: pairing.pairing.id })
}
console.log(
  `PROBE PASS: hello=${JSON.stringify(hello)} version=${known.version} socket.contract=${contract} tc-local.session.list=${sessions.length} remote.ticket.session.list=ok`
)
