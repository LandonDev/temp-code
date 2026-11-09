import { afterEach, expect, it } from 'vitest'
import { gzipSync } from 'node:zlib'
import { FakeAnthropic, FakeResponses, skillCall } from './spikeFakes'

const servers: { close(): void }[] = []
afterEach(() => {
  for (const s of servers.splice(0)) s.close()
})

it('lets the proof inspect decoded Claude requests without changing scripted Skill answers', async () => {
  const fake = await new FakeAnthropic().start()
  servers.push(fake)
  const seen: unknown[] = []
  fake.inspect = (body) => seen.push(body)
  fake.script = [{ tool: skillCall('tc-e2e-probe') }]
  const body = {
    stream: false,
    tools: [{ name: 'Skill', input_schema: { required: ['skill'] } }],
    messages: [{ role: 'user', content: 'probe' }]
  }
  const reply = await fetch(`${fake.url}/v1/messages`, {
    method: 'POST',
    headers: { 'content-encoding': 'gzip' },
    body: gzipSync(JSON.stringify(body))
  })
  expect(seen).toEqual([body])
  expect(await reply.json()).toMatchObject({
    content: [{ name: 'Skill', input: { skill: 'tc-e2e-probe' } }],
    stop_reason: 'tool_use'
  })
})

it('keeps the spike default and lets the gate classify tool-free Responses turns', async () => {
  const fake = await new FakeResponses(null).start()
  servers.push(fake)
  const seen: unknown[] = []
  fake.inspect = (body) => seen.push(body)
  fake.script = [{ text: 'scripted gate answer' }]
  const body = { input: [{ role: 'developer', content: 'tc-e2e-probe' }] }
  const send = () =>
    fetch(`${fake.url}/responses`, { method: 'POST', body: JSON.stringify(body) }).then((r) =>
      r.text()
    )
  expect(await send()).not.toContain('scripted gate answer')
  expect(fake.script).toHaveLength(1)
  fake.isMain = (b) => Array.isArray((b as typeof body).input)
  expect(await send()).toContain('scripted gate answer')
  expect(seen).toEqual([body, body])
  expect(fake.requests.map((r) => r.main)).toEqual([false, true])
})

it('scripts a native namespaced skill call from Muse tool definitions', async () => {
  const fake = await new FakeResponses(null).start()
  servers.push(fake)
  fake.script = [
    {
      tool: (tools) => {
        const ns = tools.find((t) => t.tools?.some((x) => x.name === 'read_skill'))
        return ns
          ? { name: 'read_skill', namespace: ns.name, input: { name: 'tc-e2e-probe' } }
          : null
      }
    }
  ]
  const reply = await fetch(`${fake.url}/responses`, {
    method: 'POST',
    body: JSON.stringify({
      input: [],
      tools: [
        { type: 'namespace', name: 'muse', tools: [{ type: 'function', name: 'read_skill' }] }
      ]
    })
  }).then((r) => r.text())
  expect(reply).toContain('"namespace":"muse"')
  expect(reply).toContain('"name":"read_skill"')
  expect(reply).toContain('tc-e2e-probe')
})

it('accepts Codex additional_tools and scripts its native code-mode shell call', async () => {
  const fake = await new FakeResponses(null).start()
  servers.push(fake)
  fake.script = [{ shell: 'cat /tmp/store/skill/SKILL.md' }]
  const wire = await fetch(`${fake.url}/responses`, {
    method: 'POST',
    body: JSON.stringify({
      input: [
        {
          type: 'additional_tools',
          role: 'developer',
          tools: [
            { type: 'namespace', name: 'functions', tools: [{ type: 'custom', name: 'exec' }] }
          ]
        }
      ]
    })
  }).then((r) => r.text())
  expect(fake.requests[0].main).toBe(true)
  expect(fake.requests[0].answered).toBe('call:exec')
  expect(wire).toContain('response.custom_tool_call_input.delta')
  expect(wire).toContain('tools.exec_command')
  expect(wire).toContain('"namespace":"functions"')
})
