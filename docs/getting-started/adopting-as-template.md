# Adopting this repository as a template

How to turn this backend into the starting point for a **new** product, in hours rather than days.

Everything below is automated by **`pnpm init:project`**. This document is the checklist that
script implements — read it to understand what the script does and to cover the manual remainder.
The script and this page are deliberately the same list, so they cannot drift apart.

> **Already running this project?** You want [setup.md](setup.md), not this page. This page is only
> for starting a *different* product from this codebase.

---

## 1. Get your own copy

Use the **"Use this template"** button on GitHub if the base repository has the template flag
enabled, then clone your new repository. A template copy starts with clean history; a fork carries
the base project's commits and stays linked to it upstream.

If you maintain the base repository and the button is missing, enable it once:

```bash
gh api -X PATCH repos/{owner}/{repo} -f is_template=true
```

Then add the base as an `upstream` remote so you can pull platform fixes later:

```bash
git remote add upstream https://github.com/{base-owner}/{base-repo}.git
```

---

## 2. Claim the identity

**One command does this.** It rewrites `tooling/setup/setup.config.json`, regenerates every
identity artifact, resyncs the lockfile, and reports anything left over:

```bash
pnpm init:project
```

It prompts for each value, pre-filled with the current one. To run it non-interactively:

```bash
pnpm init:project --yes --name acme-api --display-name "Acme API" --repository acme-organization/acme-api
```

Preview without writing anything:

```bash
pnpm init:project --dry-run
```

### What it changes

`tooling/setup/setup.config.json` is the **single source of truth** for project identity. The
generator (`pnpm tool:generate-project-identity`, which `init:project` runs for you) derives
everything else from it:

| Target | What it carries |
| --- | --- |
| `src/shared/constants/project-identity.constants.ts` | Runtime constants: JWT/TOTP issuer, WebAuthn RP name, MCP URI scheme, MCP server name, webhook `User-Agent`, OpenTelemetry service names, Scalar slug, Postman prefix, DBML path |
| `.github/CODEOWNERS` | Reviewer roster, from `providers.github.owners` |
| `.github/environments/production.json` | Production reviewer handles (reconciled against the roster) |
| `package.json` | `name`, `repository`, `bugs`, `homepage` |
| `sonar-project.properties` | `sonar.projectKey` / `sonar.projectName` |
| `docker-compose.yml`, `docker-compose.sonar.yml` | `container_name` for postgres, redis, toxiproxy, sonarqube |
| `docker-bake.hcl`, `.github/actions/setup-project-identity/`, `.github/project-identity.env` | Image tags and CI identity variables |
| `src/shared/locales/{en,es}/openapi.json` | OpenAPI `info.title` |

Anything not in that table should never hardcode the project name. A CI gate enforces this — see
[section 6](#6-the-identity-gate).

### Flags

| Flag | Effect |
| --- | --- |
| `--name` | Project slug (lowercase, hyphens). Becomes the Docker tag, JWT issuer, MCP URI scheme. |
| `--display-name` | Human-facing name for OpenAPI and emails. |
| `--package-name` | npm package name; defaults to the slug. |
| `--description` | `package.json` description; the committed one is kept when omitted. |
| `--repository` | `owner/repo` for the new GitHub repository. |
| `--owners` | Comma-separated CODEOWNERS handles. Defaults to the repository owner. Supply **two or more** if you intend to use `pnpm github:tool:governance-mode team`. |
| `--reset-history` | **Destructive.** Also performs the fork reset in [section 3](#3-optional-reset-the-base-projects-history). |
| `--dry-run` | Print the plan; write nothing. |
| `--yes` | Non-interactive; skip prompts and confirmations. |

---

## 3. (Optional) Reset the base project's history

`init:project` is **identity-only by default** — it will not delete anything. The fork reset is
opt-in, irreversible, and asks you to type a confirmation phrase:

```bash
pnpm init:project --reset-history
```

It truncates `CHANGELOG.md` to a fresh header and deletes the base project's archived review
reports and its observed route-coverage budget (which regenerates on your next full test run).

Skip this if you want to keep the base project's history as reference material. You can always run
it later.

---

## 4. Wire up providers

`init:project` cannot create accounts for you. After it finishes:

1. Create provider accounts and obtain credentials — Postgres (Neon), Redis, Stripe, Resend, S3,
   Sentry. Per-provider instructions:
   [integrations/credentials-and-env.md](../integrations/credentials-and-env.md).
2. Scaffold your local environment and bring the stack up:

   ```bash
   pnpm setup:local
   ```

3. Run migrations and seed reference data:

   ```bash
   pnpm db:migrate && pnpm db:seed
   ```

4. Push repository configuration — rulesets, GitHub Environments, and secrets — to the new
   repository:

   ```bash
   pnpm github:sync
   ```

5. Replace the placeholder contacts in `SECURITY.md` and `CONTRIBUTING.md` with your own.

---

## 5. Choose a governance mode

The default is `personal`: a solo maintainer, zero required approvals, but every automated gate
still blocks merges. When a second engineer joins:

```bash
pnpm github:tool:governance-mode team
pnpm github:sync
```

Team mode requires **at least two distinct CODEOWNERS handles**, so set `--owners` (or
`providers.github.owners` in the manifest) accordingly and re-run
`pnpm tool:generate-project-identity` first. The tool refuses a configuration that would deadlock
your own pull requests. See
[deployment/ci-cd/branch-protection.md](../deployment/ci-cd/branch-protection.md).

---

## 6. The identity gate

`pnpm tool:generate-project-identity:check` runs in CI (`pnpm ci:quality`) and in the pre-commit
guard. It fails when:

- a generated artifact is out of sync with the manifest — run `pnpm tool:generate-project-identity`;
- the project slug or GitHub owner is **hardcoded** anywhere outside the generated targets and a
  small allowlist — import the constant instead, or read the manifest in `tooling/`;
- an allowlist entry has gone **stale**, meaning the literal it excused no longer exists — delete
  the entry.

The allowlist lives in
`tooling/setup/codegen/validate-project-identity-literals.ts`. Markdown, `docs/`, and the
`agent-os/` tooling mirrors are out of scope: prose that names the base project is documentation,
not an identity defect.

After a rename, `init:project` also reports any file still mentioning the **previous** name. Those
are almost always prose and want a human decision, so they are reported rather than rewritten.

---

## 7. Verify

```bash
pnpm ci:local
```

This is the same gate CI runs. Green here means the new identity is consistent everywhere.

---

## Keep / replace / delete

What an adopting team should expect to change:

| Tier | Modules | Guidance |
| --- | --- | --- |
| **Platform — never remove** | `auth`, `tenancy`, `audit`, `user`, RLS contexts, queue runtime, observability | The reason to start from this base. Take upstream fixes here. |
| **Platform — provider-swappable** | mail (Resend), storage (S3), notify webhooks | Swap the provider behind the existing port/adapter; domains are unaffected. |
| **Example — delete or disable if unused** | `billing` (Stripe) | Most forks that do not charge money remove this domain entirely. |

---

## Related

- [setup.md](setup.md) — running this project locally
- [prerequisites.md](prerequisites.md) — external tools installed by `pnpm setup:local`
- [../integrations/credentials-and-env.md](../integrations/credentials-and-env.md) — per-provider credentials
- [../deployment/runbooks/environment-variables.md](../deployment/runbooks/environment-variables.md) — env workflow
- [../deployment/ci-cd/branch-protection.md](../deployment/ci-cd/branch-protection.md) — merge and deploy policy
