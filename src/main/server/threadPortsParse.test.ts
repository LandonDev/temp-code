import { describe, expect, it } from 'vitest'
import { announcedPorts, byPort, descendants, parseLsof, parsePs, parseSs, portLabel } from './threadPortsParse'

const ports = (out: string) => announcedPorts(out).map((a) => a.port)

describe('announcedPorts', () => {
  it('reads Vite', () => {
    const out = '\n  \u001b[32m\u001b[1mVITE\u001b[22m v5.4.2\u001b[39m  ready in \u001b[1m312\u001b[22m ms\n\n  ➜  \u001b[1mLocal\u001b[22m:   \u001b[36mhttp://localhost:\u001b[1m5173\u001b[22m/\u001b[39m\n  ➜  Network: use --host to expose\n'
    expect(announcedPorts(out)).toEqual([{ port: 5173, url: 'http://localhost:5173' }])
  })

  it('reads Next, new and old', () => {
    expect(ports('   ▲ Next.js 15.0.3\n   - Local:        http://localhost:3000\n   - Network:      http://192.168.1.4:3000\n\n ✓ Ready in 1.2s')).toEqual([3000])
    expect(ports('ready - started server on 0.0.0.0:3000, url: http://localhost:3000')).toEqual([3000])
  })

  it('reads bun', () => {
    expect(ports('Started development server: http://localhost:3001')).toEqual([3001])
    expect(ports('Listening on http://localhost:4000/')).toEqual([4000])
  })

  it('reads express and other bare shapes', () => {
    expect(ports('Example app listening on port 8080')).toEqual([8080])
    expect(ports('Server listening on :9090')).toEqual([9090])
    expect(ports('Server running at http://127.0.0.1:8081/')).toEqual([8081])
    expect(ports('Serving HTTP on 0.0.0.0 port 8000 (http://0.0.0.0:8000/) ...')).toEqual([8000])
    expect(ports('> Ready on http://[::1]:3002')).toEqual([3002])
  })

  it('records nothing the server did not open', () => {
    expect(ports('Port 5173 is in use, trying another one...')).toEqual([])
    expect(ports('⚠ Port 3000 is in use, trying 3001 instead.')).toEqual([])
    expect(ports('Error: listen EADDRINUSE: address already in use :::3000')).toEqual([])
    expect(ports('see http://localhost:5173 for the docs')).toEqual([])
    expect(ports('Local: http://192.168.1.4:5173/')).toEqual([])
    expect(ports('Local: https://example.com:8443')).toEqual([])
    expect(ports('proxying to http://localhost:8080 ready')).toEqual([])
    expect(ports('server listening on port 80')).toEqual([])
  })

  it('keeps each port once, in order', () => {
    expect(ports('Local: http://localhost:5173/\nready on http://localhost:3000\nLocal: http://127.0.0.1:5173/')).toEqual([5173, 3000])
  })
})

describe('listeners', () => {
  it('parses ss -ltnpH, one row per pid, skipping sockets with no process', () => {
    const text = [
      'LISTEN 0      511        127.0.0.1:38845 0.0.0.0:* users:(("electron",pid=1927404,fd=96))',
      'LISTEN 0      4096       127.0.0.1:8000  0.0.0.0:*                                       ',
      'LISTEN 0      511                *:5173        *:* users:(("node",pid=42,fd=20),("node",pid=43,fd=20))',
      'LISTEN 0      511            [::1]:3000     [::]:* users:(("bun",pid=7,fd=9))'
    ].join('\n')
    expect(parseSs(text)).toEqual([
      { port: 38845, pid: 1927404, address: '127.0.0.1', command: 'electron' },
      { port: 5173, pid: 42, address: '*', command: 'node' },
      { port: 5173, pid: 43, address: '*', command: 'node' },
      { port: 3000, pid: 7, address: '[::1]', command: 'bun' }
    ])
    expect(byPort(parseSs(text)).get(5173)?.pid).toBe(42)
  })

  it('parses lsof -nP -iTCP -sTCP:LISTEN', () => {
    const text = [
      'COMMAND   PID   USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME',
      'node    51234 landon   20u  IPv4 0x8d1c5e0f1b2a3c4d      0t0  TCP 127.0.0.1:5173 (LISTEN)',
      'Electron 900 landon   33u  IPv6 0x8d1c5e0f1b2a3c4e      0t0  TCP [::1]:9224 (LISTEN)',
      'rapportd  401 landon    9u  IPv4 0x8d1c5e0f1b2a3c4f      0t0  TCP *:49152 (LISTEN)'
    ].join('\n')
    expect(parseLsof(text)).toEqual([
      { port: 5173, pid: 51234, address: '127.0.0.1', command: 'node' },
      { port: 9224, pid: 900, address: '[::1]', command: 'Electron' },
      { port: 49152, pid: 401, address: '*', command: 'rapportd' }
    ])
  })

  it('walks the process tree from the harness', () => {
    const parents = parsePs('    1     0\n  100     1\n  200   100\n  201   200\n  300     1\n  bad line\n')
    expect([...descendants(parents, [100])].sort()).toEqual([100, 200, 201])
    expect(descendants(parents, [999])).toEqual(new Set([999]))
  })
})

describe('portLabel', () => {
  it('prefers the announced URL, then the command, then the process', () => {
    expect(portLabel(5173, { url: 'http://localhost:5173', command: 'bun run dev' })).toBe('http://localhost:5173')
    expect(portLabel(5173, { command: 'bun run dev\nmore' })).toBe('bun run dev')
    expect(portLabel(5173, { process: 'node' })).toBe('node :5173')
    expect(portLabel(5173, {})).toBe(':5173')
  })
})
