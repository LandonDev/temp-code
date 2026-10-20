#!/usr/bin/env node
// Talk to a headless temp-code host over its local socket, the implicit
// admin a renderer would otherwise be:  tc-local <method> [json-params]
// The host writes <userData>/server.json in headless mode (src/main/
// headless.ts); TEMP_CODE_USER_DATA names the dir, default the box's.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const [method, raw] = process.argv.slice(2)
if (!method) {
  console.error('usage: tc-local <method> [json-params]   e.g. tc-local remote.status')
  process.exit(2)
}
const userData = process.env.TEMP_CODE_USER_DATA || '/srv/agents/temp-code-data'
let port
try {
  port = JSON.parse(readFileSync(join(userData, 'server.json'), 'utf8')).port
} catch (err) {
  console.error(`tc-local: no running headless host under ${userData} (${err.message})`)
  process.exit(1)
}
const params = raw ? JSON.parse(raw) : {}
const timeoutMs = Number(process.env.TC_LOCAL_TIMEOUT_MS || 120_000)
const ws = new WebSocket(`ws://127.0.0.1:${port}/`)
// stdout is a pipe under box-probe and shell pipelines, where Node writes
// asynchronously: process.exit() right after console.log() drops whatever
// has not been flushed yet (a session.list of thousands of threads was cut
// off at ~140 KB). Exit from the write's callback instead.
const finish = (text, code) => {
  ws.close()
  process.stdout.write(`${text}\n`, () => process.exit(code))
}
const timer = setTimeout(() => {
  console.error(`tc-local: no answer to ${method} in ${timeoutMs} ms`)
  process.exit(1)
}, timeoutMs)
ws.addEventListener('open', () => {
  if (method !== '--hello') ws.send(JSON.stringify({ id: 'tc-local', method, params }))
})
ws.addEventListener('message', (event) => {
  const frame = JSON.parse(String(event.data))
  if (method === '--hello' && frame.push === 'hello') {
    clearTimeout(timer)
    finish(JSON.stringify(frame, null, 2), 0)
  }
  if (frame.id !== 'tc-local') return
  clearTimeout(timer)
  if (frame.ok) {
    finish(JSON.stringify(frame.result ?? null, null, 2), 0)
    return
  }
  console.error(`tc-local: ${frame.error}`)
  process.exit(1)
})
ws.addEventListener('error', (event) => {
  console.error(`tc-local: ${event.message ?? 'socket error'}`)
  process.exit(1)
})
