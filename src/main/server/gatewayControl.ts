import { accounts, localAccounts, vault, type ForwardHooks, type LimitInfo } from 'aliax-core'
import type { ControlPlane, FailedOverInfo, NetworkInfo, ResponseInfo, RoutingHooks, ScopedRequest } from './gatewayCore'

/**
 * The gateway's host in this very process: aliax-core's own reads of the
 * vault, the Keychain, the settings and the usage cache (refreshing a token
 * when this process owns the marker), and the server's routing hooks called
 * as they are. Today's wiring: tests, the in-process proofs, and the
 * gateway's home when its utility process cannot start. The main process
 * also answers the utility process's asks with it (gatewayHost.ts).
 */
export class InProcessControl implements ControlPlane {
  readonly pickNext?: (info: LimitInfo) => Promise<string | null>

  constructor(private readonly hooks: ForwardHooks & RoutingHooks = {}) {
    // Core charges a 429 and replays only when the host can pick: without the hook it passes through.
    if (hooks.pickNext) this.pickNext = (info) => hooks.pickNext!(info)
  }

  credentialFor(service: string, account: string | null) {
    return localAccounts.credentialFor(service, account)
  }

  async profilesKnown(serviceId: Parameters<ControlPlane['profilesKnown']>[0]): Promise<string[]> {
    return vault.profiles(serviceId).map((p) => p.name)
  }

  async pinned(serviceId: Parameters<ControlPlane['pinned']>[0]): Promise<string | null> {
    return localAccounts.pinned(serviceId)
  }

  async usageReport(...[serviceId, name]: Parameters<ControlPlane['usageReport']>) {
    return accounts.cachedReport(serviceId, name)
  }

  usage(...[serviceId, force]: Parameters<ControlPlane['usage']>) {
    return accounts.usage(serviceId, force)
  }

  async substitute(info: ScopedRequest): Promise<string | null> {
    return this.hooks.substitute?.(info) ?? null
  }

  async onUnauthorized(info: ScopedRequest): Promise<string | null> {
    return this.hooks.onUnauthorized?.(info) ?? null
  }

  observeLimit(...[serviceId, name, limit]: Parameters<ControlPlane['observeLimit']>): void {
    localAccounts.observeLimit(serviceId, name, limit)
  }

  async pin(...[serviceId, name]: Parameters<ControlPlane['pin']>): Promise<void> {
    await localAccounts.pin(serviceId, name)
  }

  onResponse(info: ResponseInfo): void {
    this.hooks.onResponse?.(info)
  }

  onRouted(info: Parameters<ControlPlane['onRouted']>[0]): void {
    this.hooks.onRouted?.(info)
  }

  onFailedOver(info: FailedOverInfo): void {
    this.hooks.onFailedOver?.(info)
  }

  onError(message: string): void {
    this.hooks.onError?.(message)
  }

  onNetwork(info: NetworkInfo): void {
    this.hooks.onNetwork?.(info)
  }
}
