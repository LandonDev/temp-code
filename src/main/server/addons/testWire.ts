import type { Wire } from '../gatewayWire'

/** Two in-memory ends: each post reaches the other end's listeners on a later tick, cloned as a port would. */
export function wirePair<M>(): [Wire<M> & { closed: boolean }, Wire<M> & { closed: boolean }] {
  const make = () => ({ listeners: [] as ((m: M) => void)[], closers: [] as (() => void)[] })
  const ends = [make(), make()]
  const wire = (me: number) => {
    const w = {
      closed: false,
      post: (m: M) => {
        if (w.closed) throw new Error('closed')
        const copy = structuredClone(m)
        setTimeout(() => ends[1 - me]!.listeners.forEach((fn) => fn(copy)), 0)
      },
      onMessage: (fn: (m: M) => void) => void ends[me]!.listeners.push(fn),
      onClose: (fn: () => void) => void ends[me]!.closers.push(fn),
      close: () => {
        w.closed = true
        for (const end of ends) end.closers.forEach((fn) => fn())
      }
    }
    return w
  }
  return [wire(0), wire(1)]
}
