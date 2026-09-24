/**
 * Route `:param` → `schema.params` completeness gate (EX-08).
 *
 * Fastify's TS generic (`Params`) does not force the runtime `schema.params`, so a route can declare
 * a `:segment` in its path while omitting the Zod `params` schema — malformed/oversized path params
 * then reach the handler as 500s instead of clean 400s, and OpenAPI omits the parameter. EX-05 closed
 * today's gaps; this gate stops the next route from regressing it.
 *
 * Rule: every route whose path template contains at least one `:segment` MUST declare `schema.params`.
 *
 * Usage: `pnpm validate:route-param-schemas`
 */
import {
  collectAllRouteSchemaEntries,
  type RouteSchemaEntry,
} from '@tooling/openapi/extractors/route-schema-metadata.js';

/** A `:segment` (Fastify path param) anywhere in the route template. */
const PATH_PARAM_PATTERN = /:[A-Za-z0-9_]+/;

/** Returns the routes that carry a `:param` but omit `schema.params`. */
export function findRoutesMissingParamSchema(entries: RouteSchemaEntry[]): RouteSchemaEntry[] {
  return entries.filter(
    (entry) => PATH_PARAM_PATTERN.test(entry.fullPath) && !entry.hasParamsSchema,
  );
}

function main(): void {
  const entries = collectAllRouteSchemaEntries();
  const offenders = findRoutesMissingParamSchema(entries);

  if (offenders.length > 0) {
    console.error('validate-route-param-schemas failed:\n');
    console.error(
      'Routes with a :param segment but no schema.params (malformed ids reach handlers as 500s):',
    );
    for (const entry of offenders) {
      console.error(`  - ${entry.method} ${entry.fullPath}`);
    }
    console.error(
      '\nAdd a `params:` Zod schema (snake_case + semantic id) to each route — see ' +
        'agent-os/skills/be-api-contract-guard/SKILL.md.',
    );
    process.exit(1);
  }

  const paramRouteCount = entries.filter((entry) => PATH_PARAM_PATTERN.test(entry.fullPath)).length;
  console.log(
    `✅ validate-route-param-schemas passed (${paramRouteCount} :param routes all declare schema.params)`,
  );
}

if (import.meta.url === new URL(process.argv[1] ?? '', 'file:').href) {
  main();
}
