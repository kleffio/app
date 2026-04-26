# Kleff Platform — Architecture & Plugin Overhaul

## Table of Contents
1. [Critical Fixes](#1-critical-fixes)
2. [Plugin System Redesign](#2-plugin-system-redesign)
3. [Plugin Standardization](#3-plugin-standardization)
4. [SDK Standardization](#4-sdk-standardization)
5. [Crate Standardization](#5-crate-standardization)
6. [Registry Standardization](#6-registry-standardization)
7. [Codebase Standardization](#7-codebase-standardization)
8. [Naming Conventions](#8-naming-conventions)
9. [Implementation Order](#9-implementation-order)

---

## 1. Critical Fixes

These block everything else and should be done first.

### 1.1 Remove `platform/` submodule
`platform/` is a full duplicate of `panel/api/`. All development now happens in `panel/api/`.
- Remove `platform` entry from App `.gitmodules`
- Remove `platform/` submodule from App repo
- Archive `kleffio/platform` on GitHub (do not delete — keeps history)
- Update App `go.work` to remove `./platform`

### 1.2 Fix `contracts/` nesting
`contracts/` exists at both `App/contracts/` and `panel/api/contracts/`. Both point to the same repo — that is correct. Document this explicitly:
- `panel/api/contracts/` — keep (api needs contracts at build time)
- `App/contracts/` — keep as standalone dev reference
- Add a note in both README files clarifying the dual location

### 1.3 Remove committed `node_modules/`
- `plugins/components-plugin/node_modules/` — remove, add to `.gitignore`
- `packages/ui/node_modules/` — remove, add to `.gitignore`
Both repos have lock files so this is safe.

### 1.4 Fix `plugins.local.json` tracking
`panel/api/plugins.local.json` should not be tracked. Add to `panel/api/.gitignore`. Each developer maintains their own local copy.

### 1.5 Fix `www/` package manager conflict
`www/` has both `package-lock.json` and `pnpm-lock.yaml`. Pick pnpm (matches every other JS repo), delete `package-lock.json`.

---

## 2. Plugin System Redesign

### 2.1 The Problem

Every plugin is currently a full Docker container. This means:
- A plugin that only adds a nav item still needs a running Nginx container (~50 MB image, ~20 MB RAM)
- Frontend-only plugins are served from `frontend_url` pointing at arbitrary container URLs — no SRI, no security
- Two conflicting "tier" systems exist (Tier 0/1/2 internally vs. infra/project/user in the panel)
- The plugin manager is a 1570-line God object — hard to test, hard to extend
- Capabilities are self-declared with no enforcement or probing at install time
- Manifest filenames are inconsistent (`plugin.json` vs `kleff-plugin.json`)

### 2.2 Plugin Tiers (canonical model)

Three tiers. Each is a superset of the previous.

```
┌─────────────────────────────────────────────────────────┐
│  Tier 0 — Static                                        │
│  JS bundle + manifest JSON only. No server, no Docker.  │
│  Platform downloads bundle at install time, caches it,  │
│  and serves it directly. Zero runtime cost.             │
│  Capabilities: ui.manifest only                         │
├─────────────────────────────────────────────────────────┤
│  Tier 1 — Stateless                                     │
│  gRPC service, no persistent state. Spun up on demand;  │
│  pooled or killed when idle. Cold start budget: <2s.    │
│  Capabilities: api.middleware, api.routes,              │
│               identity.provider (stateless validate)    │
├─────────────────────────────────────────────────────────┤
│  Tier 2 — Stateful                                      │
│  Full long-running service with own DB/state.           │
│  Current model. Necessary for IDP frameworks,           │
│  billing, observability, runtime providers.             │
│  Capabilities: identity.framework, billing.provider,    │
│               billing.framework, observability.*,       │
│               runtime.provider                          │
└─────────────────────────────────────────────────────────┘
```

Capability → Tier mapping:

| Capability | Min Tier | Proto Contract |
|---|---|---|
| `ui.manifest` | 0 | `proto/ui/manifest.proto` |
| `api.middleware` | 1 | `proto/api/middleware.proto` |
| `api.routes` | 1 | `proto/api/routes.proto` |
| `identity.provider` | 1 | `proto/identity/provider.proto` |
| `identity.framework` | 2 | `proto/identity/framework.proto` |
| `billing.provider` | 2 | `proto/billing/provider.proto` |
| `billing.framework` | 2 | `proto/billing/framework.proto` |
| `observability.provider` | 2 | `proto/observability/provider.proto` |
| `observability.framework` | 2 | `proto/observability/framework.proto` |
| `runtime.provider` | 2 | `proto/runtime/provider.proto` |

**Hybrid plugins (Tier 1/2 + frontend):** A gRPC plugin that also contributes UI declares both `ui.manifest` and a backend capability. Its container exposes a plain HTTP server on port 8080 alongside gRPC on port 50051. The platform fetches the JS bundle from `http://kleff-{plugin-id}:8080/bundle` at install/reconfigure time, caches it locally, and serves it from the platform API. The HTTP port is idle after that — near zero overhead.

### 2.3 Scope (replaces infra/project/user)

`scope` is a separate axis from `tier`:

| Scope | Meaning |
|---|---|
| `platform` | Admin-only; affects the whole platform (e.g., identity providers, billing) |
| `project` | Per-project, configurable by project admins or users |
| `user` | Personal, no approval required |

### 2.4 Bundle Delivery (Tier 0 and hybrid frontend)

**Why not Nginx containers:** A single static JS file does not need a container. The platform fetches it once and serves it itself.

**Flow:**
1. Manifest declares `bundle_url` (source to fetch from) and `bundle_hash` (SHA-256 hex)
2. At install time: platform fetches bundle, verifies SHA-256 hash matches `bundle_hash`, writes to `data/plugin-bundles/{id}/bundle.js`
3. Panel loads bundle from `/api/v1/plugins/{id}/assets/bundle.js` (platform-served, same origin)
4. `<script>` tag includes SRI `integrity="sha256-{base64(bundle_hash)}"` for browser-level verification
5. At uninstall: platform deletes cached bundle

**Bundle storage:** Filesystem at `${KLEFF_BUNDLE_STORE_PATH}` (default: `data/plugin-bundles/`). Requires a shared volume in multi-replica setups.

**New files:**
- `panel/api/internal/core/plugins/infrastructure/bundle_store.go` — `BundleStore` interface + `LocalBundleStore` (hash-verifying filesystem impl)
- `panel/api/internal/core/plugins/infrastructure/bundle_fetcher.go` — `BundleFetcher` (30s timeout, 10 MB max, hash verification)

**New route:** `GET /api/v1/plugins/{id}/assets/bundle.js` — served by platform with `Content-Type: application/javascript`, `Cache-Control: public, max-age=3600`, `ETag: {hash}`, conditional `304` support.

### 2.5 Plugin Permissions (Sandbox Model)

Each capability grants specific API access. Enforced by platform plugin middleware. Plugins cannot call APIs outside their declared capabilities.

| Capability | Allowed API Access | Network Access |
|---|---|---|
| `ui.manifest` | None (static) | None at runtime |
| `api.middleware` | Read request context | Outbound only |
| `api.routes` | Full HTTP request/response | Outbound only |
| `identity.provider` | Token validation endpoints | Outbound only |
| `identity.framework` | User/role/session management | Internal + Outbound |
| `billing.*` | Billing API namespace | Outbound to payment processors |
| `observability.*` | Metrics/logs push endpoints | Outbound to backends |
| `runtime.provider` | Docker socket (scoped) | Internal daemon network |

### 2.6 Plugin Manifest (`kleff-plugin.json`) — Standardized Format

```json
{
  "id": "kleffio/idp-keycloak",
  "name": "Keycloak Identity Provider",
  "version": "1.2.0",
  "tier": 2,
  "scope": "platform",
  "capabilities": ["identity.provider", "identity.framework", "ui.manifest"],
  "image": "ghcr.io/kleffio/keycloak-plugin:1.2.0",
  "bundle_url": "https://cdn.kleff.io/plugins/idp-keycloak/1.2.0/ui.js",
  "bundle_hash": "sha256-abc123def456...",
  "config": [
    { "key": "KEYCLOAK_URL", "label": "Keycloak URL", "type": "url", "required": false },
    { "key": "KEYCLOAK_CLIENT_SECRET", "label": "Client Secret", "type": "secret", "required": true }
  ],
  "permissions": ["identity.provider", "identity.framework"],
  "min_platform_version": "0.4.0"
}
```

**Key changes from current:**
- `id` is namespaced: `{org}/{plugin-id}` (first-party: `kleffio/`, community: `{author}/`)
- `bundle_url` = source URL the platform fetches from at install time (not a runtime CDN)
- `bundle_hash` = SHA-256 hex (required when `bundle_url` is present)
- `scope` replaces infra/project/user labeling
- `permissions` explicitly lists which capabilities this plugin is permitted to activate

### 2.7 Capability Enforcement

At install time, after the container starts (Tier 1/2), the platform **probes** each declared capability:
- Sends a lightweight RPC per capability (e.g., `GetUIManifest` for `ui.manifest`, `GetRoutes` for `api.routes`) with a 5-second timeout
- Probe failure → install fails with a clear error ("capability `api.routes` declared but `GetRoutes` RPC timed out")
- Prevents plugins from claiming capabilities they don't implement

### 2.8 Proto Contract Updates

- `contracts/proto/common.proto` — add `sdk_version` and `api_version` to `GetCapabilitiesResponse`
- `contracts/proto/ui/manifest.proto` — add `string bundle_hash = 7` to `UIManifest`
- `contracts/schema/plugin-manifest.schema.json` — new JSON Schema; validated at install time and in CI

### 2.9 Plugin Manager Decomposition

The 1570-line `panel/api/internal/core/plugins/application/manager.go` is split:

| File | Responsibility | Target LOC |
|------|---------------|-----------|
| `manager.go` | Thin coordinator: Install, Remove, Enable, Disable, Reconfigure orchestration | <200 |
| `lifecycle.go` | Container deploy, stop, restart, URL resolution | ~300 |
| `health.go` | 30-second health check loop, restart policy, backoff | ~200 |
| `capabilities.go` | Capability discovery, routing, probe logic | ~200 |
| `identity.go` | Auth proxy: Login, Register, RefreshToken, ChangePassword, ListSessions, RevokeSession | ~150 |

All extracted types are private structs held as fields on `Manager`. No public interface changes — every caller of `PluginManager` continues to work unmodified.

Extraction order (compile + test after each step):
1. `identity.go` — most self-contained (pure gRPC forwards)
2. `health.go` — reads state, doesn't modify it
3. `lifecycle.go` — container deploy/stop/restart
4. `capabilities.go` — routing + probing
5. What remains in `manager.go` is orchestration only

---

## 3. Plugin Standardization

### 3.1 Manifest Filename

**Canonical name: `kleff-plugin.json`** everywhere, no exceptions.

Current violations:
- `plugins/plugin-template/plugin.json` → rename to `kleff-plugin.json`
- Update any Makefile/Dockerfile/README references in the template

### 3.2 Repo Structure (Go plugins)

```
{plugin-id}/
├── cmd/
│   └── plugin/
│       └── main.go
├── internal/
│   ├── config/
│   │   └── config.go
│   └── service/
│       └── service.go        ← implements capability interface(s)
├── contracts/                ← git submodule: kleffio/contracts
├── Dockerfile
├── kleff-plugin.json
├── go.mod                    ← module: github.com/kleffio/{plugin-id}
├── .gitignore
├── LICENSE
└── README.md
```

Rules:
- Module name matches repo name exactly: `keycloak-plugin` → `github.com/kleffio/keycloak-plugin`
- No `idp-` prefix in module names — the capability declares what it is
- `internal/service/` implements the gRPC interfaces from `contracts/proto/`
- `contracts/` is always the `kleffio/contracts` submodule
- Hybrid plugins: add HTTP sidecar in `main.go` (port 8080, serves embedded `dist/bundle.js`)

### 3.3 Repo Structure (JS/TS plugins)

```
{plugin-id}/
├── src/
│   ├── index.ts              ← exports all public components/hooks
│   ├── components/
│   └── hooks/
├── contracts/                ← git submodule: kleffio/contracts (if needed)
├── kleff-plugin.json
├── package.json              ← name: "@kleffio/{plugin-id}"
├── tsup.config.ts            ← all JS plugins build with tsup
├── Dockerfile                ← only if Tier 1/2
├── .gitignore
├── LICENSE
└── README.md
```

Rules:
- All JS plugins use `pnpm` + `tsup` (not npm, not Vite, not esbuild directly)
- Package name always `@kleffio/{plugin-id}` — not `@kleff/` (missing "io")
- Build output: single ESM bundle at `dist/bundle.js`
- No committed `node_modules/`

### 3.4 Plugin Template — Two Variants

`plugins/plugin-template/` should offer two variants:
- `template-go/` — Go Tier 1/2 plugin scaffold (gRPC server, hexagonal layout, optional HTTP sidecar for hybrid frontend bundle)
- `template-js/` — JS Tier 0 plugin scaffold (tsup, pnpm, no container)

Both use `kleff-plugin.json` and the `@kleffio/plugin-sdk` naming.

### 3.5 What Plugins Can and Cannot Do

**Can:**
- Implement any capability defined in `contracts/proto/`
- Declare UI contributions via `ui.manifest`
- Own HTTP routes under `/api/v1/p/{plugin-id}/`
- Store config in the platform's plugin config store (encrypted at rest)
- Receive webhooks from the platform event bus (future)

**Cannot:**
- Access other plugins' data or config
- Call platform-internal APIs directly (only through declared capability interfaces)
- Modify core platform database schema
- Access the Docker socket (unless `runtime.provider`)
- Spawn additional containers (unless `runtime.provider`)

---

## 4. SDK Standardization

### 4.1 plugin-sdk-go

Target structure:
```
plugin-sdk-go/
├── v1/
│   ├── server.go             ← BasePlugin: health + capabilities + gRPC serve + TLS env loading
│   ├── health.go             ← PluginHealth client/server helpers
│   ├── idp.go                ← IdentityProvider client/server helpers
│   ├── middleware.go         ← APIMiddleware helpers
│   ├── routes.go             ← APIRoutes helpers
│   ├── ui.go                 ← UIManifest helpers
│   ├── types.go              ← shared Go types
│   ├── compat.go             ← error codes and aliases
│   └── jwt.go                ← JWT validation utilities
├── contracts/                ← submodule: kleffio/contracts
├── go.mod
└── README.md
```

`BasePlugin` handles: `Health()`, `GetCapabilities()`, gRPC server lifecycle, TLS cert loading from env (`PLUGIN_TLS_CERT_PEM` / `PLUGIN_TLS_KEY_PEM`), graceful shutdown. Plugin authors embed it instead of writing boilerplate:

```go
type MyPlugin struct {
    sdk.BasePlugin
}
// Implement capability interfaces on top.
```

### 4.2 plugin-sdk-js

Target structure:
```
plugin-sdk-js/
├── src/
│   ├── index.ts              ← re-exports everything
│   ├── types.ts              ← TypeScript types (updated — see below)
│   ├── define-plugin.ts      ← plugin factory
│   ├── client.ts             ← typed HTTP client for platform APIs
│   ├── hooks.ts              ← React hooks (usePluginConfig, usePluginLogger)
│   ├── components.tsx        ← PluginSlot, PluginProvider base components
│   └── plugin-context.tsx    ← PluginContext React context
├── package.json              ← name: "@kleffio/plugin-sdk" (rename from @kleffio/sdk)
├── tsup.config.ts
└── README.md
```

**Type updates to `types.ts`:**
- Add `tier: 0 | 1 | 2` and `scope: "platform" | "project" | "user"` to `PluginManifest`
- Add `bundle_url?: string`, `bundle_hash?: string` to `PluginManifest`
- Add `isolation?: "trusted" | "sandboxed"` (reserved — `"sandboxed"` = future iframe postMessage bridge)
- Export `SDK_VERSION` constant
- Add `SlotPropsMap` interface: maps each `SlotName` to its host-provided prop types
- Update `SlotRegistration<S extends SlotName>` to be generic so `component` is typed to `ComponentType<SlotPropsMap[S]>`

**Panel update (`globals.ts`):** expose `sdkVersion: SDK_VERSION` on `window.__kleff__`.

### 4.3 SDK Parity Table

| Go SDK | JS SDK | Purpose |
|---|---|---|
| `BasePlugin` | `PluginProvider` | Base setup/boilerplate |
| `RegisterCapability()` | `registerCapability()` | Declare capabilities |
| `JWTValidator` | `useAuth()` | Token validation |
| `Config` | `usePluginConfig()` | Access plugin config |
| `Logger` | `usePluginLogger()` | Structured logging |

### 4.4 Frontend Loader Update

`panel/web/src/features/plugins/lib/loader.ts`:
- Tier 0 / hybrid with frontend: load bundle from `/api/v1/plugins/${id}/assets/bundle.js`
- Backend-only (no `bundle_url`): skip script injection
- Backward compat: if `tier` is absent, fall back to `frontend_url` with console deprecation warning
- Add SRI `integrity="sha256-${hexToBase64(bundle_hash)}"` attribute to `<script>` tag

---

## 5. Crate Standardization

### 5.1 What is a Crate?

A crate is a blueprint for a deployable service (game server, database, cache). It defines Docker image, config schema, resource requirements, and port mappings. Crates are NOT plugins — they have no code execution at the platform level.

### 5.2 Crate Manifest (`crate.json`)

```json
{
  "id": "minecraft-java",
  "name": "Minecraft: Java Edition",
  "category": "games",
  "version": "1.0.0",
  "image": "ghcr.io/kleffio/crate-minecraft-java:{version}",
  "tags": ["minecraft", "java", "sandbox"],
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
    "MAX_PLAYERS": { "type": "integer", "default": 20 },
    "DIFFICULTY": { "type": "string", "enum": ["peaceful","easy","normal","hard"], "default": "normal" }
  },
  "startup_command": "./start.sh",
  "stop_command": "stop",
  "min_platform_version": "0.4.0"
}
```

### 5.3 Crate Registry Structure

```
crate-registry/
├── index.json               ← CI-generated (never edit manually)
├── games/
│   ├── minecraft-java/
│   │   ├── crate.json
│   │   └── icon.png
│   └── valheim/
│       ├── crate.json
│       └── icon.png
├── databases/
│   └── postgres/
│       └── crate.json
├── cache/
│   └── redis/
│       └── crate.json
├── constructs/              ← base images (not user-deployable)
│   └── base/
│       └── Dockerfile
├── .gitignore
├── LICENSE
└── README.md
```

CI generates `index.json` from all `crate.json` files — never edit manually.

---

## 6. Registry Standardization

### 6.1 Align plugin-registry with crate-registry

Both serve the same function but use different structures. Target: both use directory-per-entry + CI-generated index.

| Aspect | plugin-registry (current) | Target |
|---|---|---|
| Structure | Single `plugins.json` | One dir per plugin |
| Index | Is the file | `index.json` (CI-generated) |
| Schema | Inline in JSON | Per-dir `kleff-plugin.json` |
| Submission | PR editing `plugins.json` | PR adding `{plugin-id}/kleff-plugin.json` |

**Migration:** `plugins/plugin-registry/plugins.json` → one `{plugin-id}/kleff-plugin.json` per entry. Add CI workflow that validates each manifest against `contracts/schema/plugin-manifest.schema.json` and regenerates `index.json`.

---

## 7. Codebase Standardization

### 7.1 panel/api — Domain Module Completeness

All domain modules must follow full hexagonal structure:

```
internal/core/{module}/
├── adapters/
│   ├── http/handler.go
│   └── persistence/store.go
├── application/
│   └── commands/{command}.go
├── domain/{entity}.go
└── ports/repository.go
```

Modules needing completion:

| Module | Missing | Action |
|---|---|---|
| `admin` | domain, ports, application | Add or fold into shared middleware |
| `usage` | domain, ports, application | Add (usage tracking) |
| `audit` | application | Add if audit has business logic |
| `billing` | application | Add (subscription/invoice operations) |
| `catalog` | application | Add (blueprint sync logic) |
| `projects` | application | Add (project creation commands) |

### 7.2 panel/web — Feature Structure

All features follow:

```
src/features/{feature}/
├── index.ts              ← public API, re-exports only
├── pages/                ← page-level components (routed)
├── ui/                   ← feature-specific non-page components
├── hooks/                ← React hooks
├── model/                ← state, context, stores
├── server/               ← server actions and loaders
└── api.ts                ← typed API calls for this feature
```

Features needing completion: `account`, `dashboard`, `monitoring`, `settings` (currently stubs with only `pages/`).

### 7.3 daemon — Internal Structure Alignment

```
daemon/internal/
├── adapters/
│   ├── in/                ← inbound (queue consumer)
│   └── out/               ← outbound (platform client)
├── application/
│   └── ports/             ← interfaces (WorkloadSpec, RuntimeAdapter, etc.)
├── domain/                ← move WorkloadState + job domain types here
└── workers/               ← job worker implementations
```

Add `README.md` and `ARCHITECTURE.md` matching the style in `panel/api/`.

---

## 8. Naming Conventions

### 8.1 GitHub Repos
- Pattern: `kleffio/{thing}` — all lowercase, hyphen-separated
- Plugins: `kleffio/{plugin-id}` (e.g. `kleffio/keycloak-plugin`)
- SDKs: `kleffio/plugin-sdk-{lang}`
- Registries: `kleffio/{thing}-registry`

### 8.2 Go Modules
- Pattern: `github.com/kleffio/{repo-name}` — must match repo name exactly
- ✗ `github.com/kleffio/platform` (repo is now `panel`)
- ✗ `github.com/kleffio/kleff-daemon` (redundant prefix)
- ✓ `github.com/kleffio/panel`
- ✓ `github.com/kleffio/daemon`

### 8.3 npm Packages
- Pattern: `@kleffio/{package-name}` — all lowercase, hyphen-separated
- ✗ `@kleff/plugin-sdk` (missing "io")
- ✓ `@kleffio/plugin-sdk`
- ✓ `@kleffio/ui`

### 8.4 Docker Images
- Pattern: `ghcr.io/kleffio/{image-name}:{version}`
- Plugin images: `ghcr.io/kleffio/{plugin-id}:{version}`
- Core: `ghcr.io/kleffio/panel:{version}`, `ghcr.io/kleffio/daemon:{version}`

### 8.5 Plugin IDs
- Pattern: `{org}/{plugin-id}` for registry and manifest `id` field
- First-party: `kleffio/{plugin-id}`
- Community: `{author}/{plugin-id}`

### 8.6 Capability Keys
- Pattern: `{domain}.{role}` — all lowercase, dot-separated
- ✓ `identity.provider`, `billing.framework`, `runtime.provider`
- Never use underscores or hyphens in capability keys

### 8.7 Package Managers
- All JS/TS repos: `pnpm` only
- No mixing of npm/yarn/pnpm lock files in the same repo

### 8.8 Build Tools
- JS plugins and SDKs: `tsup` only (not Vite, not esbuild directly)
- Next.js apps (`panel/web`, `docs`, `www`): Next.js built-in only

---

## 9. Implementation Order

### Phase 1 — Critical Fixes
- [ ] Remove `platform/` submodule from App, archive GitHub repo, update `go.work`
- [ ] Remove `node_modules/` from `plugins/components-plugin/` and `packages/ui/`, add to `.gitignore`
- [ ] Add `plugins.local.json` to `panel/api/.gitignore`
- [ ] Fix `www/` — delete `package-lock.json`, commit to pnpm only

### Phase 2 — Plugin System Contracts & Schema
- [ ] Create `contracts/schema/plugin-manifest.schema.json`
- [ ] Update `contracts/proto/common.proto` — add `sdk_version`, `api_version` to `GetCapabilitiesResponse`
- [ ] Update `contracts/proto/ui/manifest.proto` — add `bundle_hash` field
- [ ] Update Go domain types (`domain/plugin.go`, `domain/manifest.go`) — add `Scope`, `BundleURL`, `BundleHash`; deprecate `Tier` int, add tier constants
- [ ] Rename `plugins/plugin-template/plugin.json` → `kleff-plugin.json`
- [ ] Add `tier` and `scope` to existing plugin manifests (`keycloak-plugin`, `authentik-plugin`, `components-plugin`, `hello-plugin`)

### Phase 3 — Bundle Delivery (eliminates Nginx containers)
- [ ] New: `panel/api/internal/core/plugins/infrastructure/bundle_store.go`
- [ ] New: `panel/api/internal/core/plugins/infrastructure/bundle_fetcher.go`
- [ ] Add `GET /api/v1/plugins/{id}/assets/bundle.js` route to HTTP handler
- [ ] Wire bundle fetch into `manager.go` `Install()`, `Reconfigure()`, `Remove()`
- [ ] Update `panel/web/src/features/plugins/lib/loader.ts` — load from platform API, add SRI integrity attribute, fallback deprecation warning
- [ ] Add HTTP sidecar (port 8080) to `plugins/plugin-template/server/main.go`
- [ ] Compute and add `bundle_url` + `bundle_hash` to `components-plugin` and `hello-plugin` manifests

### Phase 4 — Plugin Manager Decomposition
- [ ] Extract `identity.go` from `manager.go`
- [ ] Extract `health.go` from `manager.go`
- [ ] Extract `lifecycle.go` from `manager.go`
- [ ] Extract `capabilities.go` from `manager.go` + add capability probe logic
- [ ] Verify `manager.go` < 200 lines; no extracted file > 400 lines

### Phase 5 — SDK & Frontend Type Improvements
- [ ] Update `plugin-sdk-js/src/types.ts` — add `tier`, `scope`, `bundle_url`, `bundle_hash`, `isolation`, `SlotPropsMap`, generic `SlotRegistration<S>`
- [ ] Rename `@kleffio/sdk` → `@kleffio/plugin-sdk`; update all references
- [ ] Add `SDK_VERSION` constant; expose `sdkVersion` on `window.__kleff__`
- [ ] Add `client.ts` and `hooks.ts` stubs to `plugin-sdk-js/src/`
- [ ] Update `plugin-sdk-go/v1/server.go` — ensure `BasePlugin` handles TLS env loading and graceful shutdown
- [ ] Rebuild `plugin-template` with two variants: `template-go/` and `template-js/`

### Phase 6 — Registry & Crate Standardization
- [ ] Migrate `plugins/plugin-registry/plugins.json` → per-directory `{plugin-id}/kleff-plugin.json`
- [ ] Add CI to `plugin-registry` to validate manifests and regenerate `index.json`
- [ ] Standardize `crate-registry` manifests to `crate.json` schema (section 5.2)
- [ ] Add CI to `crate-registry` to generate `index.json`

### Phase 7 — Codebase Standardization
- [ ] Complete incomplete domain modules in `panel/api` (admin, usage, billing, catalog)
- [ ] Standardize `panel/web` feature structure (account, dashboard, monitoring, settings)
- [ ] Align `daemon` internal structure; add `README.md` + `ARCHITECTURE.md`
- [ ] Fix Go module name: `daemon` (remove `kleff-` prefix)
- [ ] Fix npm package names: `@kleff/` → `@kleffio/` everywhere

---

## Verification (end-to-end after Phase 3+4)

1. `docker ps` — no Nginx containers running for `hello-plugin` or `components-plugin`
2. Browser network tab — plugin bundle loads from `/api/v1/plugins/hello-plugin/assets/bundle.js`
3. Tamper with `bundle_hash` in manifest → install rejected with hash mismatch error
4. `keycloak-plugin` (Tier 2, no frontend) installs and functions — no bundle fetch attempted
5. `hello-dotnet-plugin` (hybrid) serves bundle via port 8080; platform fetches and caches it
6. `wc -l panel/api/internal/core/plugins/application/manager.go` — under 200 lines
7. `tsc --strict` on plugin-sdk-js — no errors
8. JSON schema validates all `kleff-plugin.json` files in repo without errors
9. Capability probe: kill gRPC port of a running plugin, attempt install → fails with descriptive error
