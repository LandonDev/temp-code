import { hostname } from 'node:os'
import { shortHostName } from '@shared/hostNames'

/**
 * What this host calls itself to clients and peers: the hostname without the
 * network's domain ("Mac.attlocal.net" → "Mac", src/shared/hostNames.ts).
 * The hello, `/api/hello`, peer.register, notices and the hub all say it.
 */
export function hostLabel(): string {
  return shortHostName(hostname())
}
