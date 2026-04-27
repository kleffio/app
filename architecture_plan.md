# Kleff Platform — Architecture Plan

> **Goal.** Make this an open-source project that an outside contributor can clone, run, understand, and extend in under an hour — and that feels enterprise-grade end to end. Plugins are covered in `plan.md`. Security is covered in `security_plan.md`. This file covers everything else: repo structure, monorepo orchestration, backend architecture, frontend architecture, daemon architecture, contracts, documentation, testing, observability, CI/CD, developer experience.

## Table of Contents

1. [Guiding Principles](#1-guiding-principles)
2. [Top-Level Repository](#2-top-level-repository)
3. [Monorepo & Workspaces](#3-monorepo--workspaces)
4. [Documentation Architecture](#4-documentation-architecture)
5. [Backend (`panel/api`)](#5-backend-panelapi)
6. [Frontend (`panel/web`)](#6-frontend-panelweb)
7. [Daemon (`daemon/`)](#7-daemon-daemon)
8. [Shared UI Library (`packages/ui`)](#8-shared-ui-library-packagesui)
9. [Contracts (`contracts/`)](#9-contracts-contracts)
10. [Observability Stack](#10-observability-stack)
11. [Testing Strategy](#11-testing-strategy)
12. [CI/CD Architecture](#12-cicd-architecture)
13. [Local Developer Experience](#13-local-developer-experience)
14. [Open-Source Posture](#14-open-source-posture)
15. [Implementation Order](#15-implementation-order)

---

## 1. Guiding Principles

These shape every decision below. Reference them when something feels wrong.

1. **Hexagonal everywhere.** Domain code never imports adapters. Every external dependency (DB, queue, gRPC, HTTP) sits behind a port. Already true for `daemon/` and partially true for `panel/api/` — make it universal.
2. **Modules are independent.** A module under `internal/core/{x}/` should compile, test, and reason about itself with only its own ports + a small set of shared kernel utilities.
3. **One way to do anything.** No mixing axios + raw fetch. No two pagination styles. No two error shapes. No two ID generators. Pick one, document it, lint for it.
4. **Boring is good.** Standard library + small focused libs. No DI framework, no metaprogramming, no clever generics. New contributors can read the code linearly.
5. **First-party docs.** Every module has a README. Every public function has a godoc/jsdoc. Every architectural decision has an ADR.
6. **Reproducible.** `git clone` → `make setup` → `make dev` → working stack. No "you also need to install X" in tribal knowledge.
7. **Open source by default.** README answers "what is this," "why would I use it," "how do I run it," and "how do I contribute" in the first 30 seconds.

---

## 2. Top-Level Repository

### 2.1 Today's state

```
App/
├── contracts/        (submodule)
├── daemon/           (submodule)
├── docs/             (submodule)
├── packages/ui/      (submodule)
├── panel/            (submodule, contains api/ + web/)
├── plugins/          (mostly submodules)
├── crate-registry/   (submodule)
├── docker-compose.dev.yml
├── docker-compose.yml
├── Makefile
├── plan.md
├── security_plan.md
├── architecture_plan.md
├── README.md         ← MISSING
├── CONTRIBUTING.md   ← MISSING
├── ARCHITECTURE.md   ← MISSING (a top-level one)
├── SECURITY.md       ← MISSING
├── CODE_OF_CONDUCT.md ← MISSING
├── LICENSE           ← MISSING (each submodule has one)
└── .gitmodules
```

A new contributor lands here and sees no entry point. Fix.

### 2.2 Target state

```
App/
├── README.md                  ← First thing anyone reads
├── ARCHITECTURE.md            ← How the pieces fit
├── CONTRIBUTING.md            ← How to contribute
├── SECURITY.md                ← Vulnerability disclosure
├── CODE_OF_CONDUCT.md         ← Standard contributor covenant
├── LICENSE                    ← Top-level (mirror of submodule licenses)
├── Makefile                   ← Single source of truth for tasks
├── go.work                    ← Workspaces panel/api + daemon + every Go submodule
├── pnpm-workspace.yaml        ← Workspaces panel/web + packages/ui + every JS plugin
├── docker-compose.dev.yml     ← Whole stack for local dev
├── docker-compose.yml         ← Production-style compose
├── .gitmodules
├── .editorconfig              ← Cross-language formatting baseline
├── .gitignore
├── .gitattributes             ← LF line endings, language detection hints
├── .nvmrc / .tool-versions    ← Pinned tool versions
├── .env.example               ← Top-level example (links to per-component .env.example files)
├── docs/                      (submodule, the actual marketing/user docs site)
├── adr/                       ← Architecture Decision Records (NEW)
│   ├── 0001-monorepo-layout.md
│   ├── 0002-hexagonal-modules.md
│   └── ...
├── scripts/                   ← Setup, dev helpers (NEW)
│   ├── setup.sh
│   ├── lint-all.sh
│   └── new-module.sh
├── .github/
│   ├── workflows/             ← Top-level CI orchestration
│   ├── ISSUE_TEMPLATE/
│   ├── PULL_REQUEST_TEMPLATE.md
│   ├── CODEOWNERS
│   └── dependabot.yml
├── contracts/        (submodule)
├── daemon/           (submodule)
├── panel/            (submodule)
├── packages/ui/      (submodule)
├── plugins/          (submodules)
└── crate-registry/   (submodule)
```

### 2.3 Root `README.md` skeleton

The README is the front door. Sections, in order:

1. **One-line elevator pitch** with logo + key badges (build status, license, version).
2. **What it is** — three sentences max. "Kleff is a self-hostable game-server hosting platform that…"
3. **Screenshot** — one panel screenshot above the fold.
4. **Quick start** — three commands (`git clone --recursive ...`, `make setup`, `make dev`) with expected output.
5. **Architecture at a glance** — small diagram (Mermaid) showing panel ↔ api ↔ daemon ↔ plugins.
6. **Project structure** — tree of top-level dirs with one-line descriptions.
7. **Where to read next** — links to ARCHITECTURE.md, CONTRIBUTING.md, plugin docs, deployment docs.
8. **Community** — Discord/Matrix link, GitHub Discussions, release notes.
9. **License** — one line, link to LICENSE.

### 2.4 Top-level `ARCHITECTURE.md` skeleton

- The 30-second mental model (panel = UI, api = control plane, daemon = workload runner, plugins = extension points).
- Repo layout with one paragraph per submodule.
- Data flow for the three canonical operations (a user signs in; a user deploys a server; an admin installs a plugin).
- Where to find the deeper architecture docs (`panel/api/ARCHITECTURE.md`, `panel/web/ARCHITECTURE.md`, `daemon/ARCHITECTURE.md`, `contracts/ARCHITECTURE.md`).
- ADR index with brief summaries.

### 2.5 ADRs (Architecture Decision Records)

A new lightweight convention for documenting big decisions. Each ADR is ≤ one page:

```markdown
# ADR-0007: Use Postgres for plugin secret storage

Date: 2026-04-26
Status: Accepted

## Context
We need to encrypt plugin secrets at rest. Options: Postgres (with column encryption),
HashiCorp Vault, AWS Secrets Manager, etc.

## Decision
Default to Postgres. Provide a `SecretStore` interface so operators can swap in Vault.

## Consequences
- Single dependency for self-hosted users (good).
- Operators with strong KMS requirements can plug in Vault (good).
- We must maintain the KDF + encryption code carefully (acceptable cost).
```

Living index lives in `adr/README.md`.

---

## 3. Monorepo & Workspaces

### 3.1 The current fragmentation

- 8 git submodules. Each repo has its own go.mod / package.json / CI.
- No root `go.work` — Go work is split between `panel/api/go.work` (links contracts) and `daemon/` standalone.
- No root `pnpm-workspace.yaml` — `panel/web` and `packages/ui` and frontend plugins each manage deps independently.
- Result: `make dev` works (ish), but day-to-day development means 5 terminal windows and "did you remember to update submodules?"

### 3.2 The target

**Stay submodules** (each component remains independently releasable — important for plugin authors who want to fork) **but unify the workspace at the top.**

#### Top-level `go.work`

```
go 1.23

use (
    ./contracts
    ./daemon
    ./panel/api
    ./panel/api/packages
    ./plugins/identity-native
    ./plugins/keycloak-plugin
    ./plugins/authentik-plugin
    ./plugins/plugin-sdk-go
)
```

Lets a developer touching `contracts/` see API compile errors immediately.

#### Top-level `pnpm-workspace.yaml`

```yaml
packages:
  - "panel/web"
  - "packages/ui"
  - "plugins/plugin-sdk-js"
  - "plugins/components-plugin"
  - "plugins/hello-plugin"
  - "www"
  - "docs"
```

`pnpm install` at root resolves all JS deps once. Internal packages (`@kleffio/ui`, `@kleffio/plugin-sdk`) are workspace links — no more `github:kleffio/sdk` dependencies in package.json (which currently break offline installs).

### 3.3 Optional: Turborepo

Add `turbo.json` for caching builds + tests across workspaces. Optional in the strict sense; if added, keep config minimal:

```json
{
  "tasks": {
    "build": { "dependsOn": ["^build"], "outputs": ["dist/**", ".next/**"] },
    "test":  { "dependsOn": ["^build"] },
    "lint":  {},
    "dev":   { "cache": false, "persistent": true }
  }
}
```

Decision: include Turbo for CI cache benefit; no developer is required to use it directly (Make wraps it).

### 3.4 Submodule workflow

- `make setup` runs `git submodule update --init --recursive --remote=false` (no surprise floats — pinned to recorded commits).
- `make submodules-bump` runs `--remote` and shows a diff for explicit review.
- CI rejects PRs whose submodule pointers are uncommitted on the upstream branch.
- Each submodule has its own GitHub Action that opens a "submodule bump" PR in App when its main branch advances.

### 3.5 The `Makefile` as the single front door

Targets every contributor needs, organized by phase:

```makefile
# Setup
setup            # init submodules, install pnpm deps, generate .env.dev.local
setup-clean      # nuke node_modules, .env.dev.local, docker volumes

# Dev
dev              # docker-compose up the whole stack
dev-detach
dev-down
dev-logs SERVICE=...
dev-shell SERVICE=...
dev-reset-db     # drop/recreate Postgres

# Build
build            # build everything (turbo run build)
build-images     # docker build all images
build-plugins    # rebuild plugin docker images
build-sdks       # build all SDKs

# Test
test             # turbo run test (everything)
test-go          # go test ./... in api + daemon
test-web         # pnpm --filter web test
test-e2e         # playwright

# Lint
lint             # everything
lint-go
lint-web
lint-yaml
lint-fix         # auto-fix where possible
fmt              # gofmt + prettier

# Release
release-prep VERSION=...
release-publish

# Misc
docs             # serve docs/ locally
generate         # regen proto + openapi + ts types
```

Every target documented in `make help` (auto-generated from comments).

---

## 4. Documentation Architecture

Documentation lives in three tiers. Each has a clear audience.

### 4.1 Tier 1 — In-repo developer docs

Audience: contributors and operators.

| File | Audience | Purpose |
|---|---|---|
| `README.md` (root) | First-time visitor | Pitch, quick start, where to go next |
| `CONTRIBUTING.md` | Would-be contributor | Setup, workflow, PR conventions, review process |
| `ARCHITECTURE.md` (root) | Anyone who wants the mental model | High-level diagram + data flows + ADR index |
| `SECURITY.md` | Security researcher | Disclosure policy, scope, GPG key |
| `CODE_OF_CONDUCT.md` | Anyone | Standard Contributor Covenant |
| `RUNBOOK.md` | Operator | Deployment, backup/restore, incident response, scaling |
| `panel/api/ARCHITECTURE.md` | Backend contributor | Module map, ports/adapters convention, request flow |
| `panel/api/internal/core/{module}/README.md` | Module contributor | What this module does, key files, who uses it |
| `panel/web/ARCHITECTURE.md` | Frontend contributor | Routing, state, API layer, design system |
| `daemon/ARCHITECTURE.md` | Daemon contributor | Worker loop, runtime adapters, registration flow |
| `plan.md` | Plugin overhaul | Living plan; archived under `adr/` once shipped |
| `security_plan.md` | Security overhaul | Living plan; archived under `adr/` once shipped |
| `architecture_plan.md` | This file | Living plan |
| `adr/####-*.md` | Architecture historian | Decisions and reasoning |

### 4.2 Tier 2 — Code-level docs

- **Every exported Go identifier** has a godoc comment. CI lint (`golangci-lint` with `revive`/`stylecheck`) enforces.
- **Every exported TS function/type** has a TSDoc comment. CI lint enforces.
- **Public API surface** (HTTP) is the OpenAPI spec at `contracts/openapi/openapi.yaml` — generated browsable docs at `https://docs.kleff.io/api`.
- **Plugin contracts** documented in `contracts/proto/*.proto` with `// description` comments rendered by `protoc-gen-doc` into `contracts/docs/`.

### 4.3 Tier 3 — User-facing docs

`docs/` submodule. Audience: end users (admins running Kleff, plugin developers).

Sections (already partially exists):

- **Getting started** — install, first login, deploy a Minecraft server.
- **Operating Kleff** — backup, scaling, monitoring, incident response.
- **Plugins** — concepts, how to install, how to write one (per-language guides).
- **Crates** — what they are, how to add custom workloads.
- **API reference** — auto-generated from OpenAPI spec.
- **Plugin contract reference** — auto-generated from .proto files.

Built with the existing docs framework (Mintlify/Nextra/Docusaurus — confirm in `docs/`). Site auto-deploys on submodule bump.

### 4.4 Documentation review

CI fails if:

- New exported Go/TS symbol without docstring.
- New module under `internal/core/` without `README.md`.
- ADR added without entry in `adr/README.md` index.
- OpenAPI spec changed without changelog entry.

---

## 5. Backend (`panel/api`)

### 5.1 What's good

- Modular monolith with hexagonal pattern (mostly correct).
- Manual DI in `bootstrap/container.go` — explicit, testable.
- `chi` router with reasonable middleware base (CORS, recover, request ID, logger).
- `pgx/v5` + Goose migrations.
- `slog` JSON structured logging.
- Clock and ID abstraction in `internal/shared/`.
- Graceful shutdown via `packages/bootstrap`.

### 5.2 What needs work

| Area | Issue | Fix |
|---|---|---|
| Stub modules | `admin`, `audit`, `billing`, `catalog` (partial), `logs`, `usage` are stubs | Complete each (Section 5.3) |
| Tests | 1 test file in 76 Go files | Mandatory ≥70% coverage on new code; backfill (Section 11) |
| Transactions | No `*sql.Tx` propagation; multi-table writes are non-atomic | Add `UnitOfWork` pattern (Section 5.5) |
| Migrations | Two directories (`internal/database/migrations/` AND `migrations/`) with overlapping numbers | Consolidate to `migrations/` (Section 5.6) |
| Errors | Custom `AppError` envelope not RFC standard | Adopt RFC 7807 Problem Details (Section 5.7) |
| Observability | Logging only; no metrics, no tracing, `/healthz` doesn't actually check anything | Section 10 |
| Pagination | `PaginationMeta` defined, never used consistently | Standard parser + middleware (Section 5.8) |
| API versioning | Hardcoded `/v1/` everywhere | Versioning policy (Section 5.9) |
| Plugin manager God object | 1570 LOC in one file | Cross-reference `plan.md` §9 — already planned |
| Module READMEs | None | Add (Section 5.4) |
| Documentation generation | No OpenAPI + handlers can drift | Generate handlers FROM OpenAPI or vice versa (Section 5.10) |

### 5.3 Module completion roadmap

| Module | Ports | Domain | Application | HTTP | Persistence | Notes |
|---|:-:|:-:|:-:|:-:|:-:|---|
| `admin` | ❌ | ❌ | ❌ | stub | ❌ | Suspend/unsuspend orgs/users; promote/demote platform admin; feature flag admin |
| `audit` | ✅ | ✅ | ❌ | 501 | ❌ | See `security_plan.md` §8 |
| `billing` | ✅ | ✅ | ❌ | stub | ❌ | Stripe integration via `billing.provider` plugin; subscription state in platform DB |
| `catalog` | ✅ | partial | ❌ | partial | ✅ | Sync logic + handler completion |
| `deployments` | ✅ | ✅ | ✅ | ✅ | ✅ | Done — use as the gold-standard reference module |
| `identity` (NEW) | ✅ | ✅ | ✅ | ✅ | ✅ | New module wrapping users + sessions + role grants — see `security_plan.md` §2 + §4 |
| `logs` | ✅ | ✅ | ❌ | stub | ✅ | Receive log batches from daemon; query API |
| `nodes` | ✅ | ✅ | partial | ✅ | ✅ | Add node draining + cordoning commands |
| `notifications` | ✅ | ✅ | ✅ | ✅ | ✅ | Done |
| `organizations` | ✅ | ✅ | ✅ | ✅ | ✅ | Done; remove personal-org subject derivation (sec §4.6) |
| `plugins` | ✅ | ✅ | ✅ (decompose) | ✅ | ✅ | See `plan.md` §9 decomposition |
| `projects` | ✅ | ✅ | ❌ | partial | ✅ | Add `application/commands/`; project-level RBAC |
| `users` | ✅ | ✅ | partial | partial | ✅ | Merge with new `identity` module or keep as thin profile-only module |
| `usage` | ✅ | ✅ | ❌ | stub | partial | Daily/monthly metering rollups; quota enforcement |
| `workloads` | ✅ | ✅ | ✅ | ✅ | ✅ | Done |

Use `deployments` as the **gold-standard reference module** — every module follows its layout exactly. Add `scripts/new-module.sh {name}` to scaffold the standard structure.

### 5.4 Module README template

Every module gets `internal/core/{name}/README.md`:

```markdown
# {Module Name}

One-paragraph purpose statement.

## Domain
What entities this module owns. Diagram if non-trivial.

## Public surface
- `ports.{Repository}` — repository contract
- `application.{Service|Commands}` — use case entry points
- HTTP routes registered: `GET /api/v1/...`, ...
- Events published: `{module}.{event}.{verb}`

## Dependencies
Modules this module imports from (kept to minimum).

## Conventions specific to this module
Things a contributor should know.
```

### 5.5 Database transactions

Today: each repository takes `*sql.DB` and runs queries directly. Multi-table writes (e.g., create org + add owner membership + create personal project) are non-atomic and can leave the DB in inconsistent states on failure.

**Add a `UnitOfWork`:**

```go
// internal/shared/database/uow.go
type UnitOfWork interface {
    Do(ctx context.Context, fn func(tx Tx) error) error
}

type Tx interface {
    Organizations() ports.OrganizationRepository
    Projects()      ports.ProjectRepository
    Users()         ports.UserRepository
    // ... one accessor per repository
}
```

Application-layer code uses `uow.Do(ctx, func(tx Tx) error { ... })` for any operation touching multiple aggregates. Single-aggregate writes can still use the bare repository.

The cost: every repository implementation must accept `*sql.Tx | *sql.DB` (use `pgx.Tx`/`pgx.Conn` interface). Not bad — `pgx` already has this.

### 5.6 Migrations

- Consolidate to single `panel/api/migrations/` directory.
- Numbering: `NNNN_description.sql` with strictly increasing numbers (no parallel `002_x.sql` and `002_y.sql`).
- Up + down halves required.
- Migration runner uses `goose` (already in use); embedded via `embed.FS`.
- `kleffctl migrate up`, `migrate down 1`, `migrate status`, `migrate redo` commands.
- Migration tests: every migration has a test verifying up + down + up roundtrip on a temp DB.

### 5.7 Error handling — RFC 7807

Adopt `application/problem+json` for error responses:

```json
{
  "type": "https://docs.kleff.io/errors/validation",
  "title": "Validation failed",
  "status": 400,
  "detail": "Email is required",
  "instance": "/api/v1/identity/users",
  "errors": {
    "email": ["required", "must be valid email"],
    "password": ["min length 12"]
  }
}
```

`packages/domain/errors.go` keeps `AppError` as the internal representation; `packages/adapters/http/error.go` renders it as Problem Details. Single conversion point.

### 5.8 Pagination, sorting, filtering

Standard parser:

```go
// packages/adapters/http/list.go
type ListParams struct {
    Page    int            // 1-indexed
    Limit   int            // default 20, max 100 (configurable)
    Sort    []SortField    // []{Field, Direction}
    Filters map[string]any // parsed from filter[field][op]=value
}

func ParseList(r *http.Request, allowed AllowedListFields) (ListParams, error)
```

Allowed fields per resource declared at the handler:

```go
var deploymentListFields = AllowedListFields{
    Sortable:   []string{"created_at", "updated_at", "name"},
    Filterable: map[string]FieldType{"status": StringEnum, "owner_id": String},
}
```

Response always includes:

```json
{
  "data": [...],
  "pagination": { "page": 1, "limit": 20, "total": 142, "total_pages": 8 }
}
```

### 5.9 API versioning

- Path-based: `/api/v1/`, `/api/v2/`.
- A v2 lives in a separate directory under `internal/core/{module}/adapters/http/v2/`.
- Old version stays for **at least one minor release after the new version's GA**.
- Deprecation: response includes `Deprecation: true` and `Sunset: <date>` headers.
- Breaking changes documented in `CHANGELOG.md` and the API docs.

### 5.10 OpenAPI as source of truth

Two options:

1. **Code-first:** annotate handlers with comments, generate spec via `swaggo/swag`. Easy to keep in sync but verbose.
2. **Spec-first:** hand-write spec in `contracts/openapi/openapi.yaml`, generate request/response Go types via `oapi-codegen`. Forces design before implementation.

**Choose spec-first.** Reasons: (a) the spec is the contract that frontend + plugin authors consume; (b) reviewers can spot API design issues before code is written; (c) `oapi-codegen` produces typed servers that prevent drift.

`make generate` regenerates types. CI fails if generated types are stale.

### 5.11 Bootstrap/DI improvements

- `bootstrap/container.go` is fine as a manual composition root — keep it.
- Split into `Container.Identity()`, `Container.Deployments()`, … methods returning each module's wired bundle. Easier to read than one 200-line constructor.
- Add `Container.Close(ctx)` for orderly shutdown of every component (DB, Redis, plugin manager, log tailer).

### 5.12 Internal HTTP listener

Introduce a second HTTP listener on `INTERNAL_LISTEN_ADDR` (default `127.0.0.1:8081`) for:

- `/metrics` (Prometheus)
- `/internal/daemon/*` (daemon callbacks; previously on the public listener)
- `/debug/pprof/*` (Go profiling; gated by env var)
- `/healthz`, `/readyz` for orchestrator probes (so the public listener can be down for maintenance while orchestrator still gets accurate status)

Public listener never serves any of these.

### 5.13 The `packages/` shared library

`panel/api/packages/` is the public-ish utility library (`@kleffio/go-common`). Today it has `adapters/http`, `bootstrap`, `domain`. Keep this layout but:

- Promote stable parts; mark experimental ones.
- Document every public type with godoc.
- Add `packages/README.md` enumerating what's here and stability promise (semver).
- Move `internal/shared/` items that mature here (clock, ids, logger config).

---

## 6. Frontend (`panel/web`)

### 6.1 What's good

- Next.js 15 App Router with route groups (`(authenticated)`, `(marketing)`).
- TanStack Query for server state with sensible defaults.
- Feature-based directory structure.
- Auth guard at layout level.
- TypeScript strict mode.
- Solid UI library via `@kleffio/ui` (Radix + Tailwind v4).

### 6.2 What needs work

| Area | Issue | Fix |
|---|---|---|
| Tests | Zero | Section 11 |
| Storybook | None | Section 8 |
| HTTP client | Mixed axios + raw fetch | Pick one (axios), forbid the other in lint |
| Form validation | Manual `useState` | Adopt React Hook Form + Zod |
| Feature exports | Inconsistent `index.ts` | Mandate one per feature (Section 6.4) |
| Stub features | account, dashboard, monitoring, settings | Complete (Section 6.5) |
| Server vs Client components | Everything is `"use client"` | Identify RSC opportunities (Section 6.6) |
| Theme | Dark-only hardcoded | Add light theme with system preference (Section 6.7) |
| URL state | None | Adopt `nuqs` for typed URL state (Section 6.8) |
| API types | Hand-written, can drift | Generate from OpenAPI (Section 6.9) |
| Error boundaries | Only inside plugin slots | Add per-feature boundaries (Section 6.10) |
| ARCHITECTURE doc | None | Add (Section 6.11) |

### 6.3 Folder convention

```
src/
├── app/                       ← Next.js App Router (routes only)
├── features/                  ← Domain features (the meat)
│   └── {feature}/
│       ├── index.ts           ← Public API of the feature (REQUIRED)
│       ├── README.md          ← What this feature does (REQUIRED)
│       ├── api/               ← React Query hooks + typed API calls
│       ├── components/        ← Feature-specific React components
│       ├── hooks/             ← Custom hooks
│       ├── lib/               ← Pure utility functions
│       ├── model/             ← Types + zod schemas
│       ├── pages/             ← Page-level components imported by app/
│       └── server/            ← Server actions / RSC data loaders
├── components/                ← Cross-feature UI (rarely used; prefer @kleffio/ui)
├── lib/                       ← Cross-feature utilities (api client, env, format)
└── styles/
```

Lint rule: `app/**` can import from `features/**` only via `features/{x}/index.ts`. `features/{x}` cannot import from `features/{y}` (use shared lib or hoist).

### 6.4 Feature index pattern

Every feature exports a deliberate public surface:

```ts
// features/notifications/index.ts
export { NotificationsBell } from "./components/NotificationsBell";
export { NotificationsPage } from "./pages/NotificationsPage";
export { useNotifications } from "./hooks/useNotifications";
export type { Notification } from "./model";
```

Internal components, hooks, and utilities are not exported — they cannot leak into other features.

### 6.5 Stub feature completion plan

| Feature | Today | Goal |
|---|---|---|
| `account` | Page stub | Profile edit, security (password, MFA, sessions), notifications prefs, API tokens |
| `dashboard` | Page stub | Project overview cards, recent activity, quick actions, plugin slots `dashboard.*` |
| `monitoring` | Page stub | Live metrics, log tail, alert list (data from `observability.framework` plugin or the platform's basic metrics) |
| `settings` | Page stub | Theme, language, density, default project, plugin slots `settings.*` |
| `organizations` (NEW) | Doesn't exist | Org list, create/switch, settings, members + invites, audit log view |
| `billing` | Doesn't exist | Subscription view, invoice history, payment method, usage, upgrade |

Each completed feature ships with its own README + tests.

### 6.6 RSC strategy

Audit pages for what could be a Server Component:

| Page | Today | Should be |
|---|---|---|
| `/auth/login` | Client | Client (form interactivity) |
| `/(authenticated)/layout.tsx` | Client (providers) | Client (must be — providers) |
| `/(authenticated)/account/profile/page.tsx` | Client | **Server**: load user data server-side, hand to a client form |
| `/(authenticated)/admin/page.tsx` | Client | **Server**: dashboard cards as RSC; client islands for interactive widgets |
| `/(authenticated)/admin/plugins/page.tsx` | Client | Client (heavy interactivity) |
| `/(authenticated)/project/[owner]/[slug]/page.tsx` | Client | **Server** for initial render; client for live updates |

Pattern: page is a Server Component, imports a client `<*View>` for the interactive shell. Initial data loaded server-side, hydrated into Query cache.

### 6.7 Theme system

- CSS variables with `--color-bg`, `--color-fg`, `--color-primary`, etc. (Tailwind v4 supports this natively).
- `next-themes` for system / light / dark switching.
- Theme persisted in cookie (so SSR returns the right HTML, no flash).
- Settings page exposes the toggle.

Plugins can declare additional themes (a "theme" capability is a `ui.manifest` plugin that injects a CSS file — see `plan.md` plugin scopes; user-scoped themes are first-class).

### 6.8 URL state — `nuqs`

For lists with filters / sort / pagination: use `nuqs` to keep state in URL params with type safety.

```ts
const [page, setPage] = useQueryState("page", parseAsInteger.withDefault(1));
const [status, setStatus] = useQueryState("status", parseAsStringEnum(["all", "running", "stopped"]));
```

Deep-linkable, refresh-safe, shareable.

### 6.9 Generated API client

`make generate` runs `openapi-typescript` against `contracts/openapi/openapi.yaml`, writes types to `panel/web/src/lib/api/generated/`. Hand-written hooks consume these types:

```ts
// panel/web/src/features/projects/api/useProjects.ts
import type { components } from "@/lib/api/generated";
type Project = components["schemas"]["Project"];

export function useProjects() {
  return useQuery({ queryKey: ["projects"], queryFn: () => api.get<Project[]>("/api/v1/projects") });
}
```

Drift is impossible — if backend changes the spec, types regenerate, type errors surface in PR.

### 6.10 Error boundaries

- Root layout wraps in `<RootErrorBoundary>` (Next.js `error.tsx` covers route boundaries).
- Each feature's top-level page wraps in `<FeatureErrorBoundary feature="notifications">` reporting feature + user IDs to the error tracker.
- Plugin slot errors caught by `PluginErrorBoundary` (already present).

### 6.11 Frontend ARCHITECTURE doc

`panel/web/ARCHITECTURE.md`:

- Routing layout map (`app/` tree with one-line purpose per route)
- State management diagram
- API layer (axios instance, interceptors, error normalization, Query client config)
- Auth flow sequence
- How to add a new feature (link to `scripts/new-feature.sh`)
- How to add a new page
- Component categorization (ui primitive vs feature component)
- Server vs Client component decision tree

---

## 7. Daemon (`daemon/`)

### 7.1 What's good

- Hexagonal layout already in place — clean ports/adapters separation.
- Multiple inbound (CLI, cron, gRPC, ws) and outbound (DB, queue, logging, runtime) adapters.
- Pulls from queue rather than receiving pushes (no inbound firewall hole needed).
- Multi-stage Dockerfile, non-root user.
- Multiple runtime adapters (Docker, Kubernetes).

### 7.2 What needs work

| Area | Issue | Fix |
|---|---|---|
| Health endpoint | None | Add `/healthz` and `/readyz` (Section 7.3) |
| Job persistence | In-memory; lost on restart | Move to Postgres (Section 7.4) |
| DLQ | None — poison pills loop forever | Implement (Section 7.4) |
| Retry strategy | Naive (no backoff/jitter) | Exponential backoff with jitter (Section 7.4) |
| Concurrency | Hardcoded 4 workers | `KLEFF_DAEMON_CONCURRENCY` env (Section 7.5) |
| Config validation | Crashes on missing env | Validated `Config` struct + clear errors (Section 7.5) |
| Multi-arch builds | amd64 only | amd64 + arm64 (Section 7.6) |
| Build provenance | None | Inject version + commit + buildtime via `-ldflags` |
| Tests | Sparse (~13 files for entire daemon) | Section 11 |
| README/ARCHITECTURE | Missing | Add (Section 7.7) |
| SQLite for state | Doesn't scale to multi-daemon | Move to shared Postgres for cluster-aware state (Section 7.8) |

### 7.3 Health endpoints

New `daemon/internal/adapters/in/http/health.go`:

- Listener on `KLEFF_DAEMON_HEALTH_ADDR` (default `127.0.0.1:9090`).
- `GET /healthz` → liveness; returns 200 if process is responding.
- `GET /readyz` → readiness; returns 200 only if:
  - Runtime adapter initialized (Docker or K8s)
  - Queue connection alive (Redis ping)
  - Platform API reachable (last successful registration < 60s ago)
  - Database (SQLite/Postgres) writable

### 7.4 Job persistence + DLQ + retries

- Move job state from in-memory map to Postgres `daemon_jobs` table (or SQLite if single-node deployment).
- Schema: `(id, type, payload jsonb, status, attempts, max_attempts, last_error, scheduled_for, created_at, updated_at)`.
- Worker loop:
  1. `SELECT FOR UPDATE SKIP LOCKED` claims a job.
  2. Run handler.
  3. Success → `status=completed, completed_at=now()`.
  4. Failure → `attempts++`, if `attempts >= max_attempts` → `status=dead, dead_letter_at=now()`, otherwise `scheduled_for = now() + backoff(attempts)`.
- Backoff: `min(60s, 2^attempts × 1s) + random_jitter(0..1s)`.
- DLQ table is just `daemon_jobs WHERE status='dead'`.
- `kleffctl jobs list-dead`, `kleffctl jobs requeue {id}`, `kleffctl jobs purge --before=...`.

### 7.5 Configuration

```go
// daemon/internal/app/config/config.go
type Config struct {
    NodeID            string        `env:"KLEFF_NODE_ID,required"`
    PlatformURL       string        `env:"KLEFF_PLATFORM_URL,required"`
    SharedSecret      string        `env:"KLEFF_SHARED_SECRET,required"`
    QueueBackend      string        `env:"KLEFF_QUEUE_BACKEND" envDefault:"redis"`
    RedisURL          string        `env:"KLEFF_REDIS_URL"`
    RedisPassword     string        `env:"KLEFF_REDIS_PASSWORD"`
    RedisTLS          bool          `env:"KLEFF_REDIS_TLS"`
    DatabasePath      string        `env:"KLEFF_DATABASE_PATH" envDefault:"/var/lib/kleffd/data"`
    Concurrency       int           `env:"KLEFF_DAEMON_CONCURRENCY" envDefault:"4"`
    HealthAddr        string        `env:"KLEFF_DAEMON_HEALTH_ADDR" envDefault:"127.0.0.1:9090"`
    LogLevel          string        `env:"LOG_LEVEL" envDefault:"info"`
    HeartbeatInterval time.Duration `env:"KLEFF_HEARTBEAT_INTERVAL" envDefault:"30s"`
}

func Load() (*Config, error) {
    var c Config
    if err := env.Parse(&c); err != nil { return nil, err }
    if err := c.Validate(); err != nil { return nil, err }
    return &c, nil
}
```

`Validate()` checks invariants (URL format, concurrency > 0, etc.) and returns descriptive errors.

### 7.6 Multi-arch builds

In Dockerfile and CI:

```dockerfile
FROM --platform=$BUILDPLATFORM golang:1.23-alpine AS builder
ARG TARGETARCH
RUN CGO_ENABLED=0 GOARCH=$TARGETARCH go build -trimpath \
    -ldflags="-s -w -X main.version=$VERSION -X main.commit=$COMMIT -X main.date=$DATE" \
    -o /kleffd ./cmd/kleffd/
```

CI `docker buildx build --platform linux/amd64,linux/arm64 ...`.

### 7.7 Daemon README + ARCHITECTURE

- `daemon/README.md` — what it is, how to run, env var reference.
- `daemon/ARCHITECTURE.md` — port/adapter map, worker loop diagram, registration flow with platform, runtime detection, scaling considerations.

### 7.8 Cluster mode

- Today: SQLite per-daemon. Two daemons can run but they don't coordinate.
- Future: Postgres-backed shared state with leader election (advisory locks). Allow N daemons polling the same job queue with `SELECT FOR UPDATE SKIP LOCKED` (Section 7.4) for safe concurrent claim.
- Document single-node vs cluster trade-offs.

### 7.9 Naming

The daemon binary is `kleffd`, the CLI is `kleffctl`. Keep this. The Go module is `github.com/kleffio/kleff-daemon` (per current); rename to `github.com/kleffio/daemon` to match the convention in `plan.md` §12.

---

## 8. Shared UI Library (`packages/ui`)

### 8.1 Today

- Submodule (`kleffio/ui`).
- ~50 components built on Radix + Tailwind v4.
- Dark theme baked in.
- No Storybook.
- `node_modules/` committed (already flagged in `plan.md` §1.3).

### 8.2 Target

| Area | Action |
|---|---|
| Storybook | Add Storybook 8 with one story per public component. CI builds and uploads to `https://ui.kleff.io` on every merge. |
| Visual regression | Chromatic or Percy on PRs. |
| Theme system | Light/dark/system (Section 6.7). Theme tokens documented in Storybook. |
| Accessibility | `eslint-plugin-jsx-a11y` rules; `@axe-core/react` integration in Storybook; manual review checklist in CONTRIBUTING. |
| Component prop docs | TSDoc on every prop; rendered in Storybook controls panel. |
| `node_modules/` | Untrack (already on the list). |
| Versioning | Independent semver; published to GitHub Packages npm registry. |
| Changelog | `changesets` for PR-driven version bumps. |

### 8.3 Component catalog

Document existing inventory + identify gaps. Likely missing for an enterprise feel: `<DataTable>` with sort/filter/pagination, `<EmptyState>` patterns, `<ConfirmDialog>`, `<CommandPalette>`, `<KeyboardShortcuts>` viewer, `<Breadcrumbs>`, `<Stepper>`.

---

## 9. Contracts (`contracts/`)

### 9.1 Today

```
contracts/
├── proto/        ← gRPC plugin contracts (~11 .proto files)
├── openapi/      ← openapi.yaml (8 endpoints — sparse)
└── queue/        ← job.schema.json
```

### 9.2 Target

```
contracts/
├── README.md             ← What's here, how to consume, versioning policy
├── ARCHITECTURE.md       ← Wire format choices, error envelope, streaming convention
├── proto/
│   ├── v1/               ← Move existing (currently flat) under v1/
│   │   ├── common.proto
│   │   ├── identity/
│   │   ├── api/
│   │   ├── ui/
│   │   ├── billing/
│   │   ├── observability/
│   │   ├── runtime/
│   │   ├── automation/   ← new (plan.md §6.3)
│   │   ├── events/       ← new
│   │   ├── secrets/      ← new
│   │   └── audit/        ← new
│   └── v2/               ← When we get there
├── openapi/
│   ├── openapi.yaml      ← Full spec (every public + plugin route)
│   └── examples/         ← Request/response samples per endpoint
├── schema/
│   ├── plugin-manifest.schema.json   ← plan.md §8.2
│   └── crate.schema.json             ← plan.md §10.1
├── queue/
│   └── job.schema.json
├── registry.yaml         ← Single source of truth: capability strings, error codes, slot names
├── docs/                 ← Generated reference docs (protoc-gen-doc, redoc)
├── scripts/
│   ├── generate-go.sh
│   ├── generate-ts.sh
│   ├── generate-dotnet.sh
│   └── lint.sh
└── .github/workflows/
    └── publish.yml       ← On tag, generate clients + publish per-language packages
```

### 9.3 The `registry.yaml`

Eliminates the cross-SDK drift problem (`plan.md` §7.4). Single file declares every:

- Capability key + permitted scopes
- Error code (with stable numeric value)
- Health status
- Slot name + prop schema (for JS SDK type generation)
- API version negotiation rules

All three SDKs regenerate their constants files from this YAML. CI fails if generated files are stale.

### 9.4 Versioning policy

Documented in `contracts/ARCHITECTURE.md`:

- **MAJOR**: breaking change to existing field/RPC/endpoint → new directory `proto/v2/`, `openapi/v2.yaml`, deprecation period overlap.
- **MINOR**: additive new field/RPC/endpoint → bump in same version.
- **PATCH**: doc/example/non-functional change.

CI lint via `buf` (proto) + `oasdiff` (OpenAPI) detects breaking changes and fails PR unless major version is bumped.

---

## 10. Observability Stack

The single biggest gap between "works" and "enterprise."

### 10.1 Logging

Today: `slog` JSON to stdout. Reasonable starting point.

Improvements:

- **Standardized fields:** every log line gets `service`, `version`, `instance_id`, `request_id`, `trace_id`, `user_id`, `org_id`, `plugin_id` (when applicable). Helper `logging.WithCtx(ctx)` adds them automatically.
- **Sampling:** debug logs sampled at 10% in prod (configurable).
- **Sensitive-field redaction:** `slog.Handler` middleware that drops keys matching `password|token|secret|key`.
- **Log shipper recommendation:** docs cover Vector/Fluent Bit setup; no built-in shipping (avoid coupling to a specific backend).

### 10.2 Metrics

Today: none.

Add:

- **Prometheus client** in `internal/shared/observability/metrics.go`.
- Metrics families:
  - `http_requests_total{route, method, status}`
  - `http_request_duration_seconds{route, method}` histogram
  - `db_queries_total{module, query}`
  - `db_query_duration_seconds{module}` histogram
  - `db_connections_in_use`, `db_connections_idle`
  - `plugin_rpc_total{plugin, capability, method, outcome}`
  - `plugin_rpc_duration_seconds{plugin, capability, method}`
  - `plugin_health_check_status{plugin}`
  - `auth_events_total{event}`
  - `audit_events_total{action}`
  - `daemon_jobs_total{type, status}`
  - `daemon_job_duration_seconds{type}` histogram
- Exposed at `/metrics` on the **internal** listener (Section 5.12).
- Grafana dashboard JSON committed under `docs/observability/dashboards/`.

### 10.3 Tracing

- OpenTelemetry SDK (`go.opentelemetry.io/otel`).
- HTTP middleware auto-spans.
- DB query spans via `pgx` tracer.
- gRPC client/server spans for plugin RPCs.
- Trace context propagated through the daemon job queue (`traceparent` in job payload).
- OTLP exporter; default off, enabled by `KLEFF_OTLP_ENDPOINT` env var.

### 10.4 Health & readiness (cross-reference)

Already covered in 5.12 (platform) + 7.3 (daemon).

### 10.5 Error tracking

- **Backend:** structured error logging with stack trace (slog `error` level) + optional Sentry SDK if `SENTRY_DSN` set.
- **Frontend:** Sentry SDK (browser) — initialized only in production, with PII scrubbing.

### 10.6 Profiling

- `/debug/pprof/*` on the internal listener, gated by `KLEFF_PROFILING=true`.
- Documented in RUNBOOK.md.

---

## 11. Testing Strategy

### 11.1 The reality

- `panel/api`: 1 test file in 76 .go files.
- `panel/web`: 0 test files.
- `daemon`: ~13 test files.
- No integration tests at the platform level.
- No e2e tests.

### 11.2 Coverage targets

| Component | Unit | Integration | E2E |
|---|---|---|---|
| `panel/api` | ≥70% per module | DB-backed tests for every repository + handler | Smoke flows in CI |
| `panel/web` | ≥60% (hooks + lib) | Component tests with MSW | Playwright happy-path flows |
| `daemon` | ≥70% | Runtime adapter tests with testcontainers | Provision-a-server flow |
| `plugin-sdk-go` | ≥80% | In-memory test server | — |
| `plugin-sdk-js` | ≥80% | jsdom + react-testing-library | — |
| `plugin-sdk-dotnet` | ≥80% | Test server | — |
| `contracts` | n/a | Lint + breaking-change detection | — |

### 11.3 Backend testing

- **Unit:** `testify/assert` + `testify/require`. Standard table-driven tests.
- **Integration:** `dockertest` or `testcontainers-go` to spin up Postgres + Redis per test package. Run in CI as a separate job (slower).
- **HTTP:** `httptest` + `chi.Mux` directly; assert on Problem Details JSON.
- **Mocks:** `mockery` to generate from port interfaces (committed to `mocks/`).
- **Test fixtures:** `testdata/` per module with deterministic seed data.

### 11.4 Frontend testing

- **Vitest** for unit (faster than Jest, better TS support).
- **Testing Library** for component tests.
- **MSW** for API mocking.
- **Playwright** for e2e; smoke flows: login, create org, install plugin, deploy server.
- Run e2e against a fresh `make dev` stack in CI (with seeded data via `make dev-seed`).

### 11.5 Daemon testing

- Mock platform API and queue for unit tests.
- Use `testcontainers-go` for the runtime adapter integration tests (real Docker, ephemeral container).
- E2E: provision → start → stop → delete cycle on a tiny test image.

### 11.6 SDK testing

- Each SDK ships test utilities for plugin authors (`sdk.NewTestServer()`, `sdk.MockContext()`).
- SDK self-tests use them as the canonical example.

### 11.7 CI test phases

- **PR check:** unit tests for changed packages only (turbo affected) → fast feedback.
- **Pre-merge:** full unit + integration suite.
- **Nightly:** e2e + load tests + dependency scans.

---

## 12. CI/CD Architecture

### 12.1 Today

Each submodule has its own `.github/workflows/`. No top-level orchestration. Release is manual tag push.

### 12.2 Target — top-level workflows

`.github/workflows/` at App root:

| Workflow | Trigger | Steps |
|---|---|---|
| `ci.yml` | PR / push to main | Per-component matrix: lint, typecheck, unit, integration |
| `e2e.yml` | PR (label `e2e`) + nightly | Spin up dev stack, run Playwright |
| `security.yml` | PR + nightly | govulncheck, pnpm audit, trivy, gitleaks, OWASP ZAP baseline |
| `release.yml` | Tag `v*` | Build all images multi-arch, sign with cosign, generate SBOM, push to ghcr, create GH release with notes |
| `submodule-bump.yml` | Repository dispatch from submodule repos | Open PR updating submodule pointer + show diff |
| `docs.yml` | PR / push to docs/ | Build docs site, deploy preview |
| `contracts.yml` | PR touching contracts/ | Buf lint, openapi diff vs main, regenerate code, ensure SDKs still compile |

### 12.3 Per-submodule workflows

Per-submodule CI stays for their own use (when the submodule is opened in isolation), but the App-level workflows are authoritative for cross-cutting checks.

### 12.4 Release process

- All components versioned together as `v{MAJOR}.{MINOR}.{PATCH}` at the App level.
- Submodule pointers tagged with the same version (a bot does this).
- `CHANGELOG.md` auto-assembled from PR labels + changesets.
- Docker images tagged with both the version and a SHA.
- Release notes published as GitHub Release; mirrored to docs site.

### 12.5 Required checks before merge

- All CI green
- Lint passes
- Coverage doesn't decrease > 1%
- At least 1 approving review
- For breaking changes: ADR linked
- For database migrations: migration test passes
- For plugin contract changes: SDK regeneration succeeds

---

## 13. Local Developer Experience

### 13.1 The 60-second test

A new contributor with `git`, `make`, `docker`, `pnpm`, and `go` installed should:

1. `git clone --recursive <repo>`
2. `cd App && make setup`
3. `make dev`
4. Open `http://localhost:3000`, see the panel, finish the setup wizard.

Total time: under 5 minutes (mostly Docker pulls).

### 13.2 `make setup`

```bash
#!/usr/bin/env bash
set -euo pipefail

# 1. Init submodules
git submodule update --init --recursive

# 2. Check tooling versions
./scripts/check-tools.sh   # go ≥ 1.23, node ≥ 22, pnpm ≥ 9, docker ≥ 24

# 3. Install JS deps (via pnpm workspace)
pnpm install

# 4. Generate .env.dev.local with random secrets
./scripts/generate-env.sh

# 5. Pull Docker images in parallel
docker compose -f docker-compose.dev.yml pull

# 6. Generate code from contracts
make generate

echo "✓ Setup complete. Run 'make dev' to start the stack."
```

### 13.3 `make dev` improvements

- **Hot reload everywhere:**
  - Web: Next.js Turbopack (already works).
  - API: `air` with config tweaked for fast incremental builds.
  - Daemon: same.
- **Tail-friendly output:** prefix each service log line with a colored service name.
- **Health-check gating:** `depends_on: { condition: service_healthy }` so dependents wait for real readiness, not container start.
- **Volume mounts:** source code mounted into containers so edits trigger reload without rebuild.
- **Seed data:** `make dev-seed` creates a test admin user, an org, a project, installs the local plugins. Lets every contributor land on the same UI state.

### 13.4 First-class CLI

`kleffctl` becomes the swiss-army knife:

```
kleffctl setup              # interactive first-run wizard
kleffctl plugin list
kleffctl plugin install <id>
kleffctl plugin probe <id>
kleffctl user create
kleffctl org create
kleffctl secrets rotate
kleffctl audit query --actor=...
kleffctl jobs list
kleffctl jobs requeue <id>
kleffctl migrate up
kleffctl backup create
kleffctl backup restore <file>
```

Lives in `daemon/cmd/kleffctl/main.go` today — promote to top-level `cmd/kleffctl/` (or its own submodule) since it talks to platform API too, not just daemon.

### 13.5 Editor support

- `.editorconfig` for formatting baseline.
- `.vscode/extensions.json` recommends Go, ESLint, Prettier, Tailwind, Biome (if adopted).
- `.vscode/settings.json` configures format-on-save, gopls, etc.
- `.idea/` ignored (we don't dictate JetBrains config but document basics in CONTRIBUTING).

### 13.6 Pre-commit

`.pre-commit-config.yaml`:

- `gofmt`, `goimports`
- `golangci-lint` on changed Go files
- `prettier` on changed JS/TS/JSON/MD files
- `eslint --fix`
- `gitleaks` (secret scan)
- `commitlint` (Conventional Commits)
- `actionlint` (workflow yaml)

Installed by `make setup`.

### 13.7 Conventional commits

Adopt for clean changelog generation and semantic-release. PR titles must match.

---

## 14. Open-Source Posture

What an outside contributor or evaluator should perceive.

### 14.1 First impressions

- README answers "what / why / how" in 30 seconds.
- Architecture diagram above the fold.
- Status badges (build, version, license, Discord member count, contributor count).
- Demo screenshot or Loom-style short video link.

### 14.2 Onboarding paths

Three documented entry points:

- **"I want to run Kleff for my homelab"** → Docker Compose deployment guide in docs/.
- **"I want to write a plugin"** → Plugin development guide + `kleff plugin new` scaffolder + `plan.md` reference.
- **"I want to contribute to Kleff itself"** → CONTRIBUTING.md → ARCHITECTURE.md → good-first-issue label.

### 14.3 Community

- Discord/Matrix server linked from README.
- GitHub Discussions enabled, with categories: Q&A, Show & Tell, Plugin Showcase, Roadmap.
- `good-first-issue` and `help-wanted` labels actively maintained.
- Monthly community update post in Discussions.
- Plugin author spotlight on docs site.

### 14.4 Governance

- `MAINTAINERS.md` listing maintainers with areas of expertise.
- `GOVERNANCE.md` describing decision-making process (BDFL → meritocratic → eventual TSC as project grows).
- Public roadmap in GitHub Projects.

### 14.5 Licensing

- Single license at the root (suggest **AGPL-3.0** for the platform if the goal is to keep modifications open while permitting plugin/integration work; or **Apache-2.0** if maximum permissiveness preferred).
- All submodule licenses aligned.
- DCO (Developer Certificate of Origin) sign-off required on commits.

### 14.6 Trust signals

- Reproducible builds documented.
- Signed releases (cosign — see `security_plan.md` §9.6).
- SBOM attached to each release.
- Security disclosure policy + GPG key.
- Public CVE history (even if empty).

---

## 15. Implementation Order

Phases are independent unless noted. Day estimates are for a focused dev.

### Phase 1 — Repo front door _(2 days)_

- [ ] Root `README.md` with quick start + diagram
- [ ] Root `ARCHITECTURE.md`
- [ ] `CONTRIBUTING.md`
- [ ] `SECURITY.md` (cross-reference `security_plan.md`)
- [ ] `CODE_OF_CONDUCT.md` (Contributor Covenant)
- [ ] `LICENSE` at root
- [ ] `.editorconfig`, `.gitattributes`, `.tool-versions`
- [ ] `adr/0001-monorepo-layout.md` + `adr/README.md` index

### Phase 2 — Workspace consolidation _(2 days)_

- [ ] Top-level `go.work` covering api + daemon + contracts + plugin SDKs
- [ ] Top-level `pnpm-workspace.yaml` covering web + ui + JS plugins + www + docs
- [ ] `Makefile` overhaul with `setup`, `dev`, `build`, `test`, `lint`, `generate`, `release-prep` targets + `make help`
- [ ] `scripts/setup.sh`, `scripts/generate-env.sh`, `scripts/check-tools.sh`
- [ ] `scripts/new-module.sh` (backend) + `scripts/new-feature.sh` (frontend)
- [ ] `.pre-commit-config.yaml` + `make hooks-install`

### Phase 3 — Contracts authoritative _(3 days)_

- [ ] Move proto under `contracts/proto/v1/`
- [ ] Add `contracts/registry.yaml` (single source of truth for capability/error/slot enums)
- [ ] Add `contracts/scripts/generate-{go,ts,dotnet}.sh`
- [ ] CI workflow: `buf lint`, `oasdiff` breaking-change detection, regenerate clients, fail PR if stale
- [ ] Spec-first OpenAPI: complete the spec for every public endpoint
- [ ] Wire `oapi-codegen` to generate Go server types from spec
- [ ] Wire `openapi-typescript` to generate TS types for the panel

### Phase 4 — Backend module hardening _(7 days)_

- [ ] Module READMEs in every `internal/core/{module}/`
- [ ] `UnitOfWork` pattern for cross-module writes
- [ ] Consolidate migrations into single `panel/api/migrations/`
- [ ] RFC 7807 Problem Details error rendering
- [ ] Standard list/pagination parser
- [ ] Internal HTTP listener (`/metrics`, `/internal/*`, `/debug/pprof`)
- [ ] Complete `admin` module
- [ ] Complete `audit` module (cross-ref `security_plan.md` §8)
- [ ] Complete `billing` module skeleton (provider plugin does heavy lifting)
- [ ] Complete `catalog` module
- [ ] Complete `logs` module
- [ ] Complete `usage` module
- [ ] Complete `projects` application layer
- [ ] Add `identity` module wrapping users + sessions + role grants (cross-ref `security_plan.md` §2)

### Phase 5 — Frontend hardening _(6 days)_

- [ ] `panel/web/ARCHITECTURE.md` + per-feature READMEs
- [ ] Lint rule: `app/**` imports `features/**` only via `index.ts`
- [ ] Forbid raw `fetch()` outside `lib/api/`; replace existing usages with axios
- [ ] React Hook Form + Zod for every form
- [ ] Generated TS types from OpenAPI; refactor api hooks to use them
- [ ] `nuqs` for URL-backed list state
- [ ] Light theme support + system preference + persisted toggle
- [ ] Per-feature error boundaries
- [ ] RSC audit + convert `account/profile`, `admin/dashboard`, `project overview` to RSC shells with client islands
- [ ] Complete stub features (account, dashboard, monitoring, settings, organizations, billing)

### Phase 6 — Daemon hardening _(4 days)_

- [ ] `daemon/README.md` + `daemon/ARCHITECTURE.md`
- [ ] Validated `Config` struct with descriptive errors at startup
- [ ] Health endpoints (`/healthz`, `/readyz`) on internal listener
- [ ] Move job state to Postgres (or single-node SQLite); add DLQ; exponential backoff with jitter
- [ ] `KLEFF_DAEMON_CONCURRENCY` configurable
- [ ] Multi-arch Docker build (amd64 + arm64)
- [ ] Build info injection (version, commit, date)
- [ ] Cluster-mode docs (multi-daemon coordination)

### Phase 7 — UI library _(3 days)_

- [ ] Storybook 8 with stories for every public component
- [ ] Chromatic visual regression in CI
- [ ] Accessibility lint + axe in Storybook
- [ ] `node_modules/` untracked
- [ ] Theme tokens documented in Storybook
- [ ] `changesets` adopted for version bumps

### Phase 8 — Observability _(4 days)_

- [ ] Standardized logging fields + `logging.WithCtx(ctx)` helper
- [ ] Sensitive-field redaction handler
- [ ] Prometheus client + metric families enumerated above
- [ ] OpenTelemetry SDK with HTTP/DB/gRPC auto-instrumentation
- [ ] Trace context propagation through job queue
- [ ] Grafana dashboards committed
- [ ] RUNBOOK.md for operators

### Phase 9 — Testing foundation _(7 days, runs alongside other phases)_

- [ ] Backend: testify + dockertest + mockery; backfill 2-3 modules to ≥70% as exemplars
- [ ] Frontend: Vitest + Testing Library + MSW; backfill auth feature as exemplar
- [ ] Daemon: testcontainers-go; backfill workers package
- [ ] SDK self-tests using the new test harnesses
- [ ] Playwright e2e suite: login, install plugin, deploy server happy paths
- [ ] CI: split unit (fast) + integration (slow) + e2e (label/nightly)
- [ ] Coverage gates: don't decrease > 1% per PR

### Phase 10 — CI/CD overhaul _(3 days)_

- [ ] Top-level `ci.yml` matrix
- [ ] `security.yml` (govulncheck + pnpm audit + trivy + gitleaks + OWASP ZAP)
- [ ] `release.yml` (multi-arch + cosign + SBOM + ghcr push + GH Release)
- [ ] `submodule-bump.yml` (auto-PR on submodule advance)
- [ ] `contracts.yml` (lint + diff + regen)
- [ ] CODEOWNERS file
- [ ] PR + Issue templates
- [ ] Dependabot configured for all submodules

### Phase 11 — Open-source posture _(2 days)_

- [ ] Demo video / screenshots in README
- [ ] Discord/Matrix link
- [ ] GitHub Discussions enabled with categories
- [ ] `good-first-issue` and `help-wanted` labels seeded
- [ ] `MAINTAINERS.md` + `GOVERNANCE.md`
- [ ] Roadmap GH Project
- [ ] `kleff plugin new` CLI scaffolder (cross-ref `plan.md` §4.6) gets a public showcase blog post

---

## Appendix A — Sample directory tree (target end state)

```
App/
├── README.md
├── ARCHITECTURE.md
├── CONTRIBUTING.md
├── SECURITY.md
├── CODE_OF_CONDUCT.md
├── MAINTAINERS.md
├── GOVERNANCE.md
├── RUNBOOK.md
├── CHANGELOG.md
├── LICENSE
├── Makefile
├── go.work
├── pnpm-workspace.yaml
├── turbo.json
├── docker-compose.dev.yml
├── docker-compose.yml
├── .editorconfig
├── .gitattributes
├── .gitignore
├── .gitmodules
├── .tool-versions
├── .pre-commit-config.yaml
├── .env.example
├── adr/
│   ├── README.md
│   └── 0001-…md … 00NN-…md
├── scripts/
│   ├── setup.sh
│   ├── check-tools.sh
│   ├── generate-env.sh
│   ├── new-module.sh
│   ├── new-feature.sh
│   └── lint-all.sh
├── .github/
│   ├── workflows/
│   ├── ISSUE_TEMPLATE/
│   ├── PULL_REQUEST_TEMPLATE.md
│   ├── CODEOWNERS
│   └── dependabot.yml
├── contracts/      (submodule)
├── daemon/         (submodule)
├── docs/           (submodule)
├── packages/ui/    (submodule)
├── panel/          (submodule, contains api/ + web/)
├── plugins/        (submodules)
├── crate-registry/ (submodule)
└── www/            (submodule)
```

## Appendix B — How this plan relates to the others

| Plan | Scope | Key cross-refs from this doc |
|---|---|---|
| `plan.md` | Plugin system, scope/tier model, frontend plugin delivery, SDK parity, plugin manager refactor | §5 (manager refactor in plan.md §9), §6 (frontend plugin slot system), §9 (contracts layout) |
| `security_plan.md` | Identity framework, RBAC, sessions, secrets, transport, audit, container hardening | §5 (`audit` + `identity` modules), §10 (audit log integration), §13 (deployment hardening surfaces in RUNBOOK) |
| `architecture_plan.md` | Repo, monorepo, backend/frontend/daemon structure, docs, testing, CI/CD, open-source posture | This file |

## Appendix C — Glossary

- **ADR (Architecture Decision Record):** One-page document capturing a significant architectural choice and its reasoning.
- **Aggregate:** DDD term — a cluster of domain objects treated as a single unit for state changes (e.g., `Order` + its `LineItems`).
- **DCO (Developer Certificate of Origin):** A lightweight alternative to a CLA; commits include `Signed-off-by: Name <email>`.
- **Hexagonal architecture:** Aka ports and adapters; the domain core knows nothing of HTTP, DB, or other infrastructure.
- **Monorepo:** Multiple projects in a single repository (here: each component is a submodule but lives in one App).
- **RSC (React Server Component):** Next.js component that renders on the server with no client JS bundle cost.
- **Submodule:** A pointer to a specific commit in another git repository, embedded in the parent.
- **Turbo / Turborepo:** Build orchestrator with task caching across monorepo workspaces.
- **UnitOfWork:** Pattern for grouping multiple repository operations into a single transaction.
- **Workspace:** A package or project participating in a monorepo's dependency graph (`go.work`, `pnpm-workspace.yaml`).
