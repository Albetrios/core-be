# Agent catalog (core-be)

<!-- GENERATED:START -->
All 11 project agents — each read-only. Generated from `agents/*.md` frontmatter
and `agents/pipelines.json`. See [platform-access.md](platform-access.md) for how to invoke on each platform.

| Agent | File | Wraps skill | Model (routing rationale) | Pipelines | Use when |
| ----- | ---- | ----------- | ------------------------- | --------- | -------- |
| **be-changelog-reviewer** | [`agent-os/agents/be-changelog-reviewer.md`](../agents/be-changelog-reviewer.md) | *(inline)* | `haiku` — mechanical diff/log/PR-title scan — no deep reasoning | — | Verify CHANGELOG.md vs git log / merged PR titles — gap report |
| **be-ci-investigator** | [`agent-os/agents/be-ci-investigator.md`](../agents/be-ci-investigator.md) | be-ci-investigation | `inherit` — root-cause diagnosis from noisy CI logs — frontier reasoning | — | One failing CI job — root-cause summary without log noise |
| **be-dependency-auditor** | [`agent-os/agents/be-dependency-auditor.md`](../agents/be-dependency-auditor.md) | be-dependency-security | `haiku` — parses pnpm audit and maps severities — mechanical | prod-readiness | pnpm audit — vulnerabilities + prioritized fix plan |
| **be-docs-auditor** | [`agent-os/agents/be-docs-auditor.md`](../agents/be-docs-auditor.md) | be-docs-audit | `haiku` — mechanical index/link/naming/Mermaid scan | — | Full docs/ audit — stale links, index gaps, Mermaid issues |
| **be-i18n-auditor** | [`agent-os/agents/be-i18n-auditor.md`](../agents/be-i18n-auditor.md) | be-i18n-message-guard | `inherit` — i18n classification (is this string user-facing?) + locale key-graph judgement — frontier reasoning | — | i18n audit — untranslated payload strings, locale key parity and drift |
| **be-production-hardening-reviewer** | [`agent-os/agents/be-production-hardening-reviewer.md`](../agents/be-production-hardening-reviewer.md) | be-production-hardening-guard | `inherit` — infra/security judgement across the stack — frontier reasoning | pre-merge-review, prod-readiness | Targeted hardening sweep — security headers, DB/Redis/worker gaps |
| **be-production-reviewer** | [`agent-os/agents/be-production-reviewer.md`](../agents/be-production-reviewer.md) | be-path-to-production-gate + be-production-hardening-guard | `inherit` — full production-readiness synthesis — frontier reasoning | prod-readiness | Pre-release / deploy sign-off — full readiness plan |
| **be-sql-design-reviewer** | [`agent-os/agents/be-sql-design-reviewer.md`](../agents/be-sql-design-reviewer.md) | be-sql-design-guard | `inherit` — schema design trade-offs (indexes/partitioning) — frontier reasoning | pre-merge-review | Schema design review — indexes, constraints, column conventions |
| **be-stack-monitor** | [`agent-os/agents/be-stack-monitor.md`](../agents/be-stack-monitor.md) | *(inline)* | `inherit` — interprets health signals + regressions — inherit | — | Periodic / continuous stack monitoring — health verdict + anomalies from the dashboards MCP data tools (never the HTML UI) |
| **be-tsdoc-coverage-reviewer** | [`agent-os/agents/be-tsdoc-coverage-reviewer.md`](../agents/be-tsdoc-coverage-reviewer.md) | be-tsdoc-export-guard *(check phase)* | `haiku` — runs tsdoc:check and lists gaps — mechanical | — | TSDoc gap scan — missing summaries and @remarks |
| **be-verifier** | [`agent-os/agents/be-verifier.md`](../agents/be-verifier.md) | *(inline)* | `inherit` — adversarial validation across edge cases — frontier reasoning | pre-merge-review | After claiming work complete — scoped validate/tests + wiring check |
<!-- GENERATED:END -->

> Each agent is read-only (Cursor `readonly` + a Claude `tools` allowlist that excludes write tools).
> Most wrap a project skill (diagnostic → procedural handoff: the agent finds, the skill fixes);
> `be-verifier`, `be-changelog-reviewer`, and `be-stack-monitor` run inline logic.
> Model routing (mechanical checkers → `haiku`, deep reasoners → `inherit`) is set per agent in its
> frontmatter and rendered in the **Model** column above.
