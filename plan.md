# Kleff Platform — Plugin & Architecture Overhaul

> **Goal.** A plugin system that is easy to author, hard to misuse, cheap to run, and feels enterprise-grade. Three clearly separated install scopes (User / Organization / Infra), strict capability-based permissions, parity across all SDKs, and frontend plugins that don't ship a Docker container.

## Table of Contents

1. [Critical Fixes](#1-critical-fixes)
2. [Plugin Scope Model — User / Org / Infra](#2-plugin-scope-model--user--org--infra)
3. [Plugin Tiers & Lifecycle](#3-plugin-tiers--lifecycle)
4. [Frontend Plugin System](#4-frontend-plugin-system)
5. [Permission & Security Model](#5-permission--security-model)
6. [Contracts & Wire Format](#6-contracts--wire-format)
7. [SDK Parity (Go / JS / .NET)](#7-sdk-parity-go--js--net)
8. [Plugin Standardization](#8-plugin-standardization)
9. [Plugin Manager Refactor](#9-plugin-manager-refactor)
10. [Crate & Registry Standardization](#10-crate--registry-standardization)
11. [Codebase Standardization](#11-codebase-standardization)
12. [Naming Conventions](#12-naming-conventions)
13. [Implementation Order](#13-implementation-order)
14. [Verification](#14-verification)

---

## 1. Critical Fixes

These block everything else.

### 1.1 Remove `platform/` submodule
`platform/` is a full duplicate of `panel/api/`. All development happens in `panel/api/`.
- Remove `platform` from App `.gitmodules`
- Delete the `platform/` submodule entry
- Archive `kleffio/platform` on GitHub
- Drop `./platform` from App `go.work`

### 1.2 Document `contracts/` dual location
`contracts/` is a submodule at both `App/contracts/` (dev reference) and `panel/api/contracts/` (build dependency). Both point at the same repo — that is correct. Add a one-line note in both READMEs.

### 1.3 Untrack committed `node_modules/`
- `plugins/components-plugin/node_modules/` → remove + `.gitignore`
- `packages/ui/node_modules/` → remove + `.gitignore`

### 1.4 Stop tracking `plugins.local.json`
Add `panel/api/plugins.local.json` to `panel/api/.gitignore`. Each developer keeps a local copy.

### 1.5 Resolve `www/` package-manager conflict
`www/` has both `package-lock.json` and `pnpm-lock.yaml`. Delete `package-lock.json`, commit to pnpm.

### 1.6 Fix the hardcoded port-3001 binding (already merged)
The `if p.Type == "ui"` block in `manager.go:879-881` was force-binding host port 3001 for every `type: "ui"` plugin, causing port collisions. Verify the fix is still in place after the manager refactor (Section 9).

---

## 2. Plugin Scope Model — User / Org / Infra

The single most important decision in the new architecture. Every plugin declares exactly one **scope**. Scope determines who installs it, what it can affect, what permissions it can request, and how it's audited.

### 2.1 The three scopes

| Scope | Who installs | What it affects | Examples |
|---|---|---|---|
| **`user`** | Any signed-in user | Only that user's experience (their panel, their settings) | Themes, personal dashboards, notification preferences, custom keybindings, personal automations |
| **`org`** | Org admins (role `admin` within an org) | Everything inside one organization (members, projects, billing within the org) | Org-wide dashboards, custom roles, project templates, slack integrations, org SSO mapping |
| **`infra`** | Platform admins only (`role: admin` at platform level) | The whole platform — every org, every user, every node | Identity providers (Keycloak, Authentik), billing providers (Stripe), runtime providers (K8s adapter), observability backends (Prometheus, Datadog) |

### 2.2 Scope ↔ capability allowlist

Capabilities are **gated by scope**. A `user`-scoped plugin literally cannot declare `identity.framework`; the platform rejects the manifest at install time.

| Capability | `user` | `org` | `infra` |
|---|:-:|:-:|:-:|
| `ui.manifest` | ✅ | ✅ | ✅ |
| `api.routes` | ✅ (under `/api/v1/u/{userid}/p/{plugin}/`) | ✅ (under `/api/v1/o/{orgid}/p/{plugin}/`) | ✅ (under `/api/v1/p/{plugin}/`) |
| `api.middleware` | ❌ | ✅ (org-scoped requests only) | ✅ (all requests) |
| `identity.provider` | ❌ | ❌ | ✅ |
| `identity.framework` | ❌ | ❌ | ✅ |
| `billing.provider` | ❌ | ❌ | ✅ |
| `billing.framework` | ❌ | ✅ (read-only) | ✅ |
| `observability.provider` | ❌ | ❌ | ✅ |
| `observability.framework` | ❌ | ✅ | ✅ |
| `runtime.provider` | ❌ | ❌ | ✅ |
| `automation.workflow` *(new)* | ✅ | ✅ | ✅ |
| `events.subscriber` *(new)* | ✅ (own events only) | ✅ (org events) | ✅ (all events) |

### 2.3 Where each scope is installed in the panel

| Scope | URL | UI |
|---|---|---|
| `user` | `/account/plugins` | Personal plugin marketplace; user can enable/disable for themselves |
| `org` | `/o/{orgid}/plugins` | Org admin marketplace; affects all org members |
| `infra` | `/admin/plugins` | Platform admin only; gated by `role: admin` |

### 2.4 Storage isolation

Each scope writes to a separate row namespace in the `plugins` table:

```
plugins(id, scope, owner_id, ...)  --  (id, scope, owner_id) is the composite key
```

- `scope = 'user'` → `owner_id = user_id`
- `scope = 'org'` → `owner_id = org_id`
- `scope = 'infra'` → `owner_id = NULL`

This means the *same* plugin manifest can be installed by 1000 users without colliding.

### 2.5 Audit visibility

| Scope | Visible in audit log to |
|---|---|
| `user` | The user, plus platform admins |
| `org` | All org admins, plus platform admins |
| `infra` | Platform admins only |

---

## 3. Plugin Tiers & Lifecycle

`tier` is orthogonal to `scope`. Tier defines **how the plugin runs**.

### 3.1 The three tiers

```
┌─────────────────────────────────────────────────────────────────────┐
│  Tier 0 — Static                                                    │
│  Frontend bundle only. No container, no gRPC. Platform downloads    │
│  the bundle at install, verifies SHA-256, caches it on disk, and    │
│  serves it from /api/v1/plugins/{id}/assets/bundle.js. Zero cost    │
│  at idle.                                                           │
│  Capabilities: ui.manifest                                          │
│  Allowed scopes: user, org, infra                                   │
├─────────────────────────────────────────────────────────────────────┤
│  Tier 1 — Sidecar (stateless)                                       │
│  gRPC service, no persistent state. Spawned on demand, kept warm    │
│  for N minutes, scaled to zero when idle. Cold start ≤ 2s.          │
│  Capabilities: api.middleware, api.routes, identity.provider        │
│                (stateless validate), automation.workflow,           │
│                events.subscriber                                    │
│  Allowed scopes: org, infra (user plugins are never tier 1+)        │
├─────────────────────────────────────────────────────────────────────┤
│  Tier 2 — Service (stateful)                                        │
│  Long-running container with its own DB, network identity, and      │
│  state. Restart policy + health checks. Necessary for full IAM,     │
│  payment processors, and runtime adapters.                          │
│  Capabilities: identity.framework, billing.provider,                │
│                billing.framework, observability.*, runtime.provider │
│  Allowed scopes: infra only                                         │
└─────────────────────────────────────────────────────────────────────┘
```

**Rule:** the platform rejects any manifest where `(scope, tier, capabilities)` is inconsistent.

### 3.2 Hybrid plugins (Tier 1 or 2 + frontend)

A backend plugin that *also* contributes UI declares `ui.manifest` plus its backend capabilities. The container exposes a tiny HTTP endpoint on port 8080 next to gRPC on 50051. The platform fetches the bundle from `http://kleff-{plugin-id}:8080/bundle` at install/reconfigure, verifies the hash, caches it, and serves it from the platform API. The HTTP endpoint sees one request per install — overhead is effectively zero.

### 3.3 Lifecycle states

```
              install
                ↓
         ┌──────────┐
         │ pending  │  manifest valid, fetching bundle / pulling image
         └─────┬────┘
               ↓
         ┌──────────┐    capability probe failed
         │ probing  │ ──────────────────────────────→ ┌───────┐
         └─────┬────┘                                 │ error │
               ↓ probes pass                          └───────┘
         ┌──────────┐    disable               ┌──────────┐
         │ running  │ ────────────────────────→│ disabled │
         └─────┬────┘                          └─────┬────┘
               ↓ uninstall                           ↓ enable
         ┌──────────┐                                │
         │ removing │ ←──────────────────────────────┘
         └─────┬────┘
               ↓
            (gone)
```

States are persisted in the `plugins.status` column. Every transition writes an audit event.

---

## 4. Frontend Plugin System

The current frontend plugin path is the most-broken part of the system. It's both **buggy** (slot registry race conditions, no error isolation between plugins, brittle window globals) and **wasteful** (a Docker container per static JS bundle).

### 4.1 What's wrong today

| Problem | Cause |
|---|---|
| Each frontend plugin needs a full Nginx container | `frontend_url` points at an arbitrary HTTP server the plugin must run |
| No SRI verification | Bundle URL is whatever the manifest says, served from anywhere |
| Hardcoded host port 3001 for every `type: "ui"` plugin | Bug in `manager.go:879-881` (now fixed; keep the regression test) |
| `window.__kleff__` global is fragile | Plugin sees a *snapshot* of React; React version mismatches silently break |
| No plugin isolation in the host | One bad plugin can crash the whole panel; PluginErrorBoundary helps but only at render time |
| `api` client has unrestricted access to every panel API | Plugin script runs in the same JS context; nothing stops `fetch('/api/v1/admin/...')` |
| No caching of bundles | Every page load re-fetches; nginx cache headers vary by plugin |
| `frontendUrl` field name is inconsistent with the proto's `bundle_url` | Manifest uses `frontendUrl`, proto uses `bundle_url`, DB column is `frontend_url` |

### 4.2 New delivery model

1. **Manifest declares `bundle_url`** (the source URL the platform should fetch from at install time) and **`bundle_hash`** (SHA-256 hex). For Tier 0 this is a CDN/registry URL. For hybrid plugins this is `http://kleff-{plugin-id}:8080/bundle` and the platform constructs it automatically.
2. **At install** the platform fetches the bundle (30s timeout, 10 MB max), verifies the SHA-256 against `bundle_hash`, and writes it to `${KLEFF_BUNDLE_STORE_PATH}/{plugin-id}/bundle.js` (default `data/plugin-bundles/`).
3. **At runtime** the panel loads the bundle from `/api/v1/plugins/{id}/assets/bundle.js` — same origin, browser-cacheable, ETag = bundle hash for free 304s.
4. **The `<script>` tag carries SRI** `integrity="sha256-{base64(bundle_hash)}"` so even a compromised platform cannot serve a tampered bundle.
5. **At uninstall** the cached file is deleted.

Result: zero containers for static plugins; one *idle* HTTP endpoint for hybrid plugins.

**New files:**
- `panel/api/internal/core/plugins/infrastructure/bundle_store.go` — `BundleStore` interface + `LocalBundleStore` (filesystem with hash check)
- `panel/api/internal/core/plugins/infrastructure/bundle_fetcher.go` — `BundleFetcher` (timeout, size cap, hash verification)
- `panel/api/internal/core/plugins/adapters/http/bundle_handler.go` — the `GET /assets/bundle.js` route

### 4.3 Frontend isolation modes

Add an `isolation` field to the manifest:

| Mode | When to use | How it works |
|---|---|---|
| `trusted` (default for `infra` plugins) | Verified first-party or admin-installed plugins | Bundle runs in the panel's JS context, gets `window.__kleff__` access. Current behavior. |
| `sandboxed` (default for `user` and `org` plugins) | Anything user-installed or community | Bundle runs inside a hidden `<iframe sandbox>` with a `postMessage` bridge. No DOM access to the host; only the slot positions the host renders into iframes. |

Sandboxed plugins receive a tiny RPC API over postMessage (navigate, toast, getCurrentUser, scoped storage, scoped fetch) and can only render React components into pre-allocated iframe slots. This makes XSS in a plugin harmless to the panel.

The choice is enforced — `user` and `org` scopes cannot opt into `trusted`.

### 4.4 Slot system improvements

Current slot registry (`pluginRegistry` + `useSyncExternalStore`) is reasonable but has gaps:

- **Typed slot props.** Add `SlotPropsMap` mapping each `SlotName` to its expected props. `SlotRegistration<S>` becomes generic so `component` is typed to `ComponentType<SlotPropsMap[S]>`.
- **Stable slot contracts.** Slot names and prop shapes become a versioned API surface (`SLOT_API_VERSION` in the SDK). Breaking changes increment the version; the panel refuses to render plugins targeting an old version.
- **Plugin error budgets.** `PluginErrorBoundary` already isolates render errors. Add a circuit breaker: 3 errors in 60s → plugin marked unhealthy, slots stop rendering, toast notifies the user/admin.
- **Slot priority.** Already supported (`priority`, default 100). Surface it in the panel UI for `org`/`infra` admins to override ordering.
- **Custom slots.** Plugins can declare their own slot names (e.g., `myplugin.dashboard.section`) that other plugins can target. Useful for plugin-of-plugins composition.

### 4.5 Frontend SDK API client scoping

Frontend plugins currently get an `api` client that can call *any* endpoint with the user's session cookie. Scope it:

```ts
// New PluginApiClient
interface PluginApiClient {
  // Plugin's own namespace — always allowed
  self: {
    get<T>(path: string): Promise<T>;   // → /api/v1/{u|o|p}/{owner}/p/{plugin-id}/{path}
    post<T,B>(path: string, body?: B): Promise<T>;
    put / patch / del ...
  };
  // Platform APIs — only allowed if plugin's scope/capability permits
  platform: {
    me(): Promise<User>;                 // any plugin
    org(): Promise<Organization|null>;   // org/infra plugins only
    listProjects(): Promise<Project[]>;  // requires `projects.read` permission
    // ... explicitly allow-listed methods only
  };
}
```

Implementation: the panel intercepts `api.platform.*` calls and checks the plugin's declared `permissions` array (Section 5.3) before forwarding. `api.self.*` is always allowed but the URL is rewritten to the plugin's own namespace.

### 4.6 Bundle build tooling

Ship a `kleff plugin` CLI in `plugins/plugin-cli/` (Go) with:

- `kleff plugin new --kind=static|sidecar|service --scope=user|org|infra` — scaffolds a repo with the right SDK, manifest, and Dockerfile (or no Dockerfile for static)
- `kleff plugin build` — runs `tsup`/`go build`/`dotnet publish` based on detected stack, writes `dist/bundle.js` for frontends, computes SHA-256, updates `kleff-plugin.json` `bundle_hash` field
- `kleff plugin validate` — validates `kleff-plugin.json` against the JSON Schema
- `kleff plugin probe --plugin path` — boots the container locally, runs the platform's capability probe against it, prints results
- `kleff plugin publish` — pushes to the registry (image to ghcr.io, manifest PR to plugin-registry)

---

## 5. Permission & Security Model

This is the section that fixes "any plugin can do anything." The current implementation has **eight critical enforcement gaps** identified in audit. Each one gets a concrete fix below.

### 5.1 Audit summary (what's broken right now)

| # | Gap | Where | Risk |
|---|---|---|---|
| 1 | `permittedCapabilities()` returns `nil` (= unrestricted) when a plugin has no layer tags | `permissions.go:26-43` | Plugin with no tags can claim ANY capability |
| 2 | No per-RPC capability check before forwarding | `pool.go`, `manager.go` `ValidateToken` etc. | Plugin claiming `api.routes` could hijack `identity.provider` if it's the active IDP slot |
| 3 | All containers on the same Docker network as Postgres/Redis | `docker-compose.dev.yml`, `docker.go:129` | Plugin can connect directly to the platform DB |
| 4 | No CPU/memory limits | `manager.go:880-889` | One plugin can OOM the host; `RestartAlways` makes it a loop |
| 5 | Secrets injected as env vars | `manager.go:847-860` | Any other process in the container namespace can read `/proc/$pid/environ` |
| 6 | mTLS is server-only (one-way) | `tls.go`, `pool.go:44-51` | Plugin cannot verify the platform; no per-RPC auth |
| 7 | Frontend `api` client has full user permissions | `PluginContextProvider.tsx:17-38` | Any user-installed plugin = full session takeover potential |
| 8 | Single AES key for all plugin secrets | `manager.go` encryptSecrets | Key compromise = total compromise |

### 5.2 Strict capability enforcement

Replace `permissions.go` with a strict allowlist driven by **scope** (Section 2.2), not by ad-hoc tags.

```go
// scope_capabilities.go (new)
var scopeCapabilities = map[PluginScope]map[string]bool{
    ScopeUser: {
        "ui.manifest":          true,
        "api.routes":           true,
        "automation.workflow":  true,
        "events.subscriber":    true, // own events only
    },
    ScopeOrg: {
        "ui.manifest":          true,
        "api.routes":           true,
        "api.middleware":       true,
        "billing.framework":    true, // read-only
        "observability.framework": true,
        "automation.workflow":  true,
        "events.subscriber":    true, // org events
    },
    ScopeInfra: { /* every capability */ },
}

func validateCapabilities(scope PluginScope, declared []string) error {
    allowed := scopeCapabilities[scope]
    for _, c := range declared {
        if !allowed[c] {
            return fmt.Errorf("capability %q is not permitted for scope %q", c, scope)
        }
    }
    return nil
}
```

- Called at install time on the manifest's declared capability list.
- Called again after `GetCapabilities()` RPC to make sure the plugin's runtime declaration matches.
- Any mismatch → install fails, no container started.

### 5.3 Per-RPC capability gating

Wrap the gRPC client pool with capability-aware interceptors so the platform can never call an RPC the plugin didn't declare.

```go
// In pool.go — every typed-client getter checks capabilities:
func (p *Pool) IDPProviderClient(id string) (pluginsv1.IdentityProviderClient, error) {
    if !p.HasCapability(id, "identity.provider") {
        return nil, fmt.Errorf("plugin %q has no identity.provider capability", id)
    }
    // ... return client wrapped with logging interceptor
}
```

Same for `IDPFrameworkClient`, `MiddlewareClient`, `APIRoutesClient`, `UIClient`. Combined with 5.2, a plugin cannot ever be called for an RPC it didn't declare and didn't pass capability probe for.

### 5.4 Capability probe at install time

Already in the existing plan; making it mandatory and enforced. After `GetCapabilities()` returns, the platform calls a lightweight RPC for each declared capability with a 5-second timeout. Failure = install fails.

| Capability | Probe RPC |
|---|---|
| `ui.manifest` | `GetUIManifest` |
| `api.routes` | `GetRoutes` (then verify routes match `/api/v1/{u\|o\|p}/...` allowed prefix for scope) |
| `api.middleware` | `OnRequest` with synthetic `path=/__probe`, plugin must return `allow=true` |
| `identity.provider` | `GetOIDCConfig` |
| `identity.framework` | `ListRoles` (read-only) |
| `billing.provider` | `Health` (full probe is too expensive) |
| `runtime.provider` | `Health` |

### 5.5 Network policies (real isolation)

Today: every plugin is on `kleff-local`, can reach `postgres:5432`. That's a remote shell waiting to happen.

New design:

- **Per-plugin Docker networks.** Each plugin gets `kleff-plugin-{id}` (Docker `network create`). Companions for that plugin attach to the same network.
- **Platform bridge network.** A separate `kleff-control` network with only the platform API. The platform is attached to every plugin network plus the control network. Plugins are not on the control network.
- **Postgres/Redis on `kleff-data`** — only the platform API attaches. Plugins cannot route there.
- **Egress.** Block external network egress by default. Plugins requesting `network: ["egress"]` in the manifest get an explicit allowlist of domains; the platform configures iptables rules in the network namespace.

In Kubernetes mode: this is a `NetworkPolicy` per plugin namespace.

### 5.6 Resource quotas

Add resource fields to the manifest with platform-enforced ceilings per scope:

```json
"resources": {
  "memory_mb": 256,        // request
  "memory_mb_max": 512,    // limit
  "cpu_millicores": 100,
  "cpu_millicores_max": 500
}
```

Defaults if omitted: 128 MB / 256 MB / 50m / 250m.

Platform-enforced **ceilings**:

| Scope | Memory max | CPU max |
|---|---|---|
| `user` | 128 MB | 100m |
| `org` | 1 GB | 1000m (1 core) |
| `infra` | unlimited (declared) | unlimited (declared) |

Restart policy: `on-failure` with exponential backoff (5s, 10s, 30s, 60s, 5min, then disable plugin and audit). No more `RestartAlways` infinite loops.

### 5.7 Secret management

Replace the single platform-wide AES key with **per-plugin derived keys** and stop injecting secrets as env vars.

- **Key derivation:** `plugin_key = HKDF(master_key, "kleff-plugin-secret-v1" || plugin_id || installed_at)`. Compromise of a single plugin's key reveals only that plugin's secrets.
- **Delivery:** Mount secrets into the plugin container as a tmpfs file at `/run/kleff/secrets/{KEY}` instead of env vars. Plugin SDK exposes `cfg.Secret("KEY")` which reads the file. tmpfs is in-memory, scoped to the container's mount namespace, and never visible via `/proc/{pid}/environ`.
- **Rotation:** Manifest can declare `"rotates": true` for a secret; platform re-injects on a schedule and signals SIGHUP to the container.
- **Backend:** Pluggable secret backend interface (`SecretStore`) with default `LocalSecretStore` (encrypted in Postgres). Optional `VaultSecretStore`, `AWSSecretsManagerStore` for enterprise deployments.

### 5.8 mTLS — both directions

Currently the plugin gets a server cert; the platform has the CA and verifies server hostname. The plugin has no way to verify the platform.

New: **bidirectional mTLS** with per-plugin CA pair.

- At install, generate two certs: server cert for the plugin, client cert for the platform.
- Plugin gets: server cert + key + the **platform CA** to verify incoming calls.
- Platform gets: client cert + key for outgoing calls + the **plugin server cert fingerprint** to pin (defense against rogue plugin CA).
- gRPC server in the SDK: `tls.Config{ ClientAuth: tls.RequireAndVerifyClientCert }`.
- Plugin can therefore verify "this gRPC call came from the real Kleff platform."

### 5.9 Signed request context

Add a `kleff-context` header on every platform→plugin RPC:

```
kleff-context: <base64 JSON {iss, sub, roles[], org_id, scope, exp, jti}>
kleff-signature: <base64 HMAC-SHA256(header, plugin_signing_key)>
```

The plugin SDK exposes `ctx.PluginContext(grpcCtx)` returning a verified, deserialized struct. Plugins can rely on `roles` and `sub` cryptographically.

The signing key is per-plugin, derived like the secret key in 5.7. Replay protection: `jti` deduplicated for `exp - now` window in the SDK helper.

### 5.10 Frontend plugin API scoping

Already covered in 4.5. The frontend `api` client splits into `api.self` (plugin's own namespace, always allowed) and `api.platform` (allow-listed methods, gated by manifest `permissions`).

For sandboxed plugins (4.3) the postMessage bridge enforces this at the iframe boundary — there's no way to bypass.

### 5.11 Audit log

Every privileged action writes an audit entry (`audit_events` table):

- Plugin installed / removed / enabled / disabled / reconfigured
- Capability probe results
- Plugin RPC failures above threshold
- mTLS handshake failures
- Secret access (just metadata: which plugin asked for which key, never the value)
- Quota violations (OOM kill, CPU throttle)

Visibility per Section 2.5. Exposed via `/api/v1/{audit endpoint per scope}` and via the panel UI.

### 5.12 Permission summary table

| Plugin can… | `user` | `org` | `infra` |
|---|:-:|:-:|:-:|
| Add nav items / pages / slot widgets | ✅ | ✅ | ✅ |
| Own routes under its scoped namespace | ✅ | ✅ | ✅ |
| Read its own config / secrets | ✅ | ✅ | ✅ |
| Read the calling user's identity (cryptographically verified) | ✅ | ✅ | ✅ |
| Subscribe to its own scope's events | ✅ | ✅ | ✅ |
| Read other plugins' config | ❌ | ❌ | ❌ |
| Modify platform DB | ❌ | ❌ | ❌ (only via declared capability) |
| Reach external network | ❌ default, allowlist via manifest | ❌ default, allowlist | ❌ default, allowlist |
| Reach Postgres/Redis | ❌ | ❌ | ❌ |
| Access Docker socket | ❌ | ❌ | only `runtime.provider` capability |
| Run as root in container | ❌ (UID 1000+) | ❌ (UID 1000+) | ❌ unless declared |
| Spawn child containers | ❌ | ❌ | only `runtime.provider` |

---

## 6. Contracts & Wire Format

### 6.1 Versioning strategy

All current contracts are `kleff.plugins.v1`. Today there's no plan for v2. Make it explicit:

- **Proto package = major version.** A v2 lives in `contracts/proto/v2/` with `package kleff.plugins.v2`. Old plugins keep working until the platform drops v1 support.
- **`api_version` field** in `GetCapabilitiesResponse` and the manifest. Platform refuses to load a plugin whose `api_version` is outside `[min_supported, current]`.
- **Capability strings stay versioned via package.** Plugins targeting v2 declare `kleff.plugins.v2/identity.provider` if they need to coexist; the bare string is shorthand for the platform's current default.

### 6.2 Capability negotiation

Extend `GetCapabilitiesResponse`:

```protobuf
message GetCapabilitiesResponse {
  repeated string capabilities = 1;
  string sdk_version = 2;        // e.g. "0.4.0"
  string api_version = 3;        // e.g. "v1"
  string sdk_language = 4;       // "go" | "js" | "dotnet"
  PluginRuntimeInfo runtime = 5; // resource usage hints, build SHA, etc.
}

message PluginRuntimeInfo {
  string build_sha = 1;
  int64  started_at = 2;
  string runtime_version = 3;    // "go1.23" / "dotnet8.0" / "node22"
}
```

Platform stores this on the plugin record for diagnostics and version pinning.

### 6.3 New capability contracts to add

| Capability | Proto file (new) | Why |
|---|---|---|
| `automation.workflow` | `proto/automation/workflow.proto` | Triggers (cron, event, webhook) → handler RPC. Replaces ad-hoc cron scheduling per-plugin. |
| `events.subscriber` | `proto/events/subscriber.proto` | Plugin subscribes to platform events (`user.created`, `project.deployed`, `billing.invoice.paid`, …). Platform pushes via streaming RPC. |
| `secrets.broker` *(infra only)* | `proto/secrets/broker.proto` | Pluggable secret backend (Vault, AWS SM, GCP). |
| `audit.sink` *(infra only)* | `proto/audit/sink.proto` | Forward audit events to external systems (SIEM). |

### 6.4 Standardize error builders in proto

Add a `well_known` import:

```protobuf
import "kleff/wellknown/error.proto";

message LoginResponse {
  oneof result {
    TokenSet token = 1;
    kleff.wellknown.Error error = 2;
  }
}
```

The `Error` message stays as-is (`code`, `message`); the import lets every SDK have a canonical error builder (`errors.Unauthorized("...")`) instead of regenerating the type per service.

### 6.5 OpenAPI alignment

Currently the OpenAPI spec covers only the platform control plane (8 endpoints). Plugins extend the API surface but there's no contract.

- Add a tag `plugins` to `openapi.yaml` covering: `GET/POST /api/v1/{admin|}/plugins`, `GET /api/v1/plugins/{id}/assets/bundle.js`, `POST /api/v1/admin/plugins/{id}/probe`, etc.
- Add the **dynamic plugin route surface**: at runtime the platform composes a per-installation OpenAPI document including each installed plugin's declared routes (`api.routes` capability). Served at `GET /api/v1/openapi.yaml`.
- Add tags: `user-plugins`, `org-plugins`, `infra-plugins` to mirror the scope model.

### 6.6 Streaming

Currently only `RuntimeProvider.Logs` streams. Add server-streaming for:

- `events.subscriber.Stream` — platform pushes events to plugin
- `observability.provider.PushMetrics` → switch to client-streaming for batching
- `automation.workflow.Trigger` — long-running workflow status

Document a streaming convention in `contracts/README.md`: 30s heartbeat, idempotency key, resumption token.

---

## 7. SDK Parity (Go / JS / .NET)

The three SDKs are wildly inconsistent. The go SDK has a JWT validator no other SDK has. The .NET SDK has TLS env loading no other SDK has. The JS SDK has slot composition no other SDK matches. We bring them to feature parity.

### 7.1 Target parity matrix

| Feature | Go | JS | .NET | Notes |
|---|:-:|:-:|:-:|---|
| `BasePlugin` / equivalent | ✅ | n/a (frontend) | ✅ | |
| Auto health + capabilities | ✅ | n/a | ✅ | |
| TLS env loading (`PLUGIN_TLS_CERT_PEM`/KEY) | ✅ *(new)* | n/a | ✅ | |
| Bidirectional mTLS (server + client cert) | ✅ *(new)* | n/a | ✅ *(new)* | |
| JWT/JWKS validator | ✅ | ✅ *(new)* | ✅ *(new)* | JS variant: client-side decode only |
| Signed `PluginContext` parser (Section 5.9) | ✅ *(new)* | ✅ *(new)* | ✅ *(new)* | |
| Error builder helpers | ✅ *(new)* | ✅ *(new)* | ✅ *(new)* | `errors.Unauthorized("...")` etc. |
| Standard logger | slog | console + structured | ILogger | |
| Graceful shutdown / signal handling | ✅ | n/a | ✅ | |
| Auto service registration | ✅ *(new)* | n/a | ✅ | Detect interfaces, register matching gRPC services |
| Config helper (env + tmpfs secrets) | ✅ *(new)* | n/a | ✅ *(new)* | `cfg.Secret("KEY")`, `cfg.String("PORT", default)` |
| Test fixtures / in-memory server | ✅ *(new)* | ✅ *(new)* | ✅ *(new)* | |
| Capability constants | ✅ | ✅ *(new)* | ✅ | |
| Slot system + `definePlugin` | n/a | ✅ | n/a | JS-only by design |
| Sandbox iframe runtime | n/a | ✅ *(new)* | n/a | JS-only |

### 7.2 Common error builder

Every SDK exposes:

```go
// Go
err := errors.Unauthorized("invalid token")
err := errors.NotFound("user", userID)
err := errors.WithDetails(errors.Internal("db down"), map[string]string{"backend":"postgres"})
```

```ts
// JS
const err = errors.unauthorized("invalid token");
```

```csharp
// .NET
var err = Error.Unauthorized("invalid token");
```

These produce a `kleff.wellknown.Error` value plug-and-play into any RPC response oneof.

### 7.3 SDK file structure (target)

**plugin-sdk-go**
```
plugin-sdk-go/
├── v1/
│   ├── server.go             ← BasePlugin + Serve + auto service registration
│   ├── tls.go                ← env loading, bidirectional mTLS config
│   ├── jwt.go                ← JWKS validator + session revocation tracker
│   ├── context.go            ← PluginContext parser (Section 5.9)
│   ├── config.go             ← env + tmpfs secrets helpers
│   ├── errors.go             ← error builders
│   ├── logger.go             ← slog default config
│   ├── capabilities.go       ← capability constants
│   ├── testing.go            ← in-memory test server
│   └── *.pb.go / *_grpc.pb.go (generated)
├── contracts/                ← submodule
├── go.mod                    ← github.com/kleffio/plugin-sdk-go
└── README.md
```

**plugin-sdk-js**
```
plugin-sdk-js/
├── src/
│   ├── index.ts              ← barrel export
│   ├── types.ts              ← PluginManifest, SlotPropsMap, CurrentUser, etc.
│   ├── define-plugin.ts      ← plugin factory
│   ├── plugin-context.tsx    ← React context provider
│   ├── client.ts             ← scoped api.self / api.platform clients
│   ├── hooks.ts              ← usePluginContext, usePluginConfig, usePluginLogger
│   ├── components.tsx        ← PluginSlot, PluginErrorBoundary
│   ├── jwt.ts                ← client-side JWT decode (no validation)
│   ├── errors.ts             ← error builders
│   ├── sandbox/              ← iframe runtime for sandboxed plugins
│   │   ├── host.ts           ← postMessage bridge in panel
│   │   └── guest.ts          ← bundled into sandboxed plugins
│   └── testing.ts            ← test harness
├── package.json              ← @kleffio/plugin-sdk
├── tsup.config.ts
└── README.md
```

**plugin-sdk-dotnet**
```
plugin-sdk-dotnet/
├── src/Kleff.Plugin.Sdk/
│   ├── KleffPlugin.cs        ← abstract base
│   ├── PluginServer.cs       ← Serve + DI + Kestrel mTLS
│   ├── Capabilities.cs       ← constants
│   ├── PluginContext.cs      ← Section 5.9 parser
│   ├── Config.cs             ← env + tmpfs secrets
│   ├── Errors.cs             ← error builders
│   ├── Jwt.cs                ← JWKS validator (Microsoft.IdentityModel.Tokens)
│   ├── Testing.cs            ← test harness
│   └── Internal/Bridges.cs
├── Kleff.Plugin.Sdk.csproj
└── README.md
```

### 7.4 Naming consistency across SDKs

Pick one convention for each name:

| Concept | Go | JS | .NET |
|---|---|---|---|
| Plugin base | `BasePlugin` | n/a | `KleffPlugin` |
| Capability constant | `CapabilityIdentityProvider` | `Capability.IdentityProvider` | `Capabilities.IdentityProvider` |
| Error code | `ErrorCodeUnauthorized` | `ErrorCode.Unauthorized` | `ErrorCode.Unauthorized` |
| Health status | `HealthStatusHealthy` | `HealthStatus.Healthy` | `HealthStatus.Healthy` |

Generation scripts in `contracts/scripts/` regenerate these enums from a single source of truth (`contracts/registry.yaml`) so they can never drift.

### 7.5 Minimal plugin example after parity

Three languages, same shape:

```go
// Go — Tier 1 sidecar with one route
func main() {
    p := sdk.NewPlugin("my-plugin", "1.0.0").
        WithCapability(sdk.CapabilityAPIRoutes).
        OnGet("/hello", func(ctx sdk.Context, r sdk.Request) sdk.Response {
            return sdk.JSON(200, map[string]any{"hi": ctx.Subject()})
        })
    sdk.Serve(p)
}
```

```ts
// JS — Tier 0 static frontend plugin
export default definePlugin({
  manifest: {
    id: "my-plugin",
    name: "My Plugin",
    version: "1.0.0",
    scope: "user",
    tier: 0,
    isolation: "sandboxed",
  },
  slots: [
    { slot: "navbar.item", component: MyNavItem },
    { slot: "page", path: "/my", component: MyPage },
  ],
});
```

```csharp
// .NET — Tier 1 sidecar with one route
public class MyPlugin : KleffPlugin {
    public override string Name => "my-plugin";
    public override string Version => "1.0.0";
    public override IReadOnlyList<string> GetCapabilities() => [Capabilities.APIRoutes];

    [Route("GET", "/hello")]
    public Response Hello(Context ctx, Request r) =>
        Response.Json(200, new { hi = ctx.Subject });
}

await PluginServer.ServeAsync<MyPlugin>(args);
```

`[Route]` attribute and `OnGet` builder DSL are new in 7.x; they remove the `GetRoutes`/`Handle` boilerplate.

---

## 8. Plugin Standardization

### 8.1 Manifest filename

**Canonical:** `kleff-plugin.json` everywhere. Current violations:
- `plugins/plugin-template/plugin.json` → rename
- Update template's Dockerfile + README references

### 8.2 Manifest schema (v1, full)

```json
{
  "schema_version": "1",
  "id": "kleffio/idp-keycloak",
  "name": "Keycloak Identity Provider",
  "version": "1.2.0",
  "scope": "infra",
  "tier": 2,
  "isolation": "trusted",
  "api_version": "v1",
  "min_platform_version": "0.5.0",

  "description": "...",
  "long_description": "...",
  "icon": "Layers",
  "tags": ["sso", "oidc"],
  "author": "Kleff",
  "license": "MIT",
  "verified": true,
  "repo": "https://github.com/kleffio/keycloak-plugin",
  "docs": "https://docs.kleff.io/plugins/keycloak",

  "image": "ghcr.io/kleffio/keycloak-plugin:1.2.0",
  "bundle_url": "https://cdn.kleff.io/plugins/keycloak/1.2.0/bundle.js",
  "bundle_hash": "sha256-abc123...",

  "capabilities": ["identity.provider", "identity.framework", "ui.manifest"],
  "permissions": [
    { "kind": "platform_api", "method": "GET", "path": "/api/v1/admin/plugins" },
    { "kind": "egress", "domain": "*.keycloak.org" }
  ],

  "resources": {
    "memory_mb": 256,
    "memory_mb_max": 512,
    "cpu_millicores": 100,
    "cpu_millicores_max": 500,
    "storage_gb": 1
  },

  "config": [
    { "key": "KEYCLOAK_URL", "label": "Keycloak URL", "type": "url", "required": false },
    { "key": "KEYCLOAK_CLIENT_SECRET", "label": "Client Secret", "type": "secret", "required": true, "rotates": true }
  ],

  "companions": [
    { "id": "keycloak", "image": "quay.io/keycloak/keycloak:26.1", "ports": [...], "volumes": [...] }
  ],

  "dependencies": []
}
```

The full schema lives in `contracts/schema/plugin-manifest.schema.json` (JSON Schema 2020-12). Validated:
- At install time (platform).
- In CI for each plugin repo (`kleff plugin validate`).
- In the registry submission CI (PR rejected if invalid).

### 8.3 Repo structure (Go plugins)

```
{plugin-id}/
├── cmd/plugin/main.go
├── internal/
│   ├── config/config.go
│   └── service/service.go        ← implements capability interface(s)
├── contracts/                    ← submodule kleffio/contracts
├── Dockerfile                    ← Tier 1/2 only
├── kleff-plugin.json
├── go.mod                        ← github.com/kleffio/{plugin-id}
├── .gitignore
├── LICENSE
└── README.md
```

### 8.4 Repo structure (JS/TS plugins)

```
{plugin-id}/
├── src/
│   ├── index.ts                  ← exports the plugin definition
│   ├── components/
│   └── hooks/
├── kleff-plugin.json
├── package.json                  ← @kleffio/{plugin-id}
├── tsup.config.ts
├── .gitignore
├── LICENSE
└── README.md
```

No `Dockerfile`, no `nginx.conf`. Static plugins ship a `dist/bundle.js` only.

### 8.5 Plugin templates

`plugins/plugin-templates/` has three variants generated by `kleff plugin new`:

- `template-static-js/` — Tier 0, JS, sandboxed by default
- `template-sidecar-go/` — Tier 1 Go gRPC server with route + middleware boilerplate
- `template-service-go/` — Tier 2 Go service with persistence layer scaffold

The .NET equivalents live in `plugins/plugin-templates/template-{sidecar,service}-dotnet/`.

### 8.6 What plugins can and cannot do (final word)

See Section 5.12. The manifest's `permissions` array is the negotiation surface: anything not declared is denied by default, anything declared must pass the scope allowlist, and the user/admin sees the full permission list at install time and explicitly grants it.

---

## 9. Plugin Manager Refactor

The current `panel/api/internal/core/plugins/application/manager.go` is **1,570 lines** doing everything. Decompose:

| File | Responsibility | Target LOC |
|---|---|---|
| `manager.go` | Thin orchestrator: Install, Remove, Enable, Disable, Reconfigure, GetActiveIDP, ValidateToken | ≤ 200 |
| `lifecycle.go` | Container deploy / stop / restart, companion deployment, image pulling | ≤ 350 |
| `health.go` | Health-check loop, restart backoff, circuit breaker | ≤ 200 |
| `capabilities.go` | Discovery, scope validation (Section 5.2), per-RPC gating, probe | ≤ 250 |
| `bundles.go` | Bundle fetch + hash verify + cache (Section 4.2) | ≤ 200 |
| `identity.go` | Auth proxy: Login, Register, RefreshToken, ChangePassword, ListSessions, RevokeSession | ≤ 200 |
| `secrets.go` | Per-plugin key derivation, tmpfs mount construction (Section 5.7) | ≤ 200 |
| `network.go` | Per-plugin Docker networks (Section 5.5), egress allowlist | ≤ 200 |

`Manager` holds these as private struct fields. **No public API changes** — every existing caller of the `PluginManager` interface compiles untouched.

Extraction order (compile + tests pass after each step):

1. `identity.go` — pure gRPC forwards, most isolated
2. `bundles.go` — new code, drop in cleanly
3. `health.go` — read-only on container state
4. `secrets.go` — replaces inline encryption
5. `network.go` — replaces direct docker calls
6. `capabilities.go` — capability discovery + probe + gating
7. `lifecycle.go` — deploy / stop / restart
8. What remains in `manager.go` is orchestration only

---

## 10. Crate & Registry Standardization

### 10.1 Crates

A crate is a **deployable workload blueprint** (Minecraft server, Postgres, Redis). Crates are NOT plugins — they don't execute platform code. Standardize the manifest:

```json
{
  "schema_version": "1",
  "id": "minecraft-java",
  "name": "Minecraft: Java Edition",
  "category": "games",
  "version": "1.0.0",
  "image": "ghcr.io/kleffio/crate-minecraft-java:{version}",
  "tags": ["minecraft", "sandbox"],
  "resources": {
    "memory_mb_min": 1024,
    "memory_mb_recommended": 2048,
    "cpu_millicores_min": 500,
    "disk_gb_min": 5
  },
  "ports": [
    { "name": "game", "port": 25565, "protocol": "tcp" },
    { "name": "rcon", "port": 25575, "protocol": "tcp" }
  ],
  "config_schema": {
    "VERSION": { "type": "string", "default": "latest" },
    "MAX_PLAYERS": { "type": "integer", "default": 20 }
  },
  "startup_command": "./start.sh",
  "stop_command": "stop",
  "min_platform_version": "0.5.0"
}
```

### 10.2 Crate registry layout

```
crate-registry/
├── index.json                ← CI-generated
├── games/{slug}/crate.json + icon.png
├── databases/{slug}/crate.json
├── cache/{slug}/crate.json
├── constructs/base/Dockerfile
└── README.md
```

### 10.3 Plugin registry layout (parity with crates)

Today: a single `plugins.json` blob. Migrate to dir-per-plugin matching crates:

```
plugin-registry/
├── index.json                ← CI-generated
├── infra/{slug}/kleff-plugin.json + icon.png + screenshots/
├── org/{slug}/kleff-plugin.json
├── user/{slug}/kleff-plugin.json
└── README.md
```

Subdirs are by **scope** so admins/users see only what they can install. CI:

1. Validates each `kleff-plugin.json` against the JSON Schema (Section 8.2).
2. Verifies the image exists at the declared `image:version` tag (where applicable).
3. For Tier 0: fetches `bundle_url`, recomputes hash, asserts equality with `bundle_hash`.
4. Regenerates `index.json` (sorted, deterministic).

---

## 11. Codebase Standardization

### 11.1 panel/api domain modules

All modules follow full hexagonal:

```
internal/core/{module}/
├── adapters/
│   ├── http/handler.go
│   └── persistence/store.go
├── application/commands/{command}.go
├── domain/{entity}.go
└── ports/repository.go
```

Modules to complete: `admin`, `usage`, `audit`, `billing`, `catalog`, `projects`, `organizations` (new for org scope).

### 11.2 panel/web feature structure

```
src/features/{feature}/
├── index.ts          ← public re-exports only
├── pages/
├── ui/
├── hooks/
├── model/
├── server/
└── api.ts
```

Features needing completion: `account`, `dashboard`, `monitoring`, `settings`, `organizations` (new).

### 11.3 daemon internal structure

```
daemon/internal/
├── adapters/{in,out}/
├── application/ports/
├── domain/
└── workers/
```

Add `README.md` + `ARCHITECTURE.md` matching `panel/api/`. Fix Go module name: drop the `kleff-` prefix.

---

## 12. Naming Conventions

| Thing | Pattern | Examples |
|---|---|---|
| GitHub repos | `kleffio/{thing}` | `kleffio/keycloak-plugin`, `kleffio/plugin-sdk-go` |
| Go modules | `github.com/kleffio/{repo}` | `github.com/kleffio/panel`, `github.com/kleffio/daemon` |
| npm packages | `@kleffio/{name}` | `@kleffio/plugin-sdk`, `@kleffio/ui` |
| Docker images | `ghcr.io/kleffio/{name}:{ver}` | `ghcr.io/kleffio/panel:1.0.0` |
| Plugin IDs | `{org}/{slug}` | `kleffio/idp-keycloak`, `acme/cool-plugin` |
| Capability keys | `{domain}.{role}` lowercase, dot-separated | `identity.provider`, `billing.framework` |
| Manifest filename | `kleff-plugin.json` | (no exceptions) |
| Slot names | `{area}.{position}` | `navbar.item`, `dashboard.metrics` |
| Package manager (JS) | `pnpm` only | (no npm/yarn lock files allowed) |
| JS build tool (libraries) | `tsup` | (Next.js apps stay on Next built-in) |

---

## 13. Implementation Order

Each phase is independently shippable. Phase N depends on Phase N-1 unless noted.

### Phase 1 — Critical fixes & untracking _(1 day)_
- [x] 1.6 Hardcoded port 3001 binding fix (already merged)
- [ ] 1.1 Remove `platform/` submodule, archive repo, update `go.work`
- [ ] 1.3 Untrack `node_modules/`, add to `.gitignore`
- [ ] 1.4 Untrack `plugins.local.json`
- [ ] 1.5 `www/` → pnpm only

### Phase 2 — Contracts foundation _(2 days)_
- [ ] Create `contracts/schema/plugin-manifest.schema.json` (Section 8.2 full schema)
- [ ] Update `contracts/proto/common.proto` — add `sdk_version`, `api_version`, `sdk_language`, `runtime` to `GetCapabilitiesResponse`
- [ ] Update `contracts/proto/ui/manifest.proto` — add `bundle_hash`, `isolation` fields
- [ ] Add `contracts/proto/wellknown/error.proto` and refactor existing `Error` references
- [ ] Add new contracts: `automation/workflow.proto`, `events/subscriber.proto`
- [ ] Update Go domain types (`domain/plugin.go`, `domain/manifest.go`) — add `Scope`, `Tier`, `Isolation`, `BundleURL`, `BundleHash`, `Permissions`, `Resources`
- [ ] Rename `plugins/plugin-template/plugin.json` → `kleff-plugin.json`

### Phase 3 — Scope model + permissions _(3 days)_
- [ ] Add `scope` enum + DB column to `plugins` table (migration)
- [ ] Replace `permissions.go` with strict `scope_capabilities.go` (Section 5.2)
- [ ] Wrap `Pool` getters with capability gating (Section 5.3)
- [ ] Implement capability probe at install time (Section 5.4)
- [ ] Per-plugin Docker networks + control/data network split (Section 5.5)
- [ ] Resource quota defaults + enforcement (Section 5.6)
- [ ] tmpfs secret delivery + per-plugin key derivation (Section 5.7)
- [ ] Bidirectional mTLS (Section 5.8)
- [ ] Signed `PluginContext` middleware (Section 5.9)
- [ ] Audit events for every install/remove/enable/probe (Section 5.11)

### Phase 4 — Bundle delivery (kills Nginx containers) _(2 days)_
- [ ] `bundle_store.go` + `LocalBundleStore` (Section 4.2)
- [ ] `bundle_fetcher.go` (Section 4.2)
- [ ] `GET /api/v1/plugins/{id}/assets/bundle.js` route + ETag
- [ ] Wire bundle fetch into `Install`, `Reconfigure`, `Remove`
- [ ] Update `panel/web/.../loader.ts` — load from platform path, SRI integrity attr
- [ ] Add HTTP sidecar (port 8080) to `plugins/plugin-template/server/main.go`
- [ ] Compute + add `bundle_url`/`bundle_hash` to `components-plugin`, `hello-plugin`
- [ ] Delete `Dockerfile` + `nginx.conf` from `components-plugin` and `hello-plugin`

### Phase 5 — Frontend isolation + scoped API client _(3 days)_
- [ ] Implement sandboxed iframe runtime (`sandbox/host.ts`, `sandbox/guest.ts`)
- [ ] Update `loader.ts` to choose `trusted` vs `sandboxed` per manifest
- [ ] Refactor `PluginContextProvider.tsx` `api` client into `api.self` / `api.platform`
- [ ] Implement platform-side per-scope route prefixes (`/api/v1/u/{user}/p/{plugin}`, `/o/{org}/p/{plugin}`, `/p/{plugin}`)
- [ ] Permission enforcement on `api.platform.*` calls
- [ ] Slot system: `SlotPropsMap`, generic `SlotRegistration<S>`, `SLOT_API_VERSION` check
- [ ] Plugin error budget / circuit breaker

### Phase 6 — Plugin manager decomposition _(2 days)_
- [ ] Extract `identity.go`
- [ ] Extract `bundles.go`
- [ ] Extract `health.go`
- [ ] Extract `secrets.go`
- [ ] Extract `network.go`
- [ ] Extract `capabilities.go`
- [ ] Extract `lifecycle.go`
- [ ] `manager.go` ≤ 200 lines, no extracted file > 400 lines

### Phase 7 — SDK parity _(4 days)_
- [ ] Generate canonical capability/error enums from `contracts/registry.yaml`
- [ ] Go SDK: TLS env loading, bidirectional mTLS, error builders, config helper, signed context parser, auto service registration, testing harness
- [ ] JS SDK: scoped `api` client, sandbox runtime, `SlotPropsMap`, JWT decode, error builders, `SDK_VERSION`, scoped `localStorage`, hooks (`usePluginConfig`, `usePluginLogger`)
- [ ] .NET SDK: JWT/JWKS validator, error builders, `[Route]` attribute DSL, signed context parser, config helper, testing harness
- [ ] Rename `@kleffio/sdk` → `@kleffio/plugin-sdk` + update all references
- [ ] Three plugin templates regenerated (`template-static-js`, `template-sidecar-go`, `template-service-go` + .NET counterparts)

### Phase 8 — CLI + dev experience _(2 days)_
- [ ] `kleff plugin` CLI (Go) with `new`, `build`, `validate`, `probe`, `publish` subcommands
- [ ] CI for plugin-registry: schema validation, bundle hash verification, image existence check, `index.json` regeneration
- [ ] CI for crate-registry: same pattern
- [ ] `kleff plugin probe` integration test runner

### Phase 9 — Registry migration _(1 day)_
- [ ] Migrate `plugin-registry/plugins.json` → `{scope}/{slug}/kleff-plugin.json` per entry
- [ ] Migrate `crate-registry/` to standardized `crate.json` schema (Section 10.1)

### Phase 10 — Codebase standardization _(2 days)_
- [ ] Complete missing domain modules in `panel/api` (admin, usage, billing, catalog, projects, organizations)
- [ ] Standardize `panel/web` features (account, dashboard, monitoring, settings, organizations)
- [ ] Daemon: structure alignment, README + ARCHITECTURE.md, drop `kleff-` module prefix
- [ ] Rename remaining `@kleff/` → `@kleffio/` everywhere

---

## 14. Verification

### 14.1 Functional checks (after Phase 4)

1. `docker ps` — no Nginx containers running for any plugin
2. Install `components-showcase`; bundle appears at `data/plugin-bundles/components-showcase/bundle.js`
3. Browser network tab: bundle loads from `/api/v1/plugins/components-showcase/assets/bundle.js`
4. Tamper with `bundle_hash` in manifest → install rejected with hash mismatch error
5. `keycloak-plugin` (infra Tier 2, no frontend) installs and functions — no bundle fetch
6. `hello-dotnet-plugin` (hybrid, infra) — platform fetches bundle from container's port 8080 sidecar, caches it, browser loads from platform path

### 14.2 Security checks (after Phase 3 + 5)

7. Install a `user`-scoped plugin declaring `identity.provider` → install rejected with "capability not permitted for scope"
8. Plugin attempts to connect from inside its container to `postgres:5432` → connection refused (different network)
9. Plugin allocates 1 GB memory, declared limit 512 MB → OOM killed; circuit breaker triggers; plugin marked disabled after N failures
10. `kill -9` the plugin gRPC port → capability probe fails on next install attempt with descriptive error
11. Frontend plugin (sandboxed) calls `fetch('/api/v1/admin/plugins')` from inside its iframe → blocked by CSP / network policy
12. Inspect `/proc/{plugin-pid}/environ` from a sibling container → no plugin secrets present (they're in tmpfs)
13. Plugin A reads plugin B's secret file → permission denied (separate tmpfs mount per plugin)

### 14.3 Permission audit checks

14. `GET /api/v1/audit/events?actor=plugin:my-plugin` returns install/probe/RPC failure history
15. `org` admin can see audit events for `org` plugins in their org but not `infra` events
16. Platform admin sees everything

### 14.4 SDK parity checks

17. All three SDKs ship a `BasePlugin`/`KleffPlugin`/`definePlugin` equivalent with the same minimum example shape (Section 7.5)
18. All three SDKs have a JWT/JWKS validator (JS variant: client-side decode only)
19. All three SDKs have error builder helpers producing identical wire-format `Error` messages
20. `tsc --strict` passes on `plugin-sdk-js`; `go vet ./... && go test ./...` passes on `plugin-sdk-go`; `dotnet build` passes on `plugin-sdk-dotnet`

### 14.5 Codebase health

21. `wc -l panel/api/internal/core/plugins/application/manager.go` — under 200 lines
22. JSON Schema validates every `kleff-plugin.json` in the repo (incl. registry entries)
23. `kleff plugin validate` runs in CI for every plugin repo
24. `plugin-registry/index.json` is generated by CI, not hand-edited

---

## Appendix A — Migration of existing plugins

| Plugin | Current | After overhaul |
|---|---|---|
| `keycloak-plugin` | infra Tier 2, no frontend | unchanged code; manifest gains `scope:"infra"`, `tier:2`, `permissions:[]` |
| `authentik-plugin` | infra Tier 2, no frontend | same |
| `components-plugin` | static, served by Nginx | `scope:"infra"` (admin showcase), `tier:0`, `isolation:"trusted"`, no Dockerfile, `bundle_hash` computed |
| `hello-plugin` | static, served by Nginx | `scope:"user"`, `tier:0`, `isolation:"sandboxed"`, no Dockerfile |
| `hello-dotnet-plugin` | hybrid, gRPC + UI | `scope:"infra"`, `tier:1`, `isolation:"trusted"`, hybrid bundle via sidecar HTTP on 8080 |
| `plugin-template` | template, mixed | three templates under `plugin-templates/`: `static-js`, `sidecar-go`, `service-go` |

## Appendix B — Glossary

- **Scope** — *who* installs and *what blast radius*: `user` / `org` / `infra`. Section 2.
- **Tier** — *how it runs*: `0` static / `1` sidecar / `2` service. Section 3.
- **Capability** — a named extension point the plugin implements via gRPC (e.g., `identity.provider`). Section 2.2 / 6.2.
- **Permission** — a runtime authorization the plugin requests in the manifest (e.g., egress to a domain, access to a platform API). Section 5.10 / 8.2.
- **Isolation** — `trusted` (same JS context) or `sandboxed` (iframe + postMessage). Section 4.3.
- **Slot** — a named injection point in the panel UI a plugin can target. Section 4.4.
- **Bundle** — the JS file a Tier 0 / hybrid plugin contributes to the panel. Hash-verified, platform-served. Section 4.2.
- **Companion** — a non-plugin container a plugin needs (e.g., Keycloak's database). Declared in the manifest, lifecycle managed by the platform.
- **Probe** — a synthetic RPC the platform sends to verify a declared capability actually works. Section 5.4.
