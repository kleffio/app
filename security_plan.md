# Kleff Platform — Security Plan

> **Scope.** Everything security-related EXCEPT the plugin sandboxing/permission model — that lives in `plan.md` Section 5. This document covers the identity stack, RBAC, sessions, transport, secrets, audit, deployment hardening, dependency hygiene, and the new **Identity Framework** built into the platform itself.

## Table of Contents

1. [Critical Issues](#1-critical-issues)
2. [Identity Framework — Native Default](#2-identity-framework--native-default)
3. [Authentication & Sessions](#3-authentication--sessions)
4. [RBAC & Authorization](#4-rbac--authorization)
5. [API Surface Hardening](#5-api-surface-hardening)
6. [Platform Secret Management](#6-platform-secret-management)
7. [Transport & Network Security](#7-transport--network-security)
8. [Audit Logging](#8-audit-logging)
9. [Container & Deployment Security](#9-container--deployment-security)
10. [Dependency & Supply-Chain Security](#10-dependency--supply-chain-security)
11. [Cross-Cutting Defenses](#11-cross-cutting-defenses)
12. [Implementation Order](#12-implementation-order)
13. [Threat Model Summary](#13-threat-model-summary)

---

## 1. Critical Issues

These are immediate-fix items. Each appears later with full context.

| # | Issue | File / Location | Severity |
|---|---|---|---|
| C1 | Daemon and API run as **`user: root`** in both dev AND prod compose | `docker-compose.yml:36`, `docker-compose.dev.yml:30` | **Critical** |
| C2 | **No rate limiting** on any endpoint (login, register, refresh, install) | All HTTP routes | **Critical** |
| C3 | **No native identity framework** — if you don't run Keycloak/Authentik, you cannot manage users at all | Architecture gap | **Critical** |
| C4 | **No fallback token verifier** — if active IDP plugin dies, the entire platform is locked | `plugin_verifier.go` | **High** |
| C5 | **JWT access tokens stored in `localStorage`** — readable by any XSS payload | `panel/web/src/features/auth/store-tokens.ts` | **High** |
| C6 | **Hardcoded dev/admin credentials committed** to repo | `docker-compose.dev.yml`, `plugins.local.json` (Authentik admin/admin, Keycloak admin/admin) | **High** |
| C7 | **Audit log endpoints return 501** — infrastructure exists, persistence + reads aren't wired | `panel/api/internal/core/audit/adapters/http/handler.go:27-35` | **High** |
| C8 | **No CSRF defense on mutating endpoints** + bearer token can be passed via `?token=` query param | `middleware/auth.go:94-104` | **High** |
| C9 | **Personal-org ID derived from JWT subject** can collide across IDPs | `organizations/adapters/http/handler.go:605-621` | **High** |
| C10 | **Single platform-wide AES key** for plugin secrets, derived via plain SHA-256 (not a real KDF) | `bootstrap/config.go:127`, `manager.go encryptSecrets` | **High** |
| C11 | **Postgres connection unencrypted** (`sslmode=disable` in examples) | `.env.example` | **Medium** |
| C12 | **Containers have no `HEALTHCHECK`** instruction → orchestrator can't detect hung processes | `panel/api/Dockerfile`, `daemon/Dockerfile` | **Medium** |
| C13 | **Header-injection trust path**: `X-Org-Id` / `X-User-Id` accepted as auth fallback in deployments | `deployments/adapters/http/handler.go:89-96` | **Medium** |
| C14 | **No structured input validation** — JSON decode + ad-hoc length checks; no max-size on request bodies | All handlers | **Medium** |

---

## 2. Identity Framework — Native Default

**The single biggest security/usability gap.** Today, every authentication, registration, password change, session listing, and user CRUD operation is forwarded over gRPC to an external IDP plugin (Keycloak/Authentik). If you don't install one, **you cannot create a user**. The "Generic OIDC" plugin only implements `identity.provider` (token validation), so users can sign in via their company SSO but cannot manage local accounts.

This is wrong for an open-source self-hostable platform. There must be a default that works out of the box.

### 2.1 Build a first-party `identity-native` framework plugin

A real plugin (not platform code) that lives in this repo and ships with the default install. Implements both `identity.provider` AND `identity.framework`. Stores users locally in the platform DB schema (separate `identity_users`, `identity_sessions`, `identity_credentials`, `identity_password_resets` tables).

**Capabilities:**

- **Provider:** issues RS256 JWTs signed by a key-pair the platform creates at first boot. Validates incoming tokens via JWKS endpoint exposed by the same plugin.
- **Framework:** full user CRUD, role assignment, session listing/revocation, password change, password reset (with email + token), TOTP MFA, WebAuthn/passkey enrollment, account lockout after N failed attempts.
- **Bootstrap:** on first boot, exposes the existing `/setup` flow to create the first admin without requiring any IDP.

**Why a plugin and not platform code:** keeps the architecture honest — platform speaks only to `identity.framework` capability, plugin can be swapped for Keycloak/Authentik when the operator wants enterprise IAM. Same contract, different implementation.

### 2.2 Password policy & credential storage

- **Hashing:** Argon2id with parameters `m=64MiB, t=3, p=4` (OWASP 2023). Migration helper for any pre-existing bcrypt hashes.
- **Password requirements:** minimum 12 chars, configurable rules in `kleff-plugin.json` config.
- **Breach check:** optional opt-in to HIBP `k-anonymity` API (`api.pwnedpasswords.com/range/{first5}`) before accepting a new password. Off by default to stay air-gap-friendly.
- **Reset flow:** email link with single-use 32-byte token, 30-minute TTL, hashed in DB.
- **Account lockout:** after 5 failed attempts in 15 minutes → 15-minute lockout, exponential per attempt thereafter. Lockout state in Redis.
- **Re-authentication:** sensitive actions (change password, change email, enable/disable MFA, delete account) require re-entering password within last 5 minutes (re-auth token).

### 2.3 MFA

- **TOTP** via standard RFC 6238 (Google Authenticator, 1Password, Authy compatible).
- **WebAuthn/Passkeys** via `github.com/go-webauthn/webauthn` library.
- **Recovery codes:** 10 single-use codes generated at MFA enrollment, shown once, hashed at rest.
- Step-up authentication: if user has MFA enabled, sensitive endpoints require a recent MFA verification (signed in JWT `amr` claim).

### 2.4 Sessions

- Session ID is a random 32-byte token issued at login alongside the access token, persisted server-side.
- JWT `sid` claim carries the session ID. Refresh + revocation operate on this ID.
- Revocation list in Redis (TTL = remaining JWT lifetime). Verifier checks `sid` against the deny-list on every request.
- Session list exposed at `/api/v1/identity/sessions` with IP, UA, location (best-effort GeoIP), last seen, current=true marker.

### 2.5 Tenant-aware identity

- A user can belong to multiple organizations. Roles are per-org (already true for `organizations.role`).
- The JWT carries `roles` for the **current org context** only, plus `org_id` and `tenant_id` claims.
- An "org switcher" in the panel re-issues the JWT with the new org context (re-using the same session).
- Platform admin (`role: admin` at platform scope, not org scope) is a separate flag (`is_platform_admin: bool`) on the user, NOT a role. Prevents a user from accidentally getting platform-admin via org membership.

---

## 3. Authentication & Sessions

### 3.1 Token storage on the frontend

The current `oidc-client-ts` setup writes raw access + refresh tokens to `localStorage` (or `sessionStorage` in redirect mode). One stored XSS = full account takeover.

**New model — split-token cookies + memory access token:**

- **Refresh token:** delivered as `__Host-kleff_rt` httpOnly + Secure + SameSite=Strict cookie. Path `/api/v1/identity/refresh`. Never readable by JS.
- **Access token:** lives in JS memory only (React context). Re-fetched via `/api/v1/identity/refresh` on page load using the cookie. Never written to storage.
- **CSRF token:** a separate `__Host-kleff_csrf` cookie (httpOnly + SameSite=Strict) plus a JS-readable `kleff-csrf` cookie. JS reads the readable one, sends it as `X-CSRF-Token` header on every state-changing request. Server compares header to the httpOnly value (double-submit pattern).
- **Multi-tab sync:** `BroadcastChannel('kleff-auth')` for login/logout events. Refresh-on-focus pattern. Already partially in place.

**Backwards compatibility:** existing `oidc-client-ts` in redirect mode continues to work for users on Keycloak/Authentik — those tokens stay in their respective storages because they're issued by an external IDP and we don't control the cookie domain. The cookie scheme applies to the native identity framework only.

### 3.2 Token verifier resilience

`PluginTokenVerifier` is a single point of failure. If the active IDP plugin's gRPC connection is down, every API request returns 401.

**Fix:** A `CompositeVerifier` chain:

1. **JWKS Verifier (preferred).** Cached JWKS from the active IDP. Validates RS256/ES256 tokens locally with no plugin RPC. Already partially in place via `internal/shared/jwks/`. Make it the primary path; fall back to plugin only when key ID is unknown.
2. **Plugin Verifier (fallback).** Current path. Used when JWKS lookup misses or token format is opaque.
3. **Native Verifier (always).** Validates tokens minted by the native identity framework (Section 2). Tried first if `iss` claim matches the platform issuer.

This means a 30-second Keycloak restart no longer kills the platform — local JWKS validation continues.

### 3.3 Token transport

- **Remove the `?token=` query parameter fallback** from `middleware/auth.go:94-104`. Tokens in URLs leak to logs, browser history, referer headers. The current excuse is SSE; replace it with the EventSource Authorization shim (custom header via fetch + body stream parser) or signed short-lived `?ticket=` query param redeemed once.
- **Reject tokens via header on routes that should be cookie-only** (the new identity-framework refresh endpoint).
- Set `Authorization-Forwarded` headers explicitly never logged in the access log.

### 3.4 Session revocation

- Verifier checks `sid` against Redis deny-list `revoked:{sid}` key (TTL = `exp - now`). Single round trip per request, ~0.1 ms.
- Logout pushes to deny-list AND broadcasts `auth.session.revoked` event to all replicas.
- `/api/v1/identity/sessions/{id}` DELETE adds to deny-list immediately, plus calls IDP plugin's `RevokeSession` if applicable.

### 3.5 Frontend session UX

- **Auto-logout on heartbeat 401**: heartbeat polls `/api/v1/identity/me` every 30 s. On 401, panel redirects to login with `?reason=session_expired`. Already in place — keep, but reduce poll to **60 s** to halve traffic and rely on operations-on-failure for faster detection.
- **Hard 401 from any request → redirect to login** with state preservation (`?return_to={path}`).
- **Idle timeout (configurable, default off):** if the tab is hidden for >X minutes, auto-logout on next activity.

---

## 4. RBAC & Authorization

The current authorization model is ad-hoc string matching: handlers call `RequireRole("admin")` middleware or compare `claims.Roles` directly. There's no policy engine, no resource-level permissions, no formal model. Add one.

### 4.1 The role model

Three orthogonal axes:

| Axis | Values | Where it lives |
|---|---|---|
| **Platform role** | `platform_admin` (bool flag) | `users.is_platform_admin` |
| **Org role** | `owner` / `admin` / `member` / `billing` / `viewer` | `org_members.role` |
| **Project role** | `owner` / `admin` / `member` / `viewer` | `project_members.role` |

A user with `is_platform_admin=true` implicitly has `owner` on every org and project — but this is an explicit promotion, audited.

### 4.2 Permission catalog

Replace string-based role checks with a typed permission catalog. Each permission is `{resource, action}`:

```go
// internal/shared/authz/permissions.go
type Permission struct {
    Resource string  // "organization", "project", "deployment", "plugin", "billing", ...
    Action   string  // "read", "write", "delete", "admin"
}

var (
    OrgRead          = Permission{"organization", "read"}
    OrgWrite         = Permission{"organization", "write"}
    OrgAdmin         = Permission{"organization", "admin"}
    ProjectRead      = Permission{"project", "read"}
    ProjectDeploy    = Permission{"project", "deploy"}
    PluginInstall    = Permission{"plugin", "install"}
    BillingRead      = Permission{"billing", "read"}
    BillingWrite     = Permission{"billing", "write"}
    PlatformAdmin    = Permission{"platform", "admin"}
    // ...
)
```

### 4.3 Role → permission grants (declarative)

```go
var rolePermissions = map[string][]Permission{
    "owner":   { OrgRead, OrgWrite, OrgAdmin, ProjectRead, ProjectWrite, ..., BillingWrite },
    "admin":   { OrgRead, OrgWrite, ProjectRead, ProjectWrite, ProjectDeploy, PluginInstall },
    "member":  { OrgRead, ProjectRead, ProjectWrite },
    "billing": { OrgRead, BillingRead, BillingWrite },
    "viewer":  { OrgRead, ProjectRead },
}
```

### 4.4 Authorization middleware

```go
// In handlers:
r.Get("/projects/{id}", authz.Require(ProjectRead).Then(handleGetProject))
r.Post("/projects/{id}/deploy", authz.Require(ProjectDeploy).Then(handleDeploy))
```

The middleware:

1. Resolves the resource from URL params (`{id}` → load org/project, find user's role).
2. Looks up the permission grant table.
3. Allows or denies, **always writes an audit event** on deny.

### 4.5 Resource-level overrides (future)

Allow direct grants on a single resource: "Alice has `ProjectAdmin` on project XYZ even though her org role is `member`." Stored in `resource_grants(user_id, resource_type, resource_id, permission)`. Defer to v2.

### 4.6 Personal-org collision (C9)

Replace the "JWT subject normalized to a slug = personal org ID" pattern with explicit creation:

- On first login, look up `users.id` by `(idp_issuer, idp_subject)` composite key.
- If new, insert into `users`, then create personal org with random ULID.
- Cache (issuer, subject) → user ID for 5 minutes.

This eliminates cross-IDP collisions and gives every user a stable, opaque ID independent of the IDP's subject format.

### 4.7 Header-injection fallback (C13)

`deployments/adapters/http/handler.go:89-96` accepts `X-Org-Id` / `X-User-Id` headers as auth fallback when the JWT is missing. Remove this entirely. If a code path needs to call deployments without auth (e.g., daemon callbacks), it should use the daemon's shared-secret auth or a service token, not header trust.

---

## 5. API Surface Hardening

### 5.1 Rate limiting (C2)

Add per-route, per-IP, and per-user limits with Redis-backed sliding-window counters. Library: `github.com/go-chi/httprate` for in-memory + Redis adapter for distributed.

| Endpoint pattern | Limit | Key |
|---|---|---|
| `POST /api/v1/identity/login` | 5/min/IP, 10/min/email | IP + email |
| `POST /api/v1/identity/register` | 3/hour/IP | IP |
| `POST /api/v1/identity/password/reset` | 3/hour/email | email |
| `POST /api/v1/identity/refresh` | 60/min/session | session ID |
| `*` (default authenticated) | 600/min/user | user ID |
| `*` (default unauthenticated) | 60/min/IP | IP |
| `POST /api/v1/admin/plugins` (install) | 10/hour/admin | user ID |

Soft limit triggers 429 with `Retry-After` header. Hard limit (3× soft within 5 min) blocks for 1 hour and writes audit event.

### 5.2 CSRF (C8)

Native identity framework uses cookie-based auth — vulnerable to CSRF. Implement double-submit cookie pattern (described in 3.1). Apply to every `POST/PUT/PATCH/DELETE` handler via middleware. Bearer-token auth (used by external integrations) is exempt because it requires reading the token from JS, which CSRF can't do.

### 5.3 Input validation (C14)

- **Request size limit:** global middleware `MaxBytesReader` capped at 1 MiB by default; per-endpoint override (e.g., file uploads at 50 MiB).
- **Schema validation:** adopt `github.com/go-playground/validator/v10` with struct tags. All request structs validated before handler runs.
- **Centralized error response:** validation failures return RFC 7807 Problem Details JSON with field-level errors.
- **Path/Query param validation:** chi route patterns + explicit `chi.URLParam` parsing with format checks (UUID, ULID, slug regex).

### 5.4 CORS

Current default (empty list = allow all) is dangerous if shipped. Change behavior:

- Default = deny cross-origin entirely.
- Operator must explicitly set `CORS_ALLOWED_ORIGINS` to enable cross-origin access.
- Reject any origin with wildcard (`*`) unless `CORS_ALLOW_ANY=true` is also set (forces conscious opt-in).
- Always reject credentials with wildcard origin.

### 5.5 Security headers

Add `internal/shared/middleware/security_headers.go` applying:

- `Strict-Transport-Security: max-age=31536000; includeSubDomains; preload`
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY` (panel never embeds itself)
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy: accelerometer=(), camera=(), geolocation=(), microphone=(), payment=()`
- `Content-Security-Policy` (panel only):
  - `default-src 'self'`
  - `script-src 'self' 'wasm-unsafe-eval'` (no inline; SRI mandatory for plugin bundles)
  - `style-src 'self' 'unsafe-inline'` (Tailwind/inline component styles)
  - `img-src 'self' data: https:`
  - `connect-src 'self' https://api.kleff.io wss://api.kleff.io`
  - `frame-src 'self'` (sandboxed plugin iframes)
  - `frame-ancestors 'none'`

The CSP nonce strategy is unnecessary because the panel doesn't ship inline scripts (Next.js produces external bundles by default).

### 5.6 Endpoint enumeration

`GET /api/v1/openapi.yaml` (added in plan.md Section 6.5) becomes the single source of truth for the public API surface. Anything not listed there is internal — middleware logs warnings if unlisted endpoints are accessed externally.

---

## 6. Platform Secret Management

### 6.1 Master key (C10)

Today: `SECRET_KEY` env var → `sha256()` → AES-256 key for plugin secret encryption. SHA-256 is not a KDF; if the key is short or guessable, it's instantly cracked.

**New:**

- `MASTER_KEY` (32 random bytes, base64 in env or file path via `MASTER_KEY_FILE`).
- HKDF-SHA256 derives sub-keys: `kek_plugin_{plugin_id}`, `kek_session`, `kek_invite`, `kek_password_reset`. Per-purpose keys mean compromise of one doesn't reveal others.
- Bootstrap warning: if `MASTER_KEY` is unset in production mode, refuse to start. Dev mode allows a generated ephemeral key (logged with a big WARN).
- **Rotation:** add `master_key_v2`; the platform decrypts with v1 if v2 fails, re-encrypts on next write. `kleffctl secrets rotate` command runs full re-encrypt.

### 6.2 Pluggable secret backend

Today: secrets live in Postgres (encrypted). Fine for self-hosted; not enough for enterprise.

Add `SecretStore` interface:

```go
type SecretStore interface {
    Get(ctx context.Context, key string) (Secret, error)
    Put(ctx context.Context, key string, val Secret, opts PutOptions) error
    Delete(ctx context.Context, key string) error
    Rotate(ctx context.Context, key string) (Secret, error)
}
```

Implementations:

- `LocalSecretStore` — Postgres, AES-GCM with derived key. Default.
- `VaultSecretStore` — HashiCorp Vault (KV v2).
- `AWSSecretsManagerStore`.
- `GCPSecretManagerStore`.

Selected via `SECRET_BACKEND` env var. Each plugin secret routed through this interface.

### 6.3 Hardcoded credentials (C6)

- **`docker-compose.dev.yml`:** stop committing concrete passwords. Generate them at first `make dev` run via a setup script that writes `.env.dev.local` (gitignored). Container env reads from the local file. The `docker-compose.dev.yml` only references env vars, never literal values.
- **`plugins.local.json`:** the bootstrap admin password for Keycloak/Authentik companions becomes a value the operator is prompted for during install (already supported as a `secret` config field type). Default values like `admin/admin` are removed entirely; the field becomes `required: true`.
- **`KLEFF_SHARED_SECRET`:** generated, not committed. `make setup` writes it.
- **CI secret hygiene:** add a pre-commit hook (`gitleaks`) and a CI job that fails any PR containing high-entropy strings or known credential patterns.

### 6.4 Secret delivery to plugin containers

Already covered in `plan.md` Section 5.7 — tmpfs mount instead of env vars. Mention here for completeness; implementation lives there.

### 6.5 Encryption at rest

- **Postgres column-level:** all columns named `*_secret`, `*_token`, `password_hash` are encrypted with AES-GCM and a column-specific subkey from HKDF. Migration adds an `encrypted` table-tag.
- **Disk:** out of scope (operator's responsibility — recommend LUKS in deployment docs).
- **Backups:** document `pg_dump | gpg --encrypt` pattern in deployment docs.

---

## 7. Transport & Network Security

### 7.1 HTTPS

- **Application:** stays HTTP internally; never bind directly to public ports. All public traffic goes through a reverse proxy (Caddy/Traefik/nginx) that terminates TLS.
- **TLS minimum version** in deployment docs: TLS 1.2; TLS 1.3 preferred.
- **HSTS:** enforced via security-headers middleware (Section 5.5).
- **Cert automation:** docs include Caddyfile example with Let's Encrypt; Traefik example; nginx + certbot example.

### 7.2 Postgres TLS (C11)

- Production deployment example switches `sslmode=verify-full` and provides `sslrootcert` path.
- Code change: `bootstrap/container.go` rejects `sslmode=disable` if `KLEFF_ENV=production`.
- Document the recommended deployment pattern (Postgres on a private network OR enforced TLS).

### 7.3 Redis

- TLS supported via `KLEFF_REDIS_TLS=true` (already in daemon config). Add the same to platform API.
- Redis ACLs documented (default user with `~kleff:*` key prefix).

### 7.4 Service-to-service (platform ↔ daemon)

- Today: shared secret via header. Functional but coarse.
- Upgrade: per-daemon mTLS (each daemon registers and receives a long-lived client cert). Shared secret remains as an enrollment bootstrap mechanism only.
- Daemon outbound reports include a short-lived JWT signed with the daemon's identity key.

### 7.5 mTLS for plugins

Already covered in `plan.md` Section 5.8 (bidirectional mTLS between platform and plugin). Cross-reference.

---

## 8. Audit Logging

### 8.1 Make it actually work (C7)

The `audit` module has the domain types but the HTTP handler returns 501 and there's no persistence wiring. Complete the module:

- **Persistence:** `audit_events` table; columns mirror `domain.AuditEvent`. Index on `(actor_id, occurred_at desc)`, `(resource_type, resource_id, occurred_at desc)`, `(occurred_at desc)`.
- **Write path:** every privileged action calls `audit.Record(ctx, event)`. Async write — events queued in-memory with a 1-second flush window OR immediate write for high-severity events. Failure to write is logged but does not block the action.
- **Read API:**
  - `GET /api/v1/audit/events` — paginated, filterable by actor, resource, action, time range. Platform-admin only.
  - `GET /api/v1/o/{org}/audit/events` — same, scoped to org. Org admin/owner.
  - `GET /api/v1/identity/me/activity` — current user's own actions. Self.
- **Retention:** configurable, default 90 days. `kleffctl audit purge --before=...` admin job.

### 8.2 What to log

Every event the platform considers privileged or interesting for an incident review:

| Category | Events |
|---|---|
| Auth | `auth.login.success`, `auth.login.failure`, `auth.logout`, `auth.refresh`, `auth.password.changed`, `auth.password.reset.requested`, `auth.password.reset.completed`, `auth.mfa.enabled`, `auth.mfa.disabled`, `auth.session.revoked`, `auth.account.locked` |
| Authz | `authz.denied` (every middleware deny) |
| Identity | `identity.user.created`, `identity.user.updated`, `identity.user.deleted`, `identity.role.assigned`, `identity.role.revoked` |
| Org | `org.created`, `org.deleted`, `org.member.added`, `org.member.removed`, `org.invite.sent`, `org.invite.accepted`, `org.invite.revoked` |
| Project | analogous |
| Plugin | `plugin.installed`, `plugin.removed`, `plugin.enabled`, `plugin.disabled`, `plugin.config.updated`, `plugin.probe.failed`, `plugin.activation.changed` |
| Billing | `billing.subscription.created`, `billing.subscription.canceled`, `billing.payment.method.added` |
| Deployment | `deployment.created`, `deployment.action.start/stop/restart`, `deployment.deleted` |
| Admin | `admin.user.suspended`, `admin.platform.config.updated`, `admin.feature_flag.toggled` |

### 8.3 Tamper resistance

- Append-only table; no `UPDATE` or `DELETE` permitted via DB role (separate writer role with INSERT-only).
- Optional **hash chain**: each event includes `prev_hash = sha256(prev_event_canonical_json)`. A periodic job verifies integrity and writes the chain head to the audit log itself, plus optionally publishes to an external sink (S3 with object-lock, syslog, SIEM).
- `audit.sink` plugin capability (defined in `plan.md` 6.3) lets enterprise users forward to Splunk/Datadog/Elastic.

### 8.4 PII handling

- Audit events store IDs, not PII (no email, no IP if `LOG_IP=false`).
- IP and UA logged by default but redactable via deployment config for GDPR jurisdictions.
- Event metadata is structured JSON with documented field names; never freeform user input.

---

## 9. Container & Deployment Security

### 9.1 Drop root (C1)

Both `panel/api/Dockerfile` and `daemon/Dockerfile` already define a non-root `app` user but `docker-compose.yml` overrides with `user: root`. Audit and remove every `user: root` instance:

- `docker-compose.dev.yml` — daemon needs Docker socket → use `user: app` + `group_add: [docker]` (mount socket with the docker group GID).
- `docker-compose.yml` (prod) — same.
- `panel/api` — never needs root. Remove the override.

### 9.2 HEALTHCHECK (C12)

Add to every Dockerfile:

```dockerfile
# panel/api/Dockerfile
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --quiet --spider http://localhost:8080/healthz || exit 1
```

Daemon: a new `/healthz` endpoint (currently missing — see architecture_plan.md Section 5.5).

### 9.3 Real readiness checks

`/readyz` should actually check:

- DB ping with 1s timeout.
- Redis ping with 500ms timeout.
- Active IDP plugin reachable (or native identity framework if active).
- Bundle store directory writable.

Returns JSON with per-component status and 200/503 overall.

### 9.4 Container hardening

- **Drop capabilities:** `cap_drop: [ALL]` in compose, `add` only what's needed (none for API; daemon needs `CAP_SYS_PTRACE` only if it needs to read child container stats).
- **Read-only root filesystem:** `read_only: true` with explicit tmpfs mounts for `/tmp`, `/run`.
- **No new privileges:** `security_opt: [no-new-privileges:true]`.
- **Memory/CPU limits:** even in dev, set generous ceilings (`mem_limit: 2g`, `cpus: 2.0`) so a runaway process doesn't kill the host.
- **AppArmor / SELinux:** document the recommended profiles in deployment docs.

### 9.5 Daemon Docker socket

The daemon's full Docker socket access is intentional but risky. Mitigations:

- **Socket-proxy in front of daemon:** `tecnativa/docker-socket-proxy` whitelists only the API endpoints the daemon needs (containers create/start/stop/inspect/logs, networks list/create, volumes list/create). Blocks `images/load`, `exec`, `system/info`, etc.
- Document the proxy as the default in the deployment example.
- Daemon binary itself runs as non-root with the docker group.

### 9.6 Image signing & provenance

- All published images signed with `cosign` (keyless via OIDC + Fulcio for OSS).
- SBOM generated by `syft` and attached to each image as an attestation.
- CI verifies SBOM has no critical CVEs before pushing the `latest` tag.

---

## 10. Dependency & Supply-Chain Security

### 10.1 Dependency scanning

- **CI (every PR + nightly):**
  - `govulncheck ./...` for Go modules.
  - `pnpm audit --audit-level=high` for JS.
  - `dotnet list package --vulnerable` for .NET SDK.
  - `trivy image` against built Docker images.
- Dependabot / Renovate enabled for all submodules with grouped PRs.
- Pin major versions; auto-bump patches.

### 10.2 Supply-chain hygiene

- `go.sum` and `pnpm-lock.yaml` mandatory in all repos; CI fails if missing or modified without intent.
- Disallow git dependencies in `package.json` (currently `@kleffio/sdk` is a `github:` dep). Publish all internal packages to a private npm scope.
- All Dockerfiles pin base images by digest, not tag (`alpine@sha256:...`).
- Verify upstream image signatures where available (Distroless, official Alpine).

### 10.3 SBOM & SLSA

- Each release publishes a CycloneDX SBOM via `syft`.
- Build provenance via SLSA-3 (GitHub Actions OIDC + provenance generator).
- `SECURITY.md` documents the provenance verification steps for downstream users.

### 10.4 Vulnerability response

- `SECURITY.md` defines: GPG key for encrypted reports, 90-day disclosure window, expected response time (5 business days).
- Private security advisories via GitHub Security Advisories.
- CVE assigned for any vuln rated High+.

---

## 11. Cross-Cutting Defenses

### 11.1 Logging hygiene

- Never log: passwords, JWTs (full), refresh tokens, MFA secrets, password reset tokens, plugin secrets, session cookies.
- Redact bearer tokens to first-8 + last-4 chars in the access log.
- `Authorization` header stripped from request dumps in error reporting.
- Stack traces never sent to clients (already enforced — keep).

### 11.2 Error message uniformity

- Login failure always returns `{error: "invalid_credentials"}` regardless of whether the user exists, password is wrong, or account is locked. Detailed reason in audit log only.
- "User not found" vs "wrong password" distinction is a classic enumeration vector. Eliminate.
- Same uniformity for password reset (`"if an account exists, an email has been sent"`).

### 11.3 Time-based attack mitigation

- Use `subtle.ConstantTimeCompare` for token/secret comparisons.
- Identity framework password verification uses Argon2 (constant-time by construction).

### 11.4 ID generation hygiene

- Today: 16-byte random hex (`internal/shared/ids/ids.go`). Random is fine for security, but not sortable.
- Move to **ULID** (sortable, 26 char Crockford base32, 80-bit randomness): `oklog/ulid/v2`.
- Public IDs in URLs use ULID; internal database PKs can stay UUID/serial as appropriate. The point is no cross-ID inference.

### 11.5 Internal-vs-external endpoint split

- Internal endpoints (daemon callbacks, internal probes, metrics) bound to a separate listener address (`INTERNAL_LISTEN_ADDR`, default `127.0.0.1:8081`).
- External listener (`HTTP_PORT`, default `8080`) never serves `/internal/*` or `/metrics`.
- Reverse-proxy config in deployment docs explicitly omits `/internal/*` and `/metrics`.

### 11.6 Input fuzzing & e2e security tests

- Add a CI job that runs OWASP ZAP baseline scan against the dev stack.
- Add Go fuzz targets for input parsers (JWT validator, manifest parser, request body parsers).
- Add `httptest`-based fuzzing for handlers via `go-fuzz` patterns.

### 11.7 Backup & disaster recovery

- Document Postgres backup strategy (`pg_dump`, WAL archiving with `pgbackrest`).
- Backups encrypted with GPG (master key separate from `MASTER_KEY`).
- Restore drill documented in `RUNBOOK.md`; quarterly DR test recommendation.

---

## 12. Implementation Order

Each phase is independently shippable. Hard dependencies noted.

### Phase A — Stop the bleeding _(2 days)_

- [ ] **C1** Drop root from all containers in dev + prod compose
- [ ] **C2** Add rate limiting to auth endpoints (login/register/refresh/reset)
- [ ] **C6** Remove hardcoded credentials; `make setup` writes `.env.dev.local`
- [ ] **C8** Remove `?token=` query parameter fallback (replace SSE with header shim or `?ticket=`)
- [ ] **C13** Remove `X-Org-Id` / `X-User-Id` header fallback
- [ ] Add `gitleaks` pre-commit hook + CI job

### Phase B — Native identity framework _(5 days, depends on plan.md Phase 2 contracts)_

- [ ] Build `identity-native` plugin in `plugins/identity-native/` (Go, Tier 2, infra scope)
- [ ] User CRUD + sessions + Argon2id password hashing
- [ ] Email-based password reset
- [ ] Bootstrap path: first install with no IDP → uses `identity-native`
- [ ] Migration path: existing Keycloak/Authentik users keep working (additive)

### Phase C — Auth & session overhaul _(4 days)_

- [ ] **C5** Cookie-based refresh + memory access token; remove localStorage
- [ ] **C8** Double-submit CSRF cookie + middleware
- [ ] **C4** `CompositeVerifier` (JWKS-first, plugin fallback, native always)
- [ ] Redis-backed session deny-list
- [ ] **C9** Stable user IDs replacing JWT-subject-derived org IDs
- [ ] Frontend: refactor `auth/provider.tsx` for new token flow

### Phase D — RBAC framework _(4 days)_

- [ ] `internal/shared/authz/` package with permissions catalog
- [ ] `authz.Require(perm)` middleware
- [ ] Migrate every handler from `RequireRole` strings to `authz.Require`
- [ ] `is_platform_admin` flag separate from org roles
- [ ] Audit: every authz deny writes `authz.denied` event

### Phase E — API hardening _(3 days)_

- [ ] **C14** Body size limits, `validator` schema validation, RFC 7807 errors
- [ ] CORS default-deny + required explicit origins
- [ ] Security headers middleware
- [ ] Internal vs external listener split

### Phase F — Secret management _(3 days)_

- [ ] **C10** `MASTER_KEY` env + HKDF subkey derivation
- [ ] `SecretStore` interface + `LocalSecretStore` (default) and `VaultSecretStore`
- [ ] `kleffctl secrets rotate` command
- [ ] Column-level encryption for `*_secret` / `*_token` / `password_hash` columns

### Phase G — Audit log _(3 days)_

- [ ] **C7** Persistence + read APIs for `audit/`
- [ ] Wire every privileged action to `audit.Record`
- [ ] Append-only DB role
- [ ] Optional hash chain
- [ ] `audit.sink` plugin contract (cross-reference plan.md 6.3)

### Phase H — Transport & deployment _(2 days)_

- [ ] **C12** `HEALTHCHECK` in every Dockerfile
- [ ] Real `/readyz` checks (DB, Redis, IDP, bundle store)
- [ ] **C11** `sslmode=disable` rejected in `KLEFF_ENV=production`
- [ ] Reverse-proxy + TLS docs (Caddy, Traefik, nginx examples)
- [ ] Docker socket-proxy in deployment example

### Phase I — Supply chain & ops _(3 days)_

- [ ] `govulncheck` + `pnpm audit` + `trivy` in CI
- [ ] Dependency pin by digest in Dockerfiles
- [ ] `cosign` image signing in release workflow
- [ ] SBOM generation via `syft`; attached to release
- [ ] `SECURITY.md` with disclosure policy + GPG key

### Phase J — Defense in depth _(ongoing)_

- [ ] OWASP ZAP baseline in CI
- [ ] Fuzz targets for parsers
- [ ] Penetration test before any 1.0 announcement
- [ ] Quarterly DR drill

---

## 13. Threat Model Summary

| Threat | Today | After this plan |
|---|---|---|
| **Stolen access token via XSS** | Full account takeover (localStorage) | Limited blast radius — refresh token is httpOnly cookie; access token only in memory |
| **CSRF on cookie-auth endpoints** | N/A (token-only today) | Defended via double-submit cookie + SameSite=Strict |
| **Brute-force login** | Unlimited attempts | Rate limit + lockout + audit |
| **Compromised IDP plugin = platform-wide compromise** | Yes — every login flows through plugin | Limited — JWKS verifier is the primary path; plugin only validates plugin-issued tokens |
| **Active IDP plugin offline = platform offline** | Yes | No — JWKS cache + native identity framework continue serving |
| **Cross-IDP user collision** | Possible (subject-derived org ID) | Eliminated (stable opaque user ID) |
| **Plugin secret key leak** | All plugin secrets compromised | Per-plugin derived keys; only that plugin's secrets exposed |
| **Container escape via root daemon** | Full host compromise | Daemon runs as `app` user with docker group; capabilities dropped |
| **Daemon Docker API abuse** | Full Docker API available | Limited via socket-proxy whitelist |
| **Postgres credential sniffing** | Plaintext on the wire | TLS required in production |
| **Audit log tampering** | Trivial (no audit log) | Append-only role + optional hash chain + external sink |
| **Supply-chain attack via dep update** | Not detected | Dependabot + govulncheck + pinned digests + SBOM verification |
| **Hardcoded `admin/admin` accidentally promoted to prod** | Possible | Removed entirely; setup script generates secrets |
| **Brute-force enumeration of users** | Possible (different errors) | Eliminated (uniform error messages) |
| **Unbounded request body DOS** | Possible | 1 MiB default cap; explicit per-endpoint overrides |
| **Privilege escalation via header injection** | Trivial in deployments handler | Removed |

---

## Appendix A — Cross-references with `plan.md`

| Concern | Lives in | Notes |
|---|---|---|
| Plugin-level capability enforcement | `plan.md` §5 | Per-RPC gating, capability probe, scope-driven allowlist |
| Plugin network isolation | `plan.md` §5.5 | Per-plugin Docker networks; data network walled off |
| Plugin resource quotas | `plan.md` §5.6 | Per-scope ceilings, OOM circuit breaker |
| Plugin secret tmpfs delivery | `plan.md` §5.7 | Cross-references this doc's master-key/HKDF design |
| Bidirectional plugin mTLS | `plan.md` §5.8 | Per-plugin server + client certs |
| Signed `PluginContext` header | `plan.md` §5.9 | HMAC-signed user context |
| Frontend plugin API scoping | `plan.md` §4.5 | `api.self` / `api.platform` split |
| Plugin sandbox iframe | `plan.md` §4.3 | `trusted` vs `sandboxed` modes |

## Appendix B — Glossary

- **AMR (Authentication Methods References):** JWT claim listing methods used for the current session (e.g., `["pwd", "totp"]`).
- **Argon2id:** Modern password hashing function; OWASP-recommended.
- **CSP (Content Security Policy):** Browser-enforced policy preventing script execution from unauthorized origins.
- **Double-submit cookie:** CSRF defense pattern: same value in two places (cookie + header), server compares.
- **HKDF:** RFC 5869 key derivation function. The right tool for deriving subkeys from a master key.
- **JWKS:** JSON Web Key Set — public keys for verifying JWTs without calling the issuer.
- **MFA / TOTP / WebAuthn:** Multi-factor authentication; Time-based one-time password; FIDO2 passkeys.
- **RFC 7807 Problem Details:** Standard JSON error format for HTTP APIs.
- **SBOM (Software Bill of Materials):** Manifest of every component shipped in a release.
- **SLSA:** Supply-chain Levels for Software Artifacts — provenance and integrity framework.
- **ULID:** Universally Unique Lexicographically Sortable Identifier — UUID alternative that sorts by creation time.
