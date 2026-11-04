// A stand-in `muse serve` for the driver tests: newline JSON-RPC 2.0 over
// stdio, the frames shaped like the spike's recordings (fixtures/muse).
// The text of a turn picks the scenario; nothing here reaches a model.
import { createInterface } from 'node:readline'

const FINGERPRINT = 'sha256:c94c3d1f2f51e6424074b9ec43eac3eedcf532d3dcd77351ec1383a87d3049c6'
const out = (frame) => process.stdout.write(JSON.stringify(frame) + '\n')
const notify = (method, params) => out({ jsonrpc: '2.0', method, params })
const reply = (id, result) => out({ jsonrpc: '2.0', id, result })
const refuse = (id, code, kind, message, extra = {}) => out({ jsonrpc: '2.0', id, error: { code, message, data: { kind, ...extra } } })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let seq = 0
const cursor = (sid) => `v4:${sid}:${++seq}`
const range = () => ({ first: { id: 'r', sequence: seq }, last: { id: 'r', sequence: seq }, stream: { id: 's', kind: 'session' } })
let serverReqId = 1000
const pendingServer = new Map()

const sessions = new Map()
let turnSeq = 0
const live = new Map() // turnId → { sid, resolveSteer, resolveDecide, resolveAnswer, cancelled }
const stderr = (line) => process.stderr.write(line + '\n')

const item = (sid, kind, over) => ({ itemId: `it-${++seq}`, kind, status: 'inProgress', revision: 1, turnId: null, ...over })
const started = (sid, it) => notify('item/started', { sessionId: sid, item: it, viewCursor: cursor(sid) })
const completed = (sid, it) => notify('item/completed', { sessionId: sid, item: { ...it, status: it.status === 'inProgress' ? 'completed' : it.status, revision: it.revision + 1 }, sourceRange: range(), viewCursor: cursor(sid) })
const delta = (sid, it, text, field) => notify('item/delta', { sessionId: sid, itemId: it.itemId, delta: text, ...(field ? { field } : {}), viewCursor: cursor(sid) })

async function message(sid, turnId, text) {
  const it = item(sid, 'agentMessage', { turnId, text: '' })
  started(sid, it)
  for (const word of text.split(' ')) {
    delta(sid, it, word + ' ', 'text')
    await sleep(2)
  }
  completed(sid, { ...it, text })
}

async function runTurn(sid, turnId, text) {
  const t = live.get(turnId)
  notify('turn/started', { sessionId: sid, turnId, commandId: turnId, sourceRange: range(), viewCursor: cursor(sid) })
  const done = (over = {}) => {
    live.delete(turnId)
    notify('turn/completed', { sessionId: sid, turnId, terminal: 'completed', usage: { inputTokens: 120, outputTokens: 30, cachedTokens: 0, reasoningTokens: 5 }, durationMs: 40, sourceRange: range(), viewCursor: cursor(sid), ...over })
  }
  if (text.startsWith('slow')) return
  if (text.startsWith('die')) {
    stderr('muse serve: panic: fake death')
    process.exit(1)
  }
  if (text.startsWith('quota')) return done({ terminal: 'failed', error: { kind: 'modelError', message: 'usage limit reached', retryable: false, quota: { limitKind: 'tierLimit', resetsAtMs: Date.now() + 90 * 60_000 } } })
  if (text.startsWith('auth')) return done({ terminal: 'failed', error: { kind: 'authRequired', message: 'No Meta credentials were found. Run `muse login`.', retryable: false } })
  if (text.startsWith('retry')) {
    notify('turn/modelRetryScheduled', { sessionId: sid, turnId, attempt: 2, maxAttempts: 5, nextAttempt: 3, retryDelayMs: 32_000, httpStatus: 503, sourceRange: range(), viewCursor: cursor(sid) })
    await message(sid, turnId, 'recovered')
    return done()
  }
  if (text.startsWith('usage')) {
    notify('usage/changed', { observedAtMs: Date.now(), tier: 'power', window: { usedPercent: 42, resetsAtMs: Date.now() + 3_600_000, windowDurationMins: 300 }, weekly: { usedPercent: 7, resetsAtMs: Date.now() + 86_400_000 } })
    notify('session/contextUsage', { sessionId: sid, usedTokens: 12_345, windowTokens: 1_048_576, pressure: 'normal', sourceRange: range(), viewCursor: cursor(sid) })
    await message(sid, turnId, 'noted')
    return done()
  }
  if (text.startsWith('think')) {
    const r = item(sid, 'reasoning', { turnId, summary: [] })
    started(sid, r)
    delta(sid, r, 'weighing ', 'summary.0')
    delta(sid, r, 'options', 'summary.0')
    completed(sid, { ...r, summary: ['weighing options'] })
    await message(sid, turnId, 'thought through')
    return done()
  }
  if (text.startsWith('tool')) {
    await message(sid, turnId, 'running ls')
    const tool = item(sid, 'toolCall', { turnId, tool: 'shell', callId: 'call-1', commandText: 'ls -la', displayLabel: { active: 'Running ls -la', done: 'Ran ls -la' } })
    started(sid, tool)
    delta(sid, tool, 'total 0\n', 'output')
    delta(sid, tool, 'drwxr-xr-x .\n', 'output')
    completed(sid, { ...tool, exitCode: 0, visibleOutput: 'total 0\ndrwxr-xr-x .\n' })
    await message(sid, turnId, 'two entries')
    return done()
  }
  if (text.startsWith('compact')) {
    const c = item(sid, 'compaction', { turnId, trigger: 'auto', tokensBefore: 900_000 })
    started(sid, c)
    completed(sid, { ...c, outcome: 'compacted', tokensAfter: 120_000, durationMs: 900 })
    await message(sid, turnId, 'compacted')
    return done()
  }
  if (text.startsWith('ask')) {
    const q = item(sid, 'toolCall', { turnId, tool: 'request_user_input', callId: 'call-q' })
    started(sid, q)
    const userInputId = `ui-${++seq}`
    const params = { sessionId: sid, turnId, userInputId, itemId: q.itemId, toolCallId: 'call-q', toolName: 'request_user_input', viewCursor: cursor(sid), questions: [{ id: 'q1', header: 'Indent', question: 'Tabs or spaces?', selection: { mode: 'single', maxSelections: 1 }, options: [{ label: 'Tabs' }, { label: 'Spaces', description: 'two of them' }] }] }
    notify('userInput/requested', params)
    out({ jsonrpc: '2.0', id: ++serverReqId, method: 'userInput/request', params })
    const answers = await new Promise((resolve) => (t.resolveAnswer = resolve))
    notify('userInput/settled', { sessionId: sid, userInputId, answers: answers ?? [], viewCursor: cursor(sid) })
    completed(sid, { ...q, status: answers ? 'completed' : 'cancelled' })
    await message(sid, turnId, answers ? `chose ${answers.map((a) => a.selectedLabel ?? a.freeText).join(',')}` : 'dismissed')
    return done()
  }
  if (text.startsWith('approve')) {
    const tool = item(sid, 'toolCall', { turnId, tool: 'shell', callId: 'call-a', commandText: 'rm -rf build' })
    started(sid, tool)
    const approvalId = `ap-${++seq}`
    const params = {
      sessionId: sid, turnId, approvalId, itemId: tool.itemId, toolCallId: 'call-a', toolName: 'shell', taskId: 'task-1', rawArgs: '{"command":"rm -rf build"}', judgeEscalated: false, protectedWrite: false, viewCursor: cursor(sid), sourceRange: range(),
      subject: { kind: 'shell', command: 'rm -rf build' },
      currentRequirementId: { approvalId, sourceIndex: 0 },
      availableChoices: [
        { choiceId: 'c-once', decision: 'approved', label: 'Allow once', scope: 'once' },
        { choiceId: 'c-session', decision: 'approvedForSession', label: 'Allow for this session', scope: 'session' },
        { choiceId: 'c-deny', decision: 'denied', label: 'Deny', scope: 'once', acceptsFeedback: true }
      ]
    }
    notify('approval/requested', params)
    out({ jsonrpc: '2.0', id: ++serverReqId, method: 'approval/request', params })
    const choiceId = await new Promise((resolve) => (t.resolveDecide = resolve))
    notify('approval/resolved', { sessionId: sid, approvalId, viewCursor: cursor(sid) })
    const allowed = choiceId === 'c-once'
    completed(sid, { ...tool, status: allowed ? 'completed' : 'rejected', exitCode: allowed ? 0 : undefined, visibleOutput: allowed ? 'removed' : '' })
    await message(sid, turnId, allowed ? 'removed build' : 'left it alone')
    return done()
  }
  if (text.startsWith('steer')) {
    const steered = await new Promise((resolve) => (t.resolveSteer = resolve))
    if (steered === 'cancelled') return done({ terminal: 'cancelled' })
    const um = item(sid, 'userMessage', { turnId, text: steered.text, commandId: steered.commandId, steered: true })
    started(sid, um)
    completed(sid, um)
    await message(sid, turnId, `heard ${steered.text}`)
    return done()
  }
  await message(sid, turnId, `echo: ${text}`)
  done()
}

const rl = createInterface({ input: process.stdin })
rl.on('close', () => {
  stderr('muse serve: exit reason recorded: stdin_closed')
  process.exit(0)
})
rl.on('line', async (line) => {
  if (!line.trim()) return
  const frame = JSON.parse(line)
  const { id, method, params = {} } = frame
  if (id !== undefined && method === undefined) {
    // the receipt of a server request
    pendingServer.get(id)?.()
    return
  }
  switch (method) {
    case 'initialize':
      return reply(id, {
        serverInfo: { name: 'muse', version: '1.4.14' }, userAgent: 'muse-build/1.4.14 (serve; fake)', museHome: '/tmp/fake-muse', platformFamily: 'unix', platformOs: process.platform === 'linux' ? 'linux' : 'macos',
        schema: { version: 1, fingerprint: FINGERPRINT }, grantedCapabilities: ['sessionMcp'], experimentalApi: true, sessionDurability: 'durable',
        sandboxAvailability: process.env.FAKE_MUSE_SANDBOX ?? 'available', ...(process.env.FAKE_MUSE_SANDBOX === 'unavailable' ? { sandboxUnavailableReason: 'bubblewrapUnavailable' } : {})
      })
    case 'initialized':
      return
    case 'model/list':
      return reply(id, { providerId: 'meta', profileId: 'tbh', source: 'providerCatalog', models: [
        { modelId: 'muse-spark-1.3', displayLabel: 'Muse Spark 1.3', contextLimit: 1_048_576, outputLimit: null, cost: null, description: null, isActive: true, isDefault: true, profileId: null, providerId: 'meta', releaseDate: null, defaultReasoningEffort: 'high', reasoningEffortVariants: [{ tier: 'minimal' }, { tier: 'low' }, { tier: 'medium' }, { tier: 'high' }, { tier: 'xhigh' }, { tier: 'max' }, { tier: 'ultra' }] }
      ] })
    case 'session/start': {
      const sid = `sess-${++seq}`
      sessions.set(sid, { params })
      process.stderr.write(`fake: start ${JSON.stringify({ profile: params.permissionProfile, mode: params.approvalMode, config: params.config ?? null, args: process.argv.slice(2) })}\n`)
      notify('session/started', { sessionId: sid })
      return reply(id, { session: { sessionId: sid, status: 'idle', workspaceRoot: params.workspaceRoot, permissionState: { profileId: params.permissionProfile ?? ':ask-me' } }, viewCursor: cursor(sid) })
    }
    case 'session/resume': {
      if (params.sessionId === 'lost') return refuse(id, -32020, 'sessionNotFound', `no session ${params.sessionId}`)
      if (params.sessionId === 'busy') return refuse(id, -32021, 'sessionInUse', `session ${params.sessionId} has a live client`)
      sessions.set(params.sessionId, { params })
      return reply(id, { session: { sessionId: params.sessionId, status: 'idle' }, history: { mode: 'none' }, pendingRequests: [], viewCursor: cursor(params.sessionId) })
    }
    case 'turn/start': {
      const sid = params.sessionId
      const turnId = `turn-${++turnSeq}`
      const text = params.input.map((p) => p.text ?? `<${p.type}>`).join(' ')
      live.set(turnId, { sid })
      reply(id, { commandId: params.commandId, turnId, disposition: 'started', startedNewTurn: true, status: 'accepted' })
      process.stderr.write(`fake: turn ${JSON.stringify({ effort: params.reasoningEffort ?? null, parts: params.input.map((p) => p.type) })}\n`)
      void runTurn(sid, turnId, text)
      return
    }
    case 'turn/steer': {
      const t = live.get(params.expectedTurnId)
      if (!t) return refuse(id, -32030, 'commandRejected', 'no such live turn', { reason: 'runtime_busy' })
      reply(id, { commandId: params.commandId, status: 'accepted' })
      t.resolveSteer?.({ text: params.input.map((p) => p.text).join(' '), commandId: params.commandId })
      return
    }
    case 'turn/cancel': {
      reply(id, { commandId: params.commandId, status: 'accepted' })
      for (const [turnId, t] of live) {
        if (t.resolveSteer) t.resolveSteer('cancelled')
        else {
          live.delete(turnId)
          notify('turn/completed', { sessionId: t.sid, turnId, terminal: 'cancelled', sourceRange: range(), viewCursor: cursor(t.sid) })
        }
      }
      return
    }
    case 'approval/decide': {
      reply(id, { commandId: params.commandId, status: 'accepted' })
      for (const t of live.values()) t.resolveDecide?.(params.choiceId)
      return
    }
    case 'userInput/answer': {
      reply(id, { commandId: params.commandId, status: 'accepted' })
      for (const t of live.values()) t.resolveAnswer?.(params.answers)
      return
    }
    case 'userInput/cancel': {
      reply(id, { commandId: params.commandId, status: 'accepted' })
      for (const t of live.values()) t.resolveAnswer?.(null)
      return
    }
    case 'session/compact':
      process.stderr.write('fake: compact\n')
      return reply(id, { commandId: params.commandId, status: 'accepted' })
    case 'task/stop':
      process.stderr.write(`fake: task/stop ${params.taskId}\n`)
      return reply(id, { commandId: params.commandId, status: 'accepted' })
    case 'usage/read':
      return reply(id, {})
    default:
      return refuse(id, -32601, 'methodNotFound', `method not found: ${method}`)
  }
})
