// Static renders of the Add key… dialog (bun run ui:preview src/renderer/src/aliax/views/AddKeyDialog.tsx#AddKeyDialog).
const pending = () => new Promise(() => {})
const props = { open: true, onOpenChange: 'fn', serviceName: 'Meta', onAdded: 'fn' }

export default [
  { name: 'Empty: Add waits for a key', props: { ...props, submit: pending } }
]
