Recorded 2026-11-08 from Mobbin's live endpoints, unauthenticated:

- `www-authenticate.txt`: the 401's `WWW-Authenticate` to a POST of `initialize` to https://api.mobbin.com/mcp
- `protected-resource.json`: GET https://api.mobbin.com/.well-known/oauth-protected-resource/mcp
- `authorization-server.json`: GET https://ujasntkfphywizsdaapi.supabase.co/.well-known/oauth-authorization-server/auth/v1 (RFC 8414 with path insertion; the OIDC path insertion answers 401)

oauthFlow.test.ts parses them the way a sign-in does.
