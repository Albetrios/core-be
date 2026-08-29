# agent-os enhancement audit — mismatch & drift report (2026-06-17)

**Status:** Report-only. No code or judgment-call doc was changed by this audit. Each item below carries a **recommended direction** for sign-off; nothing is applied until directions are assigned.

**Headline:** The mismatches are in the **agent-os documentation / cross-platform wiring** layer — **not** in the application code. Every documented API/architecture convention is CI-enforced and conforms (§3). Scope on disk today: **39 skills / 26 `*-sync.mdc` (43 rules total) / 9 agents / 11 hooks / 4 commands / 2 MCP configs**.

---

## §1 — Doc-internal drift (unambiguous; recommend: fix docs)

These root files are **outside the `agent-os:check` scan**, so stale counts survived the 2026-06-14 audit. The hardened eval (Phase 1) will cover them.

| # | File:line | Says | Should be | Direction |
|---|-----------|------|-----------|-----------|
| 1 | `CLAUDE.md:16` | "replaces reading **22** sync rules" | **26** | Fix doc |
| 2 | `CLAUDE.md:17` | "All **8** agents" | **9** | Fix doc |
| 3 | `AGENTS.md:7` | "**36** project skills" | **39** | Fix doc |

Evidence: `agent-os/skills/` = 39 dirs; `agent-os/rules/*-sync.mdc` = 26; `agent-os/agents/*.md` = 9. (`agent-os/docs/skill-triggers.md` already says "26 sync rules" — correct.)

---

## §2 — Platform-correctness mismatches (recommend: fix wiring)

| # | Item | Current | Impact | Direction |
|---|------|---------|--------|-----------|
| 4 | **Read-only agents unenforced on Claude** | 8 of 9 agents carry only `model: inherit` + `readonly: true` (Cursor-only field); no `tools:` allowlist. Affected: `ci-investigator, tsdoc-coverage-reviewer, sql-design-reviewer, production-hardening-reviewer, verifier, dependency-auditor, production-reviewer, docs-auditor`. Only `changelog-reviewer` has `tools: [Read, Bash]`. | On Claude Code these "read-only" agents can still write (read-only is not enforced). | Add `tools:` allowlist to all 9 (Phase 2) |
| 5 | **Pinned model warning** | `changelog-reviewer.md` pins `model: claude-sonnet-4-5`; the eval warns "prefer `inherit`" and current is sonnet-4-6. | Eval warning; possibly stale model. | Switch to `inherit` (or current) — your call |
| 6 | **MCP default pair not fully declared** | Root `.mcp.json` lists **only `codegraph`** (session reports "mcp 1 declared"); `.mcp.default.json` correctly has `codegraph + headroom`. | `headroom` (context compression) not auto-started in live sessions despite docs promising the pair. | Declare both in `.mcp.json` + web env settings + `targets.json` (Phase 1/6) |
| 7 | **Cursor hooks underused** | `.cursor/hooks.json` wires only `beforeShellExecution` (1 of ~8 events available since Cursor 1.7/2.4). | Cursor gets none of the format/secret/MCP/prompt-routing guards Claude has. | Expand to 5 events from the shared `hooks.json` (Phase 3) |
| 8 | **Codex on deprecated path** | Commands reach Codex via `~/.codex/prompts` symlinks (OpenAI deprecated in favor of skills). | Future-fragile; not using the shared `SKILL.md` substrate. | Move Codex to skills discovery + generated `config.toml` (Phase 3) |
| 9 | **Cursor MCP file** | `.cursor/mcp.example.json` is committed, but Cursor auto-loads `.cursor/mcp.json`. | MCP live on Cursor only after scaffolding `mcp.json`. | Confirm `mcp:setup` writes `.cursor/mcp.json` (Phase 3) |

---

## §3 — Code-vs-agent-os convention audit (recommend: no action — code conforms)

Every documented contract is **CI-enforced** by an existing test/constant, and the code conforms. No divergences found.

| Convention | Documented | Enforcement (exists ✓) | Conforms |
|------------|-----------|------------------------|----------|
| snake_case route params + registry | CLAUDE.md API contract | `PARAM_NAME_TO_ENTITY` + `tooling/openapi/route-catalog/*`, security route-matrix tests | ✓ |
| Public ids (`<prefix>_<21>`, external `id`) | api-contract-guard | `src/shared/utils/identity/public-id.util.ts` (`generatePublicId`, `PUBLIC_ID_PREFIXES`) | ✓ |
| snake_case body keys | api-contract | `src/tests/unit/api/snake-case-body-keys.policy.unit.test.ts` | ✓ |
| Method→status policy | CLAUDE.md | middleware + `tooling/openapi/route-catalog/route-success-statuses.json` | ✓ |
| RLS ENABLE+FORCE + organization GUC | rls-tenant-isolation-guard | `FORCE ROW LEVEL SECURITY` across 8 migrations (incl. `00000000000000_init.sql`); worker RLS security tests | ✓ |
| Worker DB isolation (no `getRequestDatabase` in workers) | CLAUDE.md | `src/tests/unit/infrastructure/database/worker-database-guard.unit.test.ts`, `webhook-worker-no-schema-import.policy.unit.test.ts` | ✓ |
| Import paths (`@/`, `@tooling/`, no `../`) | import-paths.mdc | `src/tests/global/import-paths.global.test.ts` | ✓ |
| Idempotency (8 required writes) | idempotency-guard | `src/shared/utils/idempotency/idempotency-required.util.ts` + unit/security tests; declared in subscription/organization/membership routes | ✓ |
| i18n keyed messages | i18n-message-guard | `src/shared/locales/en/*` + error-handler translation | ✓ |
| Domain structure | CLAUDE.md | `pnpm validate:domain` gate | ✓ |

---

## Directions needed from you

| Items | Recommended | Notes |
|-------|-------------|-------|
| §1 (1–3) | **Fix docs** — correct the counts | Zero-risk; becomes eval-enforced in Phase 1 |
| §2 (4) | **Fix wiring** — add `tools:` to all 9 agents | Real read-only enforcement on Claude |
| §2 (5) | Your call — `inherit` vs keep pinned | Clears the eval warning |
| §2 (6–9) | **Fix wiring** — per the mapped phases | All additive, do-no-harm |
| §3 | **No action** — code conforms | Mismatches are docs/wiring only |

Once directions are assigned, Phase 1 (backbone + eval hardening) applies the §1 corrections under the hardened eval and lands the generator/registry — no application code touched.
