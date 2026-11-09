import { expect, it } from 'vitest'
import { peerPidFromLsof, peerPidFromSs } from './skillsDriversPeers'

it('attributes only the client half of the proxy socket on Linux', () => {
  const text =
    'State Recv-Q Send-Q Local Address:Port Peer Address:Port Process\nESTAB 0 0 127.0.0.1:45678 127.0.0.1:12345 users:(("codex",pid=6789,fd=7))\nESTAB 0 0 127.0.0.1:12345 127.0.0.1:45678 users:(("bun",pid=111,fd=8))'
  expect(peerPidFromSs(text, 45678, 12345)).toBe(6789)
  expect(peerPidFromSs(text, 45679, 12345)).toBeNull()
})

it('attributes only the client half of the proxy socket on macOS', () => {
  const text = 'p111\nn127.0.0.1:12345->127.0.0.1:45678\np6789\nn127.0.0.1:45678->127.0.0.1:12345\n'
  expect(peerPidFromLsof(text, 45678, 12345)).toBe(6789)
  expect(peerPidFromLsof(text, 45679, 12345)).toBeNull()
})
