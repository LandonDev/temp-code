/** Network guard loaded only by the disposable skills gate instance and its children. */
const fs = require('node:fs')
const net = require('node:net')
const deniedFile = process.env.TEMP_CODE_GATE_DENIED
if (deniedFile) {
  const local = (host) => ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)
  const deny = (target) => fs.appendFileSync(deniedFile, `${process.pid} ${target}\n`)
  const connect = net.Socket.prototype.connect
  net.Socket.prototype.connect = function (...args) {
    const [opts] = net._normalizeArgs(args)
    if (!opts.path && !local(opts.host || 'localhost')) {
      deny(`connect ${opts.host}:${opts.port}`)
      throw new Error('skills gate refused an external connection')
    }
    return connect.apply(this, args)
  }
  try {
    const { app } = require('electron')
    if (app) {
      app.on('session-created', (session) => {
        session.webRequest.onBeforeRequest((details, done) => {
          const url = new URL(details.url)
          const external =
            ['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) && !local(url.hostname)
          if (external) deny(details.url)
          done({ cancel: external })
        })
        // A headless proof needs no dictionary. Its default download bypasses provider routing.
        session.setSpellCheckerEnabled(false)
      })
    }
  } catch {
    // Node CLI launchers and Electron utility processes have no browser app object.
  }
}
