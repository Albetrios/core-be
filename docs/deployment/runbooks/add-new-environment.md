# Runbook: add a new deployment environment

A "new environment" means another hosted target alongside `development` and `production` —
typically `staging` for pre-production validation. This runbook keeps the canonical 1:1
mapping intact across all dimensions.

## Canonical invariant

Every hosted environment must be declared in **`tooling/setup/setup.config.json`**
(`environments[]`). That manifest is the single source of truth; run
`pnpm tool:generate-project-identity` after manifest changes to regenerate project
identity constants and the CI composite action.

Example manifest excerpt:

```json
{
  "environments": [
    { "name": "development", "label": "Development", "nodeEnvironment": "development", "protected": true, "isDefault": true },
    { "name": "production", "label": "Production", "nodeEnvironment": "production", "protected": true }
  ]
}
```

The `name` is both the GitHub Environment and `NODE_ENV` value. Single trunk:
every environment deploys from `git.defaultBranch` (`main`), so there is **no**
per-environment `branch` field. Plus the operator-local artefact:

```text
.env.<environment>   (gitignored; created by `pnpm github:sync`, pushed by `pnpm github:sync`)
```

| Dimension | Lives in |
| --------- | -------- |
| Branch ↔ environment mapping | `tooling/setup/setup.config.json` (canonical; read by `pnpm github:sync`) |
| `NODE_ENV` enum value | `src/shared/config/env-schema.ts` |
| `.github/environments/<env>.json` | committed protection config |
| Branch ruleset | `.github/rulesets/<branch>.json` |
| Workflow case mapping | `.github/workflows/reusable-railway-deploy.yml` |
| GitHub Environment (secrets + variables) | live in GitHub UI (managed via `pnpm github:sync`) |
| `.env.<environment>` | repo root, **gitignored** (operator-local; source of truth for `github:sync`) |

`pnpm github:sync --check` enforces the committed dimensions before any GitHub write.
Run it locally before merging plumbing changes.

## Existing hosted environments

Single trunk: both environments deploy from `main` (environment ≠ branch). The
deploy workflow picks the environment explicitly, never from the branch.

| GitHub Environment | `NODE_ENV`    | Deploy trigger                                             |
| ------------------ | ------------- | ---------------------------------------------------------- |
| `development`      | `development` | every merge to `main` (`post-merge-ci.yml`)                |
| `production`       | `production`  | release published / manual dispatch (`release-deploy.yml`) |

Non-hosted runtime mode (no GH env): `local`. The Vitest suite runs as `development`.

## First-time bootstrap

For an existing environment whose values have not been seeded into GitHub yet:

```bash
pnpm github:sync                   # creates missing .env.<environment> files
# Edit each file with real values
pnpm github:sync development          # push to GitHub
pnpm github:sync production
```

`github:sync` is idempotent — safe to re-run any time you change a value locally.

## Adding a new environment

> Example: adding `staging` deployed from a `staging` branch.

### 1. Confirm the `NODE_ENV` enum already lists the new value

If not, add it to `nodeEnvSchema` in `src/shared/config/env-schema.ts` first and run
`pnpm validate`.

### 2. Update manifest, regenerate artifacts, and scaffold local files

Edit `tooling/setup/setup.config.json` — add the new entry under `environments[]`
(and `git.protectedBranches` if the deploy branch is protected).

Then run:

```bash
pnpm tool:generate-project-identity   # constants, composite action, workflow branch/env maps
pnpm github:sync                    # .env.<environment>, rulesets, GitHub Environment JSON
```

This creates (idempotent — never overwrites existing files):

- `.env.staging` (local, **gitignored**) — copy of `.env.example`. Edit it with real values.
- `.github/environments/<environment>.json` (committed, e.g. `staging`) — empty protection by default.
- `.github/rulesets/<environment>.json` (committed, e.g. `staging`) — branch ruleset matching the default non-production policy.

It also prints the exact next commands.

### 3. Fill in `.env.staging` with real values

Open `.env.staging` and replace placeholders with real `DATABASE_URL`, `REDIS_URL`, JWT
keypair, `SENTRY_DSN`, Railway token, etc. Leave optional integrations blank — `github:sync`
skips empty values.

### 4. Push to GitHub

```bash
pnpm github:sync staging --dry-run    # preview what will be pushed
pnpm github:sync staging              # push for real
```

`github:sync` creates the GitHub Environment and pushes every `KEY=VALUE` according to which
top-level half it sits in inside `.env.<environment>`:

- Anything under `# ### GitHub Secrets ### #` → `gh secret set`.
- Anything under `# ### GitHub Variables ### #` → `gh api .../variables`.

The file structure is the source of truth — no separate classifier file, no override lists.
The `be-env-schema-add` skill walks through which half + sub-section to pick when adding a new
env var.

### 5. Wire CI (usually automatic)

Re-run `pnpm tool:generate-project-identity` so workflow `branches:` lists and
`PROTECTED_BRANCHES_JSON` match the manifest. Only hand-edit a workflow if you are
adding a **new** workflow file — then add it to `WORKFLOW_FILES_TO_PATCH` in
`tooling/setup/codegen/generate-project-identity.ts`.

Single trunk: the deploy workflow does **not** map a branch to an environment. The
caller passes the target environment explicitly via the `github_environment` input
(see `.github/workflows/reusable-railway-deploy.yml`): `post-merge-ci.yml` passes
`development` on every merge to `main`, and `release-deploy.yml` passes `production`
on release. A new environment is deployed by a caller that passes its name.

### 6. Apply the branch ruleset

```bash
gh api --method POST repos/:owner/:repo/rulesets \
  --input .github/rulesets/staging.json
```

### 7. Verify everything is 1:1

```bash
pnpm github:sync --check                  # cross-dimension drift + GitHub IaC check
pnpm tool:sync-env-example                # .env.example <-> schema coverage
# GH env <-> schema required keys: verified by the deploy workflow's validate:github-env-runtime step
```

All three must exit 0 before merging.

## Removing an environment

1. `gh api --method DELETE repos/:owner/:repo/environments/<name>`
2. `rm .github/environments/<name>.json`
3. `rm .github/rulesets/<branch>.json`
4. `rm .env.<name>` (local-only, already gitignored — but tidy up your machine)
5. Edit `.github/workflows/reusable-railway-deploy.yml`: drop `<branch>` from `branches` and
   remove the corresponding case.
6. Run `pnpm github:sync --check` to confirm.

## Why the invariant matters

A drift between any two dimensions silently breaks deploys:

- Branch / GH env mismatch → workflow targets an env that has no secrets → Zod-rejects on
  first request.
- `NODE_ENV` value missing → `env.config.ts` throws at boot with no meaningful message.
- GH env config missing → workflow runs but has no protection / secrets.

`pnpm github:sync --check` is the single source of truth: if that command is green,
every committed dimension matches and remote GitHub IaC has no reported drift.
