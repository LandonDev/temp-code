import { describe, expect, it } from 'vitest'
import { ADDON_SERVICE, AddonGrantBlobSchema, addonRedirectUri, grantGaps, grantNeeds, type AddonGrantBlob } from './addonGrant'
import type { AddonSpec } from './contract-addons'

const oauthSpec: AddonSpec = { transport: 'http', url: 'https://mcp.mobbin.com/mcp', headers: [], auth: 'oauth' }
const fieldsSpec: AddonSpec = { transport: 'stdio', command: 'npx', args: ['server'], env: ['GITHUB_TOKEN', 'ORG'], auth: 'fields' }
const registered = {
  clientId: 'client-1',
  redirectPort: 47_123,
  authorizationUrl: 'https://auth.example.com/authorize',
  tokenUrl: 'https://auth.example.com/token'
}
const blob = (over: Partial<AddonGrantBlob> = {}): AddonGrantBlob => ({ v: 1, mintedBy: 'app', addonId: 'ad_x', fields: {}, ...over })

describe('the add-on grant', () => {
  it('is its own service, with a fixed loopback callback', () => {
    expect(ADDON_SERVICE).toBe('addon')
    expect(addonRedirectUri(47_123)).toBe('http://127.0.0.1:47123/callback')
  })

  it('parses a fields grant and a registered OAuth client, and refuses one not minted by the app', () => {
    expect(AddonGrantBlobSchema.parse(blob({ fields: { GITHUB_TOKEN: 'v' } })).fields.GITHUB_TOKEN).toBe('v')
    expect(AddonGrantBlobSchema.parse(blob({ oauth: registered })).oauth?.redirectPort).toBe(47_123)
    expect(AddonGrantBlobSchema.safeParse({ ...blob(), mintedBy: 'cli' }).success).toBe(false)
    expect(AddonGrantBlobSchema.safeParse(blob({ oauth: { ...registered, redirectPort: 80 } })).success).toBe(false)
  })

  it('names what a spec needs and what the grant still lacks', () => {
    expect(grantNeeds(fieldsSpec)).toEqual({ fields: ['GITHUB_TOKEN', 'ORG'], oauth: false })
    expect(grantNeeds(oauthSpec)).toEqual({ fields: [], oauth: true })
    expect(grantNeeds({ ...fieldsSpec, auth: 'oauth', tokenEnv: 'TOKEN', env: ['TOKEN', 'ORG'] } as AddonSpec)).toEqual({ fields: ['ORG'], oauth: true })
    expect(grantGaps(fieldsSpec, null)).toEqual(['GITHUB_TOKEN', 'ORG'])
    expect(grantGaps(fieldsSpec, blob({ fields: { GITHUB_TOKEN: 'v', ORG: '' } }))).toEqual(['ORG'])
    expect(grantGaps(fieldsSpec, blob({ fields: { GITHUB_TOKEN: 'v', ORG: 'o' } }))).toEqual([])
    // A client registered but never signed in still needs the sign-in.
    expect(grantGaps(oauthSpec, blob({ oauth: registered }))).toEqual(['sign-in'])
    expect(grantGaps(oauthSpec, blob({ oauth: { ...registered, accessToken: 'at' } }))).toEqual([])
    expect(grantGaps({ ...oauthSpec, auth: 'none' } as AddonSpec, null)).toEqual([])
  })
})
