# Observability log events (reference)

Structured log event names used in application code. Update dashboards and Sentry alerts when renaming events.

## Permission cache

| Event                                             | When                                                         |
| ------------------------------------------------- | ------------------------------------------------------------ |
| `permission-cache.invalidate-organization.failed` | Redis invalidation failed for an organization permission set |
| `permission-cache.get.failed`                     | Failed to read cached permissions                            |

**Migration (2026-05):** `permission-cache.invalidate-organization.failed` was renamed to `permission-cache.invalidate-organization.failed` (full-name convention). Update any saved queries or monitors that still filter on the old string.

## Related

- [architecture-consistency-roadmap-2026-05.md](../../reviews/architecture-consistency-roadmap-2026-05.md) — completed layout program (archival)
- [domains-and-public-api-design.md](../architecture/domains-and-public-api-design.md)
- [`src/infrastructure/observability/observability.overview.md`](../../../src/infrastructure/observability/observability.overview.md) — instrumentation surface, Sentry choice, structured logging design
