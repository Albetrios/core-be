---
name: be-dependency-security
description: Keeps pnpm dependencies non-vulnerable and avoids breaking changes when updating. Use when adding/updating dependencies, when CI audit fails, or when reviewing package.json / pnpm-lock.yaml.
trigger: package.json, pnpm-lock.yaml
triggerNote: Zero-vuln dependency updates
indexNote: keep pnpm deps non-vulnerable; safe patch/minor updates
---

# Dependency security (core-be)

Keep **zero known vulnerabilities** in dependencies and avoid **breaking changes** when updating. Follow this skill whenever you add, upgrade, or change dependencies.

## Non-negotiable

1. **No vulnerabilities** — `pnpm audit` must pass with no findings. CI runs `pnpm deps:audit` and `pnpm deps:audit:prod` (fail on any severity).
2. **No breaking changes by default** — Prefer patch/minor updates; use overrides for transitive vulns before bumping direct deps to a new major.

## Workflow

### When adding or updating a dependency

1. **Install or update**
   - New package: `pnpm add <package>` or `pnpm add -D <package>` (use exact or caret range per project convention).
   - Update existing: use `pnpm update` (respects semver in package.json) or `pnpm update <package>` for a single package. Prefer this over `pnpm add package@latest` to avoid accidental major jumps.

2. **Run audit**

   ```bash
   pnpm install
   pnpm audit
   ```

   If audit reports vulnerabilities, fix them (see below) before committing.

3. **Avoid breaking changes**
   - Prefer `pnpm update` (patch/minor within declared ranges). For a major upgrade, do it intentionally: update one package, run `pnpm validate` and `pnpm test`, fix any breakage, then commit.

4. **Validate and test**

   ```bash
   pnpm validate
   pnpm test
   ```

   Do not commit dependency changes without passing validate and tests.

### When `pnpm audit` reports vulnerabilities

1. **Try automatic fix (limited)**

   ```bash
   pnpm audit fix
   ```

   Often does not resolve transitive vulns; proceed to overrides if needed.

2. **Use `overrides` in `pnpm-workspace.yaml` for transitive vulnerabilities**
   - When a **transitive** dependency (e.g. pulled in by `drizzle-kit` or `openapi-to-postmanv2`) has a known vulnerability, add or update an override in `pnpm-workspace.yaml` under the top-level `overrides:` key to force a patched version:

   ```yaml
   overrides:
     package-name: '>=patched.version'
   ```

   - Look up the advisory (e.g. GitHub Advisory or `pnpm audit` output) for the **patched version**.
   - Run `pnpm install --no-frozen-lockfile` to refresh the lockfile, then `pnpm audit` again. Commit both `pnpm-workspace.yaml` and `pnpm-lock.yaml`.

3. **Upgrade direct dependency only if necessary**
   - If the vulnerable package is a **direct** dependency, prefer upgrading it to a patched version (e.g. `pnpm add package@^patched.version`) and run tests. If the only fix is a major upgrade, do it explicitly and run full test suite + fix breakage.

4. **Never leave known vulnerabilities**
   - Do not commit with `pnpm audit` failing. CI will fail. Resolve via overrides or upgrades until `pnpm audit` reports "No known vulnerabilities found."

## Scripts (package.json)

| Script | Purpose |
| --- | --- |
| `pnpm deps:audit` | Run `pnpm audit` (same as CI; must pass). |
| `pnpm deps:audit:prod` | Run `pnpm audit --prod` (production dependency tree only; same as CI quality job). |
| `pnpm deps:update` | Run `pnpm update --recursive` for safe patch/minor updates within current ranges. Run `pnpm audit` and `pnpm validate` + `pnpm test` after. |

## CI

- **Quality job** runs `pnpm install --frozen-lockfile` then `pnpm deps:audit` and `pnpm deps:audit:prod`. Any vulnerability fails the job.
- **Dependabot CI triage** ([`.github/workflows/dependabot-ci-triage.yml`](../../../.github/workflows/dependabot-ci-triage.yml)) opens an issue when PR CI fails on a Dependabot PR. All dependency PRs are merged manually after review. Branch protection must require **PR CI / Security audit**, **PR CI / Security secrets**, and **PR CI / Security SAST** so a merged dependency PR cannot skip audit, secret detection, or SAST.
- Keep `overrides` in `pnpm-workspace.yaml` when needed so that the lockfile (frozen in CI) already contains patched versions.

## Checklist (after any dependency change)

1. [ ] `pnpm install` (or `pnpm install --no-frozen-lockfile` if you added/updated overrides).
2. [ ] `pnpm audit` — must report no vulnerabilities.
3. [ ] `pnpm validate` — lint, format, typecheck pass.
4. [ ] `pnpm test` — full test suite passes.
5. [ ] Commit `pnpm-workspace.yaml` (if overrides changed) or `package.json` (if direct deps changed) and `pnpm-lock.yaml` together; do not commit lockfile with failing audit.

## Reference

- **Overrides**: [pnpm overrides](https://pnpm.io/package_json#pnpmoverrides) — live in `pnpm-workspace.yaml` under a top-level `overrides:` key (not in `package.json`).
- **Audit**: `pnpm audit` (exit code 1 if any severity); CI runs this with frozen lockfile.
- **Safe updates**: `pnpm update` updates within semver ranges; avoid `pnpm add x@latest` unless you intend a major upgrade.
