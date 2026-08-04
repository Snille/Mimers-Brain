# Plan: OIDC sign-in for the open tier

**Status: not built.** This is a design kept on the shelf. The shipped solution
is `MCP_OPEN_KEY` as a URL parameter — see *Authentication* in the README. Build
this instead when more than one client needs real user identity, or when handing
out a shared key stops being acceptable.

## Why it would exist

Claude Desktop's chat side adds remote MCP servers as *custom connectors*, and
that dialog has no field for an `Authorization` header — only OAuth Client ID and
Secret. Pointed at a server with no OAuth it fails with a registration error,
because the client finds nothing it recognises and falls back to trying the OAuth
flow.

The URL-key workaround solves the immediate problem but hands every connector the
same shared secret, in a place that leaks into stored configs and logs. OAuth
replaces that with per-user identity and revocable access.

## Prerequisite

An OpenID Connect provider, publicly reachable over https. This is the reason the
plan sits on the shelf: for a single-machine install it is a far larger
prerequisite than pasting a bearer key. Anyone forking this project without an
identity provider should stay on the key.

Authelia is the worked example below because it is what this deployment already
runs in front of the web UI. Nothing in the server code is Authelia-specific.

## Provider side

Enable the OIDC provider — on a fresh Authelia this is off entirely, and
`/.well-known/openid-configuration` returning 404 is how you confirm it. Under
`identity_providers.oidc`:

- `hmac_secret`, and an RSA key in `jwks`. Generated with
  `authelia crypto rand --length 64` and `authelia crypto pair rsa generate`.
  The key goes in a file beside the configuration, never in git.
- A client with `public: false`, a `client_secret` hashed via
  `authelia crypto hash generate pbkdf2 --variant sha512`, `require_pkce: true`
  with `pkce_challenge_method: S256`, grant types `authorization_code` and
  `refresh_token`, scopes `openid` / `profile` / `groups` / `offline_access`, and
  an `audience` containing the MCP resource URL.
- `redirect_uris` set to the client's callback — see *Open questions*.

Authelia does not support dynamic client registration, so the client ID and
secret are typed into the connector dialog by hand. Providers that do support it
(Keycloak, Auth0) skip that step.

Config syntax differs between Authelia 4.37 and 4.38+. Check `authelia --version`
before writing anything.

## Server side

Authentication already sits together in `server/index.mjs` as `keyOk`,
`cookieOk` and `authOk`. This follows that shape.

Three optional environment variables, so an empty `OIDC_ISSUER` leaves the server
byte-for-byte as it is today:

| Variable | Meaning |
| --- | --- |
| `OIDC_ISSUER` | e.g. `https://auth.example.net`; discovery is read from it |
| `OIDC_AUDIENCE` | the resource the token must be issued for |
| `OIDC_REQUIRED_GROUP` | group that must appear in the `groups` claim |

What gets added:

1. `oidcOk(req)` — verifies the RS256 signature against the provider's JWKS, plus
   `iss`, `aud` and `exp`. Use [`jose`](https://www.npmjs.com/package/jose) rather
   than hand-rolling it; it also handles JWKS caching and key rollover. That makes
   three dependencies instead of two, which is the right trade here.
2. `authOk` gains `oidcOk`, **only when `allowAuthelia` is set** — that is, on the
   open listener alone. The vault listener never gets this path in.
3. The `/mcp` branch answers `401` with
   `WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource/mcp"`
   when OIDC is enabled. This header is what lets a client discover anything at
   all; without it there is nothing to find.
4. Two public routes returning resource metadata per RFC 9728:
   `/.well-known/oauth-protected-resource` and
   `/.well-known/oauth-protected-resource/mcp`. Serve both — clients differ in
   which they ask for. The body names `resource` and `authorization_servers`.

## Proxy side

`docs/nginx-brain.conf` needs a `location` for
`/.well-known/oauth-protected-resource` pointing at the open port **without**
`auth_request`, for the same reason `/mcp` already bypasses it: behind forward
auth the document answers 302 to a login page and the client gets HTML instead of
JSON. Everything under `location /` is subject to that redirect today.

## Open questions

**The client's redirect URI.** It has to be registered exactly at the provider.
Read it from the client vendor's connector documentation, or empirically: attempt
the connection once the provider is up and read the rejected `redirect_uri` out
of the provider's log. The second way is exact and takes a minute.

**Audience.** If the provider does not put the resource URL in `aud` for this
client, validate on the `client_id` in `aud`/`azp` instead. Which applies shows
up in the first token that arrives; set `OIDC_AUDIENCE` accordingly.

## Verification

1. The provider's `/.well-known/openid-configuration` returns metadata.
2. `/.well-known/oauth-protected-resource/mcp` returns JSON, not a redirect.
3. `POST /mcp` with no credentials returns 401 **with** the `WWW-Authenticate`
   header.
4. The old bearer key still returns six tools on both ports. This is the
   regression test that matters most — OIDC is an addition, not a replacement.
5. A user outside the required group is refused; otherwise the group check is
   decoration.
