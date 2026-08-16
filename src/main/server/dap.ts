import { connect, type Socket } from 'node:net'
import type { WebSocket } from 'ws'

/**
 * DAP tunnel (docs/PLAN-4.md M20). intellij-server's `start_debug_server`
 * command opens a TCP port speaking the Debug Adapter Protocol with the
 * same Content-Length framing as LSP stdio. The renderer can't open TCP,
 * so main bridges: one WS per debug session at /dap/<id>, one text frame
 * per DAP message, symmetric with the /lsp tunnels.
 */

interface DapTunnel {
  id: string
  socket: Socket
  ws: WebSocket | null
  /** frames arriving before the WS attaches (adapter greets eagerly) */
  backlog: string[]
}

const tunnels = new Map<string, DapTunnel>()

export async function connectDap(port: number): Promise<{ tunnelId: string; wsPath: string }> {
  const socket = connect(port, '127.0.0.1')
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('error', reject)
  })
  const tunnel: DapTunnel = {
    id: `dap-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    socket,
    ws: null,
    backlog: []
  }
  tunnels.set(tunnel.id, tunnel)
  let buf = Buffer.alloc(0)
  socket.on('data', (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk
    for (;;) {
      const headerEnd = buf.indexOf('\r\n\r\n')
      if (headerEnd < 0) return
      const m = /Content-Length:\s*(\d+)/i.exec(buf.subarray(0, headerEnd).toString('ascii'))
      if (!m) {
        buf = buf.subarray(headerEnd + 4)
        continue
      }
      const len = Number(m[1])
      const start = headerEnd + 4
      if (buf.length < start + len) return
      const body = buf.subarray(start, start + len).toString('utf8')
      buf = buf.subarray(start + len)
      if (tunnel.ws?.readyState === tunnel.ws?.OPEN && tunnel.ws) tunnel.ws.send(body)
      else tunnel.backlog.push(body)
    }
  })
  const drop = (): void => {
    tunnels.delete(tunnel.id)
    tunnel.ws?.close(4002, 'debug adapter disconnected')
  }
  socket.on('close', drop)
  socket.on('error', drop)
  return { tunnelId: tunnel.id, wsPath: `/dap/${tunnel.id}` }
}

export function attachDapSocket(tunnelId: string, ws: WebSocket): void {
  const tunnel = tunnels.get(tunnelId)
  if (!tunnel) {
    ws.close(4000, 'no such debug tunnel')
    return
  }
  tunnel.ws = ws
  for (const body of tunnel.backlog.splice(0)) ws.send(body)
  ws.on('message', (data) => {
    const body = String(data)
    tunnel.socket.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
  })
  ws.on('close', () => {
    // The session owns the socket's life: closing the app-side WS ends it.
    tunnels.delete(tunnelId)
    tunnel.socket.destroy()
  })
}

export function stopAllDap(): void {
  for (const t of [...tunnels.values()]) {
    t.socket.destroy()
    t.ws?.close(4001, 'shutdown')
  }
  tunnels.clear()
}
