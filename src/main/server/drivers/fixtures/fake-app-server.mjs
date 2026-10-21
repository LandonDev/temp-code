// A stand-in `codex app-server`: answers initialize and thread/start over
// JSON-RPC on stdio, notes every request it saw in a notification, and exits
// on stdin end. Used by codexWarm.test.ts.
import { createInterface } from 'node:readline'
const seen = []
createInterface({ input: process.stdin }).on('line', (line) => {
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  if (msg.id === undefined) return
  seen.push(msg.method)
  if (msg.method === 'initialize') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { userAgent: 'fake' } }) + '\n')
  else if (msg.method === 'thread/start') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'fake/seen', params: { seen: [...seen], cwd: msg.params?.cwd } }) + '\n')
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { thread: { id: 'th-fake' } } }) + '\n')
  } else process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\n')
})
process.stdin.on('end', () => process.exit(0))
