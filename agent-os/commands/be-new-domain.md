---
description: Scaffold a new domain or sub-domain following the be-domain-generator skill
argument-hint: <name and short description> e.g. "billing/invoice  invoices issued to organizations"
---

Scaffold a new domain or sub-domain: **$ARGUMENTS**

Procedure:

1. Consult `agent-os/skills/be-skill-index/SKILL.md` first to confirm which skills apply.
2. Follow the **be-domain-generator** skill (`agent-os/skills/be-domain-generator/SKILL.md`)
   and the domain structure in `CLAUDE.md`:
   - Layout under `src/domains/<domain>/...` (controller, service, repository, dto,
     validator, serializer, types; `<domain>.container.ts`; `<domain>.routes.ts`).
   - Wire DI in the container; register routes; export services for controllers.
3. Run the follow-up skills that match what you created: **be-schema-generator** +
   **be-db-migration-maintainer** (tables), **be-route-schema-doc-guard** +
   **be-route-catalog** + **be-seed-maintainer** (routes), **be-test-generator**,
   **be-tsdoc-export-guard**, **be-overview-doc-maintainer**.
4. Keep imports within the dependency rules — cross-domain access via services only.

Do not skip the be-skill-index step.
