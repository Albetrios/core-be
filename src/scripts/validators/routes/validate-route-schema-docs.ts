/**
 * Route schema-docs gate.
 *
 * Every Fastify route registration in `src/domains/**\/*.routes.ts` (plus the
 * supplemental `health.middleware.ts` and `mcp-server.ts` registrations) must
 * declare `schema.summary`, `schema.description`, and `schema.tags`. These three
 * fields drive the generated OpenAPI operation docs — a route missing any of them
 * ships an empty/partial operation.
 *
 * The OpenAPI builder reads the same metadata via `collectRouteSchemaMetadata()`,
 * but that helper silently drops routes with no metadata; this gate uses the
 * unfiltered `collectAllRouteSchemaEntries()` so a route missing every field is
 * still caught.
 *
 * Usage: `pnpm validate:route-schema-docs`
 */
import { collectAllRouteSchemaEntries } from '@tooling/openapi/extractors/route-schema-metadata.js';
import { findRouteSchemaDocProblems } from './route-schema-docs-validation.util.js';

function main(): void {
  const entries = collectAllRouteSchemaEntries();
  const problems = findRouteSchemaDocProblems(entries);

  if (problems.length > 0) {
    console.error('validate-route-schema-docs failed:\n');
    console.error('Routes missing OpenAPI schema docs (summary / description / tags):');
    for (const line of problems) console.error(`  - ${line}`);
    console.error(
      "\nAdd summary, description, and tags to each route's `schema` block " +
        '(see agent-os/skills/be-route-schema-doc-guard/SKILL.md).',
    );
    process.exit(1);
  }

  console.log(`✅ validate-route-schema-docs passed (${entries.length} routes documented)`);
}

main();
