/**
 * Declarative env-var registry DSL. Each variable is declared once as
 * `envVar(<zod field>, { allowed, description })`, pairing its validation (the Zod schema — the
 * allowed-values authority) with a human-readable allowed-values summary and a one-line description.
 * The runtime Zod object is DERIVED from the registry via {@link toSchemaShape}, so the manifest is
 * the single source of truth for what a variable accepts, defaults to, and means.
 *
 * @remarks
 * The Zod field is written INLINE (not generated from primitives) so precise output-type inference is
 * fully preserved — `getEnv().PORT` stays `number`, an `.optional()` field stays `T | undefined`.
 * Migrating an existing field is therefore a mechanical wrap that never changes validation behaviour:
 * `PORT: z.coerce.number()...` → `PORT: envVar(z.coerce.number()..., { allowed, description })`.
 */
import type { z } from 'zod';

/**
 * A single variable's specification: its Zod field plus explicit allowed-values and description
 * metadata. The default (and required/optional status) lives in the Zod field itself and is read
 * back with Zod's public API, so it is never duplicated here.
 */
export interface EnvVarSpec<Schema extends z.ZodType = z.ZodType> {
  /** The Zod field for this variable — the validation and allowed-values authority. */
  readonly schema: Schema;
  /** Human-readable allowed-values summary for the catalog, e.g. `integer 1–65535`, `turnstile | disabled`. */
  readonly allowed: string;
  /** One-line description of the variable's purpose. */
  readonly description: string;
}

/**
 * Declares one registry variable — pairs an inline Zod field with its allowed-values summary and
 * description. The Zod field's precise type is preserved in the returned spec so the derived schema
 * object keeps full inference.
 */
export function envVar<Schema extends z.ZodType>(
  schema: Schema,
  meta: { readonly allowed: string; readonly description: string },
): EnvVarSpec<Schema> {
  return { schema, allowed: meta.allowed, description: meta.description };
}

/** The Zod-object shape derived from a registry — each key mapped to its `.schema`, with precise types. */
export type SchemaShapeOf<Registry extends Record<string, EnvVarSpec>> = {
  readonly [Key in keyof Registry]: Registry[Key]['schema'];
};

/**
 * Derives the Zod-object shape from a registry — the `{ KEY: schema }` map you spread into
 * `z.object({ ...toSchemaShape(registry), ...rest })`. Precise per-field types are preserved so the
 * inferred env type is identical to writing the Zod fields inline.
 */
export function toSchemaShape<Registry extends Record<string, EnvVarSpec>>(
  registry: Registry,
): SchemaShapeOf<Registry> {
  const shape: Record<string, z.ZodType> = {};
  for (const [key, spec] of Object.entries(registry)) {
    shape[key] = spec.schema;
  }
  return shape as SchemaShapeOf<Registry>;
}

/** One catalog row: the resolved, display-ready facts about a registry variable. */
export interface EnvCatalogRow {
  readonly name: string;
  readonly allowed: string;
  readonly description: string;
  /** Stringified default, or `null` when the variable is required / optional-without-default. */
  readonly default: string | null;
  /** `true` when the variable has no default and is not optional (must be present at runtime). */
  readonly required: boolean;
}

/**
 * Builds catalog rows from a registry — resolves each variable's default and required status from its
 * Zod field via the public API (`safeParse(undefined)`), so the catalog can never disagree with what
 * the runtime actually applies.
 */
export function buildEnvCatalog(registry: Record<string, EnvVarSpec>): EnvCatalogRow[] {
  return Object.entries(registry)
    .map(([name, spec]) => {
      const parsedAbsent = spec.schema.safeParse(undefined);
      const hasDefault = parsedAbsent.success && parsedAbsent.data !== undefined;
      return {
        name,
        allowed: spec.allowed,
        description: spec.description,
        default: hasDefault ? String(parsedAbsent.data) : null,
        required: !parsedAbsent.success,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
