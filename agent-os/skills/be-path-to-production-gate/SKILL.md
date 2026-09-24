---
name: be-path-to-production-gate
description: Run a full codebase review for production readiness, produce a plan, and require user review of that plan before any path-to-production action (release, deploy). Invoke this skill before executing path-to-production steps.
indexNote: pre-release/deploy review + plan; user must approve before prod actions
---

# Path to production gate (core-be)

## Purpose

Before any **path to production** action (release, deployment, or "ready for production" sign-off), run a full code review for production readiness, **write a plan**, and **ask the user to review that plan**. Do not proceed with production steps until the user has reviewed and confirmed.

**Workflow doc:** [docs/deployment/runbooks/production-go-live.md](../../../docs/deployment/runbooks/production-go-live.md).

## When to Use

- **Invoke this skill** when the user requests:
  - "Path to production"
  - "Pre-production review"
  - "Ready for production"
  - "Production readiness check"
  - "What's left before we can ship?"
- This skill runs **before** any production release or deployment workflow. It does not perform deployment; it produces a review plan for user approval.

## How to Run

### 1. Run the production-hardening checklist

- Read **`agent-os/skills/be-production-hardening-guard/SKILL.md`**.
- For each checklist item (Security, Database, Redis, External Services, Logging, Worker Process, CI/CD), **verify** the codebase and note:
  - **Satisfied** — with a brief reference (e.g. file or config that implements it).
  - **Gap** — not satisfied; add to the plan as an action item with file path and what to do.

### 2. Run local gates

Before marking ready for production, confirm the following primary local gate commands have been run and passed:

- `pnpm ci:local` — full PR gate: validate + domain + routes + migrate lint + env example + full test suite.
- `pnpm verify:base` — end-to-end gate: migrate → seed → API smoke → validate.
- **SonarQube gate**: `pnpm sonar:up && pnpm sonar:scan && pnpm sonar:down`. Fix any open issues on the deployed-app surface before release. The same gate is enforced at pre-commit (`pnpm guard:pre-commit`, the final guard step) and is mandatory — there is no bypass.

### 3. Run additional codebase checks

Search and verify; add any findings to the plan:

- **TODOs / placeholders**: Search `src/` for `TODO`, `FIXME`, `HACK`, `XXX`, `placeholder`, `not implemented`. If any affect production behavior or security, list them as items to fix or document.
- **i18n**: Ensure no raw user-facing strings in API error/success responses (e.g. `detail: '...'` in middleware or error handler). All should use translation keys and `request.t()`. See **`agent-os/skills/be-i18n-message-guard/SKILL.md`**.
- **Stripe idempotency**: For billing write operations (e.g. subscription create), confirm `X-Idempotency-Key` from the request is passed through to Stripe when the client sends it. Note if it is missing as an optional improvement.
- **Organization / RLS**: Confirm documentation or code exists for organization context: HTTP requests get organization context via tenant middleware; workers/scripts should not rely on RLS for organization isolation and should pass organization identifiers explicitly. Note if undocumented as a documentation task.
- **Sensitive defaults**: Check that no production secrets or unsafe defaults are hardcoded (e.g. JWT secret, CORS origins in production).

### 4. Produce the plan

Write a **single plan document** (e.g. in the chat or as a markdown block) that includes:

1. **Summary** — One or two sentences on overall readiness (e.g. "Most items satisfied; N gaps and M optional improvements.").
2. **Satisfied items** — Bullet list of production-hardening and other checks that pass, with short references.
3. **Gaps (must address before production)** — Bullet list of issues that must be fixed or documented before path to production, with:
   - Short title
   - File path or area
   - What to do (fix or document).
4. **Optional improvements** — Bullet list of recommended but non-blocking items (e.g. Stripe idempotency forwarding, hardening automation script).
5. **Next step** — "Review this plan. Once you confirm, we can proceed with path-to-production steps or address the gaps first."

### 5. Ask the user to review

- **Present the plan** clearly (use the structure above).
- **Explicitly ask**: "Please review this plan. Should we address the gaps first, or do you want to proceed with path-to-production as-is?"
- **Do not** run deployment, release, or other production actions until the user has reviewed and confirmed. If the user asks to "proceed" or "go ahead" without specifying, confirm: "I'll proceed with path-to-production after you confirm the plan above."

## Output format (plan template)

Use this structure when you write the plan:

```markdown
# Pre-production review plan

## Summary

[1–2 sentences]

## Satisfied

- [Check] — [reference]

## Gaps (address before production)

- **[Title]** — [file/area]: [what to do]

## Optional improvements

- [Item] — [file/area]: [what to do]

## Next step

Review this plan. Confirm whether to address gaps first or proceed with path-to-production.
```

## Dependencies

- **be-production-hardening-guard** — Use its checklist as the core of the review.
- **be-i18n-message-guard** — Use for checking user-facing strings.
- **be-skill-index** — Consult first if the user's request touches other areas (e.g. routes, deps); run be-path-to-production-gate **before** any production action.

## Maintaining this skill

If new production-readiness checks are added to the codebase or to **be-production-hardening-guard**, ensure this skill's "Additional codebase checks" (step 3) and the plan template stay in sync so the full code is reviewed before each path to production.
