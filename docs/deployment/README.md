# Deployment and operations

Hand-written guides grouped by **setup**, **CI/CD**, and **runbooks**.

| Subfolder              | Purpose                                                                                              |
| ---------------------- | ---------------------------------------------------------------------------------------------------- |
| [setup/](setup/)       | Manual Railway + GitHub CLI setup                                                                    |
| [ci-cd/](ci-cd/)       | Pipelines, branch protection — **canonical:** [cicd-and-deployment.md](ci-cd/cicd-and-deployment.md) |
| [runbooks/](runbooks/) | Local → prod path, gates, memory, observability                                                      |

---

## Quick links

| Goal                                | Doc                                                                                                 |
| ----------------------------------- | --------------------------------------------------------------------------------------------------- |
| Manual Railway + GitHub CLI         | [setup/railway-github-cli-setup.md](setup/railway-github-cli-setup.md)                              |
| CI, deploy, tokens, release flow    | [ci-cd/cicd-and-deployment.md](ci-cd/cicd-and-deployment.md)                                        |
| Local → production runbook          | [runbooks/production-go-live.md](runbooks/production-go-live.md) (includes path-to-production gate) |
| Roll back a bad release             | [runbooks/rollback-deploy.md](runbooks/rollback-deploy.md)                                          |
| Observability                       | [runbooks/observability.md](runbooks/observability.md)                                              |
| Memory / `NODE_OPTIONS`             | [runbooks/resource-limits.md](runbooks/resource-limits.md)                                          |
| Branch protection / required checks | [ci-cd/branch-protection.md](ci-cd/branch-protection.md)                                            |

---

## All docs

### [setup/](setup/)

| Doc                                                              | Description                                                                        |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| [railway-github-cli-setup.md](setup/railway-github-cli-setup.md) | Manual Railway + GitHub CLI setup.                                                 |

GitHub repo/environment sync is core-be's own tooling:

| Command                    | Purpose                                                                                                                                                    |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm github:sync`         | Full GitHub sync: consistency + scaffold + rulesets + environments + push each local `.env.<environment>` (typed `sync` confirmation before values). Add an environment name to limit the values push. |
| `pnpm github:sync --check` | Read-only: cross-dimension consistency + remote drift report (no writes).                                                                                    |
| `pnpm github:sync --dry-run` | Preview full sync (remote + values) without writing.                                                                                                        |

### [ci-cd/](ci-cd/)

| Doc                                                                                      | Description                                                                     |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| [cicd-and-deployment.md](ci-cd/cicd-and-deployment.md)                                   | **Single CI/CD reference** — CI jobs, deploy, release-please, tokens, diagrams. |
| [branch-protection.md](ci-cd/branch-protection.md)                                       | Required checks for `main` (`Quality gate` + `Checks`).                         |
| [deploy-artifact-and-secret-decisions.md](ci-cd/deploy-artifact-and-secret-decisions.md) | Why the release PAT is an environment secret + build-once-promote.              |

### [runbooks/](runbooks/)

| Doc                                                                                     | Description                                                                |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| [production-go-live.md](runbooks/production-go-live.md)                                 | Local gates, path-to-production gate, env checklist, build, deploy, smoke. |
| [resource-limits.md](runbooks/resource-limits.md)                                       | Railway/K8s memory and `NODE_OPTIONS`.                                     |
| [observability.md](runbooks/observability.md)                                           | Sentry, logs, health; Prometheus re-enable checklist.                      |
| [upload-storage.md](runbooks/upload-storage.md)                                         | Direct-to-S3 upload hardening: validation, sweeper, lifecycle policy.      |
| [rollback-deploy.md](runbooks/rollback-deploy.md)                                       | One-click rollback: redeploy the `:previous` GHCR images.                  |
| [hotfix-release.md](runbooks/hotfix-release.md)                                         | Ship an urgent fix under the single-`main` delivery model.                 |
| [environment-variables.md](runbooks/environment-variables.md)                           | Canonical env-var reference across every workflow.                         |
| [add-new-environment.md](runbooks/add-new-environment.md)                               | Add another hosted target alongside `development` and `production`.        |
| [redis-topology.md](runbooks/redis-topology.md)                                         | The two Redis surfaces and how they are provisioned.                       |
| [maintenance-database-role.md](runbooks/maintenance-database-role.md)                  | Dedicated `core_be_maintenance` role + `DATABASE_MAINTENANCE_URL` provisioning.   |
| [worker-scaling.md](runbooks/worker-scaling.md)                                         | BullMQ worker process: scaling, concurrency, resource envelope.            |
| [stripe-subscription-reconciliation.md](runbooks/stripe-subscription-reconciliation.md) | API-initiated subscription changes vs Stripe webhooks — reconciliation.    |
