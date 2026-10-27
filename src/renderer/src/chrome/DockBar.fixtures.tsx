const zsh = { id: 'a', path: 'zsh', cwd: '/srv/agents/work/temp-code', terminal: true }
const build = { id: 'b', path: 'bun run gate', cwd: '/srv/agents/work/temp-code', terminal: true }
const fn = 'fn'
const base = { onSelect: fn, onSelectDev: fn, onClose: fn, onReorder: fn, onAdd: fn, onHide: fn }

export default [
  { name: 'Two terminals and the Dev servers tab, two running', props: { ...base, terminals: [zsh, build], active: 'a', dev: { count: 2 } } },
  { name: 'The Dev servers tab picked, nothing running', props: { ...base, terminals: [zsh, build], active: 'dev', dev: { count: 0 } } },
  { name: 'Nothing to serve: no Dev servers tab', props: { ...base, terminals: [zsh], active: 'a', dev: null } }
]
