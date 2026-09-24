# SonarQube — local quality gate

SonarQube runs **locally** (Docker) and is enforced as a **pre-commit gate**: when you commit
changes that touch deployed-surface code (`src/` runtime), the hook scans the project and **blocks
the commit if SonarQube reports any unresolved issue or hotspot**. The gate is **mandatory — there
is no bypass**; every finding must be resolved. Everything is local — there is no hosted SonarQube
and no CI dependency.

## TL;DR

```bash
pnpm compose:up    # starts the app stack AND SonarQube (SONAR=0 pnpm compose:up skips Sonar)
pnpm sonar:scan    # scan now + print the report; exits non-zero if anything is open
git commit         # the pre-commit hook runs the same gate automatically
```

`pnpm compose:up` brings SonarQube up with the rest of the local stack — detached, so it boots in
the background and the gate waits for readiness only when needed. First boot is ~2 min and
provisions an analysis token into `.env.local` (gitignored); after that a scan is ~60–90s.
`pnpm sonar:up` starts only SonarQube, and the pre-commit gate auto-starts it if it is down.

The scanner runs with **`sonar.scm.disabled=true`** (set in `docker-compose.sonar.yml`). The gate
fails on any open issue, so blame and new-code data never change its verdict — and the scanner's git
reader (JGit) crashes with `Bare Repository has neither a working tree, nor an index` on a checkout
whose shared `.git/config` sets `core.bare = true` with per-worktree overrides
(`extensions.worktreeConfig`), a layout git itself handles. The analysis token reaches the scanner
**only** through the `SONAR_TOKEN` environment variable: passing it again as `-Dsonar.token` made the
scanner log both values in plain text ("Property 'sonar.token' … is overridden with value …") on
every pre-commit run.

### Sharing port 9000 with core-fe

Both repos use `localhost:9000` — **one server, two projects** (`core-be` and `core-fe` appear
side by side in the same UI). Whichever repo starts SonarQube first owns the container; the other
repo's gate **reuses it** instead of starting a second one. For core-fe's gate to mint its own
token there, copy `SONAR_ADMIN_PASSWORD` from this repo's `.env.local` into core-fe's
`.env.development` (see core-fe's `docs/reference/quality/sonarqube-local.md` for its side).

## Commands (`sonar:*` namespace)

| Command            | What it does                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------------- |
| `pnpm sonar:up`    | Start the local SonarQube server (`docker-compose.sonar.yml`).                                          |
| `pnpm sonar:scan`  | Run the quality gate now: ensure server up → scan → wait → report. Exit 1 if any issue/hotspot, else 0. |
| `pnpm sonar:down`  | Stop the server (keeps the analysis volume).                                                            |
| `pnpm sonar:reset` | Wipe the volume and start fresh (`down -v` + `up`). Use if auth/state gets stuck.                       |

The server UI is at <http://localhost:9000>. Admin credentials are generated on first run and
stored in `.env.local` as `SONAR_ADMIN_PASSWORD` / `SONAR_TOKEN`.

## How the pre-commit gate works

The `pnpm guard:pre-commit` hook (`.husky/pre-commit`, step 17) runs the gate **only when the
staged changes include deployed-surface code** — `src/**/*.ts` excluding tests, `src/scripts/**`,
and `__tests__/`. Commits that touch only tests, tooling, docs, or migrations skip the scan (Sonar
excludes those anyway — see [Scope](#what-sonarqube-analyzes)).

The gate ([`tooling/sonar/sonar-gate.ts`](../../../tooling/sonar/sonar-gate.ts)):

1. **Auto-starts** the SonarQube container if it is not already up, and waits for it to be ready.
2. **Provisions a token** on first run (changes the default `admin/admin` password to a generated
   one, mints a token, saves both to `.env.local`). Idempotent afterwards.
3. **Scans** via the `sonar-scanner-cli` container.
4. **Waits** for the server to finish processing the report.
5. **Reports** every unresolved issue + hotspot and **exits 1** (blocking the commit) if there is
   at least one; exits 0 when clean.

### No bypass

The gate is mandatory: there is no `SKIP_SONAR` env var and no app-level escape hatch. Every
SonarQube issue and hotspot on the deployed-app surface must be resolved before the commit is
accepted. After a fix, re-run `pnpm sonar:scan` to re-check against the local server. A finding you
believe is a genuine false positive should be marked resolved / won't-fix in the SonarQube UI
(<http://localhost:9000>) so the gate stops reporting it.

## What SonarQube analyzes

Analysis is scoped to the **deployed-application surface** (`src/` runtime), matching the CodeQL
scoping in [`.github/codeql/codeql-config.yml`](../../../.github/codeql/codeql-config.yml). Excluded
from analysis (see [`sonar-project.properties`](../../../sonar-project.properties)):

- **Tests** — `*.test.ts`, `*.spec.ts`, `__tests__/`, `src/tests/` (run with trusted fixtures; test-only rules are systematic false positives).
- **Tooling & scripts** — `tooling/**`, `src/scripts/**` (dev/CI only, developer-controlled input).
- **Migrations, generated, and build artifacts** — `migrations/**`, `dist/`, `coverage*/`, `*.d.ts`.

So a clean gate means **zero issues in the code that ships to production**.

## Troubleshooting

- **"failed to start SonarQube (is Docker running?)"** — start Docker Desktop, then retry.
- **"admin password is unknown"** — the instance was provisioned outside this flow. Run
  `pnpm sonar:reset` to start fresh, or set `SONAR_ADMIN_PASSWORD` in `.env.local`.
- **Server slow / stuck after an upgrade** — `pnpm sonar:reset`.
- **A finding you believe is a false positive** — mark it resolved / won't-fix in the SonarQube UI
  (<http://localhost:9000>) so the gate stops reporting it. There is no env bypass.
