# Changelog

All notable changes to this project will be documented in this file.

## [6.0.1](https://github.com/albetrios/core-be/compare/v6.0.0...v6.0.1) (2026-09-19)


### Fixed

* **api:** include Scalar reference in runtime image ([#1158](https://github.com/albetrios/core-be/issues/1158)) ([b414714](https://github.com/albetrios/core-be/commit/b41471457ce384d3f9f56d6f40ca0591eef6a7a3))

## [6.0.0](https://github.com/nikunjmavani/core-be/compare/v5.2.2...v6.0.0) (2026-08-31)


### ⚠ BREAKING CHANGES

* **api:** all 45 POST routes that returned 201 now return 200. The method-status policy becomes exemption-free: success is 200 everywhere, DELETE stays 204. Stripe-shaped uniform model - 200 stays true for idempotent replays and future upserts, where a fixed 201 lies on the replay ("Created" when nothing was created). The webhook + MCP exemption list is deleted rather than maintained: every inbound protocol this API might ever host (webhook acks, OAuth token endpoints, JSON-RPC) expects 200, so the exemption class is gone for good.

### Added

* **api:** uniform success 200 for every method except DELETE (204) ([#1071](https://github.com/nikunjmavani/core-be/issues/1071)) ([eee0dd3](https://github.com/nikunjmavani/core-be/commit/eee0dd3248eb114a7d0c32d6911671754ad05a2c))
* **auth:** static test login code, k6 user journey, and load tooling ([#1116](https://github.com/nikunjmavani/core-be/issues/1116)) ([f79c514](https://github.com/nikunjmavani/core-be/commit/f79c514a0fae76b2aea56a20fe83a7d4c331a8b2))
* **database:** RLS scope grammar — principal contexts, five-role taxonomy, claim-only organization ([#1127](https://github.com/nikunjmavani/core-be/issues/1127)) ([f6987b3](https://github.com/nikunjmavani/core-be/commit/f6987b302ce9829994d74541326bc865febdf456))
* **tooling:** show the git branch on the load-testing board ([#1121](https://github.com/nikunjmavani/core-be/issues/1121)) ([b03a4eb](https://github.com/nikunjmavani/core-be/commit/b03a4ebf3acda5676d9fe68353c0c7182b788d53))


### Fixed

* **auth:** accept provider params on OAuth callback; make cookie SameSite configurable ([#1103](https://github.com/nikunjmavani/core-be/issues/1103)) ([bdca0ac](https://github.com/nikunjmavani/core-be/commit/bdca0ac6756c67f0a5c282e13386524e7522c65d))
* **auth:** per-user rate-limit on the two org-switch POSTs ([#1095](https://github.com/nikunjmavani/core-be/issues/1095)) ([3fed87d](https://github.com/nikunjmavani/core-be/commit/3fed87dcb41672e41c8235faa9c7f8277f949ced))
* **auth:** point OAuth redirect URIs at the SPA's provider callback pages ([#1126](https://github.com/nikunjmavani/core-be/issues/1126)) ([a911bf4](https://github.com/nikunjmavani/core-be/commit/a911bf40bae51b049cfb89eea2b5a17f2ce9f1fc))
* **database:** bound lock waits (HTTP + worker), floor the idle timeout, close a savepoint GUC leak ([#1109](https://github.com/nikunjmavani/core-be/issues/1109)) ([3b85cb4](https://github.com/nikunjmavani/core-be/commit/3b85cb4d4c854eb59e70655dc2666fb6b7a35913))
* **database:** name the exact pool value in the connection budget failure ([#1130](https://github.com/nikunjmavani/core-be/issues/1130)) ([7f7d0ec](https://github.com/nikunjmavani/core-be/commit/7f7d0ec1a8ee7b3da1673c640fcd12a1ef033cb2))
* **deploy:** dump Railway container logs on non-success deployments ([#1132](https://github.com/nikunjmavani/core-be/issues/1132)) ([4c75a84](https://github.com/nikunjmavani/core-be/commit/4c75a84b06b6c22ae07f26817e2e240015d38ce3))
* **deploy:** dump Railway container logs when a deployment ends non-success ([4c75a84](https://github.com/nikunjmavani/core-be/commit/4c75a84b06b6c22ae07f26817e2e240015d38ce3))
* **docker:** cache-bust the apk security-patch layer per build ([#1128](https://github.com/nikunjmavani/core-be/issues/1128)) ([2be86af](https://github.com/nikunjmavani/core-be/commit/2be86afbae9786c4a654e23aa82bb7df73af0cee))
* **migrations:** SET-capable owner membership for the role-taxonomy sweep (Neon 42501) ([#1131](https://github.com/nikunjmavani/core-be/issues/1131)) ([82cfb29](https://github.com/nikunjmavani/core-be/commit/82cfb29374189a8b42b2975116697bc559051416))
* **migrations:** taxonomy owner-membership must be SET-capable — Neon 42501 on first hosted deploy ([82cfb29](https://github.com/nikunjmavani/core-be/commit/82cfb29374189a8b42b2975116697bc559051416))
* **observability:** survive a missing pino-pretty instead of crash-looping on boot ([#1134](https://github.com/nikunjmavani/core-be/issues/1134)) ([afa00ee](https://github.com/nikunjmavani/core-be/commit/afa00ee86c0ee7418b55913db9e4497c7e5ee4d4))
* **sonar,auth:** self-heal a stale Sonar admin password; drop deprecated Zod passthrough ([#1107](https://github.com/nikunjmavani/core-be/issues/1107)) ([84c92a6](https://github.com/nikunjmavani/core-be/commit/84c92a6119eb343a9b9a8b95ec9b13e199ea1902))
* **tenancy:** read active organization under the user RLS context, not global-admin ([#1105](https://github.com/nikunjmavani/core-be/issues/1105)) ([0b488db](https://github.com/nikunjmavani/core-be/commit/0b488dba5f31daf53b5a2e79b128dac7fef716ef))
* **tenancy:** resolve user ids via SECURITY DEFINER, not a raw auth.users read ([#1106](https://github.com/nikunjmavani/core-be/issues/1106)) ([66ae50b](https://github.com/nikunjmavani/core-be/commit/66ae50b6a713c9841a85e1716472b1d328b3d66b))


### Performance

* **auth:** share one database context across me/context's user reads ([#1118](https://github.com/nikunjmavani/core-be/issues/1118)) ([c0c7952](https://github.com/nikunjmavani/core-be/commit/c0c7952bc443a2f8894446806873ffe14b68b6b3))
* **auth:** share one database context across switch-to-organization's reads ([#1120](https://github.com/nikunjmavani/core-be/issues/1120)) ([dfb1ca5](https://github.com/nikunjmavani/core-be/commit/dfb1ca5daf270ce01ed0fa7b027e13eaffa9feb8))


### Documentation

* fix broken links to the organization-model doc and the collapsed worker guard ([#1138](https://github.com/nikunjmavani/core-be/issues/1138)) ([8f3f836](https://github.com/nikunjmavani/core-be/commit/8f3f8365238152fb1f16cf193708b263d516d007))

## [5.2.2](https://github.com/nikunjmavani/core-be/compare/v5.2.1...v5.2.2) (2026-08-11)


### Documentation

* add branch-naming guidance for AI web sessions ([#1043](https://github.com/nikunjmavani/core-be/issues/1043)) ([36240ee](https://github.com/nikunjmavani/core-be/commit/36240ee3d809dc3eba944661b8e691089bc716a7))

## [5.2.1](https://github.com/nikunjmavani/core-be/compare/v5.2.0...v5.2.1) (2026-08-10)


### Fixed

* **ci:** grant release-deploy's jobs the permissions their reusables need ([#1038](https://github.com/nikunjmavani/core-be/issues/1038)) ([dc4c479](https://github.com/nikunjmavani/core-be/commit/dc4c479561b383acec75501ccbc1ed16b1cf8188))
* **tooling:** stop the test summary reporting a failing run as exit=0 ([#1039](https://github.com/nikunjmavani/core-be/issues/1039)) ([758702a](https://github.com/nikunjmavani/core-be/commit/758702a9079152cfd241f3faae829b40c7fd96a7))

## [5.2.0](https://github.com/nikunjmavani/core-be/compare/v5.1.0...v5.2.0) (2026-08-10)


### Added

* **tooling:** generate full project identity and add template adoption flow ([#1025](https://github.com/nikunjmavani/core-be/issues/1025)) ([3f34497](https://github.com/nikunjmavani/core-be/commit/3f34497d09c1635727e3bb6de8a3990235486b18))


### Fixed

* **ci:** enforce the identity gate on PRs, not only post-merge ([#1037](https://github.com/nikunjmavani/core-be/issues/1037)) ([4fad0f0](https://github.com/nikunjmavani/core-be/commit/4fad0f04376d5868332e72ba3fd0c05893daa037))
* **db-viewer:** clear the lint failures blocking the tooling lane ([#1033](https://github.com/nikunjmavani/core-be/issues/1033)) ([0f5d681](https://github.com/nikunjmavani/core-be/commit/0f5d681fa74d21c94b36e3f4e15f1b7581a3e519))
* idempotent personal-org provisioning + Sentry 4xx capture policy ([#1026](https://github.com/nikunjmavani/core-be/issues/1026)) ([3021846](https://github.com/nikunjmavani/core-be/commit/302184691f5678a91e94615d833c2453fc5b150d))
* **test:** repair the broken fast test lane + close Sentry/OAuth coverage gaps ([#1029](https://github.com/nikunjmavani/core-be/issues/1029)) ([0a5bffb](https://github.com/nikunjmavani/core-be/commit/0a5bffb025d8ec527ded62fc18ffac7d0e2e5ec4))
* **tooling:** stop the identity gate reading developer-private config ([#1035](https://github.com/nikunjmavani/core-be/issues/1035)) ([dd74a2e](https://github.com/nikunjmavani/core-be/commit/dd74a2e360e88a94d74e43b01f237e73191f27ea))


### Dependencies

* **ioredis:** upgraded 5.10.1 → 6.0.0 ([#1034](https://github.com/nikunjmavani/core-be/issues/1034)) ([2a10bc4](https://github.com/nikunjmavani/core-be/commit/2a10bc47)). ioredis 6 changes its default RESP wire protocol from 2 to 3; this project pins it back to **RESP2** (`REDIS_PROTOCOL_VERSION`) on every connection, including all BullMQ queues and workers, because BullMQ declares no RESP3 support. Redis behaviour is therefore unchanged by this release.
* bumped 15 packages in the non-major group, including fastify 5.11.0 → 5.11.2, bullmq 6.0.5 → 6.0.9 and jose 6.2.7 → 6.2.8 ([#1031](https://github.com/nikunjmavani/core-be/issues/1031)) ([530bd4d](https://github.com/nikunjmavani/core-be/commit/530bd4d1f158e9b6f5b26effb57e5e8f22b6607a))


### Documentation

* **github:** restructure the PR template and align it with the paired repo ([#1027](https://github.com/nikunjmavani/core-be/issues/1027)) ([4bac5e8](https://github.com/nikunjmavani/core-be/commit/4bac5e83b1bc8da18b3628f522696014c22fe9e7))

## [5.1.0](https://github.com/nikunjmavani/core-be/compare/v5.0.0...v5.1.0) (2026-08-05)


### Added

* **tooling:** add local DB Viewer (db-viewer) ([#1022](https://github.com/nikunjmavani/core-be/issues/1022)) ([8a238a4](https://github.com/nikunjmavani/core-be/commit/8a238a4000f2fe77de7659e93370fc4139d1beb8))


### Fixed

* **deps:** raise hono/fast-uri/undici override floors for new advisories ([#1021](https://github.com/nikunjmavani/core-be/issues/1021)) ([9904a61](https://github.com/nikunjmavani/core-be/commit/9904a619abda30ad253f04ee964a8ca029b42122))
* **infra:** dead_letter payload_summary default + safe env-default stringify ([#1023](https://github.com/nikunjmavani/core-be/issues/1023)) ([f2d645a](https://github.com/nikunjmavani/core-be/commit/f2d645aee4fe423e81bc1fc6b218f97393ec3190))
* **test:** give unit beforeAll cold imports more hook headroom ([#1016](https://github.com/nikunjmavani/core-be/issues/1016)) ([61800d9](https://github.com/nikunjmavani/core-be/commit/61800d908ffec44949ff46c47e79f70017b373e4))

## [5.0.0](https://github.com/nikunjmavani/core-be/compare/v4.10.5...v5.0.0) (2026-08-01)


### ⚠ BREAKING CHANGES

* **notify:** replace the PUSH notification channel with WEB_PUSH ([#971](https://github.com/nikunjmavani/core-be/issues/971))

### Added

* **agent-os:** harden agent-guard enforcement — REVIEW.md, cross-platform hooks, Tier-4 guard evals ([#905](https://github.com/nikunjmavani/core-be/issues/905)) ([a5f9b6e](https://github.com/nikunjmavani/core-be/commit/a5f9b6ed7627424e5f5833507eb8179bd18160fc))
* **agent-os:** relocate claude plugin into agent-os, single-source app wiring, add i18n-auditor ([#907](https://github.com/nikunjmavani/core-be/issues/907)) ([e5de060](https://github.com/nikunjmavani/core-be/commit/e5de060992bc2e023a618b7e18111735c51faad1))
* **auth:** email verification-code as a bootstrap-only step-up factor ([#965](https://github.com/nikunjmavani/core-be/issues/965)) ([e781989](https://github.com/nikunjmavani/core-be/commit/e7819898a9d4f27760023d291a7d16c5f76cd08c))
* **ci:** repo-owned Railway deploy tool + env validation — CI independent of core-infra ([#947](https://github.com/nikunjmavani/core-be/issues/947)) ([158ff26](https://github.com/nikunjmavani/core-be/commit/158ff261fe197fb92e9b302c33b1926e51ed4ed3))
* **config:** add Category-L (local-only) env flags, rejected outside NODE_ENV=local ([#914](https://github.com/nikunjmavani/core-be/issues/914)) ([a777488](https://github.com/nikunjmavani/core-be/commit/a7774882e46ee3e807974b75739930ef62a072bf))
* **config:** allow `local` as a valid NODE_ENV value ([#912](https://github.com/nikunjmavani/core-be/issues/912)) ([2277756](https://github.com/nikunjmavani/core-be/commit/227775629f26dc4200f2829adf1ac6bc58ad21c0))
* **config:** force BLOCK_DISPOSABLE_EMAIL on in production; require prod-strict for security flags ([#911](https://github.com/nikunjmavani/core-be/issues/911)) ([21ed737](https://github.com/nikunjmavani/core-be/commit/21ed737dd6faf239ab5bef1b099564bd2fd4227c))
* **drift:** periodic drift nets — cited-path gate, main canary, settings check, monthly audit ([#925](https://github.com/nikunjmavani/core-be/issues/925)) ([50b5ecc](https://github.com/nikunjmavani/core-be/commit/50b5ecc499351e5ae768415c87a879c3bd2fff20))
* **env:** explicit env-var registry (allowed values + description, Zod derived) + catalog ([#987](https://github.com/nikunjmavani/core-be/issues/987)) ([a73d8ca](https://github.com/nikunjmavani/core-be/commit/a73d8ca82ee902ead43bd3a848bd31acbe051fd6))
* **github-sync:** apply environment protection from committed JSON ([#937](https://github.com/nikunjmavani/core-be/issues/937)) ([89861b6](https://github.com/nikunjmavani/core-be/commit/89861b6353e3f643f8a7be6dab73f9f1aadf0117))
* **github-sync:** skip+prune schema-default vars, paginate remote fetch, add --diff preview ([#984](https://github.com/nikunjmavani/core-be/issues/984)) ([aeb5616](https://github.com/nikunjmavani/core-be/commit/aeb56162e9a3b9f6e7dbe587bf72dcca40224fd3))
* **notify:** canonical NOTIFICATION_TYPES vocabulary + edge validation ([#964](https://github.com/nikunjmavani/core-be/issues/964)) ([2368238](https://github.com/nikunjmavani/core-be/commit/23682383c2b471a1d6d0a6a2e31cdc1143e4a4e1))
* **notify:** notify org managers when an invitation is accepted ([#967](https://github.com/nikunjmavani/core-be/issues/967)) ([556cee8](https://github.com/nikunjmavani/core-be/commit/556cee80c383979ace04cf3ac2b547a9ccebf622))
* **notify:** replace the PUSH notification channel with WEB_PUSH ([#971](https://github.com/nikunjmavani/core-be/issues/971)) ([0242acb](https://github.com/nikunjmavani/core-be/commit/0242acbadc03027b8379eda7b00c6108b17ef00f))
* **setup:** auto-install/upgrade external tools on macOS in setup:local ([#940](https://github.com/nikunjmavani/core-be/issues/940)) ([b301241](https://github.com/nikunjmavani/core-be/commit/b301241e70a461b45744eea201329a43eabcde80))
* **storage:** wire S3_ENDPOINT / S3_FORCE_PATH_STYLE for S3-compatible endpoints ([#974](https://github.com/nikunjmavani/core-be/issues/974)) ([bed9b76](https://github.com/nikunjmavani/core-be/commit/bed9b76de199d68178e1c89b92399b5b4b572c81))
* **tenancy:** add member_count to organization role responses ([#979](https://github.com/nikunjmavani/core-be/issues/979)) ([903f3cc](https://github.com/nikunjmavani/core-be/commit/903f3cce1b104fcda8191b4ec33944473bb0fd87))
* **tenancy:** allow atomic role creation with an initial permission set ([#961](https://github.com/nikunjmavani/core-be/issues/961)) ([97415e1](https://github.com/nikunjmavani/core-be/commit/97415e1fa0983e0675d82e4d897571a4828049a6))
* **tenancy:** cap pending member invitations per organization ([#972](https://github.com/nikunjmavani/core-be/issues/972)) ([4418691](https://github.com/nikunjmavani/core-be/commit/44186918742670a741bc1d7254d1a3f3bc59fcbf))
* **tenancy:** seed default Admin/Member/Viewer roles on TEAM org provisioning ([#960](https://github.com/nikunjmavani/core-be/issues/960)) ([a01ba26](https://github.com/nikunjmavani/core-be/commit/a01ba26603ea15307d49c5cff375f36022fd331c))
* **user:** onboarding_completed flag — unify onboarding across deployment modes ([#906](https://github.com/nikunjmavani/core-be/issues/906)) ([8d1cab3](https://github.com/nikunjmavani/core-be/commit/8d1cab3092ad6922aaca917993209e589f32ae62))


### Fixed

* audit findings — i18n middleware bug, hardening, doc/tooling sync ([#954](https://github.com/nikunjmavani/core-be/issues/954)) ([bdfa76a](https://github.com/nikunjmavani/core-be/commit/bdfa76a762b22f6cf0e8921e30d2c3e5e5a5aa16))
* **auth:** guarantee a personal org in the login token on the non-pinned paths ([#963](https://github.com/nikunjmavani/core-be/issues/963)) ([953dd02](https://github.com/nikunjmavani/core-be/commit/953dd02b4717853d220e1e5f03ec0d5d5b590688))
* **auth:** tag disposable-email rejections with a stable reason; deflake security tests ([#910](https://github.com/nikunjmavani/core-be/issues/910)) ([d6f97a5](https://github.com/nikunjmavani/core-be/commit/d6f97a505d877da600f22cd4bad2384734c8ad64))
* **billing:** serialize concurrent subscription creates (B4) + correct mutable-state docs (B2) ([#918](https://github.com/nikunjmavani/core-be/issues/918)) ([b56fc35](https://github.com/nikunjmavani/core-be/commit/b56fc3556ab3bedb850a54846cf70109e7b33006))
* **ci:** seed reference data on Railway deploy + drop dead target_branch input ([#957](https://github.com/nikunjmavani/core-be/issues/957)) ([6da44de](https://github.com/nikunjmavani/core-be/commit/6da44de9c2ab09fb6780a03f20222be28df691c5))
* **deploy:** production env uses protectedBranches (Model A) — resolves [#924](https://github.com/nikunjmavani/core-be/issues/924), [#877](https://github.com/nikunjmavani/core-be/issues/877) ([#938](https://github.com/nikunjmavani/core-be/issues/938)) ([e76a76c](https://github.com/nikunjmavani/core-be/commit/e76a76c90605eb1d366c7f5c8c23d9fbced4a849))
* **deps:** override find-my-way &gt;=9.6.1 to patch HTTP/2 DDoS advisory ([#1000](https://github.com/nikunjmavani/core-be/issues/1000)) ([fda7805](https://github.com/nikunjmavani/core-be/commit/fda780534ddab701ce92f97daebf78e61aaf4f49))
* **deps:** patch 3 new advisories (brace-expansion, js-yaml, body-parser) ([#990](https://github.com/nikunjmavani/core-be/issues/990)) ([41383f1](https://github.com/nikunjmavani/core-be/commit/41383f1655757ef8084426573be1b22ad936d071))
* **errors:** resolve error detail via i18next singleton so raw keys never leak ([#909](https://github.com/nikunjmavani/core-be/issues/909)) ([0f791aa](https://github.com/nikunjmavani/core-be/commit/0f791aa290d43a51e305568ce133736e78fcefa0))
* **github-sync:** a blank local value must not delete the live remote secret ([#953](https://github.com/nikunjmavani/core-be/issues/953)) ([3795134](https://github.com/nikunjmavani/core-be/commit/3795134789a7c49c05321e311a79774f582c0f1a))
* **i18n:** add missing error keys, remove dead ones, and gate code→JSON key existence ([#955](https://github.com/nikunjmavani/core-be/issues/955)) ([9cc2eea](https://github.com/nikunjmavani/core-be/commit/9cc2eea4b366b71ea2cdffe7f3d9047ec2297436))
* **lint:** resolve Biome errors in dashboards/hub.html ([#930](https://github.com/nikunjmavani/core-be/issues/930)) ([5277c68](https://github.com/nikunjmavani/core-be/commit/5277c686c921865ef7c3f0fc33cae4fdbf37da16))
* **logging:** replace deprecated disableRequestLogging with LogController (FSTDEP023) ([#995](https://github.com/nikunjmavani/core-be/issues/995)) ([dcf8bbf](https://github.com/nikunjmavani/core-be/commit/dcf8bbfd35bd77364276e4bf9a1868d331b635dc))
* **migrate:** fail fast on bad/unreachable DB URL + actionable connection hints ([#988](https://github.com/nikunjmavani/core-be/issues/988)) ([3737717](https://github.com/nikunjmavani/core-be/commit/37377174e8f0c75d18b091c2670b9514f4c34076))
* **platform:** parity sweep — dependabot post-merge CI, codegraph ignore, hooks/vscode/docs polish ([#908](https://github.com/nikunjmavani/core-be/issues/908)) ([6e3288b](https://github.com/nikunjmavani/core-be/commit/6e3288b709a250760f337e9ccc4a57c20c5c8ab9))
* seat-sync mis-billing + auth timing/step-up hardening (from code review) ([#999](https://github.com/nikunjmavani/core-be/issues/999)) ([cb63044](https://github.com/nikunjmavani/core-be/commit/cb6304496e6036286a3b79e416b95de160397c88))
* **security:** CAPTCHA_PROVIDER=disabled turns captcha off on its own ([#980](https://github.com/nikunjmavani/core-be/issues/980)) ([68ebf51](https://github.com/nikunjmavani/core-be/commit/68ebf516b90ff70578b8b8e69c209b0696f5a97a))
* **security:** fail-closed field-secret decryption (drop plaintext passthrough) ([#920](https://github.com/nikunjmavani/core-be/issues/920)) ([d8dd932](https://github.com/nikunjmavani/core-be/commit/d8dd932fba40f3126d7d0c2605d9b7e8d16f6595))
* **security:** resolve confirmed pre-launch review findings (H1, T0/T1/T3, T2, M1, M2, W1, W2, L1) ([#915](https://github.com/nikunjmavani/core-be/issues/915)) ([17ffecb](https://github.com/nikunjmavani/core-be/commit/17ffecbfa878aaee7db032b65a41f2273df84c76))
* **seed:** guard full-seed CLI so importing runFullSeed is side-effect-free ([#969](https://github.com/nikunjmavani/core-be/issues/969)) ([ce0fc42](https://github.com/nikunjmavani/core-be/commit/ce0fc42337faa9f53ddbe0782563eb905cc7f3f1))
* **seed:** mint tenancy seed public_ids with each row's own entity prefix ([#959](https://github.com/nikunjmavani/core-be/issues/959)) ([e8a0453](https://github.com/nikunjmavani/core-be/commit/e8a045372fcb0a8b1c5fdaf45295ce57cc426842))
* **seed:** stamp onboarding_completed_at on the demo admin + allow Vite origin ([#958](https://github.com/nikunjmavani/core-be/issues/958)) ([b316793](https://github.com/nikunjmavani/core-be/commit/b31679335154a429b111a9853e75a3f1d91ed4d0))
* **tenancy:** invitation email links to the frontend accept page, not the API route ([#966](https://github.com/nikunjmavani/core-be/issues/966)) ([a1d77cc](https://github.com/nikunjmavani/core-be/commit/a1d77cc4dd9c692afdabe19766b1882b5205a78e))
* **tenancy:** provision organizations under the new org's RLS context, not global-admin ([#998](https://github.com/nikunjmavani/core-be/issues/998)) ([c28dc6b](https://github.com/nikunjmavani/core-be/commit/c28dc6b9663c486b1a2fbdc57647c9987588d07f))
* **test:** repair validate:test-api-prefix drift red on main ([#935](https://github.com/nikunjmavani/core-be/issues/935)) ([652054c](https://github.com/nikunjmavani/core-be/commit/652054cac7c425fc10e4cbad26953a13ee9d0ce3))
* **test:** stabilize flaky unit timeouts under parallel forks ([#1008](https://github.com/nikunjmavani/core-be/issues/1008)) ([2526ce8](https://github.com/nikunjmavani/core-be/commit/2526ce80c5470be19a75cf1693c232aec6cd3fbd))
* **tooling:** hold 5 min per abuse-limit error in github:sync so a run rides out the penalty ([#997](https://github.com/nikunjmavani/core-be/issues/997)) ([1c5724c](https://github.com/nikunjmavani/core-be/commit/1c5724c1afc9e3ac2de56155d8b73d24aead0812))
* **tooling:** jitter github:sync write spacing to dodge GitHub's secondary rate limit ([#996](https://github.com/nikunjmavani/core-be/issues/996)) ([c3c59b3](https://github.com/nikunjmavani/core-be/commit/c3c59b340692897311c283b6b2198e92552aab1f))
* **tooling:** make Stryker mutation testing work on TypeScript 7 ([#1001](https://github.com/nikunjmavani/core-be/issues/1001)) ([db7f8ac](https://github.com/nikunjmavani/core-be/commit/db7f8ac39ec9b8fb65ecf438dafd6d519fe0f750))


### Changed

* **auth:** single-key RS256 JWT — remove keyring, legacy fallback, and rotation tool ([#921](https://github.com/nikunjmavani/core-be/issues/921)) ([6f08117](https://github.com/nikunjmavani/core-be/commit/6f0811731f7d35d4c1fbd481b64674cf642b607a))
* **config:** default NODE_ENV to local (a fresh clone sets up as local) ([#926](https://github.com/nikunjmavani/core-be/issues/926)) ([362efda](https://github.com/nikunjmavani/core-be/commit/362efdafa8def2c9229c9472db4ce80a7c9a145a))
* **config:** drop unused Category-L env flags + dead GIT_COMMIT_SHA fallback ([#927](https://github.com/nikunjmavani/core-be/issues/927)) ([40d9ab2](https://github.com/nikunjmavani/core-be/commit/40d9ab2806a634755c1c7f9fc46a79ae535c99d1))
* **config:** one env flag per thing — wipe gates on TEST_MODE alone + documented principles ([#932](https://github.com/nikunjmavani/core-be/issues/932)) ([7d9fa28](https://github.com/nikunjmavani/core-be/commit/7d9fa2832168a30c3e1575b6bde4d9ab11e0a2d2))
* **setup:** fold envs:sync:github into github:sync + propagate session changes to docs/skills/tests ([#951](https://github.com/nikunjmavani/core-be/issues/951)) ([3d34dd8](https://github.com/nikunjmavani/core-be/commit/3d34dd8037cc6a37628d74193b9b8b14b3c2b38d))
* **test-env:** TEST_MODE gate, test-var consolidation, passwordless-signup load test ([#929](https://github.com/nikunjmavani/core-be/issues/929)) ([f378769](https://github.com/nikunjmavani/core-be/commit/f378769a3b16d6cb93ed6ace3a0d79e1e633f337))
* **user:** drop the capabilities object from /users/me ([#956](https://github.com/nikunjmavani/core-be/issues/956)) ([941f075](https://github.com/nikunjmavani/core-be/commit/941f0755e6e2bba4b72a95386ce71a0e4aeee7ea))


### Documentation

* **agent-os:** always-applied skill-router rule + repeatable codebase-audit-loop (core-fe Tier 2) ([#899](https://github.com/nikunjmavani/core-be/issues/899)) ([e5710d3](https://github.com/nikunjmavani/core-be/commit/e5710d3807ff77095e8fabc524aac3b9690f9c2c))
* **agent-os:** authoritative agent-behavior rule — full completion, one checkpoint (core-fe audit [#6](https://github.com/nikunjmavani/core-be/issues/6)) ([#903](https://github.com/nikunjmavani/core-be/issues/903)) ([9702845](https://github.com/nikunjmavani/core-be/commit/9702845d0fba6945ef6c26531f0cc9b2a7a407ab))
* **core-infra:** frame extracted provisioning commands across all remaining docs ([#943](https://github.com/nikunjmavani/core-be/issues/943)) ([4085c8f](https://github.com/nikunjmavani/core-be/commit/4085c8f199089a5c17fd336d1c3edb9406b7e3b5))
* **core-infra:** frame validate:github-environments in .github/environments/README ([#946](https://github.com/nikunjmavani/core-be/issues/946)) ([cf8f1a1](https://github.com/nikunjmavani/core-be/commit/cf8f1a1037b27f6ee21795952c3c9b12832daf4e))
* fix 11 doc-vs-code drift items from deep audit ([#904](https://github.com/nikunjmavani/core-be/issues/904)) ([c9d16c5](https://github.com/nikunjmavani/core-be/commit/c9d16c53d0a5cb89c3115ba63318ec68603d4457))
* **overviews:** add the 7 missing nested sub-domain overview docs ([#945](https://github.com/nikunjmavani/core-be/issues/945)) ([ffbba17](https://github.com/nikunjmavani/core-be/commit/ffbba17ec42193ec04e2a6c24509dd0d069e5ca6))
* purge all external-provisioning references — core-be documents only itself ([#949](https://github.com/nikunjmavani/core-be/issues/949)) ([4625262](https://github.com/nikunjmavani/core-be/commit/46252628535d4b75da27831e2ab7172003b6c61c))
* **runbook:** document DATABASE_URL runtime-role RLS-safety requirement ([#992](https://github.com/nikunjmavani/core-be/issues/992)) ([fd81082](https://github.com/nikunjmavani/core-be/commit/fd810829f8dd3e656dbad16f90b0e3f178f2740b))
* **security:** reconcile authz review + testing-plan with the real route model ([#975](https://github.com/nikunjmavani/core-be/issues/975)) ([5a920bc](https://github.com/nikunjmavani/core-be/commit/5a920bc630886bb73374ece970c6a16806d29147))
* **structure:** regenerate src-structure-tree (fixes [#991](https://github.com/nikunjmavani/core-be/issues/991) canary drift) ([#993](https://github.com/nikunjmavani/core-be/issues/993)) ([0c9b3b1](https://github.com/nikunjmavani/core-be/commit/0c9b3b12514e59eca2a19148c054a58af29fe6bb))
* **tenancy:** clarify inviting a member is POST /memberships, not a phantom invitations resource ([#962](https://github.com/nikunjmavani/core-be/issues/962)) ([426d0f5](https://github.com/nikunjmavani/core-be/commit/426d0f592bc6d0970a08ef910039f3229472c78c))
* **tenancy:** fix phantom POST /organization/invitations in the team-only route docs ([#970](https://github.com/nikunjmavani/core-be/issues/970)) ([b6b0ebc](https://github.com/nikunjmavani/core-be/commit/b6b0ebcb13cdb04f169355b502b2811e5e860163))

## [4.10.5](https://github.com/nikunjmavani/core-be/compare/v4.10.4...v4.10.5) (2026-07-09)


### Documentation

* **CLAUDE:** fix structural drift — domain table, infra tree, commands, testing (Cluster D) ([#891](https://github.com/nikunjmavani/core-be/issues/891)) ([c0f34cc](https://github.com/nikunjmavani/core-be/commit/c0f34cc27875ccefe27301f10ecd644e71d0d95d))
* mark billing→notification event flow as planned/not-implemented (Cluster E) ([#892](https://github.com/nikunjmavani/core-be/issues/892)) ([3343803](https://github.com/nikunjmavani/core-be/commit/33438031984bb60ab121635c8362e8f54f673274))
* seat_limit_reached + 503 in response-codes; index 3 missing docs (Cluster G) ([#894](https://github.com/nikunjmavani/core-be/issues/894)) ([c959266](https://github.com/nikunjmavani/core-be/commit/c959266f9d20d74236e9ce3e29fc2d159b154ef3))
* **skills:** fix idempotency route table, SonarQube step ref, skill-index trigger (Cluster F) ([#893](https://github.com/nikunjmavani/core-be/issues/893)) ([a1fda2d](https://github.com/nikunjmavani/core-be/commit/a1fda2d653a5214bc58b7e5da1d17726aa9534d8))
* strip the dead billing-event concept entirely (not "planned") ([#895](https://github.com/nikunjmavani/core-be/issues/895)) ([f0ca473](https://github.com/nikunjmavani/core-be/commit/f0ca4732c796bc270f7ffe3c4d5fc8e9bb7eca92))
* sync narrative docs to code (final verification pass) ([#896](https://github.com/nikunjmavani/core-be/issues/896)) ([767904b](https://github.com/nikunjmavani/core-be/commit/767904bc04db6aa9dd554f044366b2cb30304ed7))
* sync stale counts + pnpm version (Cluster C) ([#889](https://github.com/nikunjmavani/core-be/issues/889)) ([5283b12](https://github.com/nikunjmavani/core-be/commit/5283b12271f6df167671c29b6f157ce722e7e22d))

## [4.10.4](https://github.com/nikunjmavani/core-be/compare/v4.10.3...v4.10.4) (2026-07-08)


### Documentation

* correct validator/serializer unit-test filename convention (Cluster B) ([#887](https://github.com/nikunjmavani/core-be/issues/887)) ([da65939](https://github.com/nikunjmavani/core-be/commit/da659390ffdca2e1735c8850282cedd17201c0ba))

## [4.10.3](https://github.com/nikunjmavani/core-be/compare/v4.10.2...v4.10.3) (2026-07-08)


### Documentation

* align event-test-location docs with enforced layout (Cluster A) ([#885](https://github.com/nikunjmavani/core-be/issues/885)) ([893c16d](https://github.com/nikunjmavani/core-be/commit/893c16d127b3627b6b501c1cfe069dc106c5ade6))

## [4.10.2](https://github.com/nikunjmavani/core-be/compare/v4.10.1...v4.10.2) (2026-07-07)


### Changed

* **setup:** drop per-environment branch; source trunk from git.defaultBranch ([#881](https://github.com/nikunjmavani/core-be/issues/881)) ([a291e61](https://github.com/nikunjmavani/core-be/commit/a291e61db202e303b8553067ed476923afc6439f))

## [4.10.1](https://github.com/nikunjmavani/core-be/compare/v4.10.0...v4.10.1) (2026-07-07)


### Documentation

* **process:** single-trunk docs + hotfix runbook + release/* ruleset ([1ffe7d7](https://github.com/nikunjmavani/core-be/commit/1ffe7d749842237b3eb8a5e0787e8359a3037508))

## [4.10.0](https://github.com/nikunjmavani/core-be/compare/v4.8.1...v4.10.0) (2026-07-07)


### Added

* **tenancy:** server-side sort of org memberships list by member name ([ead8d6c](https://github.com/nikunjmavani/core-be/commit/ead8d6c248409569cd63a4c79ca56dc743d417e5))
* **tenancy:** server-side sort of org memberships list by member name ([6e679bf](https://github.com/nikunjmavani/core-be/commit/6e679bf91bf0b8c46c91c8e1f1a61d82cc938e3a))
* **user:** add job_title to user profile update ([d916eb7](https://github.com/nikunjmavani/core-be/commit/d916eb7381d9a910275ae98cbf8ae56be6c7c0ba))
* **user:** add job_title to user profile update ([739b109](https://github.com/nikunjmavani/core-be/commit/739b1099c845719a703a21e1beccc1a78da262c5))


### Fixed

* **ci:** relax hardened boot-safety flags in the docker smoke boot ([2fc586f](https://github.com/nikunjmavani/core-be/commit/2fc586f13b06f81af25964077c23f9f75e200a7b))
* **ci:** relax hardened boot-safety flags in the docker smoke boot ([894f247](https://github.com/nikunjmavani/core-be/commit/894f247ef7df295226878e5044f2ae1556e9f8bb))
* **config:** point development frontend + CORS origins at deployed Netlify FE ([be1da34](https://github.com/nikunjmavani/core-be/commit/be1da3437f4505a79632a39db3a9768aaf797b8c))
* **config:** point development frontend + CORS origins at deployed Netlify FE ([8e451d7](https://github.com/nikunjmavani/core-be/commit/8e451d7290c87b76f7a1c731f9dc30c45e99809e))
* **cors:** allow X-Requested-With in preflight to restore silent auth refresh ([39edab8](https://github.com/nikunjmavani/core-be/commit/39edab831072a827fb35c5a865d027876cbfffec))
* **cors:** allow X-Requested-With in preflight to restore silent auth refresh ([2eb29a0](https://github.com/nikunjmavani/core-be/commit/2eb29a0638fbc9cc192c743dfd932fb06245d5d0))
* **cors:** wrap cors middleware in fastify-plugin so actual responses carry CORS headers ([b744877](https://github.com/nikunjmavani/core-be/commit/b74487750e2a8ff02419be9573bdf78dc4920238))
* **cors:** wrap cors middleware in fastify-plugin so actual responses carry CORS headers ([0b049ce](https://github.com/nikunjmavani/core-be/commit/0b049ce250cf781f299aa7ec13f69695cdcfa3b8))
* **sonar:** clear pre-existing quality-gate findings on the deployed surface ([8641ea2](https://github.com/nikunjmavani/core-be/commit/8641ea24b719d35c5ba03e3755761a83c7c22d85))
* **tenancy:** make personal-org self-heal read-safe + seed permissions in e2e ([#867](https://github.com/nikunjmavani/core-be/issues/867)) ([8749a90](https://github.com/nikunjmavani/core-be/commit/8749a901c9ba011512eb5ffd030c728685680f1c))
* **tenancy:** self-heal missing personal organization on read ([#865](https://github.com/nikunjmavani/core-be/issues/865)) ([ceb81a4](https://github.com/nikunjmavani/core-be/commit/ceb81a4ce56ab78123dc192d714f38cd81bda183))


### Changed

* **config:** drive all env behavior via flags; NODE_ENV=development|production only ([00d77f6](https://github.com/nikunjmavani/core-be/commit/00d77f6588828563b0c14807445e392f14864f4d))
* **config:** drive all env behavior via flags; NODE_ENV=development|production only ([9de0a67](https://github.com/nikunjmavani/core-be/commit/9de0a678666aac4129a67ea2ae04c9e4642e48e2))


### Documentation

* **process:** add languages to plan fenced blocks; gitignore SESSION.md ([893b84d](https://github.com/nikunjmavani/core-be/commit/893b84dc0259136599badf17d5fdc314ebcea6a6))


### Chores

* set release baseline to 4.10.0 ([4de716e](https://github.com/nikunjmavani/core-be/commit/4de716e04392038226a040ba4ed10d6cdb22c29b))

## [4.8.1](https://github.com/nikunjmavani/core-be/compare/v4.8.0...v4.8.1) (2026-07-03)


### Fixed

* **ci:** call core-infra's validate:github-environments in Railway deploy ([26696f1](https://github.com/nikunjmavani/core-be/commit/26696f13d60e782eb3affad48d1232bc135fe343))
* **ci:** correct core-infra validate script name in Railway deploy ([cab27b2](https://github.com/nikunjmavani/core-be/commit/cab27b26b81db286fff1bccb9c3109a8353b9781))

## [4.8.0](https://github.com/nikunjmavani/core-be/compare/v4.7.1...v4.8.0) (2026-07-03)


### Added

* **agent-os:** add stack-monitor sub-agent for data-driven stack monitoring ([#787](https://github.com/nikunjmavani/core-be/issues/787)) ([0d62e6d](https://github.com/nikunjmavani/core-be/commit/0d62e6d38c7b75d0942292b952322a4d84c075d9))
* **agent-os:** centralize cloud agent environment config ([d78c20f](https://github.com/nikunjmavani/core-be/commit/d78c20fa4f45560e8c114a58f918fe6592ee6c85))
* **agent-os:** centralize cloud agent environment config ([9126a9b](https://github.com/nikunjmavani/core-be/commit/9126a9bdd3fb262657f60c54c11b2fe97a96f1d5))
* **auth,tenancy:** claim invited account on signup + verified-email accept gate ([3803076](https://github.com/nikunjmavani/core-be/commit/38030763ad88db57db6dbc5c32989aab5493fded))
* **auth,tenancy:** switch endpoints return active-org delta; accept returns organization_id ([#789](https://github.com/nikunjmavani/core-be/issues/789)) ([75e3c69](https://github.com/nikunjmavani/core-be/commit/75e3c699732e20ccd9410e1f844886130ef59a76))
* **auth:** add email OTP primitive (6-digit code generation + scoped consume) ([df747c2](https://github.com/nikunjmavani/core-be/commit/df747c20e329b0c8675c0642d45938e73f85ebf9))
* **auth:** add POST /auth/signup (email/password signup with auto-login) ([0c32fb2](https://github.com/nikunjmavani/core-be/commit/0c32fb2f6b70eae69a4caf01d4460590a30c6b88))
* **auth:** audit MFA outcomes, recovery-code use, API-key lifecycle, org-switch, passkey register, reset ([9a5a3a4](https://github.com/nikunjmavani/core-be/commit/9a5a3a495078e1a170914d273ec355005edb861a))
* **auth:** auto-login after password reset (MFA-safe) + document invite-squatting risk ([22d1ce5](https://github.com/nikunjmavani/core-be/commit/22d1ce50b78dc48c21d8e059ce6e1db0b82bdd28))
* **auth:** email verification via 6-digit OTP (replaces the token link) ([e3939a1](https://github.com/nikunjmavani/core-be/commit/e3939a109a3c6c70c9329a539b191ce92c1ac506))
* **auth:** magic-link via 6-digit OTP + auto-signup ([52f87f7](https://github.com/nikunjmavani/core-be/commit/52f87f7624781c4437488d0b1768ec33d3c61249))
* **auth:** OTP login + signup, invitation onboarding, and auth security hardening ([b4faba6](https://github.com/nikunjmavani/core-be/commit/b4faba64d8c3d5710f6d89d542a7cfaf81f928f2))
* **auth:** passkey list + revoke management API (audit R5b / M3) ([8b7e491](https://github.com/nikunjmavani/core-be/commit/8b7e491d8961bf02f7ffb9b8f8a155488cd07fc9))
* **auth:** passkey list + revoke management API (audit R5b / M3) ([effa387](https://github.com/nikunjmavani/core-be/commit/effa387671e352bfe64bb02f8beeb7d5c9d1bc0b))
* **auth:** replace magic-link with email verification-code login ([#814](https://github.com/nikunjmavani/core-be/issues/814)) ([cce59f3](https://github.com/nikunjmavani/core-be/commit/cce59f3e77befd181dc9dda45227cbc94e9b378b))
* **billing:** auto-suspend excess members on over-cap downgrade (F2) ([9877d24](https://github.com/nikunjmavani/core-be/commit/9877d24b545677aa404964812a1c6320d7ff20b4))
* **billing:** auto-suspend excess members on over-cap downgrade (F2) ([f3496d5](https://github.com/nikunjmavani/core-be/commit/f3496d5a5e243da3974390424f702dd4c61deeee))
* **billing:** entitlement seat-ceiling — Free-tier cap for unsubscribed + dunning grace (F3/F4) ([8092bd0](https://github.com/nikunjmavani/core-be/commit/8092bd03d0c3bc2914d492ece991bb1293578ccb))
* **billing:** entitlement seat-ceiling — Free-tier cap for unsubscribed + dunning grace (F3/F4) ([1b808eb](https://github.com/nikunjmavani/core-be/commit/1b808eb590e7addad983e6ce37d675236b5d0329))
* **billing:** paginate invoices via Stripe cursor (limit + starting_after + has_more) ([#824](https://github.com/nikunjmavani/core-be/issues/824)) ([761ca72](https://github.com/nikunjmavani/core-be/commit/761ca72f4427a73c1d6db3cfa3bb46c87ca8c204))
* common server-side search/sort for org list endpoints (roles, api-keys) ([#823](https://github.com/nikunjmavani/core-be/issues/823)) ([d097af7](https://github.com/nikunjmavani/core-be/commit/d097af7876998f3075f96cf8539f301335e4c3d2))
* **dev:** resizable + draggable dashboard panel grid (gridstack) ([#785](https://github.com/nikunjmavani/core-be/issues/785)) ([0b3b77c](https://github.com/nikunjmavani/core-be/commit/0b3b77c109a4780a649b390cc79cd9397178dc74))
* enrich sessions (device/browser/is_current), remove org capabilities object, add FE endpoint mapping doc ([c85015f](https://github.com/nikunjmavani/core-be/commit/c85015f983bdd1842767009a929260d7a725bdb8))
* membership management overhaul, billing seat model & API contract docs (REQ-1–7) ([#740](https://github.com/nikunjmavani/core-be/issues/740)) ([d6b3435](https://github.com/nikunjmavani/core-be/commit/d6b34355b46487a9776977a396b6cf664926dd29))
* **observability:** add PostHog analytics and sync env schema/config ([#815](https://github.com/nikunjmavani/core-be/issues/815)) ([7fca1b1](https://github.com/nikunjmavani/core-be/commit/7fca1b1a74296ae5b4c52d6f89911f2286c107da))
* **tenancy,billing:** personal-org billing guard + can_manage_billing capability ([#788](https://github.com/nikunjmavani/core-be/issues/788)) ([3f10347](https://github.com/nikunjmavani/core-be/commit/3f10347060cd60f8b49e4b09c10bec379c562ff0))
* **tenancy:** server-side member search (q over email/name) ([#825](https://github.com/nikunjmavani/core-be/issues/825)) ([9c56489](https://github.com/nikunjmavani/core-be/commit/9c5648982dcad45022d12f5a155c6d32e44de264))
* **tooling:** local dashboards control room (pnpm dashboards:*) ([a0ab8c9](https://github.com/nikunjmavani/core-be/commit/a0ab8c9812b1a4799c98ee2928534b39c1aa96b3))


### Fixed

* **agent-os:** harden cloud Docker bootstrap fallbacks ([#801](https://github.com/nikunjmavani/core-be/issues/801)) ([43b32b0](https://github.com/nikunjmavani/core-be/commit/43b32b0809a973935b87cfc11566954063e3ea15))
* **agent-os:** restrict stack monitor tools ([#798](https://github.com/nikunjmavani/core-be/issues/798)) ([7ed9ad4](https://github.com/nikunjmavani/core-be/commit/7ed9ad40c9c0e6b0bfbdc4a895549cd54057d63f))
* **api:** idempotency error responses emit the standard meta envelope + snake_case (audit api-contract-[#1](https://github.com/nikunjmavani/core-be/issues/1)) ([1502cc2](https://github.com/nikunjmavani/core-be/commit/1502cc2b5cc8338ad7149cd5cfdbb60dd777141e))
* **api:** idempotency error responses emit the standard meta envelope + snake_case (audit api-contract-[#1](https://github.com/nikunjmavani/core-be/issues/1)) ([a5f8a5f](https://github.com/nikunjmavani/core-be/commit/a5f8a5f65790c06a623161e535722c4528bb98e9))
* **audit:** emit audit rows under the matching RLS context so they aren't dropped (audit R10) ([1ff2f1f](https://github.com/nikunjmavani/core-be/commit/1ff2f1fde5d86cf271b33d5fc10a32ab47b8b7d4))
* **audit:** emit audit rows under the matching RLS context so they aren't dropped (audit R10) ([08de0d6](https://github.com/nikunjmavani/core-be/commit/08de0d649df35e7efad1d9c7f3cd2af34ffd7c61))
* **audit:** isolate audit-outbox poison rows with a per-row savepoint (audit R7 / M2) ([bc46135](https://github.com/nikunjmavani/core-be/commit/bc46135458eec93fbecf419d0d9d0fa2fe5f362b))
* **audit:** isolate audit-outbox poison rows with a per-row savepoint (audit R7 / M2) ([6600ebc](https://github.com/nikunjmavani/core-be/commit/6600ebc21367ac15e2f619acc4d974da8fdaaca9))
* **auth:** cap concurrent sessions per user with oldest-eviction on login ([c402ad7](https://github.com/nikunjmavani/core-be/commit/c402ad792b4dbfbfee5c31341aa436aefc41d8c7))
* **auth:** cap linked auth-methods + passkeys, trim error-log free-text, guard signup over-post ([638aed7](https://github.com/nikunjmavani/core-be/commit/638aed78f20a24e0ffe355b2df4ef025938d5fa9))
* **auth:** claim bare invited accounts via OAuth + reset OTP attempt cap on resend ([d81cb45](https://github.com/nikunjmavani/core-be/commit/d81cb450a390ee136bea1f616380d260a19cc5b5))
* **auth:** count passkeys when classifying a claimable bare account ([1256247](https://github.com/nikunjmavani/core-be/commit/12562478b4e47f5fde89246bc5ab1195b2481154))
* **auth:** enforce OTP/magic-link resend cooldown (wire the dead constant) ([eef15a9](https://github.com/nikunjmavani/core-be/commit/eef15a915513e5f06e433d2a0c64a79003b2f453))
* **auth:** hardening — turnstile hostname, dead-code removal, list caps (audit PR-8) ([324ced2](https://github.com/nikunjmavani/core-be/commit/324ced2c4fee7ad8433786f79575f8414564a763))
* **auth:** hardening — turnstile hostname, dead-code removal, list caps (audit PR-8) ([6554050](https://github.com/nikunjmavani/core-be/commit/65540507c81dc542f0bdac3b5744698307834335))
* **auth:** provision personal org after the OAuth signup commit (FK visibility) ([feda7a5](https://github.com/nikunjmavani/core-be/commit/feda7a5fb5e44aa52efc428eb4fad4a36cfbd67f))
* **auth:** provision personal org after the signup commit (FK visibility) ([6e0c626](https://github.com/nikunjmavani/core-be/commit/6e0c626af059d26bb9d45ca66de6f43ffb372e29))
* **auth:** provision personal org on first magic-link verification ([c051df5](https://github.com/nikunjmavani/core-be/commit/c051df5bfad9d397e6e1606807c50033b129e5e0))
* **auth:** re-derive super-admin with the same email-verified gate as minting ([907daf7](https://github.com/nikunjmavani/core-be/commit/907daf7fc8295e16afb37689c1126b93af981174))
* **auth:** require verified email before MFA/WebAuthn enrollment (account pre-hijacking) ([dba4577](https://github.com/nikunjmavani/core-be/commit/dba4577a6e8d23d15f9865c984770ec8ef35eed4))
* **auth:** require verified email before MFA/WebAuthn enrollment (account pre-hijacking) ([90c9bef](https://github.com/nikunjmavani/core-be/commit/90c9bef8089b37b4f82536d8bf4fc98657ce47df))
* **auth:** scope token consume by type + grant-guard reads fresh perms (audit R5a / L2+L3) ([63b78cb](https://github.com/nikunjmavani/core-be/commit/63b78cbc0c7282c7d55f0c6e3882e568a2c87174))
* **auth:** type-scoped token consume + grant-guard reads fresh perms (audit R5a / L2+L3) ([d41da79](https://github.com/nikunjmavani/core-be/commit/d41da791969108c848d1b16fc92dacc6eab4bb76))
* **auth:** verify email + clear failed-login lockout on password reset ([77d1594](https://github.com/nikunjmavani/core-be/commit/77d15949dc0a87292d6ac2111a39958694a91757))
* **billing:** enforce seats on member reactivation + over-cap downgrade (audit F1/F2) ([f32bd7d](https://github.com/nikunjmavani/core-be/commit/f32bd7d8567c6d155727d73bde8b3233158b5684))
* **billing:** enforce seats on member reactivation + over-cap downgrade (audit F1/F2) ([71225aa](https://github.com/nikunjmavani/core-be/commit/71225aae241c4f2d54959a6c2d1fe76f28557d59))
* **billing:** fail-closed changePlan + offboarding cancel idempotency key (audit R1) ([ab34935](https://github.com/nikunjmavani/core-be/commit/ab349355b223f2fe5c9fb8dbdd3cff8d70d8e0e1))
* **billing:** fail-closed changePlan + offboarding cancel idempotency key (audit R1) ([509a1e9](https://github.com/nikunjmavani/core-be/commit/509a1e9038289222526a114349b70ada706245f0))
* **billing:** stripe idempotency & subscription correctness (audit PR-2) ([5d32961](https://github.com/nikunjmavani/core-be/commit/5d3296110ea41cddca4ef505486f077eca5141e7))
* **billing:** stripe idempotency & subscription correctness (audit PR-2) ([5578273](https://github.com/nikunjmavani/core-be/commit/5578273313a42e4531e477e6477c8a611559535f))
* **billing:** webhook tenant-scope & subscription RLS hardening (audit PR-3) ([cd4fff3](https://github.com/nikunjmavani/core-be/commit/cd4fff3d6e71d367cc7a6872c8fe4d2f8fad78f0))
* **billing:** webhook tenant-scope & subscription RLS hardening (audit PR-3) ([3a96e66](https://github.com/nikunjmavani/core-be/commit/3a96e6663a4f26470c8afb1d6d0f577d09701f75))
* **cloud:** make startup update script work unprivileged + document bring-up caveats ([#804](https://github.com/nikunjmavani/core-be/issues/804)) ([93d7691](https://github.com/nikunjmavani/core-be/commit/93d76912a03b1d07665f2013a40ed0507bee835d))
* **db:** hash advisory-lock objid so bigint scope ids don't overflow int4 (audit B-1) ([256015b](https://github.com/nikunjmavani/core-be/commit/256015b2495637cf0c3e65aa9350f6b41ff1223a))
* **db:** hash advisory-lock objid so bigint scope ids don't overflow int4 (audit B-1) ([e00bc68](https://github.com/nikunjmavani/core-be/commit/e00bc6836e7bd956e5157261930d1e5f49f09e03))
* **dev:** stop a stale event-loop peak lingering on the dashboard ([#783](https://github.com/nikunjmavani/core-be/issues/783)) ([a1ac4d2](https://github.com/nikunjmavani/core-be/commit/a1ac4d2278fa89a9dd95c97728471ecdd097e970))
* **http:** return 400 (not 500) for a malformed JSON request body ([c44be98](https://github.com/nikunjmavani/core-be/commit/c44be9888f29b4e93354a0d87e8869c25591d3da))
* **http:** return 400 (not 500) for a malformed JSON request body ([5e06579](https://github.com/nikunjmavani/core-be/commit/5e06579d6e70bd4903c7c62a23b98ebf064943ac))
* **idempotency:** enforce 16-char min key and document all 13 required writes ([#735](https://github.com/nikunjmavani/core-be/issues/735)) ([606edbb](https://github.com/nikunjmavani/core-be/commit/606edbba19a7c5234b72f1f46b036b9187d06794))
* **infra:** production env-guard for Bull-Board dashboard + 403 read-only status (re-audit A1) ([7f856e0](https://github.com/nikunjmavani/core-be/commit/7f856e0a8778225f281c6dfb379d88d4ce1669cf))
* **infra:** production env-guard for Bull-Board dashboard + 403 read-only status (re-audit A1) ([ebfd821](https://github.com/nikunjmavani/core-be/commit/ebfd8214299749d3d83743351335efb9b3be598f))
* **lint:** suppress two pre-existing biome findings surfaced by the PR lint gate ([b1b444a](https://github.com/nikunjmavani/core-be/commit/b1b444a0cce44e53c8befb0a5b8d65a508529fad))
* **load:** align k6 journey with idempotency and invitation API ([#813](https://github.com/nikunjmavani/core-be/issues/813)) ([4456a29](https://github.com/nikunjmavani/core-be/commit/4456a293861aed6b06f6091b718fb499d6828de8))
* magic-link Redis resilience, flaky test teardown, and local-startup blockers ([#791](https://github.com/nikunjmavani/core-be/issues/791)) ([e0917ba](https://github.com/nikunjmavani/core-be/commit/e0917ba42b136bcee4c969a4eeb2388b66279296))
* **mcp:** make call_api read-only by default + mask errors, add route allowlist (audit R14) ([cbb9dee](https://github.com/nikunjmavani/core-be/commit/cbb9dee32d05ffca545586f230a934306f376ec3))
* **mcp:** make call_api read-only by default + mask errors; route allowlist (audit R14) ([1ae019e](https://github.com/nikunjmavani/core-be/commit/1ae019e1e9d3ead0560d1fe0eaed3ffd1837d2d0))
* **notify:** delivery reliability — idempotent enqueue, bounded mark-all, honest outcomes (audit PR-5) ([10269fb](https://github.com/nikunjmavani/core-be/commit/10269fb0ced73422677bbb5c0276368d43e305c3))
* **notify:** delivery reliability — idempotent enqueue, bounded mark-all, honest outcomes (audit PR-5) ([f5649a2](https://github.com/nikunjmavani/core-be/commit/f5649a201c42f732fc0f933b35b27a411b9cdedb))
* **notify:** webhook SSRF egress hardening (audit PR-4) ([8239e08](https://github.com/nikunjmavani/core-be/commit/8239e08da0f91885be1041ce5fb42c32f13b8084))
* **notify:** webhook SSRF egress hardening (audit PR-4) ([646c697](https://github.com/nikunjmavani/core-be/commit/646c69739012ccb1fefc5e97dfaca70e13a34424))
* **observability:** initialize OpenTelemetry at runtime (audit R4 / M5) ([9f15ac9](https://github.com/nikunjmavani/core-be/commit/9f15ac9cccca77eaa32518dd7f8daefc28b8aec2))
* **observability:** initialize OpenTelemetry at runtime (audit R4 / M5) ([991414e](https://github.com/nikunjmavani/core-be/commit/991414ebd2c90255b3fddf1a4c81fabb3dbde7e7))
* **overload:** shed new requests on DB-pool saturation, not just event-loop stall (prod-readiness) ([60452e6](https://github.com/nikunjmavani/core-be/commit/60452e6d24c50fd8db40c43670d392bcbb8fb543))
* **overload:** shed new requests on DB-pool saturation, not just event-loop stall (prod-readiness) ([3b362f5](https://github.com/nikunjmavani/core-be/commit/3b362f5ece7313b42029816fbdfb06cee7933048))
* **platform:** harden middleware & boot config (audit PR-1) ([375eff8](https://github.com/nikunjmavani/core-be/commit/375eff8e43986eb37e8b7e9e5e324843244027b7))
* **platform:** harden middleware & boot config (audit PR-1) ([a1f11e3](https://github.com/nikunjmavani/core-be/commit/a1f11e34006c2dfe85ba39ccb4d6a37f3634808d))
* **rls:** FORCE RLS on audit.outbox + correct worker request-database import rule ([68082c4](https://github.com/nikunjmavani/core-be/commit/68082c48fe463390c3e669caadba72a0a5bfb6a5))
* **rls:** FORCE ROW LEVEL SECURITY on audit.outbox ([a22b911](https://github.com/nikunjmavani/core-be/commit/a22b911c316358a4582fe03af9ad7031b12c71e4))
* **rls:** propagate explicit WITH CHECK to all org-scoped policies (audit R2) ([01ef1cf](https://github.com/nikunjmavani/core-be/commit/01ef1cf717e22fd6aba4f39acb8665e8bd10eac7))
* **rls:** propagate explicit WITH CHECK to all org-scoped policies (audit R2) ([d72a187](https://github.com/nikunjmavani/core-be/commit/d72a187c877d6a12c5bdf21a6e64038bf9a90740))
* tag the parser's error with statusCode 400 + FST_ERR_CTP_INVALID_JSON_SYNTAX so the error handler's existing 4xx-framework-error path returns a clean 400 (logged at warn, not captured to Sentry). Adds 3 regression cases to the JSON content-type parser integration suite. Verified: typecheck + biome clean; regression 6/6; live-verified on the running server. ([5e06579](https://github.com/nikunjmavani/core-be/commit/5e06579d6e70bd4903c7c62a23b98ebf064943ac))
* **tenancy:** concurrency & isolation hygiene (audit PR-6) ([c7dc4dc](https://github.com/nikunjmavani/core-be/commit/c7dc4dcda1155c12b613102940141a9ae587316e))
* **tenancy:** concurrency & isolation hygiene (audit PR-6) ([8a2cd9b](https://github.com/nikunjmavani/core-be/commit/8a2cd9bd1f2ef6b4655632fc50e012ca81810b61))
* **tenancy:** invalidate the permission cache after commit, not inside the write txn (audit R11) ([97f6086](https://github.com/nikunjmavani/core-be/commit/97f60868165954cd27ee85db193327649268ae89))
* **tenancy:** invalidate the permission cache after commit, not inside the write txn (audit R11) ([d6598e2](https://github.com/nikunjmavani/core-be/commit/d6598e2538b89855b3c3c114a4bdc1035d864a84))
* **tenancy:** make organizations.slug unique index partial on deleted_at (audit R9) ([2d847be](https://github.com/nikunjmavani/core-be/commit/2d847be65855d92a61cc1a2c5a132708dedff8e3))
* **tenancy:** make organizations.slug unique index partial on deleted_at (audit R9) ([4b392d5](https://github.com/nikunjmavani/core-be/commit/4b392d5d74183a56d1a5bb4061f88a8a9400f4e4))
* **upload:** reserve org-scoped upload slots under organization RLS context (R8 / M4) ([50c82b0](https://github.com/nikunjmavani/core-be/commit/50c82b00b4de3fd854be9981cbb96a0ccd84bf6a))
* **upload:** reserve org-scoped upload slots under organization RLS context (R8 / M4) ([6b7ea5a](https://github.com/nikunjmavani/core-be/commit/6b7ea5a012ddcb266f7c037cc050e20b1df6fb21))
* **user:** data-access concurrency & query hardening (audit PR-7) ([d2988a8](https://github.com/nikunjmavani/core-be/commit/d2988a8140c546d444bd9749fc591b4826a8f93b))
* **user:** data-access concurrency & query hardening (audit PR-7) ([b569c9c](https://github.com/nikunjmavani/core-be/commit/b569c9c6a94a430a14c76d4169e48549f917bb1b))
* **user:** serialize concurrent notification-preferences replace (+ local dashboards hardening) ([#780](https://github.com/nikunjmavani/core-be/issues/780)) ([a617c9d](https://github.com/nikunjmavani/core-be/commit/a617c9dd1820871180d7736cfa916a8643094098))
* **validation:** reject webhook-URL userinfo and traversal in storage-key DTOs (audit R13) ([a06c5d8](https://github.com/nikunjmavani/core-be/commit/a06c5d882f7709851cb4ab6b7fed2c250e8527a7))
* **validation:** reject webhook-URL userinfo and traversal in storage-key DTOs (audit R13) ([fd6e43f](https://github.com/nikunjmavani/core-be/commit/fd6e43fa26b5b0d260d22940f9b663208acafd11))


### Performance

* **db:** index attribution FK columns for online user deletes ([#781](https://github.com/nikunjmavani/core-be/issues/781)) ([dd7efac](https://github.com/nikunjmavani/core-be/commit/dd7efac9ea5a338b650ea2147c8cdd7cf104fa74))
* **tenancy:** let the keyset index drive organization discovery (audit perf-[#1](https://github.com/nikunjmavani/core-be/issues/1)) ([8837329](https://github.com/nikunjmavani/core-be/commit/8837329ada641d95ae776a1ff6376a97d786eeea))
* **tenancy:** let the keyset index drive organization discovery (audit perf-[#1](https://github.com/nikunjmavani/core-be/issues/1)) ([2a05df0](https://github.com/nikunjmavani/core-be/commit/2a05df00bc2cdeb3c5664adc81e2d4511a1b1748))


### Changed

* **auth:** drop session location enrichment; fix FE mapping + reset schema ([f4b7e27](https://github.com/nikunjmavani/core-be/commit/f4b7e2783b8d0f6004adf3863593133b63735814))
* ponytail-audit dead-code cleanup, add ponytail skill, fix test captcha env ([#739](https://github.com/nikunjmavani/core-be/issues/739)) ([904d170](https://github.com/nikunjmavani/core-be/commit/904d1709682f6d7ad02a2c97b1472ec5943acb5c))
* **setup:** extract setup:infra into standalone core-infra repo ([#820](https://github.com/nikunjmavani/core-be/issues/820)) ([25083c3](https://github.com/nikunjmavani/core-be/commit/25083c37ba7a4e7624998f7fb11d0b8772a9bc71))
* **tenancy:** drop redundant org-create advisory lock, delete dead cap-lock module (audit R12) ([0d82149](https://github.com/nikunjmavani/core-be/commit/0d821495855f6b44d70c34b3a8931b30bbfa2cef))
* **tenancy:** drop redundant org-create advisory lock, delete dead cap-lock module (audit R12) ([21479a9](https://github.com/nikunjmavani/core-be/commit/21479a993d9dc4701587b759449e1a2744fecdb3))
* **tooling:** group the dashboards into a tooling/dev/dashboards/ module ([e4f2e26](https://github.com/nikunjmavani/core-be/commit/e4f2e26dc9f4157d72cfc52b4303cc944df654b3))


### Documentation

* add route-effects-by-mode table; fix switch-to-personal status ([c9125b9](https://github.com/nikunjmavani/core-be/commit/c9125b9ba685861c745c5dc6d57c23247ebc654c))
* **agent-os:** codify list search/sort/pagination + FORCE-RLS search conventions ([#826](https://github.com/nikunjmavani/core-be/issues/826)) ([0e12e36](https://github.com/nikunjmavani/core-be/commit/0e12e3699e6d954337807d50226cfb068b84cebb))
* **api-reference:** correct overview to match the implemented /reference UI ([2eda32b](https://github.com/nikunjmavani/core-be/commit/2eda32b7aafd7a23993ef737039a3a31402dc5bf))
* **api:** frontend auth entry flows — call-count matrix + typed landOnDashboard client ([#793](https://github.com/nikunjmavani/core-be/issues/793)) ([63b0010](https://github.com/nikunjmavani/core-be/commit/63b00100533c3fc44a7d80b04275949a44640d11))
* breaking (no unaccepted breaking changes). Third and final deferred follow-up. ([9c56489](https://github.com/nikunjmavani/core-be/commit/9c5648982dcad45022d12f5a155c6d32e44de264))
* **cloud:** scaffold default MCP pair in install and document skills/MCPs ([#803](https://github.com/nikunjmavani/core-be/issues/803)) ([405a29e](https://github.com/nikunjmavani/core-be/commit/405a29e4cf9723fae10b582ca27c3375cf6462e9))
* correct OVERVIEW content drift vs schema/services (audit R3) ([d1f5765](https://github.com/nikunjmavani/core-be/commit/d1f576538f31ff73d494991a7470635e1292e2d2))
* correct OVERVIEW content drift vs schema/services (audit R3) ([98f16fd](https://github.com/nikunjmavani/core-be/commit/98f16fd7eaae24d13d50f948c49148e599149f95))
* document organization capability flags (B2C/B2B/hybrid mode) ([dbbb193](https://github.com/nikunjmavani/core-be/commit/dbbb193f5c64dd51ab9005222fd44b114bb5d0f9))
* **frontend-auth-guide:** document the new-user invited join flow ([#790](https://github.com/nikunjmavani/core-be/issues/790)) ([f8a22e3](https://github.com/nikunjmavani/core-be/commit/f8a22e329fee5bf10fe652c842ef9540499b1ce1))
* mark seat-entitlement policy as shipped + resolve open considerations ([830b457](https://github.com/nikunjmavani/core-be/commit/830b457e4087f10ea17017e4777ce764d837363c))
* mark seat-entitlement policy as shipped + resolve open considerations ([c4f4790](https://github.com/nikunjmavani/core-be/commit/c4f47903f6c6fd97037f736567d24c27baf986a4))
* record production-audit decisions + seat-entitlement policy ([6794fef](https://github.com/nikunjmavani/core-be/commit/6794fef9258ba3bf72499589a390925348143aad))
* record production-audit decisions + seat-entitlement policy ([b12a3b3](https://github.com/nikunjmavani/core-be/commit/b12a3b3f2fa3c8276b06e4995d6bfe38e617948d))
* rename per-folder OVERVIEW.md → &lt;folder&gt;.overview.md ([94e0f05](https://github.com/nikunjmavani/core-be/commit/94e0f05b18801d22cb5688b495efb7763b0a3edc))
* rename per-folder OVERVIEW.md → &lt;folder&gt;.overview.md ([f5aa247](https://github.com/nikunjmavani/core-be/commit/f5aa247e979c77dc1eaa995681315f6576de2f00))
* rename personal-team-organizations -&gt; personal-vs-team-organizations ([ef04d39](https://github.com/nikunjmavani/core-be/commit/ef04d39a358b7f5abeb15b0a359ce04c9c6b091f))
* **rls:** correct the SECURITY DEFINER inventory in the rls-tenant-isolation skill ([83c4f7a](https://github.com/nikunjmavani/core-be/commit/83c4f7aaed3705d963c4fec1f812894e2bc86a8c))
* **rls:** correct the SECURITY DEFINER inventory in the rls-tenant-isolation skill ([65ee120](https://github.com/nikunjmavani/core-be/commit/65ee12090ae73c5df6f4e56375f6ffded55e7544))
* **rls:** correct the worker request-database.context import rule ([05ece95](https://github.com/nikunjmavani/core-be/commit/05ece9577da268bcba229c606d4d5b0c854fcecd))
* sync agent-os (CLAUDE.md, docs index, skills, rules) with code ([#737](https://github.com/nikunjmavani/core-be/issues/737)) ([7918a8e](https://github.com/nikunjmavani/core-be/commit/7918a8e25a0672e89c6024b5cce704ca6560e8b9))

## [4.7.1](https://github.com/nikunjmavani/core-be/compare/v4.7.0...v4.7.1) (2026-06-20)


### Fixed

* add Codex Docker vfs fallback ([#715](https://github.com/nikunjmavani/core-be/issues/715)) ([f61b64e](https://github.com/nikunjmavani/core-be/commit/f61b64eaf8794d403bf6752c3660fdf2bbf2de1e))
* audit remediation — verified production-hardening items ([#725](https://github.com/nikunjmavani/core-be/issues/725)) ([bdaabac](https://github.com/nikunjmavani/core-be/commit/bdaabacd88cf643d2093d68b16bf0d68d2ccd253))
* install docker for cloud bootstrap ([2055ce5](https://github.com/nikunjmavani/core-be/commit/2055ce51b545d74b41dc933970ea06006cbbb76f))
* install docker for cloud bootstrap ([c421afa](https://github.com/nikunjmavani/core-be/commit/c421afa0ffa0960d86695fd0183d61011d1afdef))
* **seed:** idempotent demo seed helpers + smoke test status fixes ([#723](https://github.com/nikunjmavani/core-be/issues/723)) ([3d3a998](https://github.com/nikunjmavani/core-be/commit/3d3a998e169a7fc111ec1e9790f9ad10b90b1924))
* start docker daemon before cloud compose ([6c93d3e](https://github.com/nikunjmavani/core-be/commit/6c93d3eaa30a0a9cd9227d4703527331c83e99a5))
* support restricted docker in codex cloud ([#713](https://github.com/nikunjmavani/core-be/issues/713)) ([c557ca0](https://github.com/nikunjmavani/core-be/commit/c557ca0839bdfb7c17db90ff2d56477d0358ac0a))
* use shared cloud agent docker fallback ([#716](https://github.com/nikunjmavani/core-be/issues/716)) ([7ab2c17](https://github.com/nikunjmavani/core-be/commit/7ab2c176ca2c58082e61c20b75c8b801ee3534a1))


### Documentation

* add handoff summary, enforcement gates, and version override to release-dev-to-production ([#727](https://github.com/nikunjmavani/core-be/issues/727)) ([812afba](https://github.com/nikunjmavani/core-be/commit/812afbaf98b421cb516cd8cf50f6f00b3b825d2c))
* **agent-os:** document dev production release command ([7d023a2](https://github.com/nikunjmavani/core-be/commit/7d023a203df9dc7bc81020428c24eb4e78a1b31d))
* archive Codex Cloud setup ([#719](https://github.com/nikunjmavani/core-be/issues/719)) ([831865e](https://github.com/nikunjmavani/core-be/commit/831865e05d9a770eabe031f638c18fac95889ca3))
* **load-testing:** document co-located load-generation caveat ([#722](https://github.com/nikunjmavani/core-be/issues/722)) ([1df13ae](https://github.com/nikunjmavani/core-be/commit/1df13aec72510e73763537c3615424bafc9d2f90))

## [4.7.0](https://github.com/nikunjmavani/core-be/compare/v4.6.0...v4.7.0) (2026-06-18)


### Added

* 131-route security & production-flow audit — fix all RED/AMBER findings ([#601](https://github.com/nikunjmavani/core-be/issues/601)) ([3df1fbd](https://github.com/nikunjmavani/core-be/commit/3df1fbd91ea9011a6378a6f0785200e4a5f990ed))
* **agent-os:** add PreToolUse edit-guard and SessionStart hooks ([dcf6335](https://github.com/nikunjmavani/core-be/commit/dcf6335773cb9b8d15f570d7b2afac9e2a1a284c))
* **agent-os:** add RLS/tenant-isolation and idempotency guard skills ([a94cbb5](https://github.com/nikunjmavani/core-be/commit/a94cbb52df397f1abadf3a3f411f31bf2fc6f49a))
* **agent-os:** PreToolUse edit-guard + SessionStart hooks (Move 2) ([ad2e2b3](https://github.com/nikunjmavani/core-be/commit/ad2e2b3b87051c2fe34d3005d6a84fc6e37965e0))
* **agent-os:** RLS/tenant-isolation + idempotency guard skills ([0a3b902](https://github.com/nikunjmavani/core-be/commit/0a3b902748f4fc3e84d5d971b0915496b5e4f440))
* **ai:** cross-platform AI commands, SessionStart hook, and guardrails ([#643](https://github.com/nikunjmavani/core-be/issues/643)) ([b6fccf1](https://github.com/nikunjmavani/core-be/commit/b6fccf1630257d2920ba3831f625bbeeca7cad41))
* **audit:** transactional outbox for audit.logs writes (P0-[#2](https://github.com/nikunjmavani/core-be/issues/2)) ([#557](https://github.com/nikunjmavani/core-be/issues/557)) ([4c337da](https://github.com/nikunjmavani/core-be/commit/4c337da6b81523c01d23bf8947226194ee9ad665))
* **auth:** add switch-to-personal and switch-to-organization endpoints ([79be5b0](https://github.com/nikunjmavani/core-be/commit/79be5b0fe799563e9612eaa3fc48a4a12f3ce2ae))
* **auth:** carry active organization + session version as signed JWT claims ([9864a2e](https://github.com/nikunjmavani/core-be/commit/9864a2e34917837b7102fdd72f9ba61982e4b0e0))
* **auth:** GET /auth/me/context — frontend-ready effective context ([#659](https://github.com/nikunjmavani/core-be/issues/659)) ([d08bb35](https://github.com/nikunjmavani/core-be/commit/d08bb35049c443015b3d53be0f13c7a80f4a845a))
* **auth:** mint the active-organization claim at login (default selection) ([a3a805d](https://github.com/nikunjmavani/core-be/commit/a3a805dc143b7af537c0757b4b74bfc77516d75d))
* **auth:** permission layer falls back to the org token claim (Phase 3 bridge) ([ea07091](https://github.com/nikunjmavani/core-be/commit/ea0709135504d09faa6367bfded88107cc438295))
* **auth:** permission layer reads the org token claim (Phase 3 bridge) ([6b9e7c3](https://github.com/nikunjmavani/core-be/commit/6b9e7c3458f6788b5c75b0ed4a49d3709b48d181))
* **auth:** refresh re-mints the active-organization claim ([b22f0a1](https://github.com/nikunjmavani/core-be/commit/b22f0a1712aa76b1f997257997b157025712b791))
* **auth:** switch building blocks — membership-validation resolvers + session token re-bind ([62cc944](https://github.com/nikunjmavani/core-be/commit/62cc9449314b7684007c937a9ec72b73c2d0eceb))
* **auth:** switchToOrganization / switchToPersonal service methods ([3f5ecc8](https://github.com/nikunjmavani/core-be/commit/3f5ecc84267e747d6e6d900ae5caf733f6255752))
* **billing:** flatten subscription routes onto the org token claim ([f835d60](https://github.com/nikunjmavani/core-be/commit/f835d605e0529e0e0e91ca7da1b16aa5f8940bec))
* **billing:** flatten subscription routes onto the org token claim ([df21c2c](https://github.com/nikunjmavani/core-be/commit/df21c2c62c4b65e4f1bf57228743ac2cd042a92c))
* **ci:** add PR-time Trivy IaC misconfig scan ([#388](https://github.com/nikunjmavani/core-be/issues/388)) ([e8499e0](https://github.com/nikunjmavani/core-be/commit/e8499e04b8c8d311a14fb6ac3bdd1c4a4d151a49))
* **config:** gated local-dev defaults for DB/Redis/origins/retention ([#651](https://github.com/nikunjmavani/core-be/issues/651)) ([773e427](https://github.com/nikunjmavani/core-be/commit/773e427ca11bd44d1a65fea996ebbc92a629c236))
* **infra-tests:** drop_index_without_concurrently lint rule + org slug collision-proof factory ([#526](https://github.com/nikunjmavani/core-be/issues/526)) ([0915c85](https://github.com/nikunjmavani/core-be/commit/0915c851ab7b5c8934a06108d28f8aec3662e97b))
* **load:** per-VU credential pool + realistic user-journey k6 scenario ([#342](https://github.com/nikunjmavani/core-be/issues/342)) ([a05a611](https://github.com/nikunjmavani/core-be/commit/a05a611ced68683c0855c65d572fbc5fc7d06bb1))
* **mcp,k6:** client auth-flow guide + k6 org-claim flow; fix dead idempotency exclusions ([f4bac5a](https://github.com/nikunjmavani/core-be/commit/f4bac5aa9a67f14e5ec87209e326e67b5ae15de6))
* **mcp,k6:** client auth-flow guide + k6 org-claim flow; fix idempotency exclusions; flatten stale refs ([f6e5894](https://github.com/nikunjmavani/core-be/commit/f6e5894a66cee5de1ff0790f5898b5510fd74f37))
* **mcp:** scope project MCP servers and wire MCP setup into the session-start flow ([#675](https://github.com/nikunjmavani/core-be/issues/675)) ([9ed07b4](https://github.com/nikunjmavani/core-be/commit/9ed07b4ba576db0ac5849d9c7de76b4c2c91af73))
* **notify:** flatten webhook routes onto the org token claim ([643d13a](https://github.com/nikunjmavani/core-be/commit/643d13ad09bd64e28bca029e4ed42cc40b56d04f))
* **notify:** flatten webhook routes onto the org token claim ([0bdc8ad](https://github.com/nikunjmavani/core-be/commit/0bdc8add9f37df2bd944995368be8d9f94710755))
* **notify:** time-based retention for webhook_delivery_attempts (audit-[#3](https://github.com/nikunjmavani/core-be/issues/3)) ([05d6325](https://github.com/nikunjmavani/core-be/commit/05d63258002fd9762962498b0a5059a5b971400f))
* **observability:** emit Server-Timing header for true server-side latency ([#339](https://github.com/nikunjmavani/core-be/issues/339)) ([5e78cde](https://github.com/nikunjmavani/core-be/commit/5e78cde15b30deac077cbf4e27081cf6da27e814))
* **openapi:** document the full error-status matrix; observed-vs-spec error gate ([95a71b5](https://github.com/nikunjmavani/core-be/commit/95a71b505c9d8d7f802d73c4e0841b4140bf836d))
* **openapi:** document the full error-status matrix; observed-vs-spec error gate ([5a001de](https://github.com/nikunjmavani/core-be/commit/5a001de48bb661e048e012dde8ce658bfe612f3e))
* **openapi:** embed sanitized live-call request/response examples per route and status ([3a1ddb1](https://github.com/nikunjmavani/core-be/commit/3a1ddb1e5d38b40e18b9300a14942219da6ce868))
* **openapi:** embed sanitized live-call request/response examples per route and status ([bea574c](https://github.com/nikunjmavani/core-be/commit/bea574c92291f96bd309ad1969fe38cdf756722f))
* personal & team organizations — foundation + token/switch (Phase 1-2) ([9a8b179](https://github.com/nikunjmavani/core-be/commit/9a8b179a097b615b2e7292ad6f6362011ea2563c))
* **round-5-followup:** per-org row caps (api-keys, member-roles, notification-policies) + auth/MFA route policy tests ([#528](https://github.com/nikunjmavani/core-be/issues/528)) ([19b556f](https://github.com/nikunjmavani/core-be/commit/19b556f9379a3d70889644356e9928a68de549e9))
* **round-5:** residual-risk findings — DLQ-RLS bug + 5 backlog fixes + 3 test gaps + audit doc ([#527](https://github.com/nikunjmavani/core-be/issues/527)) ([6aa6f88](https://github.com/nikunjmavani/core-be/commit/6aa6f8831e12fa7c8ef88f3d95f9e15bcd2d23d2))
* **scalar:** publish OpenAPI to Scalar Registry (CI docs pipeline + interactive setup) ([#672](https://github.com/nikunjmavani/core-be/issues/672)) ([3ddc9b2](https://github.com/nikunjmavani/core-be/commit/3ddc9b2325a8cc8417bfe679c748a64f5c510da2))
* **tenancy:** atomic org provisioning with owner role+permissions+membership ([266b22e](https://github.com/nikunjmavani/core-be/commit/266b22ebeb3604dbc45d08608efd7604df37c81e))
* **tenancy:** auto-provision personal org at signup + exclude personal from delete guard ([9daed03](https://github.com/nikunjmavani/core-be/commit/9daed03c85997744bbfeb50919681de5658cd556))
* **tenancy:** block invitations on a personal organization (capability matrix) ([cafc549](https://github.com/nikunjmavani/core-be/commit/cafc5493d497f7e99a924a152ca6a64e4f29dd0d))
* **tenancy:** cap team organizations per owner (anti-abuse) ([f71b968](https://github.com/nikunjmavani/core-be/commit/f71b968577aa19a8ce4c3b4f6ce83142c3fd51d3))
* **tenancy:** flatten organization routes onto the org token claim ([ddd1a76](https://github.com/nikunjmavani/core-be/commit/ddd1a7604f7da6dfb3a878fdb28c9e35dff086d8))
* **tenancy:** flatten organization routes onto the org token claim ([f35b74e](https://github.com/nikunjmavani/core-be/commit/f35b74eb0f14cf2e5225b3fb477ea686a82763ed))
* **tenancy:** make the personal organization immutable (no delete / no transfer) ([a726064](https://github.com/nikunjmavani/core-be/commit/a726064b5f009c1a5ccd878fe8379eb79a533a37))
* **tenancy:** org-creation per-owner cap + personal-org capability guards ([94d7715](https://github.com/nikunjmavani/core-be/commit/94d77153740b2076afb57ded14748b727367617c))
* **tenancy:** organization create accepts type + nullable slug (provisioning groundwork) ([35bc409](https://github.com/nikunjmavani/core-be/commit/35bc409c7e85453a2d294f1baf4bd38b19e26d6f))
* **tenancy:** personal-org backfill script + provisioning tests ([5a40f5d](https://github.com/nikunjmavani/core-be/commit/5a40f5d5eadfd970e712b8d4b5a7f85b86258727))
* **tenancy:** personal/team organization foundation — schema + capability flags ([11e23d9](https://github.com/nikunjmavani/core-be/commit/11e23d92fc301307638f73e3e1269a0612ddde3d))
* **testing:** route success-status registry, observed coverage ratchet, never-5xx fuzz gate ([8d88dcf](https://github.com/nikunjmavani/core-be/commit/8d88dcf0677104ce4885ad80d62543c6ec45052a))
* **testing:** route success-status registry, observed coverage ratchet, never-5xx fuzz gate ([dfe2b43](https://github.com/nikunjmavani/core-be/commit/dfe2b436d3fa28843597576d6b29f43d7932d8ab))
* **testing:** verified happy path for every route — budget 30→0; 201 creates; OAuth 404 ([01b1b77](https://github.com/nikunjmavani/core-be/commit/01b1b77cbf2f60dcafbfa1afeafab68fe1e54437))
* **testing:** verified happy path for every route — budget 30→0; 201 creates; OAuth 404 ([624c9d5](https://github.com/nikunjmavani/core-be/commit/624c9d58945e78317e39cd9a412e488454fbdf29))
* **tests:** post-load settle-and-assert-clean gate + audit-outbox drain coverage ([01258c5](https://github.com/nikunjmavani/core-be/commit/01258c5b5aa9c03f8d6e9c7c9a5218cd10d3750b))
* **tooling:** project identity refactor, 5 review agents, architecture policy tests ([#552](https://github.com/nikunjmavani/core-be/issues/552)) ([324689e](https://github.com/nikunjmavani/core-be/commit/324689e3c5027056932272f90d3495539d25ea44))
* **user:** add a scheduled reconciler that detects + alerts on stuck offboarding (audit-[#15](https://github.com/nikunjmavani/core-be/issues/15)) ([6443673](https://github.com/nikunjmavani/core-be/commit/64436733ec73792a3295b46ade51da2ceee98a53))
* **user:** expose deployment organization capabilities on /users/me ([a27f7a6](https://github.com/nikunjmavani/core-be/commit/a27f7a6d9a1a03a75e6163ab061e137d8a65e1d8))
* **user:** expose personal_organization_id on /users/me ([b725aca](https://github.com/nikunjmavani/core-be/commit/b725acad609f8a9743f2a199c4234df423ade3a5))


### Fixed

* 8th-audit concurrency races + correctness hardening (C1-C5) ([bf077b7](https://github.com/nikunjmavani/core-be/commit/bf077b743cfbe51549c39ca4d4ae28b824a1a6df))
* **api:** truthful error envelope, id-only external fields, DELETE→204 stragglers, local oasdiff gate ([25b4629](https://github.com/nikunjmavani/core-be/commit/25b46297b331681b528962246f8bee28c4695204))
* **api:** truthful error envelope, id-only external fields, DELETE→204 stragglers, local oasdiff gate ([2777308](https://github.com/nikunjmavani/core-be/commit/2777308d77c2938b0f66437a24a02b9637392b19))
* audit batch2 — WebAuthn typed DTOs, oasdiff SIGSEGV CI workaround ([6e44557](https://github.com/nikunjmavani/core-be/commit/6e4455700f39ed6cc6dee5ca71baf4eaddac49ed))
* **audit-13:** remove dead jobTimeout field from worker options — BullMQ does not enforce it ([#379](https://github.com/nikunjmavani/core-be/issues/379)) ([b393d5e](https://github.com/nikunjmavani/core-be/commit/b393d5e0add3e299de889d023056397a559b5df6))
* **audit:** cursor max-length, DLQ catch, jobTimeout, age-based queue eviction (batch5) ([#375](https://github.com/nikunjmavani/core-be/issues/375)) ([5882436](https://github.com/nikunjmavani/core-be/commit/588243618efe4be76f3b9e1d2b0c2aa851b06930))
* **audit:** MCP caller JWT forwarding and IP-level failed-login counter ([#373](https://github.com/nikunjmavani/core-be/issues/373)) ([ceee226](https://github.com/nikunjmavani/core-be/commit/ceee2269da8c40bb16f1332e56de8028de24b069))
* **audit:** omit soft-deleted orgs from audit-log public id resolution (sec-r4-D2) ([#506](https://github.com/nikunjmavani/core-be/issues/506)) ([e76a015](https://github.com/nikunjmavani/core-be/commit/e76a01530ed22da2e35d21f0080547075d0475d8))
* **audit:** rate limits, User-Agent truncation, webhook HTTPS, CAPTCHA staging (batch4) ([#374](https://github.com/nikunjmavani/core-be/issues/374)) ([4c9486a](https://github.com/nikunjmavani/core-be/commit/4c9486ac64959cea4bd308cb59c37ba858018066))
* **auth-webauthn:** require user verification at options time (sec-r4-A2) ([#514](https://github.com/nikunjmavani/core-be/issues/514)) ([38f60cf](https://github.com/nikunjmavani/core-be/commit/38f60cf8443a94ff327e95e6bad5d03d7bdf6947))
* **auth,openapi:** MFA-login org claim (H1) + captcha/bearerAuth OpenAPI accuracy ([909a5ce](https://github.com/nikunjmavani/core-be/commit/909a5ce448a362af445736e8a02cb2e18b7949b8))
* **auth,openapi:** mfa-login org claim (H1) plus captcha and bearerAuth openapi accuracy ([fc336b8](https://github.com/nikunjmavani/core-be/commit/fc336b867a9a597fb3c613aa0574a4b8e91bae60))
* **auth:** add user FK + index to mfa_methods to purge orphaned MFA secrets (reaudit-[#1](https://github.com/nikunjmavani/core-be/issues/1)) ([a5a0992](https://github.com/nikunjmavani/core-be/commit/a5a0992eb777f40851e2c97ac7c26ff371325c06))
* **auth:** atomic credential-mutation guards + lockout counter (route-audit C1, C5) ([e6e33db](https://github.com/nikunjmavani/core-be/commit/e6e33db37b405bf0c92622b3c152f35c88cbf186))
* **auth:** block revoking the current session via DELETE /me/sessions/:id (route-[#9](https://github.com/nikunjmavani/core-be/issues/9)) ([19f4bff](https://github.com/nikunjmavani/core-be/commit/19f4bff7ba7a651f630204a173f859dc40206d2b))
* **auth:** bounded refresh-token reuse grace for concurrent refreshes (audit-[#2](https://github.com/nikunjmavani/core-be/issues/2)) ([0cdd75d](https://github.com/nikunjmavani/core-be/commit/0cdd75dd8b85e880950b8a076fbadee39c01d18f))
* **auth:** close session-revoke cache repopulation race + normalize OAuth email (route-audit session-[#1](https://github.com/nikunjmavani/core-be/issues/1), oauth-[#3](https://github.com/nikunjmavani/core-be/issues/3)) ([b8303a0](https://github.com/nikunjmavani/core-be/commit/b8303a02e1e7010f9516e0e5c2df5b7777c83694))
* **auth:** close WebAuthn enumeration timing oracle + complete credential-mutation lock (route-audit D1, D2, D3) ([10e2b52](https://github.com/nikunjmavani/core-be/commit/10e2b5271c7cb454e15e99035389787e5c233c25))
* **auth:** drop SUPER_ADMIN for non-active accounts in per-request re-derive (reaudit-[#10](https://github.com/nikunjmavani/core-be/issues/10)) ([e54a97b](https://github.com/nikunjmavani/core-be/commit/e54a97bd1e643916ac3eb579eeda2dcdb1d26493))
* **auth:** fix controller unit test and ack OpenAPI breaking change for B4 ([48f8c81](https://github.com/nikunjmavani/core-be/commit/48f8c818fa14f205efe5a6e12d2528e8461f6790))
* **auth:** floor login failure branches to mask enumeration timing (audit-[#15](https://github.com/nikunjmavani/core-be/issues/15)d) ([0c4af59](https://github.com/nikunjmavani/core-be/commit/0c4af594c6aba8d84d383d20c01838ef6d134bf0))
* **auth:** key DELETE /mfa/:mfaMethodId on public id, not the sequential DB id (route-[#10](https://github.com/nikunjmavani/core-be/issues/10)) ([31bdd46](https://github.com/nikunjmavani/core-be/commit/31bdd46de650dce63aa6bc542beda50d57c0dea2))
* **auth:** make magic-link verification atomic with first-factor completion (audit-[#12](https://github.com/nikunjmavani/core-be/issues/12)) ([4350845](https://github.com/nikunjmavani/core-be/commit/435084506afc855e48169b8e26b3d87a1690f36a))
* **auth:** make MFA verification lockout counter atomic (route-audit-[#4](https://github.com/nikunjmavani/core-be/issues/4)) ([7d98218](https://github.com/nikunjmavani/core-be/commit/7d982183877aeea6cbc4531cea9eb47376c704fc))
* **auth:** make one-time-token issuance atomic with the mail-outbox insert (audit-[#11](https://github.com/nikunjmavani/core-be/issues/11)) ([f122beb](https://github.com/nikunjmavani/core-be/commit/f122beb20866aaf4748b05d29d2307f9a0768462))
* **auth:** make password change and email verification atomic with their side effects (audit-[#4](https://github.com/nikunjmavani/core-be/issues/4), [#12](https://github.com/nikunjmavani/core-be/issues/12)) ([42d7893](https://github.com/nikunjmavani/core-be/commit/42d7893572ee6e89c5bbe42a08cc18d1f33aa6e6))
* **auth:** make password reset atomic (transaction) so sessions can't survive it ([#319](https://github.com/nikunjmavani/core-be/issues/319)) ([30cffe5](https://github.com/nikunjmavani/core-be/commit/30cffe5c205fdd7d0f1a835cf335791ad78ad36e))
* **auth:** per-user MFA verification lockout (audit-[#12](https://github.com/nikunjmavani/core-be/issues/12)) ([d6331e0](https://github.com/nikunjmavani/core-be/commit/d6331e01f9a0d378096ecc26b30404f23fc20d7c))
* **auth:** persist and revalidate the active organization across refresh (audit-[#3](https://github.com/nikunjmavani/core-be/issues/3)) ([f9d8f1b](https://github.com/nikunjmavani/core-be/commit/f9d8f1b5a757c5b8dc5f267f4cf166f2e5677816))
* **auth:** re-derive any privileged JWT claim (admin + super_admin) against live state (route-[#6](https://github.com/nikunjmavani/core-be/issues/6)) ([956c43d](https://github.com/nikunjmavani/core-be/commit/956c43d855978ea9f49c573e4c8a498ae2c4309f))
* **auth:** remove silent params.id fallback in requireOrganizationPermission ([#346](https://github.com/nikunjmavani/core-be/issues/346)) ([17f4d83](https://github.com/nikunjmavani/core-be/commit/17f4d83fae5114820bf4f1c00940306628ea1228))
* **auth:** restore org-mandated MFA under FORCE RLS via SECURITY DEFINER resolvers ([#318](https://github.com/nikunjmavani/core-be/issues/318)) ([e152c0c](https://github.com/nikunjmavani/core-be/commit/e152c0c458aed788289c7d75b3e8fe0c79ec938f))
* **auth:** restrict POST /me/auth-methods to MAGIC_LINK to stop phantom-credential lockout (route-[#3](https://github.com/nikunjmavani/core-be/issues/3)) ([ee9af9a](https://github.com/nikunjmavani/core-be/commit/ee9af9a5819990189c658a69d9396e0fdb3ed7c5))
* **auth:** scope MFA lockout to TOTP so recovery codes stay usable (reaudit-[#3](https://github.com/nikunjmavani/core-be/issues/3)) ([a6d4b05](https://github.com/nikunjmavani/core-be/commit/a6d4b05530cd06f563be8a0ede17552d6831f4ac))
* **auth:** sec-new-A2 reject suspended/deleted users on bearer auth cache miss ([#474](https://github.com/nikunjmavani/core-be/issues/474)) ([eff74f4](https://github.com/nikunjmavani/core-be/commit/eff74f453a57f071258b8275aa850d375e6a67cc))
* **auth:** sec-new-A3 preserve caller session on DELETE /me/sessions ([#478](https://github.com/nikunjmavani/core-be/issues/478)) ([32936f3](https://github.com/nikunjmavani/core-be/commit/32936f3625022fcb98a3b2f681b6d19ee86a7611))
* **auth:** sec-new-A4 flip is_mfa_enabled inside deleteMfa transaction ([#479](https://github.com/nikunjmavani/core-be/issues/479)) ([a50d899](https://github.com/nikunjmavani/core-be/commit/a50d8995f7c42b08643d6a503b70971d24cbf6e9))
* **auth:** sec-new-B4 add public_id to auth_methods, stop leaking bigserial ids ([c82295d](https://github.com/nikunjmavani/core-be/commit/c82295d43b2768b8fb53160c26704e3dabadf4ce))
* **auth:** sec-new-B4 add public_id to auth_methods, stop leaking bigserial ids ([02a6ddd](https://github.com/nikunjmavani/core-be/commit/02a6ddd7b4dff060e87709bfa74dcd955a679228))
* **auth:** session-revoke cache repopulation race + OAuth email normalization ([c981c7f](https://github.com/nikunjmavani/core-be/commit/c981c7f634a1090faae6513d62aa30206e5e1778))
* **auth:** stop GET /auth/me/auth-methods leaking encrypted TOTP secret + PII ([#321](https://github.com/nikunjmavani/core-be/issues/321)) ([32cb49e](https://github.com/nikunjmavani/core-be/commit/32cb49e7b1c2039c2554adc481c2f68837720e6e))
* **auth:** switch-to-organization relies on route schema for body validation + suite green ([ab02f71](https://github.com/nikunjmavani/core-be/commit/ab02f711379690a987cf2cc7ab46139dc411adf8))
* **auth:** WebAuthn enumeration timing oracle + complete credential-mutation lock (D1/D2/D3) ([9a1f3f0](https://github.com/nikunjmavani/core-be/commit/9a1f3f0d5aef7156d4d455935f5295f20b76d257))
* backend production-readiness audit findings ([0f60e0f](https://github.com/nikunjmavani/core-be/commit/0f60e0f71d6dd0b1f7a5d9aa20bf60712c8a04cb))
* backend production-readiness re-audit findings ([6bd64bc](https://github.com/nikunjmavani/core-be/commit/6bd64bc3c47c7c28a1f1d42121867bc990f9c99c))
* **billing:** add per-route rate limit to subscription mutations (route-[#2](https://github.com/nikunjmavani/core-be/issues/2)) ([1e6975e](https://github.com/nikunjmavani/core-be/commit/1e6975e24271d14561f544981c651e254c3ef862))
* **billing:** alert on plan&lt;-&gt;Stripe price catalog drift (audit-[#13](https://github.com/nikunjmavani/core-be/issues/13)) ([3377510](https://github.com/nikunjmavani/core-be/commit/33775103b9ec7470270ff172b734b34586aebcb3))
* **billing:** bound PlanRepository.findAllActive at 100 rows (sec-r4-D3) ([#507](https://github.com/nikunjmavani/core-be/issues/507)) ([43180a9](https://github.com/nikunjmavani/core-be/commit/43180a98e2b62abdc0584460d06d455a55701900))
* **billing:** cancel the org's active subscription on organization delete (route-audit-[#2](https://github.com/nikunjmavani/core-be/issues/2)) ([718c80f](https://github.com/nikunjmavani/core-be/commit/718c80f307ae14d9db2ff77dbd26ae591f667afc))
* **billing:** cancel() releases the slot for never-activated INCOMPLETE subscriptions (reaudit-[#6](https://github.com/nikunjmavani/core-be/issues/6)) ([3d6cfe0](https://github.com/nikunjmavani/core-be/commit/3d6cfe03758b1302a8d1e7f8612d4641d381c1e8))
* **billing:** correct misleading plan route OpenAPI descriptions ([#349](https://github.com/nikunjmavani/core-be/issues/349)) ([27246ce](https://github.com/nikunjmavani/core-be/commit/27246ce78082f134005ac028852c7d95233f3c8b))
* **billing:** enforce unique subscriptions.provider_subscription_id (audit-[#10](https://github.com/nikunjmavani/core-be/issues/10)) ([acf919b](https://github.com/nikunjmavani/core-be/commit/acf919b105cbc10c502b8b197f5af1bd8782646c))
* **billing:** hide inactive plans from public GET /billing/plans/:id (route-[#7](https://github.com/nikunjmavani/core-be/issues/7)) ([0be46ed](https://github.com/nikunjmavani/core-be/commit/0be46ed971f32287ba326cdbbbb94275ca7f9465))
* **billing:** make Stripe customer creation idempotent on retry ([#326](https://github.com/nikunjmavani/core-be/issues/326)) ([8990fb3](https://github.com/nikunjmavani/core-be/commit/8990fb32b15fa133aece4ce428182d9b1996ee93))
* **billing:** make terminal subscriptions immutable (compare-and-set, B5/B6) ([5ac4328](https://github.com/nikunjmavani/core-be/commit/5ac43284d69e28101615d1a2f2caa306ab31cfe2))
* **billing:** make terminal subscriptions immutable via compare-and-set (route-audit B5, B6) ([18a3e43](https://github.com/nikunjmavani/core-be/commit/18a3e43540814b94e66ad085f40df767a32598e3))
* **billing:** persist a CANCELED tombstone for out-of-order Stripe deletions (audit-[#1](https://github.com/nikunjmavani/core-be/issues/1)) ([7862609](https://github.com/nikunjmavani/core-be/commit/7862609ed32b9c5c16d5780f4a6d7b59ba5066bb))
* **billing:** persist new Stripe subscriptions as INCOMPLETE not TRIALING (audit-[#2](https://github.com/nikunjmavani/core-be/issues/2)) ([b5a7f66](https://github.com/nikunjmavani/core-be/commit/b5a7f66537091e20632b3898364c7ac71e3f9f5f))
* **billing:** pin Stripe API version to 2026-05-27.dahlia ([#350](https://github.com/nikunjmavani/core-be/issues/350)) ([7c329bd](https://github.com/nikunjmavani/core-be/commit/7c329bd496bdff587f3c12748f923a2ef7267909))
* **billing:** release subscription slot for INCOMPLETE_EXPIRED (audit-[#1](https://github.com/nikunjmavani/core-be/issues/1)) ([14cd328](https://github.com/nikunjmavani/core-be/commit/14cd3289545d1229e72b08e16977286cde39db18))
* **billing:** remove redundant parseBullMQJobData from stripe-webhook processor (sec-r4-Q1) ([#502](https://github.com/nikunjmavani/core-be/issues/502)) ([d20c731](https://github.com/nikunjmavani/core-be/commit/d20c731dbaf5764fcb0ebf96376830c882991205))
* **billing:** sec-new-B1 guard cancel/resume/changePlan against terminal subscriptions ([#475](https://github.com/nikunjmavani/core-be/issues/475)) ([86bb32f](https://github.com/nikunjmavani/core-be/commit/86bb32f6de0ed2c3e293f2a17f979b9cfbfc3328))
* **billing:** sec-new-D1-D2 data integrity guards in billing writes ([#476](https://github.com/nikunjmavani/core-be/issues/476)) ([def085a](https://github.com/nikunjmavani/core-be/commit/def085adf233218dac8c01dad35e2efde385313b))
* **billing:** sec-new-M2 emit Deprecation+Sunset headers on deprecated /stripe/webhook alias ([#489](https://github.com/nikunjmavani/core-be/issues/489)) ([d95f4aa](https://github.com/nikunjmavani/core-be/commit/d95f4aa8becdae0454be1d727a09c1580fb1ff4d))
* **billing:** set concrete sunset for deprecated stripe webhook alias (audit-[#15](https://github.com/nikunjmavani/core-be/issues/15)a) ([4efb4a7](https://github.com/nikunjmavani/core-be/commit/4efb4a78e02af5da54c10fb04de02239120b1f79))
* **billing:** support comma-separated STRIPE_WEBHOOK_SECRET for zero-downtime rotation (sec-new-B3) ([#490](https://github.com/nikunjmavani/core-be/issues/490)) ([4be65fe](https://github.com/nikunjmavani/core-be/commit/4be65fe218a948b63f9386a09a934aa4cb4d42e5))
* block user delete when owning orgs + webhook updated_at flake ([08a5ac2](https://github.com/nikunjmavani/core-be/commit/08a5ac27734c2d3abb3604ab5e694abeb429d85e))
* **cache:** add commandTimeout to Redis client to prevent hung commands ([8cd8107](https://github.com/nikunjmavani/core-be/commit/8cd8107df573d5a8255911dc2fac8f21e676fb66))
* **ci:** dispatch stable release backmerge ([be9190f](https://github.com/nikunjmavani/core-be/commit/be9190f6ff26d04905bc46127717c96fbbe57ab0))
* **ci:** export GLOBAL_ADMIN_EMAILS in test-env so audit.test.ts super-admin paths work in Matrix Tests ([#532](https://github.com/nikunjmavani/core-be/issues/532)) ([873f59d](https://github.com/nikunjmavani/core-be/commit/873f59df59340bc182e3d8f261b5c2e435f89c63))
* **ci:** grant release-please job id-token + actions write permissions ([#536](https://github.com/nikunjmavani/core-be/issues/536)) ([b83eab2](https://github.com/nikunjmavani/core-be/commit/b83eab2d4ac3e2b46f5e77e00e34d720db6508e0))
* **ci:** publish API docs (incl. Scalar Registry) independently of release-please ([#676](https://github.com/nikunjmavani/core-be/issues/676)) ([7c4fe62](https://github.com/nikunjmavani/core-be/commit/7c4fe62027431e4d79e006afb84cc24c61e5fc67))
* **ci:** publish Scalar registry from GitHub Variables ([#677](https://github.com/nikunjmavani/core-be/issues/677)) ([cfaaef8](https://github.com/nikunjmavani/core-be/commit/cfaaef883eb57327cfd3f558597407250d3a752c))
* **ci:** use bare check-run names as ruleset required-check contexts ([#344](https://github.com/nikunjmavani/core-be/issues/344)) ([c431a63](https://github.com/nikunjmavani/core-be/commit/c431a63a292e9dcff7dc09147c9ae0fd7eb3d5d2))
* **ci:** use fetch-depth: 0 in post-merge changes job to avoid paths-filter race ([#390](https://github.com/nikunjmavani/core-be/issues/390)) ([61a2100](https://github.com/nikunjmavani/core-be/commit/61a210090ae518f75f459cc33806b10ba1442993))
* **config:** cap AUTH_SESSION_MAX_AGE_DAYS at 365 (sec-r4-C4) ([#510](https://github.com/nikunjmavani/core-be/issues/510)) ([2a48a88](https://github.com/nikunjmavani/core-be/commit/2a48a88355744445298e8fb36dda0c22fca0b472))
* **config:** make .env.local the self-contained primary local env file ([#650](https://github.com/nikunjmavani/core-be/issues/650)) ([aeb32e7](https://github.com/nikunjmavani/core-be/commit/aeb32e7c60d4686f71b2f14f46efe873404652c3))
* **config:** require legacy JWT gate closed once keyring configured in prod (audit-[#15](https://github.com/nikunjmavani/core-be/issues/15)b) ([43e5139](https://github.com/nikunjmavani/core-be/commit/43e5139de2e4b9f7e969b9832e8ffac1a0c32b89))
* **database:** keyset-page batch delete so FK-blocked rows can't infinite-loop retention ([fd9b523](https://github.com/nikunjmavani/core-be/commit/fd9b523ecaf1825d111a636d6cad954ecba6e83a))
* **database:** keyset-page batch delete so FK-blocked rows can't infinite-loop retention (route-audit A1) ([f81ca72](https://github.com/nikunjmavani/core-be/commit/f81ca724b6e5d25c158e02403ee39d7132c8c8f2))
* **database:** sec-new-Q4 apply worker statement timeout in system-table retention context ([#487](https://github.com/nikunjmavani/core-be/issues/487)) ([4e0b5c2](https://github.com/nikunjmavani/core-be/commit/4e0b5c2156544d72b9dbf51b4a3c07b77930492a))
* **db:** enforce RLS deny-all on billing.plans and tenancy.permissions (reaudit-[#9](https://github.com/nikunjmavani/core-be/issues/9)) ([2bb9476](https://github.com/nikunjmavani/core-be/commit/2bb947621fafabfd2ec03ca2d2fc9f905970c838))
* **deps:** bump esbuild override to &gt;=0.28.1 (GHSA-gv7w-rqvm-qjhr / GHSA-g7r4-m6w7-qqqr) ([514fa96](https://github.com/nikunjmavani/core-be/commit/514fa961bd392ef4583c7e148a7f47277ef23dae))
* **deps:** override @grpc/grpc-js to &gt;=1.14.4 (GHSA-5375-pq7m-f5r2) ([0a66557](https://github.com/nikunjmavani/core-be/commit/0a6655731c02a3efa03ca598c306fce4d34012c7))
* **docker:** add HEALTHCHECK to worker image (audit-[#15](https://github.com/nikunjmavani/core-be/issues/15)c) ([b4f7a67](https://github.com/nikunjmavani/core-be/commit/b4f7a67cc2072c9510f63906b2b1ec50ae114f92))
* **docker:** refresh apk index so base-image security patches install ([#607](https://github.com/nikunjmavani/core-be/issues/607)) ([a3690b9](https://github.com/nikunjmavani/core-be/commit/a3690b91f2f61f48f837553c74890e5d358fbec3))
* **docker:** worker HEALTHCHECK honors WORKER_HEALTH_PORT at runtime (reaudit-[#8](https://github.com/nikunjmavani/core-be/issues/8)) ([3530bff](https://github.com/nikunjmavani/core-be/commit/3530bff1c5cb6a65e21cc0f507018211150236a3))
* **email-templates:** escape URL fields in invitation and magic-link templates ([#364](https://github.com/nikunjmavani/core-be/issues/364)) ([26c67fa](https://github.com/nikunjmavani/core-be/commit/26c67fac20bff7ccf765c6d93a6264e35ebee079))
* **events:** capture swallowed event-bus errors in Sentry ([2a30d84](https://github.com/nikunjmavani/core-be/commit/2a30d845482dadbe97dd922a4bc54e974105655a))
* **events:** release commit-dispatch marker on rollback (in-memory leak) ([#324](https://github.com/nikunjmavani/core-be/issues/324)) ([7e3ec55](https://github.com/nikunjmavani/core-be/commit/7e3ec559455954d9aeb489e69c4bf416801d76d3))
* **finding-13:** escape title/preheader/footerText inside baseTemplate ([8996b26](https://github.com/nikunjmavani/core-be/commit/8996b2616b52de6f55b0b16315c4a439034e3fba))
* **finding-46:** validate DATABASE_HTTP_STATEMENT_TIMEOUT_MS stays within permission cache lock TTL ([#356](https://github.com/nikunjmavani/core-be/issues/356)) ([47bdab4](https://github.com/nikunjmavani/core-be/commit/47bdab435f83a307cc04f4dc8274f5407aeb8ad3))
* **finding-62:** export WEBHOOK_DELIVERY_JOB_ATTEMPTS and fix vi.mock factories ([#357](https://github.com/nikunjmavani/core-be/issues/357)) ([cd24515](https://github.com/nikunjmavani/core-be/commit/cd24515fa2acf75774da7d636ea42bc0212ec3a2))
* **finding-74:** replace unsafe Stripe object casts with proper type narrowing ([#359](https://github.com/nikunjmavani/core-be/issues/359)) ([f8f9cfe](https://github.com/nikunjmavani/core-be/commit/f8f9cfe8ae24f51ff34c92100dd31b2d1f7745fe))
* **infra:** throw on startup when monolithic worker pool demand exceeds DATABASE_POOL_MAX ([faf2fab](https://github.com/nikunjmavani/core-be/commit/faf2fab638f0b77d1ea82dd856d3cefefa893711))
* **infra:** use correct JWT env keys in docker-compose smoke profile (sec-r4-C5) ([#512](https://github.com/nikunjmavani/core-be/issues/512)) ([c9a48f1](https://github.com/nikunjmavani/core-be/commit/c9a48f107f0f89fe41814c253e4d3defc0595437))
* **lockfile:** regenerate pnpm-lock.yaml (merge produced duplicate mapping key) ([c2eba7e](https://github.com/nikunjmavani/core-be/commit/c2eba7eb879f20ee0b5ff182c5edf1ca64715308))
* **mail:** scrub secret-bearing body on terminally-failed outbox rows (audit-[#10](https://github.com/nikunjmavani/core-be/issues/10)) ([61dc948](https://github.com/nikunjmavani/core-be/commit/61dc948505b0eb6e4e7c60020d66a7c3663452bb))
* **mcp:** apply STRICT_AUTHED_RATE_LIMIT to MCP endpoint (audit finding [#7](https://github.com/nikunjmavani/core-be/issues/7)) ([#366](https://github.com/nikunjmavani/core-be/issues/366)) ([6783141](https://github.com/nikunjmavani/core-be/commit/6783141ed14cc7009e1ec2be258386fac1706ed3))
* **mcp:** strip X-Organization-Id from call_api proxied sub-requests (route-[#8](https://github.com/nikunjmavani/core-be/issues/8)) ([d5a7167](https://github.com/nikunjmavani/core-be/commit/d5a716716e8acff86e1523641e3f44620374411c))
* **migration:** make audit_logs_actor_api_key FK idempotent (unblock dev deploy) ([#385](https://github.com/nikunjmavani/core-be/issues/385)) ([b8cc4fb](https://github.com/nikunjmavani/core-be/commit/b8cc4fb70d3d3d13f31f4b67af35772ff5afdb7e))
* **migration:** make core_be_app least-privilege ALTER ROLE Neon-safe (unblocks all deploys) ([#341](https://github.com/nikunjmavani/core-be/issues/341)) ([488c793](https://github.com/nikunjmavani/core-be/commit/488c793ee93173a2b7d1cedb32879743c3136533))
* **notify:** cap webhook response body bytes read before truncation (audit-[#6](https://github.com/nikunjmavani/core-be/issues/6)) ([0f2421e](https://github.com/nikunjmavani/core-be/commit/0f2421e3b6b211f888f08a0161274063d7599cc1))
* **notify:** durability-first notification email dedup to stop lost emails (audit-[#7](https://github.com/nikunjmavani/core-be/issues/7)) ([b9d9759](https://github.com/nikunjmavani/core-be/commit/b9d9759885b92320210d681520ecc16236d70d2c))
* **notify:** durable mail-outbox dedupe key to close concurrent duplicate-email window (reaudit-[#4](https://github.com/nikunjmavani/core-be/issues/4)) ([47cd280](https://github.com/nikunjmavani/core-be/commit/47cd280504c9acdf324b2ff11ff4ca36ded05a1c))
* **notify:** enforce webhook secret-rotation eligibility in the update predicate (audit-[#9](https://github.com/nikunjmavani/core-be/issues/9)) ([d3337e0](https://github.com/nikunjmavani/core-be/commit/d3337e0c3ad3e314206cce494c23e6b644c90d03))
* **notify:** guard webhook secret re-rotation within the dual-sign overlap window ([0cfedd0](https://github.com/nikunjmavani/core-be/commit/0cfedd0d28177f40f354133a3d1f53b94002e955))
* **notify:** guard webhook secret re-rotation within the dual-sign overlap window (route-audit webhook-[#1](https://github.com/nikunjmavani/core-be/issues/1)) ([5c16f85](https://github.com/nikunjmavani/core-be/commit/5c16f8548c7c528944d937c60fe985ee887e8174))
* **notify:** route webhook handlers through zodApplication type provider ([eaa5684](https://github.com/nikunjmavani/core-be/commit/eaa5684c13253e6f5c7204a7dc8b479e4c9c5465))
* **notify:** sec-new-B2 replace bigserial with public_id in X-Webhook-Delivery-Id header ([#494](https://github.com/nikunjmavani/core-be/issues/494)) ([771954a](https://github.com/nikunjmavani/core-be/commit/771954a360383fcb797e38a6ea55b07d2055790c))
* **notify:** sec-new-D4 add status=PENDING filter to fallback SELECT in webhook delivery ([#488](https://github.com/nikunjmavani/core-be/issues/488)) ([164c6f8](https://github.com/nikunjmavani/core-be/commit/164c6f8a0bebbc89f0bb47d0b432e0db0bf453d7))
* **notify:** sec-new-N1 validate webhookId path param in all webhook handlers ([#482](https://github.com/nikunjmavani/core-be/issues/482)) ([d66099e](https://github.com/nikunjmavani/core-be/commit/d66099e00764f935260de97560e60529d61d5e53))
* **notify:** stamp webhook updated_at as greatest(created_at, now()) to fix chk_webhooks_updated flake ([988d87b](https://github.com/nikunjmavani/core-be/commit/988d87baf86a74ebb05ba9d81948e205ffcda2e3))
* **notify:** trim payload and response_body from webhook delivery list (sec-r4-D6) ([#518](https://github.com/nikunjmavani/core-be/issues/518)) ([89c24b7](https://github.com/nikunjmavani/core-be/commit/89c24b7f05dba72eba97447f746abb08130c61f6))
* **observability:** monitor every retention worker DLQ + add drift guard (reaudit-[#5](https://github.com/nikunjmavani/core-be/issues/5)) ([0e954dc](https://github.com/nikunjmavani/core-be/commit/0e954dcfe96a4c2d46c48815e963632468243236))
* **openapi:** registry-authoritative success statuses; deterministic OAuth coverage; scan cleanups ([a7cc7bd](https://github.com/nikunjmavani/core-be/commit/a7cc7bdeb47f4d9d5f5a18465470d8a9b2b86c67))
* **openapi:** registry-authoritative success statuses; deterministic OAuth coverage; scan cleanups ([1f84793](https://github.com/nikunjmavani/core-be/commit/1f84793ff6f149d7a759ac0223fb45a5d28d1942))
* **ops:** log circuit-breaker resets for attribution (route-[#5](https://github.com/nikunjmavani/core-be/issues/5)) ([eae48fe](https://github.com/nikunjmavani/core-be/commit/eae48fe4e9c937f7ca65d219acacb55832a1b218))
* **queue:** acknowledge commit-dispatch tasks after execution, not before (reaudit-[#2](https://github.com/nikunjmavani/core-be/issues/2)) ([8f399c0](https://github.com/nikunjmavani/core-be/commit/8f399c0ddaed24901f6c92445091770286c7a852))
* **queue:** bound audit.dead_letter_jobs growth via the audit-retention purge ([#322](https://github.com/nikunjmavani/core-be/issues/322)) ([06e729d](https://github.com/nikunjmavani/core-be/commit/06e729ddba34ce6d47ac3f2f7d73ad54910800a2))
* **queue:** bound commandTimeout on BullMQ producer connections (audit-[#5](https://github.com/nikunjmavani/core-be/issues/5)) ([2c4e21b](https://github.com/nikunjmavani/core-be/commit/2c4e21bf12dedc6039a0f0085379e80e8a83fee2))
* **queue:** monitor the offboarding-reconciler DLQ + exempt it from tenant-scoping policy (audit-[#15](https://github.com/nikunjmavani/core-be/issues/15)) ([f5f4ceb](https://github.com/nikunjmavani/core-be/commit/f5f4cebfbf7cc99072c06c0b7588d7c3eb4289fc))
* **queue:** sec-new-Q1 add env overrides for hardcoded cron schedules ([#484](https://github.com/nikunjmavani/core-be/issues/484)) ([d2d03e1](https://github.com/nikunjmavani/core-be/commit/d2d03e1c6a41861a22965a0c57707b8157ce66da))
* **queue:** sec-new-Q2 capture per-task failures in Sentry in recovery processor ([#485](https://github.com/nikunjmavani/core-be/issues/485)) ([b66a7a6](https://github.com/nikunjmavani/core-be/commit/b66a7a68ed27dc357b83b010e4778991fb198242))
* **queue:** stop DLQ auto-retry starvation via a resolved marker on exhausted rows ([#330](https://github.com/nikunjmavani/core-be/issues/330)) ([86c3817](https://github.com/nikunjmavani/core-be/commit/86c381769b50262e30687506b0c9ebeec9a739d9))
* **rate-limit,observability:** scope org rate-limit + error context by the org claim ([5e12926](https://github.com/nikunjmavani/core-be/commit/5e12926e869e17a3bd66e71a3d7ec87b98119132))
* **rate-limit,observability:** scope org rate-limit + error context by the org token claim ([b2caeb1](https://github.com/nikunjmavani/core-be/commit/b2caeb1be96e8fde9631028c4b92e047b14d433d))
* **rls:** pin core_be_app to NOSUPERUSER/NOBYPASSRLS + assert RLS-binding ([#334](https://github.com/nikunjmavani/core-be/issues/334)) ([18f8b9a](https://github.com/nikunjmavani/core-be/commit/18f8b9aa6f0ae44d45208dabf270a6c5a52c60ec))
* route-audit state-machine, billing, and cache-header findings ([d4b34ef](https://github.com/nikunjmavani/core-be/commit/d4b34ef388184860aece138aa10716b226562158))
* route-focused security audit findings ([1fffbf0](https://github.com/nikunjmavani/core-be/commit/1fffbf0270b20b7fdbeef5d0f3d86528e4fb11a5))
* **runtime:** real-world deep-flow inspection findings — 3 fixes + regression test ([#533](https://github.com/nikunjmavani/core-be/issues/533)) ([5a85ecd](https://github.com/nikunjmavani/core-be/commit/5a85ecd7d19303cb45231ec2d73082dfd6d4e631))
* **sec:** account-deletion safety — invalidate verification tokens + revoke-before-purge (sec-U1+U8) ([#404](https://github.com/nikunjmavani/core-be/issues/404)) ([43a1e5a](https://github.com/nikunjmavani/core-be/commit/43a1e5aedc49cd19f2e082febeb9b247a6bea3cf))
* **sec:** add captchaPreHandler to POST /mfa/login (sec-new-A1) ([85d2a89](https://github.com/nikunjmavani/core-be/commit/85d2a892decb1cf9e882922188633de6ffdea5c0))
* **sec:** add captchaPreHandler to POST /mfa/login (sec-new-A1) ([f2c02db](https://github.com/nikunjmavani/core-be/commit/f2c02db0212721ec29b99633f455f36f8e9f23c9))
* **sec:** add closeUserDataExportQueue to worker shutdown sequence (sec-r4-R1) ([#501](https://github.com/nikunjmavani/core-be/issues/501)) ([6e8e96f](https://github.com/nikunjmavani/core-be/commit/6e8e96ff11af4819d22cfb34df5b27f125518cbd))
* **sec:** add deleted_at guards to org-discovery RLS and invitation lookup (sec-r4-T1/T2) ([#500](https://github.com/nikunjmavani/core-be/issues/500)) ([b4ea6ee](https://github.com/nikunjmavani/core-be/commit/b4ea6ee0969cd5ff8da76b7abb68823e711d5939))
* **sec:** add partial index for audit.logs.actor_api_key_id (sec-D8) ([#432](https://github.com/nikunjmavani/core-be/issues/432)) ([761f28b](https://github.com/nikunjmavani/core-be/commit/761f28b96207265002e24ad2f263da00ff97eb99))
* **sec:** audit append-only DB invariant — split tenant-isolation policy + REVOKE UPDATE (sec-U3) ([#409](https://github.com/nikunjmavani/core-be/issues/409)) ([7991dfc](https://github.com/nikunjmavani/core-be/commit/7991dfc486ed22eff946b346982285c1f87fee65))
* **sec:** audit every data-export URL mint, rate-limit GET, drop TTL 24h→15min (sec-U6) ([#429](https://github.com/nikunjmavani/core-be/issues/429)) ([4943057](https://github.com/nikunjmavani/core-be/commit/4943057037519b0c294e4e46405d202008083973))
* **sec:** audit every login surface, not just password (sec-A8) ([#427](https://github.com/nikunjmavani/core-be/issues/427)) ([9872491](https://github.com/nikunjmavani/core-be/commit/9872491ad9ee8271d3a063738dd3b1423013095c))
* **sec:** audit hygiene — denylist metadata strip + admin user-mgmt audit + admin audit-read audit + permission-deny audit (sec-U2+U9+U4+U13) ([#408](https://github.com/nikunjmavani/core-be/issues/408)) ([98e60ff](https://github.com/nikunjmavani/core-be/commit/98e60ff889e7c94d716aaf235c0b782d05bd4a8f))
* **sec:** audit login failures alongside successes on every login surface (sec-A8 follow-up) ([#438](https://github.com/nikunjmavani/core-be/issues/438)) ([e4a9c2f](https://github.com/nikunjmavani/core-be/commit/e4a9c2f88925653cf12910efbb6258ba2c7c1d73))
* **sec:** audit serializer is strip-only with resolved public ids (sec-re-08) ([#458](https://github.com/nikunjmavani/core-be/issues/458)) ([5a07fdb](https://github.com/nikunjmavani/core-be/commit/5a07fdb15f4706478587523c96f090a92a8a3ce1))
* **sec:** auth defense in depth — last login-method guard + super-admin rederive + step-up on session revoke (sec-A5+A6+A7) ([#407](https://github.com/nikunjmavani/core-be/issues/407)) ([021c4b3](https://github.com/nikunjmavani/core-be/commit/021c4b31ce8d3c619f48ebcf43e4393ad2cf9b3d))
* **sec:** bind audit-list pagination cursor to its minting filter set (sec-U12) ([#434](https://github.com/nikunjmavani/core-be/issues/434)) ([f6a40e2](https://github.com/nikunjmavani/core-be/commit/f6a40e2db1fc34916c236f5fc3a478d5d09020df))
* **sec:** block update() on org-owner membership to prevent Admin lockout (sec-new-T1) ([dfa526a](https://github.com/nikunjmavani/core-be/commit/dfa526a03dafa3ddae99029e34651aeffa979d51))
* **sec:** block update() on org-owner membership to prevent Admin lockout (sec-new-T1) ([c3c6cfe](https://github.com/nikunjmavani/core-be/commit/c3c6cfe24145ab0cc3e63fe8a8d3d1a20d5a7642))
* **sec:** breach compression-skip actually engages in production (sec-re-03) ([#454](https://github.com/nikunjmavani/core-be/issues/454)) ([5039ccd](https://github.com/nikunjmavani/core-be/commit/5039ccd0699dac287c89a94b85e9c6a4f630c25e))
* **sec:** build Stripe customer email from a platform-owned domain, not tenant slug (sec-B11) ([#436](https://github.com/nikunjmavani/core-be/issues/436)) ([8bb5338](https://github.com/nikunjmavani/core-be/commit/8bb533845fcf074150dc3796e2038dcab01df372))
* **sec:** cache the i18n preHandler organization → locale lookup (sec-M1) ([#440](https://github.com/nikunjmavani/core-be/issues/440)) ([180937a](https://github.com/nikunjmavani/core-be/commit/180937a42a83ec058d0e66823c534db54270cf73))
* **sec:** collapse unmatched-route Prometheus label into __unmatched__ sentinel (sec-C2) ([#401](https://github.com/nikunjmavani/core-be/issues/401)) ([5fc8743](https://github.com/nikunjmavani/core-be/commit/5fc87432500a76271dc867df7b68851e5e68ed74))
* **sec:** config + middleware hardening (sec-cm batch) ([#449](https://github.com/nikunjmavani/core-be/issues/449)) ([b150253](https://github.com/nikunjmavani/core-be/commit/b15025363ad4af584a93572f1a0afb5dc76f1e4f))
* **sec:** config cleanup — drop JWT_SECRET + add deps:audit:prod to ci:local + ENABLE_RESPONSE_ENCRYPTION pairing refine (sec-C5+C10+C11) ([#419](https://github.com/nikunjmavani/core-be/issues/419)) ([7cab170](https://github.com/nikunjmavani/core-be/commit/7cab17038463c7a568e36c48f4c10acc0e6235f3))
* **sec:** cors exposes x-client-request-id (sec-re-17) ([#467](https://github.com/nikunjmavani/core-be/issues/467)) ([8960cfc](https://github.com/nikunjmavani/core-be/commit/8960cfcc13b33e6abb222631ff5de62f3b1d9a7b))
* **sec:** data-export request route advertises 15-minute URL lifetime (sec-re-12) ([#462](https://github.com/nikunjmavani/core-be/issues/462)) ([bc7cea3](https://github.com/nikunjmavani/core-be/commit/bc7cea3c096583e338e25edca4d58d59616718c4))
* **sec:** db retention growth — verification token sweep + AUDIT_RETENTION_DAYS cap (sec-D5+U10) ([#415](https://github.com/nikunjmavani/core-be/issues/415)) ([ab9428b](https://github.com/nikunjmavani/core-be/commit/ab9428b5a5cd93a24ce283f8598dd318e0e0ef03))
* **sec:** db stability — drop volatile chk_org_notif_muted + worker statement_timeout + audit.logs target_user_id index (sec-D1+D2+D3) ([#414](https://github.com/nikunjmavani/core-be/issues/414)) ([f77ce4a](https://github.com/nikunjmavani/core-be/commit/f77ce4aee1366eaa1ff82da6575b5011dd382ca5))
* **sec:** delete dead findActiveByUserId / findActiveByOrganizationId (sec-D12) ([#437](https://github.com/nikunjmavani/core-be/issues/437)) ([6367dd4](https://github.com/nikunjmavani/core-be/commit/6367dd45ca44614f1e0a2d10fd2dfdf0df9f390e))
* **sec:** derive invitation email from membership user on create (sec-T1 complete) ([#471](https://github.com/nikunjmavani/core-be/issues/471)) ([6d54c99](https://github.com/nikunjmavani/core-be/commit/6d54c99a15cd6c1dc48ec3b1c6357c540db4bf29))
* **sec:** dlq replay no-op + commit-dispatch cleanup + worker hardening (sec-q batch) ([#444](https://github.com/nikunjmavani/core-be/issues/444)) ([6c96a0b](https://github.com/nikunjmavani/core-be/commit/6c96a0bb1c47d016d87735cbe16ee173e7de19c4))
* **sec:** do not clear session cookie in revokeAllSessions handler (sec-r4-A1) ([#499](https://github.com/nikunjmavani/core-be/issues/499)) ([b7e3952](https://github.com/nikunjmavani/core-be/commit/b7e395262f8ec06a84a5426b9c4a9dafa85ec351))
* **sec:** docker.agent USER node + drop openssh + enforce abort timeout on retrieveStripeEvent (sec-C8 + sec-Q5 partial) ([#422](https://github.com/nikunjmavani/core-be/issues/422)) ([d10af52](https://github.com/nikunjmavani/core-be/commit/d10af524ec39a00994b041f7727d18cc6e81639b))
* **sec:** document the online-safe ALTER COLUMN pattern (sec-D6) ([#443](https://github.com/nikunjmavani/core-be/issues/443)) ([c72deb4](https://github.com/nikunjmavani/core-be/commit/c72deb4e3f9b7cdaba267b14948fd73025dce3e3))
* **sec:** document verification_tokens application-trust safety model (sec-D9) ([#441](https://github.com/nikunjmavani/core-be/issues/441)) ([e069891](https://github.com/nikunjmavani/core-be/commit/e069891909cd0487a4cd5ab523930f8b0d6e105d))
* **sec:** drop org branch from user_notification_preferences RLS + add CHECK pin (sec-U7) ([#428](https://github.com/nikunjmavani/core-be/issues/428)) ([13fc188](https://github.com/nikunjmavani/core-be/commit/13fc188e22603b55f3226994399e5564e50f5843))
* **sec:** enforce SSE-S3 on every server-side S3 write (sec-U11) ([#435](https://github.com/nikunjmavani/core-be/issues/435)) ([0792d76](https://github.com/nikunjmavani/core-be/commit/0792d76c07ece878f8adc1f282f1966efbe54ae7))
* **sec:** expose policy public_id instead of bigserial in URLs and responses (sec-T5) ([#442](https://github.com/nikunjmavani/core-be/issues/442)) ([88d5db7](https://github.com/nikunjmavani/core-be/commit/88d5db72bc21184da5ea00ec0baaa0256d0f03a9))
* **sec:** extend staging guards to ALLOWED_ORIGINS, COOKIE_SECURE, and SECRETS_ENCRYPTION_KEY (sec-r4-C1/C2/C3) ([#498](https://github.com/nikunjmavani/core-be/issues/498)) ([0efd169](https://github.com/nikunjmavani/core-be/commit/0efd169841cea7cfba5197012dfb6e3f615fe629))
* **sec:** fall back to INSERT when subscription.created arrives before local row (sec-B9) ([#439](https://github.com/nikunjmavani/core-be/issues/439)) ([fd68e66](https://github.com/nikunjmavani/core-be/commit/fd68e660e7d19d1707b0bfe97ac4fe29d08ab427))
* **sec:** harden invitation binding, webhook retry, role invariants, and upload key contract ([#470](https://github.com/nikunjmavani/core-be/issues/470)) ([65cdf2f](https://github.com/nikunjmavani/core-be/commit/65cdf2f9179ac01aa1110f95b60cb6a7fd1519db))
* **sec:** invitation accept requires auth + invitee email match (sec-T4) ([#423](https://github.com/nikunjmavani/core-be/issues/423)) ([7cdc3f8](https://github.com/nikunjmavani/core-be/commit/7cdc3f83beafaa9e682bf39348cb1caa4047c2fb))
* **sec:** mark-confirmed-by-internal-id filters deleted_at and pending (sec-re-13) ([#463](https://github.com/nikunjmavani/core-be/issues/463)) ([dbd9156](https://github.com/nikunjmavani/core-be/commit/dbd9156fd40ff4e2e92ab6ace5823b2e60279e60))
* **sec:** mfa hardening — step-up requires mfa + per-session binding + org-policy delete guard (sec-A1+A2+A4) ([#403](https://github.com/nikunjmavani/core-be/issues/403)) ([1ba5047](https://github.com/nikunjmavani/core-be/commit/1ba504726442aaaea626d2b73f542c55b8214d0a))
* **sec:** mfa is_mfa_enabled flip happens inside the enrollConfirm transaction (sec-re-06) ([#469](https://github.com/nikunjmavani/core-be/issues/469)) ([675c1f2](https://github.com/nikunjmavani/core-be/commit/675c1f257bb02ecf3967a3295ff1f6d1068da136))
* **sec:** mfa re-enroll dedups stale totp factors (sec-re-04) ([#455](https://github.com/nikunjmavani/core-be/issues/455)) ([f7a66ab](https://github.com/nikunjmavani/core-be/commit/f7a66abb8218a13bbf92472ba3fc0c3e26ab6f3e))
* **sec:** middleware observability — captcha bypass closed in staging + HSTS env gate + ALLOWED_ORIGINS canonicalization + encryption 503 (sec-M3+M5+M8+M9) ([#417](https://github.com/nikunjmavani/core-be/issues/417)) ([57abed9](https://github.com/nikunjmavani/core-be/commit/57abed9c55fa7fc50c72b1161e8270b5a64b024f))
* **sec:** notification worker user context + db integrity indexes (sec-d batch) ([#450](https://github.com/nikunjmavani/core-be/issues/450)) ([a1a8fe5](https://github.com/nikunjmavani/core-be/commit/a1a8fe5c15fd5b3c4b8437413ef40e5b4efeb821))
* **sec:** notification worker user-context fix is live wiring (sec-re-01) ([#452](https://github.com/nikunjmavani/core-be/issues/452)) ([653adf5](https://github.com/nikunjmavani/core-be/commit/653adf5653b634dcf907927ad4f6a660256f8a79))
* **sec:** notify abuse caps — per-organization webhook cap + secret-rotation overlap window (sec-N4+N8) ([#411](https://github.com/nikunjmavani/core-be/issues/411)) ([a7455f5](https://github.com/nikunjmavani/core-be/commit/a7455f5548d20fe8460b92154e17b2ca75eda24a))
* **sec:** notify durability — worker re-checks disabled/deleted + delivery-id header + event_key dedupe (sec-N1+N3+N2) ([#410](https://github.com/nikunjmavani/core-be/issues/410)) ([c09ae6c](https://github.com/nikunjmavani/core-be/commit/c09ae6c7acad9de05fe7c28f365ba9af84795c16))
* **sec:** notify recipient + idempotency canonical fingerprint + tenant authorized-org helper (sec-N7+M6+M7) ([#420](https://github.com/nikunjmavani/core-be/issues/420)) ([17a8bbd](https://github.com/nikunjmavani/core-be/commit/17a8bbdc9d364eb9b5bfa5f71d0ffbe86e30645e))
* **sec:** org-scoped audit log sanitiser + strip-only serializers (sec-t batch) ([#448](https://github.com/nikunjmavani/core-be/issues/448)) ([6019182](https://github.com/nikunjmavani/core-be/commit/6019182b695080795d232d7afe04b96659ff34d2))
* **sec:** protect owner role from permission writes via ROLE_MANAGE (sec-T2) ([#402](https://github.com/nikunjmavani/core-be/issues/402)) ([6b11b6e](https://github.com/nikunjmavani/core-be/commit/6b11b6e6da7e825d48d7348b50576861a5fc4cbc))
* **sec:** queue infrastructure — defaultJobOptions on cron queues + flip topology warn + fail boot on scheduler drift in prod (sec-Q1+Q2+Q3) ([#416](https://github.com/nikunjmavani/core-be/issues/416)) ([32b960e](https://github.com/nikunjmavani/core-be/commit/32b960e03cc6a164d137dc080f583846b93635a9))
* **sec:** rate-limit per-email bucket id is hashed (sec-re-11) ([#461](https://github.com/nikunjmavani/core-be/issues/461)) ([4239be4](https://github.com/nikunjmavani/core-be/commit/4239be4ddb5d3432295565b4bb8e110612e97012))
* **sec:** recovery-code alphabet doc reflects 31 symbols and case-insensitive hash (sec-re-14) ([#464](https://github.com/nikunjmavani/core-be/issues/464)) ([1bc8b00](https://github.com/nikunjmavani/core-be/commit/1bc8b001519154b9e5da12abf4a4d808b12cd9d8))
* **sec:** refresh stale ordering comments around the no-op RLS-transaction plugin (sec-M4) ([#433](https://github.com/nikunjmavani/core-be/issues/433)) ([1bd211e](https://github.com/nikunjmavani/core-be/commit/1bd211e288ac062486e9374667e1619401e4f666))
* **sec:** refresh-token reuse detection fires for revoked sessions (sec-re-05) ([#456](https://github.com/nikunjmavani/core-be/issues/456)) ([bf5ee5e](https://github.com/nikunjmavani/core-be/commit/bf5ee5e30c0233d13a0f28d0b9b2afff4df0da4c))
* **sec:** remove privilege-bypass arms from audit.logs INSERT RLS (sec-r4-D1) ([#497](https://github.com/nikunjmavani/core-be/issues/497)) ([787b3c8](https://github.com/nikunjmavani/core-be/commit/787b3c8d20ebb37f97ef9cd2d27aa66f992df7c3))
* **sec:** replace z.coerce.boolean() foot-gun on env booleans (sec-C1) ([#400](https://github.com/nikunjmavani/core-be/issues/400)) ([f8a49c3](https://github.com/nikunjmavani/core-be/commit/f8a49c367e9bbc5cdc7e54e9d9c988e4dbe13bca))
* **sec:** repository hygiene — atomic markAllRead count + WebAuthn counter monotonicity guard (sec-D10/D11) ([#426](https://github.com/nikunjmavani/core-be/issues/426)) ([1d817db](https://github.com/nikunjmavani/core-be/commit/1d817db6ded2820f9334b31d05ca4e4b23ae30b2))
* **sec:** require caller can grant target role permissions on membership create (sec-T1) ([#399](https://github.com/nikunjmavani/core-be/issues/399)) ([899aab3](https://github.com/nikunjmavani/core-be/commit/899aab3abcf9de727a8b0e7fe3ecdcb7ad14d654))
* **sec:** require caller to hold every code added or removed on role-permission PUT (sec-T2) ([#425](https://github.com/nikunjmavani/core-be/issues/425)) ([b9b545e](https://github.com/nikunjmavani/core-be/commit/b9b545ee4de3c1b36bd05a8d80e8ebce8f497565))
* **sec:** require live-mode + both-or-neither Stripe keys in production (sec-B5/B6) ([#424](https://github.com/nikunjmavani/core-be/issues/424)) ([2ca7f2c](https://github.com/nikunjmavani/core-be/commit/2ca7f2cdb4e411275f465164b91ae2099f98a395))
* **sec:** role-delete guards + strip is_system from createMemberRoleDto (sec-T3) ([#406](https://github.com/nikunjmavani/core-be/issues/406)) ([1b41ab9](https://github.com/nikunjmavani/core-be/commit/1b41ab98cfaedfb11a7f5f3c87c26106e8bc2373))
* **sec:** sentry/log redaction + observability — OTLP https refine + readyz verbose env gate + Sentry message/exception/user redaction + LOG_LEVEL enum (sec-C3+C4+C6+C9) ([#418](https://github.com/nikunjmavani/core-be/issues/418)) ([b0337ce](https://github.com/nikunjmavani/core-be/commit/b0337ce2ad6f21ac16b0c97fccda158e7c64dd55))
* **sec:** stripe event retrieve honours per-attempt timeout for real (sec-re-15) ([#465](https://github.com/nikunjmavani/core-be/issues/465)) ([d5640da](https://github.com/nikunjmavani/core-be/commit/d5640daf8c1bacf06e9ca92894ac4d97a9945fe3))
* **sec:** stripe ingress durability + ordering + raw-body wiring (sec-b batch) ([#446](https://github.com/nikunjmavani/core-be/issues/446)) ([8a88beb](https://github.com/nikunjmavani/core-be/commit/8a88beb6cd7ea43f4cf42d034f2a37ba6a241d9e))
* **sec:** stripe reclaim cron→worker handoff is recoverable (sec-re-02) ([#453](https://github.com/nikunjmavani/core-be/issues/453)) ([3cdce4f](https://github.com/nikunjmavani/core-be/commit/3cdce4fcaabf0b6895b73c4feb412f0edd451080))
* **sec:** stripe reconciliation — close 4 silent-divergence paths (sec-B1+B2+B3+B4) ([#405](https://github.com/nikunjmavani/core-be/issues/405)) ([87ab3fb](https://github.com/nikunjmavani/core-be/commit/87ab3fb998f712f5a1b033708c1d65b9ba4c8b82))
* **sec:** subscription response surfaces plan public id (sec-re-07) ([#457](https://github.com/nikunjmavani/core-be/issues/457)) ([537325c](https://github.com/nikunjmavani/core-be/commit/537325c9f8f71a7e7452db8126bcb5517c8b2b1b))
* **sec:** sync local plan_id from Stripe customer.subscription.updated (sec-B7) ([#430](https://github.com/nikunjmavani/core-be/issues/430)) ([bc5a21a](https://github.com/nikunjmavani/core-be/commit/bc5a21ae87d6c253ad7094e752859fe254492d0e))
* **sec:** tenant context lifts the worker statement_timeout (sec-re-16) ([#466](https://github.com/nikunjmavani/core-be/issues/466)) ([415a58e](https://github.com/nikunjmavani/core-be/commit/415a58eb3a4c8c2334d8bcd5649f1348fdf9f455))
* **sec:** tombstoneAllByOrganizationId removes S3 objects synchronously (sec-UP8) ([#421](https://github.com/nikunjmavani/core-be/issues/421)) ([186bd71](https://github.com/nikunjmavani/core-be/commit/186bd711303862d3386cc6f7391ef0dd73928613))
* **sec:** two-phase mfa enrollment + refresh reuse-detection + login uniformity (sec-a batch) ([#445](https://github.com/nikunjmavani/core-be/issues/445)) ([d1e1e59](https://github.com/nikunjmavani/core-be/commit/d1e1e593bcf31c515f22fb1e2c4d07a89c76e81c))
* **sec:** upload confirm pins copy to verified etag (sec-re-10) ([#460](https://github.com/nikunjmavani/core-be/issues/460)) ([2eb3d11](https://github.com/nikunjmavani/core-be/commit/2eb3d11ca070c52c0e4fcf2cc5c5c0c391573837))
* **sec:** upload security — refuse legacy in-place + sweep refuses SVG + assertKeyConfirmedForOwner + DOMPurify hardening (sec-UP1+UP2+UP5+UP6) ([#412](https://github.com/nikunjmavani/core-be/issues/412)) ([76e80ad](https://github.com/nikunjmavani/core-be/commit/76e80ad3617b7d87f57fc292c6e41efba7f89d89))
* **sec:** upload size/policy — organizationId regex + org pending cap + force presigned POST in prod (sec-UP3+UP4+UP10) ([#413](https://github.com/nikunjmavani/core-be/issues/413)) ([237d517](https://github.com/nikunjmavani/core-be/commit/237d517905e321c9c73c1e9cc8f9fa181a73a597))
* **security:** add maxItems array bounds and fix WebAuthn type casts ([#363](https://github.com/nikunjmavani/core-be/issues/363)) ([ab4e7c7](https://github.com/nikunjmavani/core-be/commit/ab4e7c7c6fb65f374c458b18ef7b8b5927b0e77d))
* **security:** fail closed on privileged re-derivation + bound all retention settings (audit-[#16](https://github.com/nikunjmavani/core-be/issues/16), [#14](https://github.com/nikunjmavani/core-be/issues/14)) ([65a4347](https://github.com/nikunjmavani/core-be/commit/65a4347972c7d029600559f69a080fc611bc555d))
* **security:** mark recovery-codes + presigned-URL responses no-store / non-cacheable (route-audit-[#3](https://github.com/nikunjmavani/core-be/issues/3)) ([bc67eed](https://github.com/nikunjmavani/core-be/commit/bc67eed1cc521709b36e4eca38289310276ff922))
* **security:** reject JWT tokens with unknown kid when keyring is active ([#347](https://github.com/nikunjmavani/core-be/issues/347)) ([2bedfa1](https://github.com/nikunjmavani/core-be/commit/2bedfa1fc7bfe30ebe07e3529cfe8b7c8c78a15d))
* **security:** remediate all 16 findings from the 2026-06-14 dev security audit ([01a22aa](https://github.com/nikunjmavani/core-be/commit/01a22aa5f83fbd1f784039a98b5ac4eda151efdb))
* **security:** remediate all 16 findings from the 2026-06-14 dev security audit ([#600](https://github.com/nikunjmavani/core-be/issues/600)) ([01a22aa](https://github.com/nikunjmavani/core-be/commit/01a22aa5f83fbd1f784039a98b5ac4eda151efdb))
* **security:** require explicit wildcard prefix for webhook allowlist subdomain matching ([8d79c89](https://github.com/nikunjmavani/core-be/commit/8d79c891b2a88a8a44cca1420535cfcc6a567a12))
* **security:** strip privileged headers from MCP call_api and remove unversioned aliases ([#348](https://github.com/nikunjmavani/core-be/issues/348)) ([cdaf9ce](https://github.com/nikunjmavani/core-be/commit/cdaf9cef188e146b090bf411dc21e803c53ddea7))
* **security:** strip Stripe-shaped literals from source + add regression test (GH secret-scanning) ([#529](https://github.com/nikunjmavani/core-be/issues/529)) ([f234e60](https://github.com/nikunjmavani/core-be/commit/f234e6044879c72385e3b61728ea4ba665931ae6))
* **security:** untrack agent-os/mcp/mcp.json and repair stale ai/ paths ([#560](https://github.com/nikunjmavani/core-be/issues/560)) ([b3547a4](https://github.com/nikunjmavani/core-be/commit/b3547a43172e2388c0a1a2e4fa8e0388d046b4c6))
* **sec:** validate membership and api-key path params at the boundary (sec-re-18) ([#468](https://github.com/nikunjmavani/core-be/issues/468)) ([c0ab171](https://github.com/nikunjmavani/core-be/commit/c0ab17106d8e7dd27513e3bf2f76a480775fd557))
* **sec:** validate subscriptionId path param at every billing handler (sec-B10) ([#431](https://github.com/nikunjmavani/core-be/issues/431)) ([2bbd338](https://github.com/nikunjmavani/core-be/commit/2bbd33864cd192a22d5d41f70ed7064a628a3809))
* **sec:** webhook secret strength + upload sweep file_key invariant + data-export doc (sec-up batch) ([#447](https://github.com/nikunjmavani/core-be/issues/447)) ([145c838](https://github.com/nikunjmavani/core-be/commit/145c8385ec8b02c25b0b508adbabd71c2ce8dc05))
* **setup:** activate pinned Node on PATH in agent bootstrap step 1 ([#649](https://github.com/nikunjmavani/core-be/issues/649)) ([968d54f](https://github.com/nikunjmavani/core-be/commit/968d54fae13b6e8cb9c40c39e565c116739dd479))
* **storage:** distinguish S3 not-found from transient failure (audit-[#5](https://github.com/nikunjmavani/core-be/issues/5)) ([5ba8d00](https://github.com/nikunjmavani/core-be/commit/5ba8d002a05a423b8a2e8b99e4f23c29a1d79e51))
* **storage:** enforce SSE-S3 on presigned uploads (sec-r4-E1) ([#509](https://github.com/nikunjmavani/core-be/issues/509)) ([f962d37](https://github.com/nikunjmavani/core-be/commit/f962d372565e05986fb00a2cef960694b4b35885))
* **storage:** serve public media via a distribution and refuse public URLs for private keys (audit-[#13](https://github.com/nikunjmavani/core-be/issues/13)) ([cc10be0](https://github.com/nikunjmavani/core-be/commit/cc10be00c43a9891bff17bfc097f9ba50c5a165d))
* **stripe:** tighten webhook replay window to 150 s (audit finding [#6](https://github.com/nikunjmavani/core-be/issues/6)) ([#365](https://github.com/nikunjmavani/core-be/issues/365)) ([848360d](https://github.com/nikunjmavani/core-be/commit/848360d739857212d1822c6e9e4564498649b5c3))
* **tenancy,notify:** atomic role-delete, webhook clock-skew, security_policy proto guard (route-audit C2, C3, C4) ([ddf4f35](https://github.com/nikunjmavani/core-be/commit/ddf4f35762595f2318930855bf1bfccaba3a30ed))
* **tenancy,notify:** make per-scope resource caps atomic with an advisory lock (audit-[#8](https://github.com/nikunjmavani/core-be/issues/8)) ([3681133](https://github.com/nikunjmavani/core-be/commit/3681133339f47f68570aaf54f773ae8c5964238b))
* **tenancy,security:** post-flatten audit corrections — idempotency claim scope + personal-org guards ([e105372](https://github.com/nikunjmavani/core-be/commit/e10537260c541131a4386bb37570653242fcc41b))
* **tenancy,security:** post-flatten audit corrections — idempotency claim scope, personal-org guards, dead-code cleanup ([018fb31](https://github.com/nikunjmavani/core-be/commit/018fb313308ea78843d22df4dd234dc41dea1190))
* **tenancy:** bound MemberRolePermissionRepository.findByRoleId rows per role (sec-r4-D4) ([#508](https://github.com/nikunjmavani/core-be/issues/508)) ([9218518](https://github.com/nikunjmavani/core-be/commit/92185187cd5397f4f349442626a936f55e718b7b))
* **tenancy:** emit public ids (not internal bigserial ids) in membership responses ([#329](https://github.com/nikunjmavani/core-be/issues/329)) ([3aac2ac](https://github.com/nikunjmavani/core-be/commit/3aac2ac13d072c1f41bf71bd296468de63d73b3c))
* **tenancy:** exclude soft-deleted orgs from organizations_tenant_isolation RLS policy (sec-new-D3) ([#491](https://github.com/nikunjmavani/core-be/issues/491)) ([904802a](https://github.com/nikunjmavani/core-be/commit/904802affcc95bea74e6f510b64c655ccbd46df0))
* **tenancy:** only activate INVITED memberships on invitation accept (route-audit-[#1](https://github.com/nikunjmavani/core-be/issues/1)) ([aeea26a](https://github.com/nikunjmavani/core-be/commit/aeea26af9f5346fdbf4c7dd38745de90d8951b14))
* **tenancy:** rate-limit membership lifecycle endpoints (sec-r4-I3) ([#505](https://github.com/nikunjmavani/core-be/issues/505)) ([1f0c8c0](https://github.com/nikunjmavani/core-be/commit/1f0c8c01d38bbaa6020b8a8cab7e3d5b0657b0b7))
* **tenancy:** rate-limit organization mutation endpoints (sec-r4-I2) ([#504](https://github.com/nikunjmavani/core-be/issues/504)) ([2f6bedb](https://github.com/nikunjmavani/core-be/commit/2f6bedb59ca27d9d11c68299560470d8f0418d77))
* **tenancy:** reject prototype-pollution keys in organization security_policy (route-audit hardening) ([b1eba43](https://github.com/nikunjmavani/core-be/commit/b1eba43d872fe1ff7e018edd45eb42c10f67fa3f))
* **tenancy:** revoke a removed member's API keys on membership removal (reaudit-[#7](https://github.com/nikunjmavani/core-be/issues/7)) ([1387bd3](https://github.com/nikunjmavani/core-be/commit/1387bd306046d439b5f52840e4b45ae0f0794037))
* **tenancy:** scale permission-cache stampede poll budget to lock TTL (audit-[#9](https://github.com/nikunjmavani/core-be/issues/9)) ([5322d0f](https://github.com/nikunjmavani/core-be/commit/5322d0fae4dc9043f3563eda431d880ccab74f97))
* **tenancy:** sec-new-M1 add STRICT_AUTHED_RATE_LIMIT to POST /organizations ([#477](https://github.com/nikunjmavani/core-be/issues/477)) ([dd9fd62](https://github.com/nikunjmavani/core-be/commit/dd9fd62112aefe4eaa63869ab6c37ac62ee8540c))
* **tenancy:** sec-new-T2 validate invitationId path param in all invitation handlers ([#480](https://github.com/nikunjmavani/core-be/issues/480)) ([93fa940](https://github.com/nikunjmavani/core-be/commit/93fa940a7d371acd95889257b027075d305d1e60))
* **tenancy:** sec-new-T3 validate id and roleId path params in role handlers ([#481](https://github.com/nikunjmavani/core-be/issues/481)) ([361159a](https://github.com/nikunjmavani/core-be/commit/361159aca4126ae5df7b446dd437c199082a9636))
* **tenancy:** throttle api-key last_used_at writes (audit-[#8](https://github.com/nikunjmavani/core-be/issues/8)) ([96b3e56](https://github.com/nikunjmavani/core-be/commit/96b3e562e136892ff44e5adf2f06009bdcce5a06))
* **tests:** align e2e fixtures with audit batch2 (WebAuthn typed DTO) + Stripe items.period ([#384](https://github.com/nikunjmavani/core-be/issues/384)) ([b906731](https://github.com/nikunjmavani/core-be/commit/b906731f9fdfb6813303c3f25a0ce148a1e2023a))
* **tests:** cleanupDatabase preserves schema_migrations; update tests inherited from main's B4 + sec-r4-A1 semantics ([#525](https://github.com/nikunjmavani/core-be/issues/525)) ([169327e](https://github.com/nikunjmavani/core-be/commit/169327ec7652cefd7301b8d0c1c47009caa9ae5e))
* three pre-existing dev post-merge CI failures (migration idempotency, Stripe Date bind, permission seed) ([#614](https://github.com/nikunjmavani/core-be/issues/614)) ([798cefe](https://github.com/nikunjmavani/core-be/commit/798cefe26f59b8f56c3987f437772d707a42e364))
* **upload:** add DTO-level fileSize ceiling (sec-r4-I4) ([#515](https://github.com/nikunjmavani/core-be/issues/515)) ([049f917](https://github.com/nikunjmavani/core-be/commit/049f917c71b8c043e39bbbcd40f93eec534994fc))
* **upload:** lock the organization pending-upload quota at the org scope (audit-[#7](https://github.com/nikunjmavani/core-be/issues/7)) ([171a0fc](https://github.com/nikunjmavani/core-be/commit/171a0fc4c618c93c4bc74aafe0c3ec45f6376b74))
* **upload:** reclaim orphaned avatar/logo objects + owner-binding + purpose/target check (L1/L2/L3) ([7ffef76](https://github.com/nikunjmavani/core-be/commit/7ffef768a889cab424139e42cab34e7f055f6bb9))
* **upload:** reclaim orphaned avatar/logo objects, wire owner-binding gate, validate purpose-target (route-audit L1, L2, L3) ([d9d9738](https://github.com/nikunjmavani/core-be/commit/d9d97381082b330d32843511d29e8823fde2cb56))
* **user-data-export:** bound offboarding S3 delete fan-out (sec-r4-R2) ([#513](https://github.com/nikunjmavani/core-be/issues/513)) ([6ef83de](https://github.com/nikunjmavani/core-be/commit/6ef83de5039fcb08bd4422ad04cfc4282ee53bd4))
* **user:** block admin suspend/delete of protected super-admins (route-[#1](https://github.com/nikunjmavani/core-be/issues/1)) ([b84259d](https://github.com/nikunjmavani/core-be/commit/b84259d3f6cbb34ffb2f8617e900aa0157fc5fae))
* **user:** block deleting a user who still owns organizations (route-audit-[#2](https://github.com/nikunjmavani/core-be/issues/2) follow-up) ([f94b7c9](https://github.com/nikunjmavani/core-be/commit/f94b7c9c0c95d1525ea31fe41e44970efe452f19))
* **user:** rate-limit /me profile mutation endpoints (sec-r4-I1) ([#503](https://github.com/nikunjmavani/core-be/issues/503)) ([0c745e1](https://github.com/nikunjmavani/core-be/commit/0c745e182c0c6be2de608f42e9c434212ad07c08))
* **user:** rate-limit admin user-management mutations (route-[#4](https://github.com/nikunjmavani/core-be/issues/4)) ([a0d8114](https://github.com/nikunjmavani/core-be/commit/a0d8114b28fc1730fbc982271018d64700569537))
* **user:** reject org-scoped notification preference with 400 (was raw 42501 -&gt; 500) ([#327](https://github.com/nikunjmavani/core-be/issues/327)) ([db1e7a7](https://github.com/nikunjmavani/core-be/commit/db1e7a77e3c8f464bd8354f1235a1f33c5c71967))
* **user:** sec-new-U1 cap ListUsersDto.after cursor to 512 chars ([#483](https://github.com/nikunjmavani/core-be/issues/483)) ([fae555d](https://github.com/nikunjmavani/core-be/commit/fae555dd2717a4cde9a703f64941cca09d55e33f))
* **user:** unique notification-preference natural key + input dedupe (audit-[#11](https://github.com/nikunjmavani/core-be/issues/11)) ([6805459](https://github.com/nikunjmavani/core-be/commit/68054599b5fb2a120c6fb8571f23a76dc9277e7a))
* validators (audit follow-up) — centralize AES_GCM_IV_LENGTH, allowlist 5 and 512, env-load sunset validator ([#378](https://github.com/nikunjmavani/core-be/issues/378)) ([3bae917](https://github.com/nikunjmavani/core-be/commit/3bae917577c65d11cf771725f81392a0a62ce904))


### Performance

* parallelize S3 object deletes in deleteAllExportsForUser ([#361](https://github.com/nikunjmavani/core-be/issues/361)) ([4c36173](https://github.com/nikunjmavani/core-be/commit/4c36173e703bfaa9737ed2a529f0e28e8f863046))


### Changed

* **api:** rename inbound Idempotency-Key header to X-Idempotency-Key ([#656](https://github.com/nikunjmavani/core-be/issues/656)) ([b595c1b](https://github.com/nikunjmavani/core-be/commit/b595c1b0ed35a9248f1dd53660c7b3afb849eee4))
* **api:** semantic snake_case params, prefixed public ids, uniform status policy, documented headers ([03820fb](https://github.com/nikunjmavani/core-be/commit/03820fb407116e2532f2afdf12133861b8c58497))
* **api:** semantic snake_case route params, prefixed public ids, uniform method-status policy, documented headers ([3311bc0](https://github.com/nikunjmavani/core-be/commit/3311bc022f65fcbd517802cc91dcb194d5a31c0c))
* **architecture:** move raw SQL out of stripe-webhook-organization.util into the repository (+ global gate) ([#530](https://github.com/nikunjmavani/core-be/issues/530)) ([f48fb46](https://github.com/nikunjmavani/core-be/commit/f48fb46fe1005a95adc0abf14222df8f86c030f9))
* **billing:** remove deprecated /stripe/webhook alias ([#670](https://github.com/nikunjmavani/core-be/issues/670)) ([e0a4c8b](https://github.com/nikunjmavani/core-be/commit/e0a4c8bfac04fcbe041c6b6c1e47a5585d411820))
* **constants:** centralize scope-localized config constants ([#667](https://github.com/nikunjmavani/core-be/issues/667)) ([f6dad66](https://github.com/nikunjmavani/core-be/commit/f6dad66887513bd519c020794526b3b32c8c728a))
* enforce architecture boundaries (DB-in-services, DI, controller thinness) ([#602](https://github.com/nikunjmavani/core-be/issues/602)) ([cc43b3b](https://github.com/nikunjmavani/core-be/commit/cc43b3b3f38cd94d190928ac6728f1077195bbbf))
* **quality:** clear SonarQube debt on the deployed surface ([#663](https://github.com/nikunjmavani/core-be/issues/663)) ([8f5116a](https://github.com/nikunjmavani/core-be/commit/8f5116a5ddb29ac435078922ed7188ca4f6f1df3))
* **queue:** remove redundant alert-only offboarding reconciler ([#611](https://github.com/nikunjmavani/core-be/issues/611)) ([55e979e](https://github.com/nikunjmavani/core-be/commit/55e979e10528a3b6c794aaea1595e7feeedbc7b6))
* route consistency + personal/team org model ([#658](https://github.com/nikunjmavani/core-be/issues/658)) ([d304b88](https://github.com/nikunjmavani/core-be/commit/d304b88439d8611d7b7d668f4b0d1f15c9a7a2dc))
* **tenancy:** route org-scoped controllers through claim-aware org accessor ([f4c3b54](https://github.com/nikunjmavani/core-be/commit/f4c3b54f70b5c9c49c2a03cf908f1407810138a8))
* **tenancy:** route org-scoped controllers through claim-aware org accessor ([af30b20](https://github.com/nikunjmavani/core-be/commit/af30b20e50b8c49f3c906bbbb1ca6d4093fd14ef))
* **validation:** extract shared parseWithSchema + parseCursorPaginatedQuery helpers ([#661](https://github.com/nikunjmavani/core-be/issues/661)) ([7831156](https://github.com/nikunjmavani/core-be/commit/78311567eb27b6676b63fa3dec89ab3d1bab3130))


### Documentation

* add 2026-06-04 deep audit report (20 findings) ([6515589](https://github.com/nikunjmavani/core-be/commit/65155899935406e72781fab5348f146b20b5b8e4))
* add deep backend audit report 2026-06-03 ([#362](https://github.com/nikunjmavani/core-be/issues/362)) ([3d7ae31](https://github.com/nikunjmavani/core-be/commit/3d7ae31779c7975b4b61d19c8f7867c8a58432a9))
* add remediation status tracker to 2026-06-03 audit report ([93ef121](https://github.com/nikunjmavani/core-be/commit/93ef12150cd3917f3a6ecc46c9e8da4573ada94b))
* **agent-os:** align schema skills to varchar(n) codebase convention ([#638](https://github.com/nikunjmavani/core-be/issues/638)) ([e575074](https://github.com/nikunjmavani/core-be/commit/e5750743e7a8af7a59eebd06d552ca8223a598d1))
* **agent-os:** correct stale workflow, seed, and provider paths in skills ([#641](https://github.com/nikunjmavani/core-be/issues/641)) ([5550f4c](https://github.com/nikunjmavani/core-be/commit/5550f4c274b58403008bb98dd4982642565ed110))
* **api:** add frontend auth & headers integration guide ([b8ca013](https://github.com/nikunjmavani/core-be/commit/b8ca01362c4a04aa8d65e511cac136a0953b2445))
* **api:** add frontend auth & headers integration guide ([ab201e8](https://github.com/nikunjmavani/core-be/commit/ab201e8046a524ad2f5dd9868e22897d77aaf2a9))
* **audit-2026-06-04:** mark all 20 findings resolved with file:line citations ([#381](https://github.com/nikunjmavani/core-be/issues/381)) ([96dd4f7](https://github.com/nikunjmavani/core-be/commit/96dd4f74574b1dca6ee93190b59edc56ab414b1e))
* check in sync; enricher unit tests + full suite (4,516) green. ([c58d39b](https://github.com/nikunjmavani/core-be/commit/c58d39b0aa550158d3106a41fadd403c203eb4c5))
* check verified green on 0.28.1. ([514fa96](https://github.com/nikunjmavani/core-be/commit/514fa961bd392ef4583c7e148a7f47277ef23dae))
* check, tsdoc 0/0, migrate lint, env sync, validate all pass. ([3311bc0](https://github.com/nikunjmavani/core-be/commit/3311bc022f65fcbd517802cc91dcb194d5a31c0c))
* consolidate setup guide into single root SETUP.md ([#555](https://github.com/nikunjmavani/core-be/issues/555)) ([5c311a3](https://github.com/nikunjmavani/core-be/commit/5c311a3c72f1fb33cb44daa087e94ee19e2edb1c))
* **env:** standardize OPTIONAL marker for conditionally-empty env keys ([#549](https://github.com/nikunjmavani/core-be/issues/549)) ([d7155b4](https://github.com/nikunjmavani/core-be/commit/d7155b48786aee7a8ce2e306133b61398f00cf20))
* **infra:** annotate Dockerfile build-stage ENV as test-only placeholders (sec-r4-C6) ([#519](https://github.com/nikunjmavani/core-be/issues/519)) ([cdf76ef](https://github.com/nikunjmavani/core-be/commit/cdf76ef7e6a85de7e638c161d1e7ad34dd12e38a))
* **integrations:** add Codex Cloud agent environment guide and GitHub prerequisites ([#660](https://github.com/nikunjmavani/core-be/issues/660)) ([d2128de](https://github.com/nikunjmavani/core-be/commit/d2128de716f1f19c25d934c87ecb517baf05d04e))
* **integrations:** add Postman + Resend agent MCP servers ([#631](https://github.com/nikunjmavani/core-be/issues/631)) ([6966744](https://github.com/nikunjmavani/core-be/commit/6966744da40ff9887700f433f78afc1f8f313140))
* **integrations:** common Claude Code session-setup overview ([#674](https://github.com/nikunjmavani/core-be/issues/674)) ([9052152](https://github.com/nikunjmavani/core-be/commit/90521520c34495a066342656f1ba104beb827f54))
* **integrations:** expand Stripe webhook runbook + Turnstile TODO ([#635](https://github.com/nikunjmavani/core-be/issues/635)) ([be08946](https://github.com/nikunjmavani/core-be/commit/be08946a84175689883f858e61e96b928e8c222d))
* **integrations:** fix Stripe CLI/Dashboard webhook URL ([#630](https://github.com/nikunjmavani/core-be/issues/630)) ([570e58f](https://github.com/nikunjmavani/core-be/commit/570e58f79991d12dcf75781ccdc9465da2647b85))
* **integrations:** map third-party services to CLI/MCP/SDK by consumer ([#626](https://github.com/nikunjmavani/core-be/issues/626)) ([5e90f52](https://github.com/nikunjmavani/core-be/commit/5e90f522061e5de8f31cb2905b9edda43caf2bf9))
* **openapi:** drop "Public ID" from request-body/query field descriptions → "id" ([3cb01a0](https://github.com/nikunjmavani/core-be/commit/3cb01a0b294a1a47a80a25a209ab410403e38117))
* **openapi:** drop "Public ID" from request-body/query field descriptions → "id" ([c58d39b](https://github.com/nikunjmavani/core-be/commit/c58d39b0aa550158d3106a41fadd403c203eb4c5))
* **process:** add release-versioning cheat-sheet (commit prefix → bump) ([#612](https://github.com/nikunjmavani/core-be/issues/612)) ([6e58397](https://github.com/nikunjmavani/core-be/commit/6e58397013279da347bf5a56305e150ea1cc8e26))
* **process:** document "watch CI -&gt; merge when green" in git flow + pr-babysit ([#616](https://github.com/nikunjmavani/core-be/issues/616)) ([0537a8e](https://github.com/nikunjmavani/core-be/commit/0537a8e86fc135038585d78b523e648cbc289e69))
* **reviews:** add agent-os AI-tooling audit + evals session writeup ([ef55c53](https://github.com/nikunjmavani/core-be/commit/ef55c536b406a3b1aea5df055c844bd4159c7a78))
* **reviews:** agent-os AI-tooling audit + evals/enforcement session writeup ([32288fa](https://github.com/nikunjmavani/core-be/commit/32288fa07f7e0b3caa92b5325ec51938b95be557))
* **reviews:** architecture conformance audit + 8-PR follow-up plan ([#531](https://github.com/nikunjmavani/core-be/issues/531)) ([4a9264c](https://github.com/nikunjmavani/core-be/commit/4a9264cb674f57930241a8b348d12afdcc727476))
* **reviews:** correct sec-r4-A3 analysis and defer to follow-up task ([#523](https://github.com/nikunjmavani/core-be/issues/523)) ([c7e1dab](https://github.com/nikunjmavani/core-be/commit/c7e1dab9433b40eb16a7df6e28fdf317df9318b7))
* **reviews:** route-coverage audit — 129 routes, 9 deferred gaps allowlisted ([#534](https://github.com/nikunjmavani/core-be/issues/534)) ([d18ec1d](https://github.com/nikunjmavani/core-be/commit/d18ec1df87b78237c77bac6f84b1ec464ff71965))
* **runbooks:** refresh worker registry breakdown to 30 workers / 27 Postgres ([#621](https://github.com/nikunjmavani/core-be/issues/621)) ([2d4d111](https://github.com/nikunjmavani/core-be/commit/2d4d111a9578679c856367881c16a5f6d8f62cb6))
* **superpowers:** re-audit remediation design spec for 18 findings ([#451](https://github.com/nikunjmavani/core-be/issues/451)) ([1b05734](https://github.com/nikunjmavani/core-be/commit/1b05734fe69e593ae6ad9f5fb2f11e6f4a8f69f6))

## [4.6.0](https://github.com/nikunjmavani/core-be/compare/v4.5.0...v4.6.0) (2026-06-18)


### Added

* 131-route security & production-flow audit — fix all RED/AMBER findings ([#601](https://github.com/nikunjmavani/core-be/issues/601)) ([3df1fbd](https://github.com/nikunjmavani/core-be/commit/3df1fbd91ea9011a6378a6f0785200e4a5f990ed))
* **agent-os:** add PreToolUse edit-guard and SessionStart hooks ([dcf6335](https://github.com/nikunjmavani/core-be/commit/dcf6335773cb9b8d15f570d7b2afac9e2a1a284c))
* **agent-os:** add RLS/tenant-isolation and idempotency guard skills ([a94cbb5](https://github.com/nikunjmavani/core-be/commit/a94cbb52df397f1abadf3a3f411f31bf2fc6f49a))
* **agent-os:** PreToolUse edit-guard + SessionStart hooks (Move 2) ([ad2e2b3](https://github.com/nikunjmavani/core-be/commit/ad2e2b3b87051c2fe34d3005d6a84fc6e37965e0))
* **agent-os:** RLS/tenant-isolation + idempotency guard skills ([0a3b902](https://github.com/nikunjmavani/core-be/commit/0a3b902748f4fc3e84d5d971b0915496b5e4f440))
* **ai:** cross-platform AI commands, SessionStart hook, and guardrails ([#643](https://github.com/nikunjmavani/core-be/issues/643)) ([b6fccf1](https://github.com/nikunjmavani/core-be/commit/b6fccf1630257d2920ba3831f625bbeeca7cad41))
* **audit:** transactional outbox for audit.logs writes (P0-[#2](https://github.com/nikunjmavani/core-be/issues/2)) ([#557](https://github.com/nikunjmavani/core-be/issues/557)) ([4c337da](https://github.com/nikunjmavani/core-be/commit/4c337da6b81523c01d23bf8947226194ee9ad665))
* **auth:** add switch-to-personal and switch-to-organization endpoints ([79be5b0](https://github.com/nikunjmavani/core-be/commit/79be5b0fe799563e9612eaa3fc48a4a12f3ce2ae))
* **auth:** carry active organization + session version as signed JWT claims ([9864a2e](https://github.com/nikunjmavani/core-be/commit/9864a2e34917837b7102fdd72f9ba61982e4b0e0))
* **auth:** GET /auth/me/context — frontend-ready effective context ([#659](https://github.com/nikunjmavani/core-be/issues/659)) ([d08bb35](https://github.com/nikunjmavani/core-be/commit/d08bb35049c443015b3d53be0f13c7a80f4a845a))
* **auth:** mint the active-organization claim at login (default selection) ([a3a805d](https://github.com/nikunjmavani/core-be/commit/a3a805dc143b7af537c0757b4b74bfc77516d75d))
* **auth:** permission layer falls back to the org token claim (Phase 3 bridge) ([ea07091](https://github.com/nikunjmavani/core-be/commit/ea0709135504d09faa6367bfded88107cc438295))
* **auth:** permission layer reads the org token claim (Phase 3 bridge) ([6b9e7c3](https://github.com/nikunjmavani/core-be/commit/6b9e7c3458f6788b5c75b0ed4a49d3709b48d181))
* **auth:** refresh re-mints the active-organization claim ([b22f0a1](https://github.com/nikunjmavani/core-be/commit/b22f0a1712aa76b1f997257997b157025712b791))
* **auth:** switch building blocks — membership-validation resolvers + session token re-bind ([62cc944](https://github.com/nikunjmavani/core-be/commit/62cc9449314b7684007c937a9ec72b73c2d0eceb))
* **auth:** switchToOrganization / switchToPersonal service methods ([3f5ecc8](https://github.com/nikunjmavani/core-be/commit/3f5ecc84267e747d6e6d900ae5caf733f6255752))
* **billing:** flatten subscription routes onto the org token claim ([f835d60](https://github.com/nikunjmavani/core-be/commit/f835d605e0529e0e0e91ca7da1b16aa5f8940bec))
* **billing:** flatten subscription routes onto the org token claim ([df21c2c](https://github.com/nikunjmavani/core-be/commit/df21c2c62c4b65e4f1bf57228743ac2cd042a92c))
* **ci:** add PR-time Trivy IaC misconfig scan ([#388](https://github.com/nikunjmavani/core-be/issues/388)) ([e8499e0](https://github.com/nikunjmavani/core-be/commit/e8499e04b8c8d311a14fb6ac3bdd1c4a4d151a49))
* **config:** gated local-dev defaults for DB/Redis/origins/retention ([#651](https://github.com/nikunjmavani/core-be/issues/651)) ([773e427](https://github.com/nikunjmavani/core-be/commit/773e427ca11bd44d1a65fea996ebbc92a629c236))
* **infra-tests:** drop_index_without_concurrently lint rule + org slug collision-proof factory ([#526](https://github.com/nikunjmavani/core-be/issues/526)) ([0915c85](https://github.com/nikunjmavani/core-be/commit/0915c851ab7b5c8934a06108d28f8aec3662e97b))
* **load:** per-VU credential pool + realistic user-journey k6 scenario ([#342](https://github.com/nikunjmavani/core-be/issues/342)) ([a05a611](https://github.com/nikunjmavani/core-be/commit/a05a611ced68683c0855c65d572fbc5fc7d06bb1))
* **mcp,k6:** client auth-flow guide + k6 org-claim flow; fix dead idempotency exclusions ([f4bac5a](https://github.com/nikunjmavani/core-be/commit/f4bac5aa9a67f14e5ec87209e326e67b5ae15de6))
* **mcp,k6:** client auth-flow guide + k6 org-claim flow; fix idempotency exclusions; flatten stale refs ([f6e5894](https://github.com/nikunjmavani/core-be/commit/f6e5894a66cee5de1ff0790f5898b5510fd74f37))
* **mcp:** scope project MCP servers and wire MCP setup into the session-start flow ([#675](https://github.com/nikunjmavani/core-be/issues/675)) ([9ed07b4](https://github.com/nikunjmavani/core-be/commit/9ed07b4ba576db0ac5849d9c7de76b4c2c91af73))
* **notify:** flatten webhook routes onto the org token claim ([643d13a](https://github.com/nikunjmavani/core-be/commit/643d13ad09bd64e28bca029e4ed42cc40b56d04f))
* **notify:** flatten webhook routes onto the org token claim ([0bdc8ad](https://github.com/nikunjmavani/core-be/commit/0bdc8add9f37df2bd944995368be8d9f94710755))
* **notify:** time-based retention for webhook_delivery_attempts (audit-[#3](https://github.com/nikunjmavani/core-be/issues/3)) ([05d6325](https://github.com/nikunjmavani/core-be/commit/05d63258002fd9762962498b0a5059a5b971400f))
* **observability:** emit Server-Timing header for true server-side latency ([#339](https://github.com/nikunjmavani/core-be/issues/339)) ([5e78cde](https://github.com/nikunjmavani/core-be/commit/5e78cde15b30deac077cbf4e27081cf6da27e814))
* **openapi:** document the full error-status matrix; observed-vs-spec error gate ([95a71b5](https://github.com/nikunjmavani/core-be/commit/95a71b505c9d8d7f802d73c4e0841b4140bf836d))
* **openapi:** document the full error-status matrix; observed-vs-spec error gate ([5a001de](https://github.com/nikunjmavani/core-be/commit/5a001de48bb661e048e012dde8ce658bfe612f3e))
* **openapi:** embed sanitized live-call request/response examples per route and status ([3a1ddb1](https://github.com/nikunjmavani/core-be/commit/3a1ddb1e5d38b40e18b9300a14942219da6ce868))
* **openapi:** embed sanitized live-call request/response examples per route and status ([bea574c](https://github.com/nikunjmavani/core-be/commit/bea574c92291f96bd309ad1969fe38cdf756722f))
* personal & team organizations — foundation + token/switch (Phase 1-2) ([9a8b179](https://github.com/nikunjmavani/core-be/commit/9a8b179a097b615b2e7292ad6f6362011ea2563c))
* **round-5-followup:** per-org row caps (api-keys, member-roles, notification-policies) + auth/MFA route policy tests ([#528](https://github.com/nikunjmavani/core-be/issues/528)) ([19b556f](https://github.com/nikunjmavani/core-be/commit/19b556f9379a3d70889644356e9928a68de549e9))
* **round-5:** residual-risk findings — DLQ-RLS bug + 5 backlog fixes + 3 test gaps + audit doc ([#527](https://github.com/nikunjmavani/core-be/issues/527)) ([6aa6f88](https://github.com/nikunjmavani/core-be/commit/6aa6f8831e12fa7c8ef88f3d95f9e15bcd2d23d2))
* **scalar:** publish OpenAPI to Scalar Registry (CI docs pipeline + interactive setup) ([#672](https://github.com/nikunjmavani/core-be/issues/672)) ([3ddc9b2](https://github.com/nikunjmavani/core-be/commit/3ddc9b2325a8cc8417bfe679c748a64f5c510da2))
* **tenancy:** atomic org provisioning with owner role+permissions+membership ([266b22e](https://github.com/nikunjmavani/core-be/commit/266b22ebeb3604dbc45d08608efd7604df37c81e))
* **tenancy:** auto-provision personal org at signup + exclude personal from delete guard ([9daed03](https://github.com/nikunjmavani/core-be/commit/9daed03c85997744bbfeb50919681de5658cd556))
* **tenancy:** block invitations on a personal organization (capability matrix) ([cafc549](https://github.com/nikunjmavani/core-be/commit/cafc5493d497f7e99a924a152ca6a64e4f29dd0d))
* **tenancy:** cap team organizations per owner (anti-abuse) ([f71b968](https://github.com/nikunjmavani/core-be/commit/f71b968577aa19a8ce4c3b4f6ce83142c3fd51d3))
* **tenancy:** flatten organization routes onto the org token claim ([ddd1a76](https://github.com/nikunjmavani/core-be/commit/ddd1a7604f7da6dfb3a878fdb28c9e35dff086d8))
* **tenancy:** flatten organization routes onto the org token claim ([f35b74e](https://github.com/nikunjmavani/core-be/commit/f35b74eb0f14cf2e5225b3fb477ea686a82763ed))
* **tenancy:** make the personal organization immutable (no delete / no transfer) ([a726064](https://github.com/nikunjmavani/core-be/commit/a726064b5f009c1a5ccd878fe8379eb79a533a37))
* **tenancy:** org-creation per-owner cap + personal-org capability guards ([94d7715](https://github.com/nikunjmavani/core-be/commit/94d77153740b2076afb57ded14748b727367617c))
* **tenancy:** organization create accepts type + nullable slug (provisioning groundwork) ([35bc409](https://github.com/nikunjmavani/core-be/commit/35bc409c7e85453a2d294f1baf4bd38b19e26d6f))
* **tenancy:** personal-org backfill script + provisioning tests ([5a40f5d](https://github.com/nikunjmavani/core-be/commit/5a40f5d5eadfd970e712b8d4b5a7f85b86258727))
* **tenancy:** personal/team organization foundation — schema + capability flags ([11e23d9](https://github.com/nikunjmavani/core-be/commit/11e23d92fc301307638f73e3e1269a0612ddde3d))
* **testing:** route success-status registry, observed coverage ratchet, never-5xx fuzz gate ([8d88dcf](https://github.com/nikunjmavani/core-be/commit/8d88dcf0677104ce4885ad80d62543c6ec45052a))
* **testing:** route success-status registry, observed coverage ratchet, never-5xx fuzz gate ([dfe2b43](https://github.com/nikunjmavani/core-be/commit/dfe2b436d3fa28843597576d6b29f43d7932d8ab))
* **testing:** verified happy path for every route — budget 30→0; 201 creates; OAuth 404 ([01b1b77](https://github.com/nikunjmavani/core-be/commit/01b1b77cbf2f60dcafbfa1afeafab68fe1e54437))
* **testing:** verified happy path for every route — budget 30→0; 201 creates; OAuth 404 ([624c9d5](https://github.com/nikunjmavani/core-be/commit/624c9d58945e78317e39cd9a412e488454fbdf29))
* **tests:** post-load settle-and-assert-clean gate + audit-outbox drain coverage ([01258c5](https://github.com/nikunjmavani/core-be/commit/01258c5b5aa9c03f8d6e9c7c9a5218cd10d3750b))
* **tooling:** project identity refactor, 5 review agents, architecture policy tests ([#552](https://github.com/nikunjmavani/core-be/issues/552)) ([324689e](https://github.com/nikunjmavani/core-be/commit/324689e3c5027056932272f90d3495539d25ea44))
* **user:** add a scheduled reconciler that detects + alerts on stuck offboarding (audit-[#15](https://github.com/nikunjmavani/core-be/issues/15)) ([6443673](https://github.com/nikunjmavani/core-be/commit/64436733ec73792a3295b46ade51da2ceee98a53))
* **user:** expose deployment organization capabilities on /users/me ([a27f7a6](https://github.com/nikunjmavani/core-be/commit/a27f7a6d9a1a03a75e6163ab061e137d8a65e1d8))
* **user:** expose personal_organization_id on /users/me ([b725aca](https://github.com/nikunjmavani/core-be/commit/b725acad609f8a9743f2a199c4234df423ade3a5))


### Fixed

* 8th-audit concurrency races + correctness hardening (C1-C5) ([bf077b7](https://github.com/nikunjmavani/core-be/commit/bf077b743cfbe51549c39ca4d4ae28b824a1a6df))
* **api:** truthful error envelope, id-only external fields, DELETE→204 stragglers, local oasdiff gate ([25b4629](https://github.com/nikunjmavani/core-be/commit/25b46297b331681b528962246f8bee28c4695204))
* **api:** truthful error envelope, id-only external fields, DELETE→204 stragglers, local oasdiff gate ([2777308](https://github.com/nikunjmavani/core-be/commit/2777308d77c2938b0f66437a24a02b9637392b19))
* audit batch2 — WebAuthn typed DTOs, oasdiff SIGSEGV CI workaround ([6e44557](https://github.com/nikunjmavani/core-be/commit/6e4455700f39ed6cc6dee5ca71baf4eaddac49ed))
* **audit-13:** remove dead jobTimeout field from worker options — BullMQ does not enforce it ([#379](https://github.com/nikunjmavani/core-be/issues/379)) ([b393d5e](https://github.com/nikunjmavani/core-be/commit/b393d5e0add3e299de889d023056397a559b5df6))
* **audit:** cursor max-length, DLQ catch, jobTimeout, age-based queue eviction (batch5) ([#375](https://github.com/nikunjmavani/core-be/issues/375)) ([5882436](https://github.com/nikunjmavani/core-be/commit/588243618efe4be76f3b9e1d2b0c2aa851b06930))
* **audit:** MCP caller JWT forwarding and IP-level failed-login counter ([#373](https://github.com/nikunjmavani/core-be/issues/373)) ([ceee226](https://github.com/nikunjmavani/core-be/commit/ceee2269da8c40bb16f1332e56de8028de24b069))
* **audit:** omit soft-deleted orgs from audit-log public id resolution (sec-r4-D2) ([#506](https://github.com/nikunjmavani/core-be/issues/506)) ([e76a015](https://github.com/nikunjmavani/core-be/commit/e76a01530ed22da2e35d21f0080547075d0475d8))
* **audit:** rate limits, User-Agent truncation, webhook HTTPS, CAPTCHA staging (batch4) ([#374](https://github.com/nikunjmavani/core-be/issues/374)) ([4c9486a](https://github.com/nikunjmavani/core-be/commit/4c9486ac64959cea4bd308cb59c37ba858018066))
* **auth-webauthn:** require user verification at options time (sec-r4-A2) ([#514](https://github.com/nikunjmavani/core-be/issues/514)) ([38f60cf](https://github.com/nikunjmavani/core-be/commit/38f60cf8443a94ff327e95e6bad5d03d7bdf6947))
* **auth,openapi:** MFA-login org claim (H1) + captcha/bearerAuth OpenAPI accuracy ([909a5ce](https://github.com/nikunjmavani/core-be/commit/909a5ce448a362af445736e8a02cb2e18b7949b8))
* **auth,openapi:** mfa-login org claim (H1) plus captcha and bearerAuth openapi accuracy ([fc336b8](https://github.com/nikunjmavani/core-be/commit/fc336b867a9a597fb3c613aa0574a4b8e91bae60))
* **auth:** add user FK + index to mfa_methods to purge orphaned MFA secrets (reaudit-[#1](https://github.com/nikunjmavani/core-be/issues/1)) ([a5a0992](https://github.com/nikunjmavani/core-be/commit/a5a0992eb777f40851e2c97ac7c26ff371325c06))
* **auth:** atomic credential-mutation guards + lockout counter (route-audit C1, C5) ([e6e33db](https://github.com/nikunjmavani/core-be/commit/e6e33db37b405bf0c92622b3c152f35c88cbf186))
* **auth:** block revoking the current session via DELETE /me/sessions/:id (route-[#9](https://github.com/nikunjmavani/core-be/issues/9)) ([19f4bff](https://github.com/nikunjmavani/core-be/commit/19f4bff7ba7a651f630204a173f859dc40206d2b))
* **auth:** bounded refresh-token reuse grace for concurrent refreshes (audit-[#2](https://github.com/nikunjmavani/core-be/issues/2)) ([0cdd75d](https://github.com/nikunjmavani/core-be/commit/0cdd75dd8b85e880950b8a076fbadee39c01d18f))
* **auth:** close session-revoke cache repopulation race + normalize OAuth email (route-audit session-[#1](https://github.com/nikunjmavani/core-be/issues/1), oauth-[#3](https://github.com/nikunjmavani/core-be/issues/3)) ([b8303a0](https://github.com/nikunjmavani/core-be/commit/b8303a02e1e7010f9516e0e5c2df5b7777c83694))
* **auth:** close WebAuthn enumeration timing oracle + complete credential-mutation lock (route-audit D1, D2, D3) ([10e2b52](https://github.com/nikunjmavani/core-be/commit/10e2b5271c7cb454e15e99035389787e5c233c25))
* **auth:** drop SUPER_ADMIN for non-active accounts in per-request re-derive (reaudit-[#10](https://github.com/nikunjmavani/core-be/issues/10)) ([e54a97b](https://github.com/nikunjmavani/core-be/commit/e54a97bd1e643916ac3eb579eeda2dcdb1d26493))
* **auth:** fix controller unit test and ack OpenAPI breaking change for B4 ([48f8c81](https://github.com/nikunjmavani/core-be/commit/48f8c818fa14f205efe5a6e12d2528e8461f6790))
* **auth:** floor login failure branches to mask enumeration timing (audit-[#15](https://github.com/nikunjmavani/core-be/issues/15)d) ([0c4af59](https://github.com/nikunjmavani/core-be/commit/0c4af594c6aba8d84d383d20c01838ef6d134bf0))
* **auth:** key DELETE /mfa/:mfaMethodId on public id, not the sequential DB id (route-[#10](https://github.com/nikunjmavani/core-be/issues/10)) ([31bdd46](https://github.com/nikunjmavani/core-be/commit/31bdd46de650dce63aa6bc542beda50d57c0dea2))
* **auth:** make magic-link verification atomic with first-factor completion (audit-[#12](https://github.com/nikunjmavani/core-be/issues/12)) ([4350845](https://github.com/nikunjmavani/core-be/commit/435084506afc855e48169b8e26b3d87a1690f36a))
* **auth:** make MFA verification lockout counter atomic (route-audit-[#4](https://github.com/nikunjmavani/core-be/issues/4)) ([7d98218](https://github.com/nikunjmavani/core-be/commit/7d982183877aeea6cbc4531cea9eb47376c704fc))
* **auth:** make one-time-token issuance atomic with the mail-outbox insert (audit-[#11](https://github.com/nikunjmavani/core-be/issues/11)) ([f122beb](https://github.com/nikunjmavani/core-be/commit/f122beb20866aaf4748b05d29d2307f9a0768462))
* **auth:** make password change and email verification atomic with their side effects (audit-[#4](https://github.com/nikunjmavani/core-be/issues/4), [#12](https://github.com/nikunjmavani/core-be/issues/12)) ([42d7893](https://github.com/nikunjmavani/core-be/commit/42d7893572ee6e89c5bbe42a08cc18d1f33aa6e6))
* **auth:** make password reset atomic (transaction) so sessions can't survive it ([#319](https://github.com/nikunjmavani/core-be/issues/319)) ([30cffe5](https://github.com/nikunjmavani/core-be/commit/30cffe5c205fdd7d0f1a835cf335791ad78ad36e))
* **auth:** per-user MFA verification lockout (audit-[#12](https://github.com/nikunjmavani/core-be/issues/12)) ([d6331e0](https://github.com/nikunjmavani/core-be/commit/d6331e01f9a0d378096ecc26b30404f23fc20d7c))
* **auth:** persist and revalidate the active organization across refresh (audit-[#3](https://github.com/nikunjmavani/core-be/issues/3)) ([f9d8f1b](https://github.com/nikunjmavani/core-be/commit/f9d8f1b5a757c5b8dc5f267f4cf166f2e5677816))
* **auth:** re-derive any privileged JWT claim (admin + super_admin) against live state (route-[#6](https://github.com/nikunjmavani/core-be/issues/6)) ([956c43d](https://github.com/nikunjmavani/core-be/commit/956c43d855978ea9f49c573e4c8a498ae2c4309f))
* **auth:** remove silent params.id fallback in requireOrganizationPermission ([#346](https://github.com/nikunjmavani/core-be/issues/346)) ([17f4d83](https://github.com/nikunjmavani/core-be/commit/17f4d83fae5114820bf4f1c00940306628ea1228))
* **auth:** restore org-mandated MFA under FORCE RLS via SECURITY DEFINER resolvers ([#318](https://github.com/nikunjmavani/core-be/issues/318)) ([e152c0c](https://github.com/nikunjmavani/core-be/commit/e152c0c458aed788289c7d75b3e8fe0c79ec938f))
* **auth:** restrict POST /me/auth-methods to MAGIC_LINK to stop phantom-credential lockout (route-[#3](https://github.com/nikunjmavani/core-be/issues/3)) ([ee9af9a](https://github.com/nikunjmavani/core-be/commit/ee9af9a5819990189c658a69d9396e0fdb3ed7c5))
* **auth:** scope MFA lockout to TOTP so recovery codes stay usable (reaudit-[#3](https://github.com/nikunjmavani/core-be/issues/3)) ([a6d4b05](https://github.com/nikunjmavani/core-be/commit/a6d4b05530cd06f563be8a0ede17552d6831f4ac))
* **auth:** sec-new-A2 reject suspended/deleted users on bearer auth cache miss ([#474](https://github.com/nikunjmavani/core-be/issues/474)) ([eff74f4](https://github.com/nikunjmavani/core-be/commit/eff74f453a57f071258b8275aa850d375e6a67cc))
* **auth:** sec-new-A3 preserve caller session on DELETE /me/sessions ([#478](https://github.com/nikunjmavani/core-be/issues/478)) ([32936f3](https://github.com/nikunjmavani/core-be/commit/32936f3625022fcb98a3b2f681b6d19ee86a7611))
* **auth:** sec-new-A4 flip is_mfa_enabled inside deleteMfa transaction ([#479](https://github.com/nikunjmavani/core-be/issues/479)) ([a50d899](https://github.com/nikunjmavani/core-be/commit/a50d8995f7c42b08643d6a503b70971d24cbf6e9))
* **auth:** sec-new-B4 add public_id to auth_methods, stop leaking bigserial ids ([c82295d](https://github.com/nikunjmavani/core-be/commit/c82295d43b2768b8fb53160c26704e3dabadf4ce))
* **auth:** sec-new-B4 add public_id to auth_methods, stop leaking bigserial ids ([02a6ddd](https://github.com/nikunjmavani/core-be/commit/02a6ddd7b4dff060e87709bfa74dcd955a679228))
* **auth:** session-revoke cache repopulation race + OAuth email normalization ([c981c7f](https://github.com/nikunjmavani/core-be/commit/c981c7f634a1090faae6513d62aa30206e5e1778))
* **auth:** stop GET /auth/me/auth-methods leaking encrypted TOTP secret + PII ([#321](https://github.com/nikunjmavani/core-be/issues/321)) ([32cb49e](https://github.com/nikunjmavani/core-be/commit/32cb49e7b1c2039c2554adc481c2f68837720e6e))
* **auth:** switch-to-organization relies on route schema for body validation + suite green ([ab02f71](https://github.com/nikunjmavani/core-be/commit/ab02f711379690a987cf2cc7ab46139dc411adf8))
* **auth:** WebAuthn enumeration timing oracle + complete credential-mutation lock (D1/D2/D3) ([9a1f3f0](https://github.com/nikunjmavani/core-be/commit/9a1f3f0d5aef7156d4d455935f5295f20b76d257))
* backend production-readiness audit findings ([0f60e0f](https://github.com/nikunjmavani/core-be/commit/0f60e0f71d6dd0b1f7a5d9aa20bf60712c8a04cb))
* backend production-readiness re-audit findings ([6bd64bc](https://github.com/nikunjmavani/core-be/commit/6bd64bc3c47c7c28a1f1d42121867bc990f9c99c))
* **billing:** add per-route rate limit to subscription mutations (route-[#2](https://github.com/nikunjmavani/core-be/issues/2)) ([1e6975e](https://github.com/nikunjmavani/core-be/commit/1e6975e24271d14561f544981c651e254c3ef862))
* **billing:** alert on plan&lt;-&gt;Stripe price catalog drift (audit-[#13](https://github.com/nikunjmavani/core-be/issues/13)) ([3377510](https://github.com/nikunjmavani/core-be/commit/33775103b9ec7470270ff172b734b34586aebcb3))
* **billing:** bound PlanRepository.findAllActive at 100 rows (sec-r4-D3) ([#507](https://github.com/nikunjmavani/core-be/issues/507)) ([43180a9](https://github.com/nikunjmavani/core-be/commit/43180a98e2b62abdc0584460d06d455a55701900))
* **billing:** cancel the org's active subscription on organization delete (route-audit-[#2](https://github.com/nikunjmavani/core-be/issues/2)) ([718c80f](https://github.com/nikunjmavani/core-be/commit/718c80f307ae14d9db2ff77dbd26ae591f667afc))
* **billing:** cancel() releases the slot for never-activated INCOMPLETE subscriptions (reaudit-[#6](https://github.com/nikunjmavani/core-be/issues/6)) ([3d6cfe0](https://github.com/nikunjmavani/core-be/commit/3d6cfe03758b1302a8d1e7f8612d4641d381c1e8))
* **billing:** correct misleading plan route OpenAPI descriptions ([#349](https://github.com/nikunjmavani/core-be/issues/349)) ([27246ce](https://github.com/nikunjmavani/core-be/commit/27246ce78082f134005ac028852c7d95233f3c8b))
* **billing:** enforce unique subscriptions.provider_subscription_id (audit-[#10](https://github.com/nikunjmavani/core-be/issues/10)) ([acf919b](https://github.com/nikunjmavani/core-be/commit/acf919b105cbc10c502b8b197f5af1bd8782646c))
* **billing:** hide inactive plans from public GET /billing/plans/:id (route-[#7](https://github.com/nikunjmavani/core-be/issues/7)) ([0be46ed](https://github.com/nikunjmavani/core-be/commit/0be46ed971f32287ba326cdbbbb94275ca7f9465))
* **billing:** make Stripe customer creation idempotent on retry ([#326](https://github.com/nikunjmavani/core-be/issues/326)) ([8990fb3](https://github.com/nikunjmavani/core-be/commit/8990fb32b15fa133aece4ce428182d9b1996ee93))
* **billing:** make terminal subscriptions immutable (compare-and-set, B5/B6) ([5ac4328](https://github.com/nikunjmavani/core-be/commit/5ac43284d69e28101615d1a2f2caa306ab31cfe2))
* **billing:** make terminal subscriptions immutable via compare-and-set (route-audit B5, B6) ([18a3e43](https://github.com/nikunjmavani/core-be/commit/18a3e43540814b94e66ad085f40df767a32598e3))
* **billing:** persist a CANCELED tombstone for out-of-order Stripe deletions (audit-[#1](https://github.com/nikunjmavani/core-be/issues/1)) ([7862609](https://github.com/nikunjmavani/core-be/commit/7862609ed32b9c5c16d5780f4a6d7b59ba5066bb))
* **billing:** persist new Stripe subscriptions as INCOMPLETE not TRIALING (audit-[#2](https://github.com/nikunjmavani/core-be/issues/2)) ([b5a7f66](https://github.com/nikunjmavani/core-be/commit/b5a7f66537091e20632b3898364c7ac71e3f9f5f))
* **billing:** pin Stripe API version to 2026-05-27.dahlia ([#350](https://github.com/nikunjmavani/core-be/issues/350)) ([7c329bd](https://github.com/nikunjmavani/core-be/commit/7c329bd496bdff587f3c12748f923a2ef7267909))
* **billing:** release subscription slot for INCOMPLETE_EXPIRED (audit-[#1](https://github.com/nikunjmavani/core-be/issues/1)) ([14cd328](https://github.com/nikunjmavani/core-be/commit/14cd3289545d1229e72b08e16977286cde39db18))
* **billing:** remove redundant parseBullMQJobData from stripe-webhook processor (sec-r4-Q1) ([#502](https://github.com/nikunjmavani/core-be/issues/502)) ([d20c731](https://github.com/nikunjmavani/core-be/commit/d20c731dbaf5764fcb0ebf96376830c882991205))
* **billing:** sec-new-B1 guard cancel/resume/changePlan against terminal subscriptions ([#475](https://github.com/nikunjmavani/core-be/issues/475)) ([86bb32f](https://github.com/nikunjmavani/core-be/commit/86bb32f6de0ed2c3e293f2a17f979b9cfbfc3328))
* **billing:** sec-new-D1-D2 data integrity guards in billing writes ([#476](https://github.com/nikunjmavani/core-be/issues/476)) ([def085a](https://github.com/nikunjmavani/core-be/commit/def085adf233218dac8c01dad35e2efde385313b))
* **billing:** sec-new-M2 emit Deprecation+Sunset headers on deprecated /stripe/webhook alias ([#489](https://github.com/nikunjmavani/core-be/issues/489)) ([d95f4aa](https://github.com/nikunjmavani/core-be/commit/d95f4aa8becdae0454be1d727a09c1580fb1ff4d))
* **billing:** set concrete sunset for deprecated stripe webhook alias (audit-[#15](https://github.com/nikunjmavani/core-be/issues/15)a) ([4efb4a7](https://github.com/nikunjmavani/core-be/commit/4efb4a78e02af5da54c10fb04de02239120b1f79))
* **billing:** support comma-separated STRIPE_WEBHOOK_SECRET for zero-downtime rotation (sec-new-B3) ([#490](https://github.com/nikunjmavani/core-be/issues/490)) ([4be65fe](https://github.com/nikunjmavani/core-be/commit/4be65fe218a948b63f9386a09a934aa4cb4d42e5))
* block user delete when owning orgs + webhook updated_at flake ([08a5ac2](https://github.com/nikunjmavani/core-be/commit/08a5ac27734c2d3abb3604ab5e694abeb429d85e))
* **cache:** add commandTimeout to Redis client to prevent hung commands ([8cd8107](https://github.com/nikunjmavani/core-be/commit/8cd8107df573d5a8255911dc2fac8f21e676fb66))
* **ci:** dispatch stable release backmerge ([be9190f](https://github.com/nikunjmavani/core-be/commit/be9190f6ff26d04905bc46127717c96fbbe57ab0))
* **ci:** export GLOBAL_ADMIN_EMAILS in test-env so audit.test.ts super-admin paths work in Matrix Tests ([#532](https://github.com/nikunjmavani/core-be/issues/532)) ([873f59d](https://github.com/nikunjmavani/core-be/commit/873f59df59340bc182e3d8f261b5c2e435f89c63))
* **ci:** grant release-please job id-token + actions write permissions ([#536](https://github.com/nikunjmavani/core-be/issues/536)) ([b83eab2](https://github.com/nikunjmavani/core-be/commit/b83eab2d4ac3e2b46f5e77e00e34d720db6508e0))
* **ci:** publish API docs (incl. Scalar Registry) independently of release-please ([#676](https://github.com/nikunjmavani/core-be/issues/676)) ([7c4fe62](https://github.com/nikunjmavani/core-be/commit/7c4fe62027431e4d79e006afb84cc24c61e5fc67))
* **ci:** publish Scalar registry from GitHub Variables ([#677](https://github.com/nikunjmavani/core-be/issues/677)) ([cfaaef8](https://github.com/nikunjmavani/core-be/commit/cfaaef883eb57327cfd3f558597407250d3a752c))
* **ci:** use bare check-run names as ruleset required-check contexts ([#344](https://github.com/nikunjmavani/core-be/issues/344)) ([c431a63](https://github.com/nikunjmavani/core-be/commit/c431a63a292e9dcff7dc09147c9ae0fd7eb3d5d2))
* **ci:** use fetch-depth: 0 in post-merge changes job to avoid paths-filter race ([#390](https://github.com/nikunjmavani/core-be/issues/390)) ([61a2100](https://github.com/nikunjmavani/core-be/commit/61a210090ae518f75f459cc33806b10ba1442993))
* **config:** cap AUTH_SESSION_MAX_AGE_DAYS at 365 (sec-r4-C4) ([#510](https://github.com/nikunjmavani/core-be/issues/510)) ([2a48a88](https://github.com/nikunjmavani/core-be/commit/2a48a88355744445298e8fb36dda0c22fca0b472))
* **config:** make .env.local the self-contained primary local env file ([#650](https://github.com/nikunjmavani/core-be/issues/650)) ([aeb32e7](https://github.com/nikunjmavani/core-be/commit/aeb32e7c60d4686f71b2f14f46efe873404652c3))
* **config:** require legacy JWT gate closed once keyring configured in prod (audit-[#15](https://github.com/nikunjmavani/core-be/issues/15)b) ([43e5139](https://github.com/nikunjmavani/core-be/commit/43e5139de2e4b9f7e969b9832e8ffac1a0c32b89))
* **database:** keyset-page batch delete so FK-blocked rows can't infinite-loop retention ([fd9b523](https://github.com/nikunjmavani/core-be/commit/fd9b523ecaf1825d111a636d6cad954ecba6e83a))
* **database:** keyset-page batch delete so FK-blocked rows can't infinite-loop retention (route-audit A1) ([f81ca72](https://github.com/nikunjmavani/core-be/commit/f81ca724b6e5d25c158e02403ee39d7132c8c8f2))
* **database:** sec-new-Q4 apply worker statement timeout in system-table retention context ([#487](https://github.com/nikunjmavani/core-be/issues/487)) ([4e0b5c2](https://github.com/nikunjmavani/core-be/commit/4e0b5c2156544d72b9dbf51b4a3c07b77930492a))
* **db:** enforce RLS deny-all on billing.plans and tenancy.permissions (reaudit-[#9](https://github.com/nikunjmavani/core-be/issues/9)) ([2bb9476](https://github.com/nikunjmavani/core-be/commit/2bb947621fafabfd2ec03ca2d2fc9f905970c838))
* **deps:** bump esbuild override to &gt;=0.28.1 (GHSA-gv7w-rqvm-qjhr / GHSA-g7r4-m6w7-qqqr) ([514fa96](https://github.com/nikunjmavani/core-be/commit/514fa961bd392ef4583c7e148a7f47277ef23dae))
* **deps:** override @grpc/grpc-js to &gt;=1.14.4 (GHSA-5375-pq7m-f5r2) ([0a66557](https://github.com/nikunjmavani/core-be/commit/0a6655731c02a3efa03ca598c306fce4d34012c7))
* **docker:** add HEALTHCHECK to worker image (audit-[#15](https://github.com/nikunjmavani/core-be/issues/15)c) ([b4f7a67](https://github.com/nikunjmavani/core-be/commit/b4f7a67cc2072c9510f63906b2b1ec50ae114f92))
* **docker:** refresh apk index so base-image security patches install ([#607](https://github.com/nikunjmavani/core-be/issues/607)) ([a3690b9](https://github.com/nikunjmavani/core-be/commit/a3690b91f2f61f48f837553c74890e5d358fbec3))
* **docker:** worker HEALTHCHECK honors WORKER_HEALTH_PORT at runtime (reaudit-[#8](https://github.com/nikunjmavani/core-be/issues/8)) ([3530bff](https://github.com/nikunjmavani/core-be/commit/3530bff1c5cb6a65e21cc0f507018211150236a3))
* **email-templates:** escape URL fields in invitation and magic-link templates ([#364](https://github.com/nikunjmavani/core-be/issues/364)) ([26c67fa](https://github.com/nikunjmavani/core-be/commit/26c67fac20bff7ccf765c6d93a6264e35ebee079))
* **events:** capture swallowed event-bus errors in Sentry ([2a30d84](https://github.com/nikunjmavani/core-be/commit/2a30d845482dadbe97dd922a4bc54e974105655a))
* **events:** release commit-dispatch marker on rollback (in-memory leak) ([#324](https://github.com/nikunjmavani/core-be/issues/324)) ([7e3ec55](https://github.com/nikunjmavani/core-be/commit/7e3ec559455954d9aeb489e69c4bf416801d76d3))
* **finding-13:** escape title/preheader/footerText inside baseTemplate ([8996b26](https://github.com/nikunjmavani/core-be/commit/8996b2616b52de6f55b0b16315c4a439034e3fba))
* **finding-46:** validate DATABASE_HTTP_STATEMENT_TIMEOUT_MS stays within permission cache lock TTL ([#356](https://github.com/nikunjmavani/core-be/issues/356)) ([47bdab4](https://github.com/nikunjmavani/core-be/commit/47bdab435f83a307cc04f4dc8274f5407aeb8ad3))
* **finding-62:** export WEBHOOK_DELIVERY_JOB_ATTEMPTS and fix vi.mock factories ([#357](https://github.com/nikunjmavani/core-be/issues/357)) ([cd24515](https://github.com/nikunjmavani/core-be/commit/cd24515fa2acf75774da7d636ea42bc0212ec3a2))
* **finding-74:** replace unsafe Stripe object casts with proper type narrowing ([#359](https://github.com/nikunjmavani/core-be/issues/359)) ([f8f9cfe](https://github.com/nikunjmavani/core-be/commit/f8f9cfe8ae24f51ff34c92100dd31b2d1f7745fe))
* **infra:** throw on startup when monolithic worker pool demand exceeds DATABASE_POOL_MAX ([faf2fab](https://github.com/nikunjmavani/core-be/commit/faf2fab638f0b77d1ea82dd856d3cefefa893711))
* **infra:** use correct JWT env keys in docker-compose smoke profile (sec-r4-C5) ([#512](https://github.com/nikunjmavani/core-be/issues/512)) ([c9a48f1](https://github.com/nikunjmavani/core-be/commit/c9a48f107f0f89fe41814c253e4d3defc0595437))
* **lockfile:** regenerate pnpm-lock.yaml (merge produced duplicate mapping key) ([c2eba7e](https://github.com/nikunjmavani/core-be/commit/c2eba7eb879f20ee0b5ff182c5edf1ca64715308))
* **mail:** scrub secret-bearing body on terminally-failed outbox rows (audit-[#10](https://github.com/nikunjmavani/core-be/issues/10)) ([61dc948](https://github.com/nikunjmavani/core-be/commit/61dc948505b0eb6e4e7c60020d66a7c3663452bb))
* **mcp:** apply STRICT_AUTHED_RATE_LIMIT to MCP endpoint (audit finding [#7](https://github.com/nikunjmavani/core-be/issues/7)) ([#366](https://github.com/nikunjmavani/core-be/issues/366)) ([6783141](https://github.com/nikunjmavani/core-be/commit/6783141ed14cc7009e1ec2be258386fac1706ed3))
* **mcp:** strip X-Organization-Id from call_api proxied sub-requests (route-[#8](https://github.com/nikunjmavani/core-be/issues/8)) ([d5a7167](https://github.com/nikunjmavani/core-be/commit/d5a716716e8acff86e1523641e3f44620374411c))
* **migration:** make audit_logs_actor_api_key FK idempotent (unblock dev deploy) ([#385](https://github.com/nikunjmavani/core-be/issues/385)) ([b8cc4fb](https://github.com/nikunjmavani/core-be/commit/b8cc4fb70d3d3d13f31f4b67af35772ff5afdb7e))
* **migration:** make core_be_app least-privilege ALTER ROLE Neon-safe (unblocks all deploys) ([#341](https://github.com/nikunjmavani/core-be/issues/341)) ([488c793](https://github.com/nikunjmavani/core-be/commit/488c793ee93173a2b7d1cedb32879743c3136533))
* **notify:** cap webhook response body bytes read before truncation (audit-[#6](https://github.com/nikunjmavani/core-be/issues/6)) ([0f2421e](https://github.com/nikunjmavani/core-be/commit/0f2421e3b6b211f888f08a0161274063d7599cc1))
* **notify:** durability-first notification email dedup to stop lost emails (audit-[#7](https://github.com/nikunjmavani/core-be/issues/7)) ([b9d9759](https://github.com/nikunjmavani/core-be/commit/b9d9759885b92320210d681520ecc16236d70d2c))
* **notify:** durable mail-outbox dedupe key to close concurrent duplicate-email window (reaudit-[#4](https://github.com/nikunjmavani/core-be/issues/4)) ([47cd280](https://github.com/nikunjmavani/core-be/commit/47cd280504c9acdf324b2ff11ff4ca36ded05a1c))
* **notify:** enforce webhook secret-rotation eligibility in the update predicate (audit-[#9](https://github.com/nikunjmavani/core-be/issues/9)) ([d3337e0](https://github.com/nikunjmavani/core-be/commit/d3337e0c3ad3e314206cce494c23e6b644c90d03))
* **notify:** guard webhook secret re-rotation within the dual-sign overlap window ([0cfedd0](https://github.com/nikunjmavani/core-be/commit/0cfedd0d28177f40f354133a3d1f53b94002e955))
* **notify:** guard webhook secret re-rotation within the dual-sign overlap window (route-audit webhook-[#1](https://github.com/nikunjmavani/core-be/issues/1)) ([5c16f85](https://github.com/nikunjmavani/core-be/commit/5c16f8548c7c528944d937c60fe985ee887e8174))
* **notify:** route webhook handlers through zodApplication type provider ([eaa5684](https://github.com/nikunjmavani/core-be/commit/eaa5684c13253e6f5c7204a7dc8b479e4c9c5465))
* **notify:** sec-new-B2 replace bigserial with public_id in X-Webhook-Delivery-Id header ([#494](https://github.com/nikunjmavani/core-be/issues/494)) ([771954a](https://github.com/nikunjmavani/core-be/commit/771954a360383fcb797e38a6ea55b07d2055790c))
* **notify:** sec-new-D4 add status=PENDING filter to fallback SELECT in webhook delivery ([#488](https://github.com/nikunjmavani/core-be/issues/488)) ([164c6f8](https://github.com/nikunjmavani/core-be/commit/164c6f8a0bebbc89f0bb47d0b432e0db0bf453d7))
* **notify:** sec-new-N1 validate webhookId path param in all webhook handlers ([#482](https://github.com/nikunjmavani/core-be/issues/482)) ([d66099e](https://github.com/nikunjmavani/core-be/commit/d66099e00764f935260de97560e60529d61d5e53))
* **notify:** stamp webhook updated_at as greatest(created_at, now()) to fix chk_webhooks_updated flake ([988d87b](https://github.com/nikunjmavani/core-be/commit/988d87baf86a74ebb05ba9d81948e205ffcda2e3))
* **notify:** trim payload and response_body from webhook delivery list (sec-r4-D6) ([#518](https://github.com/nikunjmavani/core-be/issues/518)) ([89c24b7](https://github.com/nikunjmavani/core-be/commit/89c24b7f05dba72eba97447f746abb08130c61f6))
* **observability:** monitor every retention worker DLQ + add drift guard (reaudit-[#5](https://github.com/nikunjmavani/core-be/issues/5)) ([0e954dc](https://github.com/nikunjmavani/core-be/commit/0e954dcfe96a4c2d46c48815e963632468243236))
* **openapi:** registry-authoritative success statuses; deterministic OAuth coverage; scan cleanups ([a7cc7bd](https://github.com/nikunjmavani/core-be/commit/a7cc7bdeb47f4d9d5f5a18465470d8a9b2b86c67))
* **openapi:** registry-authoritative success statuses; deterministic OAuth coverage; scan cleanups ([1f84793](https://github.com/nikunjmavani/core-be/commit/1f84793ff6f149d7a759ac0223fb45a5d28d1942))
* **ops:** log circuit-breaker resets for attribution (route-[#5](https://github.com/nikunjmavani/core-be/issues/5)) ([eae48fe](https://github.com/nikunjmavani/core-be/commit/eae48fe4e9c937f7ca65d219acacb55832a1b218))
* **queue:** acknowledge commit-dispatch tasks after execution, not before (reaudit-[#2](https://github.com/nikunjmavani/core-be/issues/2)) ([8f399c0](https://github.com/nikunjmavani/core-be/commit/8f399c0ddaed24901f6c92445091770286c7a852))
* **queue:** bound audit.dead_letter_jobs growth via the audit-retention purge ([#322](https://github.com/nikunjmavani/core-be/issues/322)) ([06e729d](https://github.com/nikunjmavani/core-be/commit/06e729ddba34ce6d47ac3f2f7d73ad54910800a2))
* **queue:** bound commandTimeout on BullMQ producer connections (audit-[#5](https://github.com/nikunjmavani/core-be/issues/5)) ([2c4e21b](https://github.com/nikunjmavani/core-be/commit/2c4e21bf12dedc6039a0f0085379e80e8a83fee2))
* **queue:** monitor the offboarding-reconciler DLQ + exempt it from tenant-scoping policy (audit-[#15](https://github.com/nikunjmavani/core-be/issues/15)) ([f5f4ceb](https://github.com/nikunjmavani/core-be/commit/f5f4cebfbf7cc99072c06c0b7588d7c3eb4289fc))
* **queue:** sec-new-Q1 add env overrides for hardcoded cron schedules ([#484](https://github.com/nikunjmavani/core-be/issues/484)) ([d2d03e1](https://github.com/nikunjmavani/core-be/commit/d2d03e1c6a41861a22965a0c57707b8157ce66da))
* **queue:** sec-new-Q2 capture per-task failures in Sentry in recovery processor ([#485](https://github.com/nikunjmavani/core-be/issues/485)) ([b66a7a6](https://github.com/nikunjmavani/core-be/commit/b66a7a68ed27dc357b83b010e4778991fb198242))
* **queue:** stop DLQ auto-retry starvation via a resolved marker on exhausted rows ([#330](https://github.com/nikunjmavani/core-be/issues/330)) ([86c3817](https://github.com/nikunjmavani/core-be/commit/86c381769b50262e30687506b0c9ebeec9a739d9))
* **rate-limit,observability:** scope org rate-limit + error context by the org claim ([5e12926](https://github.com/nikunjmavani/core-be/commit/5e12926e869e17a3bd66e71a3d7ec87b98119132))
* **rate-limit,observability:** scope org rate-limit + error context by the org token claim ([b2caeb1](https://github.com/nikunjmavani/core-be/commit/b2caeb1be96e8fde9631028c4b92e047b14d433d))
* **rls:** pin core_be_app to NOSUPERUSER/NOBYPASSRLS + assert RLS-binding ([#334](https://github.com/nikunjmavani/core-be/issues/334)) ([18f8b9a](https://github.com/nikunjmavani/core-be/commit/18f8b9aa6f0ae44d45208dabf270a6c5a52c60ec))
* route-audit state-machine, billing, and cache-header findings ([d4b34ef](https://github.com/nikunjmavani/core-be/commit/d4b34ef388184860aece138aa10716b226562158))
* route-focused security audit findings ([1fffbf0](https://github.com/nikunjmavani/core-be/commit/1fffbf0270b20b7fdbeef5d0f3d86528e4fb11a5))
* **runtime:** real-world deep-flow inspection findings — 3 fixes + regression test ([#533](https://github.com/nikunjmavani/core-be/issues/533)) ([5a85ecd](https://github.com/nikunjmavani/core-be/commit/5a85ecd7d19303cb45231ec2d73082dfd6d4e631))
* **sec:** account-deletion safety — invalidate verification tokens + revoke-before-purge (sec-U1+U8) ([#404](https://github.com/nikunjmavani/core-be/issues/404)) ([43a1e5a](https://github.com/nikunjmavani/core-be/commit/43a1e5aedc49cd19f2e082febeb9b247a6bea3cf))
* **sec:** add captchaPreHandler to POST /mfa/login (sec-new-A1) ([85d2a89](https://github.com/nikunjmavani/core-be/commit/85d2a892decb1cf9e882922188633de6ffdea5c0))
* **sec:** add captchaPreHandler to POST /mfa/login (sec-new-A1) ([f2c02db](https://github.com/nikunjmavani/core-be/commit/f2c02db0212721ec29b99633f455f36f8e9f23c9))
* **sec:** add closeUserDataExportQueue to worker shutdown sequence (sec-r4-R1) ([#501](https://github.com/nikunjmavani/core-be/issues/501)) ([6e8e96f](https://github.com/nikunjmavani/core-be/commit/6e8e96ff11af4819d22cfb34df5b27f125518cbd))
* **sec:** add deleted_at guards to org-discovery RLS and invitation lookup (sec-r4-T1/T2) ([#500](https://github.com/nikunjmavani/core-be/issues/500)) ([b4ea6ee](https://github.com/nikunjmavani/core-be/commit/b4ea6ee0969cd5ff8da76b7abb68823e711d5939))
* **sec:** add partial index for audit.logs.actor_api_key_id (sec-D8) ([#432](https://github.com/nikunjmavani/core-be/issues/432)) ([761f28b](https://github.com/nikunjmavani/core-be/commit/761f28b96207265002e24ad2f263da00ff97eb99))
* **sec:** audit append-only DB invariant — split tenant-isolation policy + REVOKE UPDATE (sec-U3) ([#409](https://github.com/nikunjmavani/core-be/issues/409)) ([7991dfc](https://github.com/nikunjmavani/core-be/commit/7991dfc486ed22eff946b346982285c1f87fee65))
* **sec:** audit every data-export URL mint, rate-limit GET, drop TTL 24h→15min (sec-U6) ([#429](https://github.com/nikunjmavani/core-be/issues/429)) ([4943057](https://github.com/nikunjmavani/core-be/commit/4943057037519b0c294e4e46405d202008083973))
* **sec:** audit every login surface, not just password (sec-A8) ([#427](https://github.com/nikunjmavani/core-be/issues/427)) ([9872491](https://github.com/nikunjmavani/core-be/commit/9872491ad9ee8271d3a063738dd3b1423013095c))
* **sec:** audit hygiene — denylist metadata strip + admin user-mgmt audit + admin audit-read audit + permission-deny audit (sec-U2+U9+U4+U13) ([#408](https://github.com/nikunjmavani/core-be/issues/408)) ([98e60ff](https://github.com/nikunjmavani/core-be/commit/98e60ff889e7c94d716aaf235c0b782d05bd4a8f))
* **sec:** audit login failures alongside successes on every login surface (sec-A8 follow-up) ([#438](https://github.com/nikunjmavani/core-be/issues/438)) ([e4a9c2f](https://github.com/nikunjmavani/core-be/commit/e4a9c2f88925653cf12910efbb6258ba2c7c1d73))
* **sec:** audit serializer is strip-only with resolved public ids (sec-re-08) ([#458](https://github.com/nikunjmavani/core-be/issues/458)) ([5a07fdb](https://github.com/nikunjmavani/core-be/commit/5a07fdb15f4706478587523c96f090a92a8a3ce1))
* **sec:** auth defense in depth — last login-method guard + super-admin rederive + step-up on session revoke (sec-A5+A6+A7) ([#407](https://github.com/nikunjmavani/core-be/issues/407)) ([021c4b3](https://github.com/nikunjmavani/core-be/commit/021c4b31ce8d3c619f48ebcf43e4393ad2cf9b3d))
* **sec:** bind audit-list pagination cursor to its minting filter set (sec-U12) ([#434](https://github.com/nikunjmavani/core-be/issues/434)) ([f6a40e2](https://github.com/nikunjmavani/core-be/commit/f6a40e2db1fc34916c236f5fc3a478d5d09020df))
* **sec:** block update() on org-owner membership to prevent Admin lockout (sec-new-T1) ([dfa526a](https://github.com/nikunjmavani/core-be/commit/dfa526a03dafa3ddae99029e34651aeffa979d51))
* **sec:** block update() on org-owner membership to prevent Admin lockout (sec-new-T1) ([c3c6cfe](https://github.com/nikunjmavani/core-be/commit/c3c6cfe24145ab0cc3e63fe8a8d3d1a20d5a7642))
* **sec:** breach compression-skip actually engages in production (sec-re-03) ([#454](https://github.com/nikunjmavani/core-be/issues/454)) ([5039ccd](https://github.com/nikunjmavani/core-be/commit/5039ccd0699dac287c89a94b85e9c6a4f630c25e))
* **sec:** build Stripe customer email from a platform-owned domain, not tenant slug (sec-B11) ([#436](https://github.com/nikunjmavani/core-be/issues/436)) ([8bb5338](https://github.com/nikunjmavani/core-be/commit/8bb533845fcf074150dc3796e2038dcab01df372))
* **sec:** cache the i18n preHandler organization → locale lookup (sec-M1) ([#440](https://github.com/nikunjmavani/core-be/issues/440)) ([180937a](https://github.com/nikunjmavani/core-be/commit/180937a42a83ec058d0e66823c534db54270cf73))
* **sec:** collapse unmatched-route Prometheus label into __unmatched__ sentinel (sec-C2) ([#401](https://github.com/nikunjmavani/core-be/issues/401)) ([5fc8743](https://github.com/nikunjmavani/core-be/commit/5fc87432500a76271dc867df7b68851e5e68ed74))
* **sec:** config + middleware hardening (sec-cm batch) ([#449](https://github.com/nikunjmavani/core-be/issues/449)) ([b150253](https://github.com/nikunjmavani/core-be/commit/b15025363ad4af584a93572f1a0afb5dc76f1e4f))
* **sec:** config cleanup — drop JWT_SECRET + add deps:audit:prod to ci:local + ENABLE_RESPONSE_ENCRYPTION pairing refine (sec-C5+C10+C11) ([#419](https://github.com/nikunjmavani/core-be/issues/419)) ([7cab170](https://github.com/nikunjmavani/core-be/commit/7cab17038463c7a568e36c48f4c10acc0e6235f3))
* **sec:** cors exposes x-client-request-id (sec-re-17) ([#467](https://github.com/nikunjmavani/core-be/issues/467)) ([8960cfc](https://github.com/nikunjmavani/core-be/commit/8960cfcc13b33e6abb222631ff5de62f3b1d9a7b))
* **sec:** data-export request route advertises 15-minute URL lifetime (sec-re-12) ([#462](https://github.com/nikunjmavani/core-be/issues/462)) ([bc7cea3](https://github.com/nikunjmavani/core-be/commit/bc7cea3c096583e338e25edca4d58d59616718c4))
* **sec:** db retention growth — verification token sweep + AUDIT_RETENTION_DAYS cap (sec-D5+U10) ([#415](https://github.com/nikunjmavani/core-be/issues/415)) ([ab9428b](https://github.com/nikunjmavani/core-be/commit/ab9428b5a5cd93a24ce283f8598dd318e0e0ef03))
* **sec:** db stability — drop volatile chk_org_notif_muted + worker statement_timeout + audit.logs target_user_id index (sec-D1+D2+D3) ([#414](https://github.com/nikunjmavani/core-be/issues/414)) ([f77ce4a](https://github.com/nikunjmavani/core-be/commit/f77ce4aee1366eaa1ff82da6575b5011dd382ca5))
* **sec:** delete dead findActiveByUserId / findActiveByOrganizationId (sec-D12) ([#437](https://github.com/nikunjmavani/core-be/issues/437)) ([6367dd4](https://github.com/nikunjmavani/core-be/commit/6367dd45ca44614f1e0a2d10fd2dfdf0df9f390e))
* **sec:** derive invitation email from membership user on create (sec-T1 complete) ([#471](https://github.com/nikunjmavani/core-be/issues/471)) ([6d54c99](https://github.com/nikunjmavani/core-be/commit/6d54c99a15cd6c1dc48ec3b1c6357c540db4bf29))
* **sec:** dlq replay no-op + commit-dispatch cleanup + worker hardening (sec-q batch) ([#444](https://github.com/nikunjmavani/core-be/issues/444)) ([6c96a0b](https://github.com/nikunjmavani/core-be/commit/6c96a0bb1c47d016d87735cbe16ee173e7de19c4))
* **sec:** do not clear session cookie in revokeAllSessions handler (sec-r4-A1) ([#499](https://github.com/nikunjmavani/core-be/issues/499)) ([b7e3952](https://github.com/nikunjmavani/core-be/commit/b7e395262f8ec06a84a5426b9c4a9dafa85ec351))
* **sec:** docker.agent USER node + drop openssh + enforce abort timeout on retrieveStripeEvent (sec-C8 + sec-Q5 partial) ([#422](https://github.com/nikunjmavani/core-be/issues/422)) ([d10af52](https://github.com/nikunjmavani/core-be/commit/d10af524ec39a00994b041f7727d18cc6e81639b))
* **sec:** document the online-safe ALTER COLUMN pattern (sec-D6) ([#443](https://github.com/nikunjmavani/core-be/issues/443)) ([c72deb4](https://github.com/nikunjmavani/core-be/commit/c72deb4e3f9b7cdaba267b14948fd73025dce3e3))
* **sec:** document verification_tokens application-trust safety model (sec-D9) ([#441](https://github.com/nikunjmavani/core-be/issues/441)) ([e069891](https://github.com/nikunjmavani/core-be/commit/e069891909cd0487a4cd5ab523930f8b0d6e105d))
* **sec:** drop org branch from user_notification_preferences RLS + add CHECK pin (sec-U7) ([#428](https://github.com/nikunjmavani/core-be/issues/428)) ([13fc188](https://github.com/nikunjmavani/core-be/commit/13fc188e22603b55f3226994399e5564e50f5843))
* **sec:** enforce SSE-S3 on every server-side S3 write (sec-U11) ([#435](https://github.com/nikunjmavani/core-be/issues/435)) ([0792d76](https://github.com/nikunjmavani/core-be/commit/0792d76c07ece878f8adc1f282f1966efbe54ae7))
* **sec:** expose policy public_id instead of bigserial in URLs and responses (sec-T5) ([#442](https://github.com/nikunjmavani/core-be/issues/442)) ([88d5db7](https://github.com/nikunjmavani/core-be/commit/88d5db72bc21184da5ea00ec0baaa0256d0f03a9))
* **sec:** extend staging guards to ALLOWED_ORIGINS, COOKIE_SECURE, and SECRETS_ENCRYPTION_KEY (sec-r4-C1/C2/C3) ([#498](https://github.com/nikunjmavani/core-be/issues/498)) ([0efd169](https://github.com/nikunjmavani/core-be/commit/0efd169841cea7cfba5197012dfb6e3f615fe629))
* **sec:** fall back to INSERT when subscription.created arrives before local row (sec-B9) ([#439](https://github.com/nikunjmavani/core-be/issues/439)) ([fd68e66](https://github.com/nikunjmavani/core-be/commit/fd68e660e7d19d1707b0bfe97ac4fe29d08ab427))
* **sec:** harden invitation binding, webhook retry, role invariants, and upload key contract ([#470](https://github.com/nikunjmavani/core-be/issues/470)) ([65cdf2f](https://github.com/nikunjmavani/core-be/commit/65cdf2f9179ac01aa1110f95b60cb6a7fd1519db))
* **sec:** invitation accept requires auth + invitee email match (sec-T4) ([#423](https://github.com/nikunjmavani/core-be/issues/423)) ([7cdc3f8](https://github.com/nikunjmavani/core-be/commit/7cdc3f83beafaa9e682bf39348cb1caa4047c2fb))
* **sec:** mark-confirmed-by-internal-id filters deleted_at and pending (sec-re-13) ([#463](https://github.com/nikunjmavani/core-be/issues/463)) ([dbd9156](https://github.com/nikunjmavani/core-be/commit/dbd9156fd40ff4e2e92ab6ace5823b2e60279e60))
* **sec:** mfa hardening — step-up requires mfa + per-session binding + org-policy delete guard (sec-A1+A2+A4) ([#403](https://github.com/nikunjmavani/core-be/issues/403)) ([1ba5047](https://github.com/nikunjmavani/core-be/commit/1ba504726442aaaea626d2b73f542c55b8214d0a))
* **sec:** mfa is_mfa_enabled flip happens inside the enrollConfirm transaction (sec-re-06) ([#469](https://github.com/nikunjmavani/core-be/issues/469)) ([675c1f2](https://github.com/nikunjmavani/core-be/commit/675c1f257bb02ecf3967a3295ff1f6d1068da136))
* **sec:** mfa re-enroll dedups stale totp factors (sec-re-04) ([#455](https://github.com/nikunjmavani/core-be/issues/455)) ([f7a66ab](https://github.com/nikunjmavani/core-be/commit/f7a66abb8218a13bbf92472ba3fc0c3e26ab6f3e))
* **sec:** middleware observability — captcha bypass closed in staging + HSTS env gate + ALLOWED_ORIGINS canonicalization + encryption 503 (sec-M3+M5+M8+M9) ([#417](https://github.com/nikunjmavani/core-be/issues/417)) ([57abed9](https://github.com/nikunjmavani/core-be/commit/57abed9c55fa7fc50c72b1161e8270b5a64b024f))
* **sec:** notification worker user context + db integrity indexes (sec-d batch) ([#450](https://github.com/nikunjmavani/core-be/issues/450)) ([a1a8fe5](https://github.com/nikunjmavani/core-be/commit/a1a8fe5c15fd5b3c4b8437413ef40e5b4efeb821))
* **sec:** notification worker user-context fix is live wiring (sec-re-01) ([#452](https://github.com/nikunjmavani/core-be/issues/452)) ([653adf5](https://github.com/nikunjmavani/core-be/commit/653adf5653b634dcf907927ad4f6a660256f8a79))
* **sec:** notify abuse caps — per-organization webhook cap + secret-rotation overlap window (sec-N4+N8) ([#411](https://github.com/nikunjmavani/core-be/issues/411)) ([a7455f5](https://github.com/nikunjmavani/core-be/commit/a7455f5548d20fe8460b92154e17b2ca75eda24a))
* **sec:** notify durability — worker re-checks disabled/deleted + delivery-id header + event_key dedupe (sec-N1+N3+N2) ([#410](https://github.com/nikunjmavani/core-be/issues/410)) ([c09ae6c](https://github.com/nikunjmavani/core-be/commit/c09ae6c7acad9de05fe7c28f365ba9af84795c16))
* **sec:** notify recipient + idempotency canonical fingerprint + tenant authorized-org helper (sec-N7+M6+M7) ([#420](https://github.com/nikunjmavani/core-be/issues/420)) ([17a8bbd](https://github.com/nikunjmavani/core-be/commit/17a8bbdc9d364eb9b5bfa5f71d0ffbe86e30645e))
* **sec:** org-scoped audit log sanitiser + strip-only serializers (sec-t batch) ([#448](https://github.com/nikunjmavani/core-be/issues/448)) ([6019182](https://github.com/nikunjmavani/core-be/commit/6019182b695080795d232d7afe04b96659ff34d2))
* **sec:** protect owner role from permission writes via ROLE_MANAGE (sec-T2) ([#402](https://github.com/nikunjmavani/core-be/issues/402)) ([6b11b6e](https://github.com/nikunjmavani/core-be/commit/6b11b6e6da7e825d48d7348b50576861a5fc4cbc))
* **sec:** queue infrastructure — defaultJobOptions on cron queues + flip topology warn + fail boot on scheduler drift in prod (sec-Q1+Q2+Q3) ([#416](https://github.com/nikunjmavani/core-be/issues/416)) ([32b960e](https://github.com/nikunjmavani/core-be/commit/32b960e03cc6a164d137dc080f583846b93635a9))
* **sec:** rate-limit per-email bucket id is hashed (sec-re-11) ([#461](https://github.com/nikunjmavani/core-be/issues/461)) ([4239be4](https://github.com/nikunjmavani/core-be/commit/4239be4ddb5d3432295565b4bb8e110612e97012))
* **sec:** recovery-code alphabet doc reflects 31 symbols and case-insensitive hash (sec-re-14) ([#464](https://github.com/nikunjmavani/core-be/issues/464)) ([1bc8b00](https://github.com/nikunjmavani/core-be/commit/1bc8b001519154b9e5da12abf4a4d808b12cd9d8))
* **sec:** refresh stale ordering comments around the no-op RLS-transaction plugin (sec-M4) ([#433](https://github.com/nikunjmavani/core-be/issues/433)) ([1bd211e](https://github.com/nikunjmavani/core-be/commit/1bd211e288ac062486e9374667e1619401e4f666))
* **sec:** refresh-token reuse detection fires for revoked sessions (sec-re-05) ([#456](https://github.com/nikunjmavani/core-be/issues/456)) ([bf5ee5e](https://github.com/nikunjmavani/core-be/commit/bf5ee5e30c0233d13a0f28d0b9b2afff4df0da4c))
* **sec:** remove privilege-bypass arms from audit.logs INSERT RLS (sec-r4-D1) ([#497](https://github.com/nikunjmavani/core-be/issues/497)) ([787b3c8](https://github.com/nikunjmavani/core-be/commit/787b3c8d20ebb37f97ef9cd2d27aa66f992df7c3))
* **sec:** replace z.coerce.boolean() foot-gun on env booleans (sec-C1) ([#400](https://github.com/nikunjmavani/core-be/issues/400)) ([f8a49c3](https://github.com/nikunjmavani/core-be/commit/f8a49c367e9bbc5cdc7e54e9d9c988e4dbe13bca))
* **sec:** repository hygiene — atomic markAllRead count + WebAuthn counter monotonicity guard (sec-D10/D11) ([#426](https://github.com/nikunjmavani/core-be/issues/426)) ([1d817db](https://github.com/nikunjmavani/core-be/commit/1d817db6ded2820f9334b31d05ca4e4b23ae30b2))
* **sec:** require caller can grant target role permissions on membership create (sec-T1) ([#399](https://github.com/nikunjmavani/core-be/issues/399)) ([899aab3](https://github.com/nikunjmavani/core-be/commit/899aab3abcf9de727a8b0e7fe3ecdcb7ad14d654))
* **sec:** require caller to hold every code added or removed on role-permission PUT (sec-T2) ([#425](https://github.com/nikunjmavani/core-be/issues/425)) ([b9b545e](https://github.com/nikunjmavani/core-be/commit/b9b545ee4de3c1b36bd05a8d80e8ebce8f497565))
* **sec:** require live-mode + both-or-neither Stripe keys in production (sec-B5/B6) ([#424](https://github.com/nikunjmavani/core-be/issues/424)) ([2ca7f2c](https://github.com/nikunjmavani/core-be/commit/2ca7f2cdb4e411275f465164b91ae2099f98a395))
* **sec:** role-delete guards + strip is_system from createMemberRoleDto (sec-T3) ([#406](https://github.com/nikunjmavani/core-be/issues/406)) ([1b41ab9](https://github.com/nikunjmavani/core-be/commit/1b41ab98cfaedfb11a7f5f3c87c26106e8bc2373))
* **sec:** sentry/log redaction + observability — OTLP https refine + readyz verbose env gate + Sentry message/exception/user redaction + LOG_LEVEL enum (sec-C3+C4+C6+C9) ([#418](https://github.com/nikunjmavani/core-be/issues/418)) ([b0337ce](https://github.com/nikunjmavani/core-be/commit/b0337ce2ad6f21ac16b0c97fccda158e7c64dd55))
* **sec:** stripe event retrieve honours per-attempt timeout for real (sec-re-15) ([#465](https://github.com/nikunjmavani/core-be/issues/465)) ([d5640da](https://github.com/nikunjmavani/core-be/commit/d5640daf8c1bacf06e9ca92894ac4d97a9945fe3))
* **sec:** stripe ingress durability + ordering + raw-body wiring (sec-b batch) ([#446](https://github.com/nikunjmavani/core-be/issues/446)) ([8a88beb](https://github.com/nikunjmavani/core-be/commit/8a88beb6cd7ea43f4cf42d034f2a37ba6a241d9e))
* **sec:** stripe reclaim cron→worker handoff is recoverable (sec-re-02) ([#453](https://github.com/nikunjmavani/core-be/issues/453)) ([3cdce4f](https://github.com/nikunjmavani/core-be/commit/3cdce4fcaabf0b6895b73c4feb412f0edd451080))
* **sec:** stripe reconciliation — close 4 silent-divergence paths (sec-B1+B2+B3+B4) ([#405](https://github.com/nikunjmavani/core-be/issues/405)) ([87ab3fb](https://github.com/nikunjmavani/core-be/commit/87ab3fb998f712f5a1b033708c1d65b9ba4c8b82))
* **sec:** subscription response surfaces plan public id (sec-re-07) ([#457](https://github.com/nikunjmavani/core-be/issues/457)) ([537325c](https://github.com/nikunjmavani/core-be/commit/537325c9f8f71a7e7452db8126bcb5517c8b2b1b))
* **sec:** sync local plan_id from Stripe customer.subscription.updated (sec-B7) ([#430](https://github.com/nikunjmavani/core-be/issues/430)) ([bc5a21a](https://github.com/nikunjmavani/core-be/commit/bc5a21ae87d6c253ad7094e752859fe254492d0e))
* **sec:** tenant context lifts the worker statement_timeout (sec-re-16) ([#466](https://github.com/nikunjmavani/core-be/issues/466)) ([415a58e](https://github.com/nikunjmavani/core-be/commit/415a58eb3a4c8c2334d8bcd5649f1348fdf9f455))
* **sec:** tombstoneAllByOrganizationId removes S3 objects synchronously (sec-UP8) ([#421](https://github.com/nikunjmavani/core-be/issues/421)) ([186bd71](https://github.com/nikunjmavani/core-be/commit/186bd711303862d3386cc6f7391ef0dd73928613))
* **sec:** two-phase mfa enrollment + refresh reuse-detection + login uniformity (sec-a batch) ([#445](https://github.com/nikunjmavani/core-be/issues/445)) ([d1e1e59](https://github.com/nikunjmavani/core-be/commit/d1e1e593bcf31c515f22fb1e2c4d07a89c76e81c))
* **sec:** upload confirm pins copy to verified etag (sec-re-10) ([#460](https://github.com/nikunjmavani/core-be/issues/460)) ([2eb3d11](https://github.com/nikunjmavani/core-be/commit/2eb3d11ca070c52c0e4fcf2cc5c5c0c391573837))
* **sec:** upload security — refuse legacy in-place + sweep refuses SVG + assertKeyConfirmedForOwner + DOMPurify hardening (sec-UP1+UP2+UP5+UP6) ([#412](https://github.com/nikunjmavani/core-be/issues/412)) ([76e80ad](https://github.com/nikunjmavani/core-be/commit/76e80ad3617b7d87f57fc292c6e41efba7f89d89))
* **sec:** upload size/policy — organizationId regex + org pending cap + force presigned POST in prod (sec-UP3+UP4+UP10) ([#413](https://github.com/nikunjmavani/core-be/issues/413)) ([237d517](https://github.com/nikunjmavani/core-be/commit/237d517905e321c9c73c1e9cc8f9fa181a73a597))
* **security:** add maxItems array bounds and fix WebAuthn type casts ([#363](https://github.com/nikunjmavani/core-be/issues/363)) ([ab4e7c7](https://github.com/nikunjmavani/core-be/commit/ab4e7c7c6fb65f374c458b18ef7b8b5927b0e77d))
* **security:** fail closed on privileged re-derivation + bound all retention settings (audit-[#16](https://github.com/nikunjmavani/core-be/issues/16), [#14](https://github.com/nikunjmavani/core-be/issues/14)) ([65a4347](https://github.com/nikunjmavani/core-be/commit/65a4347972c7d029600559f69a080fc611bc555d))
* **security:** mark recovery-codes + presigned-URL responses no-store / non-cacheable (route-audit-[#3](https://github.com/nikunjmavani/core-be/issues/3)) ([bc67eed](https://github.com/nikunjmavani/core-be/commit/bc67eed1cc521709b36e4eca38289310276ff922))
* **security:** reject JWT tokens with unknown kid when keyring is active ([#347](https://github.com/nikunjmavani/core-be/issues/347)) ([2bedfa1](https://github.com/nikunjmavani/core-be/commit/2bedfa1fc7bfe30ebe07e3529cfe8b7c8c78a15d))
* **security:** remediate all 16 findings from the 2026-06-14 dev security audit ([01a22aa](https://github.com/nikunjmavani/core-be/commit/01a22aa5f83fbd1f784039a98b5ac4eda151efdb))
* **security:** remediate all 16 findings from the 2026-06-14 dev security audit ([#600](https://github.com/nikunjmavani/core-be/issues/600)) ([01a22aa](https://github.com/nikunjmavani/core-be/commit/01a22aa5f83fbd1f784039a98b5ac4eda151efdb))
* **security:** require explicit wildcard prefix for webhook allowlist subdomain matching ([8d79c89](https://github.com/nikunjmavani/core-be/commit/8d79c891b2a88a8a44cca1420535cfcc6a567a12))
* **security:** strip privileged headers from MCP call_api and remove unversioned aliases ([#348](https://github.com/nikunjmavani/core-be/issues/348)) ([cdaf9ce](https://github.com/nikunjmavani/core-be/commit/cdaf9cef188e146b090bf411dc21e803c53ddea7))
* **security:** strip Stripe-shaped literals from source + add regression test (GH secret-scanning) ([#529](https://github.com/nikunjmavani/core-be/issues/529)) ([f234e60](https://github.com/nikunjmavani/core-be/commit/f234e6044879c72385e3b61728ea4ba665931ae6))
* **security:** untrack agent-os/mcp/mcp.json and repair stale ai/ paths ([#560](https://github.com/nikunjmavani/core-be/issues/560)) ([b3547a4](https://github.com/nikunjmavani/core-be/commit/b3547a43172e2388c0a1a2e4fa8e0388d046b4c6))
* **sec:** validate membership and api-key path params at the boundary (sec-re-18) ([#468](https://github.com/nikunjmavani/core-be/issues/468)) ([c0ab171](https://github.com/nikunjmavani/core-be/commit/c0ab17106d8e7dd27513e3bf2f76a480775fd557))
* **sec:** validate subscriptionId path param at every billing handler (sec-B10) ([#431](https://github.com/nikunjmavani/core-be/issues/431)) ([2bbd338](https://github.com/nikunjmavani/core-be/commit/2bbd33864cd192a22d5d41f70ed7064a628a3809))
* **sec:** webhook secret strength + upload sweep file_key invariant + data-export doc (sec-up batch) ([#447](https://github.com/nikunjmavani/core-be/issues/447)) ([145c838](https://github.com/nikunjmavani/core-be/commit/145c8385ec8b02c25b0b508adbabd71c2ce8dc05))
* **setup:** activate pinned Node on PATH in agent bootstrap step 1 ([#649](https://github.com/nikunjmavani/core-be/issues/649)) ([968d54f](https://github.com/nikunjmavani/core-be/commit/968d54fae13b6e8cb9c40c39e565c116739dd479))
* **storage:** distinguish S3 not-found from transient failure (audit-[#5](https://github.com/nikunjmavani/core-be/issues/5)) ([5ba8d00](https://github.com/nikunjmavani/core-be/commit/5ba8d002a05a423b8a2e8b99e4f23c29a1d79e51))
* **storage:** enforce SSE-S3 on presigned uploads (sec-r4-E1) ([#509](https://github.com/nikunjmavani/core-be/issues/509)) ([f962d37](https://github.com/nikunjmavani/core-be/commit/f962d372565e05986fb00a2cef960694b4b35885))
* **storage:** serve public media via a distribution and refuse public URLs for private keys (audit-[#13](https://github.com/nikunjmavani/core-be/issues/13)) ([cc10be0](https://github.com/nikunjmavani/core-be/commit/cc10be00c43a9891bff17bfc097f9ba50c5a165d))
* **stripe:** tighten webhook replay window to 150 s (audit finding [#6](https://github.com/nikunjmavani/core-be/issues/6)) ([#365](https://github.com/nikunjmavani/core-be/issues/365)) ([848360d](https://github.com/nikunjmavani/core-be/commit/848360d739857212d1822c6e9e4564498649b5c3))
* **tenancy,notify:** atomic role-delete, webhook clock-skew, security_policy proto guard (route-audit C2, C3, C4) ([ddf4f35](https://github.com/nikunjmavani/core-be/commit/ddf4f35762595f2318930855bf1bfccaba3a30ed))
* **tenancy,notify:** make per-scope resource caps atomic with an advisory lock (audit-[#8](https://github.com/nikunjmavani/core-be/issues/8)) ([3681133](https://github.com/nikunjmavani/core-be/commit/3681133339f47f68570aaf54f773ae8c5964238b))
* **tenancy,security:** post-flatten audit corrections — idempotency claim scope + personal-org guards ([e105372](https://github.com/nikunjmavani/core-be/commit/e10537260c541131a4386bb37570653242fcc41b))
* **tenancy,security:** post-flatten audit corrections — idempotency claim scope, personal-org guards, dead-code cleanup ([018fb31](https://github.com/nikunjmavani/core-be/commit/018fb313308ea78843d22df4dd234dc41dea1190))
* **tenancy:** bound MemberRolePermissionRepository.findByRoleId rows per role (sec-r4-D4) ([#508](https://github.com/nikunjmavani/core-be/issues/508)) ([9218518](https://github.com/nikunjmavani/core-be/commit/92185187cd5397f4f349442626a936f55e718b7b))
* **tenancy:** emit public ids (not internal bigserial ids) in membership responses ([#329](https://github.com/nikunjmavani/core-be/issues/329)) ([3aac2ac](https://github.com/nikunjmavani/core-be/commit/3aac2ac13d072c1f41bf71bd296468de63d73b3c))
* **tenancy:** exclude soft-deleted orgs from organizations_tenant_isolation RLS policy (sec-new-D3) ([#491](https://github.com/nikunjmavani/core-be/issues/491)) ([904802a](https://github.com/nikunjmavani/core-be/commit/904802affcc95bea74e6f510b64c655ccbd46df0))
* **tenancy:** only activate INVITED memberships on invitation accept (route-audit-[#1](https://github.com/nikunjmavani/core-be/issues/1)) ([aeea26a](https://github.com/nikunjmavani/core-be/commit/aeea26af9f5346fdbf4c7dd38745de90d8951b14))
* **tenancy:** rate-limit membership lifecycle endpoints (sec-r4-I3) ([#505](https://github.com/nikunjmavani/core-be/issues/505)) ([1f0c8c0](https://github.com/nikunjmavani/core-be/commit/1f0c8c01d38bbaa6020b8a8cab7e3d5b0657b0b7))
* **tenancy:** rate-limit organization mutation endpoints (sec-r4-I2) ([#504](https://github.com/nikunjmavani/core-be/issues/504)) ([2f6bedb](https://github.com/nikunjmavani/core-be/commit/2f6bedb59ca27d9d11c68299560470d8f0418d77))
* **tenancy:** reject prototype-pollution keys in organization security_policy (route-audit hardening) ([b1eba43](https://github.com/nikunjmavani/core-be/commit/b1eba43d872fe1ff7e018edd45eb42c10f67fa3f))
* **tenancy:** revoke a removed member's API keys on membership removal (reaudit-[#7](https://github.com/nikunjmavani/core-be/issues/7)) ([1387bd3](https://github.com/nikunjmavani/core-be/commit/1387bd306046d439b5f52840e4b45ae0f0794037))
* **tenancy:** scale permission-cache stampede poll budget to lock TTL (audit-[#9](https://github.com/nikunjmavani/core-be/issues/9)) ([5322d0f](https://github.com/nikunjmavani/core-be/commit/5322d0fae4dc9043f3563eda431d880ccab74f97))
* **tenancy:** sec-new-M1 add STRICT_AUTHED_RATE_LIMIT to POST /organizations ([#477](https://github.com/nikunjmavani/core-be/issues/477)) ([dd9fd62](https://github.com/nikunjmavani/core-be/commit/dd9fd62112aefe4eaa63869ab6c37ac62ee8540c))
* **tenancy:** sec-new-T2 validate invitationId path param in all invitation handlers ([#480](https://github.com/nikunjmavani/core-be/issues/480)) ([93fa940](https://github.com/nikunjmavani/core-be/commit/93fa940a7d371acd95889257b027075d305d1e60))
* **tenancy:** sec-new-T3 validate id and roleId path params in role handlers ([#481](https://github.com/nikunjmavani/core-be/issues/481)) ([361159a](https://github.com/nikunjmavani/core-be/commit/361159aca4126ae5df7b446dd437c199082a9636))
* **tenancy:** throttle api-key last_used_at writes (audit-[#8](https://github.com/nikunjmavani/core-be/issues/8)) ([96b3e56](https://github.com/nikunjmavani/core-be/commit/96b3e562e136892ff44e5adf2f06009bdcce5a06))
* **tests:** align e2e fixtures with audit batch2 (WebAuthn typed DTO) + Stripe items.period ([#384](https://github.com/nikunjmavani/core-be/issues/384)) ([b906731](https://github.com/nikunjmavani/core-be/commit/b906731f9fdfb6813303c3f25a0ce148a1e2023a))
* **tests:** cleanupDatabase preserves schema_migrations; update tests inherited from main's B4 + sec-r4-A1 semantics ([#525](https://github.com/nikunjmavani/core-be/issues/525)) ([169327e](https://github.com/nikunjmavani/core-be/commit/169327ec7652cefd7301b8d0c1c47009caa9ae5e))
* three pre-existing dev post-merge CI failures (migration idempotency, Stripe Date bind, permission seed) ([#614](https://github.com/nikunjmavani/core-be/issues/614)) ([798cefe](https://github.com/nikunjmavani/core-be/commit/798cefe26f59b8f56c3987f437772d707a42e364))
* **upload:** add DTO-level fileSize ceiling (sec-r4-I4) ([#515](https://github.com/nikunjmavani/core-be/issues/515)) ([049f917](https://github.com/nikunjmavani/core-be/commit/049f917c71b8c043e39bbbcd40f93eec534994fc))
* **upload:** lock the organization pending-upload quota at the org scope (audit-[#7](https://github.com/nikunjmavani/core-be/issues/7)) ([171a0fc](https://github.com/nikunjmavani/core-be/commit/171a0fc4c618c93c4bc74aafe0c3ec45f6376b74))
* **upload:** reclaim orphaned avatar/logo objects + owner-binding + purpose/target check (L1/L2/L3) ([7ffef76](https://github.com/nikunjmavani/core-be/commit/7ffef768a889cab424139e42cab34e7f055f6bb9))
* **upload:** reclaim orphaned avatar/logo objects, wire owner-binding gate, validate purpose-target (route-audit L1, L2, L3) ([d9d9738](https://github.com/nikunjmavani/core-be/commit/d9d97381082b330d32843511d29e8823fde2cb56))
* **user-data-export:** bound offboarding S3 delete fan-out (sec-r4-R2) ([#513](https://github.com/nikunjmavani/core-be/issues/513)) ([6ef83de](https://github.com/nikunjmavani/core-be/commit/6ef83de5039fcb08bd4422ad04cfc4282ee53bd4))
* **user:** block admin suspend/delete of protected super-admins (route-[#1](https://github.com/nikunjmavani/core-be/issues/1)) ([b84259d](https://github.com/nikunjmavani/core-be/commit/b84259d3f6cbb34ffb2f8617e900aa0157fc5fae))
* **user:** block deleting a user who still owns organizations (route-audit-[#2](https://github.com/nikunjmavani/core-be/issues/2) follow-up) ([f94b7c9](https://github.com/nikunjmavani/core-be/commit/f94b7c9c0c95d1525ea31fe41e44970efe452f19))
* **user:** rate-limit /me profile mutation endpoints (sec-r4-I1) ([#503](https://github.com/nikunjmavani/core-be/issues/503)) ([0c745e1](https://github.com/nikunjmavani/core-be/commit/0c745e182c0c6be2de608f42e9c434212ad07c08))
* **user:** rate-limit admin user-management mutations (route-[#4](https://github.com/nikunjmavani/core-be/issues/4)) ([a0d8114](https://github.com/nikunjmavani/core-be/commit/a0d8114b28fc1730fbc982271018d64700569537))
* **user:** reject org-scoped notification preference with 400 (was raw 42501 -&gt; 500) ([#327](https://github.com/nikunjmavani/core-be/issues/327)) ([db1e7a7](https://github.com/nikunjmavani/core-be/commit/db1e7a77e3c8f464bd8354f1235a1f33c5c71967))
* **user:** sec-new-U1 cap ListUsersDto.after cursor to 512 chars ([#483](https://github.com/nikunjmavani/core-be/issues/483)) ([fae555d](https://github.com/nikunjmavani/core-be/commit/fae555dd2717a4cde9a703f64941cca09d55e33f))
* **user:** unique notification-preference natural key + input dedupe (audit-[#11](https://github.com/nikunjmavani/core-be/issues/11)) ([6805459](https://github.com/nikunjmavani/core-be/commit/68054599b5fb2a120c6fb8571f23a76dc9277e7a))
* validators (audit follow-up) — centralize AES_GCM_IV_LENGTH, allowlist 5 and 512, env-load sunset validator ([#378](https://github.com/nikunjmavani/core-be/issues/378)) ([3bae917](https://github.com/nikunjmavani/core-be/commit/3bae917577c65d11cf771725f81392a0a62ce904))


### Performance

* parallelize S3 object deletes in deleteAllExportsForUser ([#361](https://github.com/nikunjmavani/core-be/issues/361)) ([4c36173](https://github.com/nikunjmavani/core-be/commit/4c36173e703bfaa9737ed2a529f0e28e8f863046))


### Changed

* **api:** rename inbound Idempotency-Key header to X-Idempotency-Key ([#656](https://github.com/nikunjmavani/core-be/issues/656)) ([b595c1b](https://github.com/nikunjmavani/core-be/commit/b595c1b0ed35a9248f1dd53660c7b3afb849eee4))
* **api:** semantic snake_case params, prefixed public ids, uniform status policy, documented headers ([03820fb](https://github.com/nikunjmavani/core-be/commit/03820fb407116e2532f2afdf12133861b8c58497))
* **api:** semantic snake_case route params, prefixed public ids, uniform method-status policy, documented headers ([3311bc0](https://github.com/nikunjmavani/core-be/commit/3311bc022f65fcbd517802cc91dcb194d5a31c0c))
* **architecture:** move raw SQL out of stripe-webhook-organization.util into the repository (+ global gate) ([#530](https://github.com/nikunjmavani/core-be/issues/530)) ([f48fb46](https://github.com/nikunjmavani/core-be/commit/f48fb46fe1005a95adc0abf14222df8f86c030f9))
* **billing:** remove deprecated /stripe/webhook alias ([#670](https://github.com/nikunjmavani/core-be/issues/670)) ([e0a4c8b](https://github.com/nikunjmavani/core-be/commit/e0a4c8bfac04fcbe041c6b6c1e47a5585d411820))
* **constants:** centralize scope-localized config constants ([#667](https://github.com/nikunjmavani/core-be/issues/667)) ([f6dad66](https://github.com/nikunjmavani/core-be/commit/f6dad66887513bd519c020794526b3b32c8c728a))
* enforce architecture boundaries (DB-in-services, DI, controller thinness) ([#602](https://github.com/nikunjmavani/core-be/issues/602)) ([cc43b3b](https://github.com/nikunjmavani/core-be/commit/cc43b3b3f38cd94d190928ac6728f1077195bbbf))
* **quality:** clear SonarQube debt on the deployed surface ([#663](https://github.com/nikunjmavani/core-be/issues/663)) ([8f5116a](https://github.com/nikunjmavani/core-be/commit/8f5116a5ddb29ac435078922ed7188ca4f6f1df3))
* **queue:** remove redundant alert-only offboarding reconciler ([#611](https://github.com/nikunjmavani/core-be/issues/611)) ([55e979e](https://github.com/nikunjmavani/core-be/commit/55e979e10528a3b6c794aaea1595e7feeedbc7b6))
* route consistency + personal/team org model ([#658](https://github.com/nikunjmavani/core-be/issues/658)) ([d304b88](https://github.com/nikunjmavani/core-be/commit/d304b88439d8611d7b7d668f4b0d1f15c9a7a2dc))
* **tenancy:** route org-scoped controllers through claim-aware org accessor ([f4c3b54](https://github.com/nikunjmavani/core-be/commit/f4c3b54f70b5c9c49c2a03cf908f1407810138a8))
* **tenancy:** route org-scoped controllers through claim-aware org accessor ([af30b20](https://github.com/nikunjmavani/core-be/commit/af30b20e50b8c49f3c906bbbb1ca6d4093fd14ef))
* **validation:** extract shared parseWithSchema + parseCursorPaginatedQuery helpers ([#661](https://github.com/nikunjmavani/core-be/issues/661)) ([7831156](https://github.com/nikunjmavani/core-be/commit/78311567eb27b6676b63fa3dec89ab3d1bab3130))


### Documentation

* add 2026-06-04 deep audit report (20 findings) ([6515589](https://github.com/nikunjmavani/core-be/commit/65155899935406e72781fab5348f146b20b5b8e4))
* add deep backend audit report 2026-06-03 ([#362](https://github.com/nikunjmavani/core-be/issues/362)) ([3d7ae31](https://github.com/nikunjmavani/core-be/commit/3d7ae31779c7975b4b61d19c8f7867c8a58432a9))
* add remediation status tracker to 2026-06-03 audit report ([93ef121](https://github.com/nikunjmavani/core-be/commit/93ef12150cd3917f3a6ecc46c9e8da4573ada94b))
* **agent-os:** align schema skills to varchar(n) codebase convention ([#638](https://github.com/nikunjmavani/core-be/issues/638)) ([e575074](https://github.com/nikunjmavani/core-be/commit/e5750743e7a8af7a59eebd06d552ca8223a598d1))
* **agent-os:** correct stale workflow, seed, and provider paths in skills ([#641](https://github.com/nikunjmavani/core-be/issues/641)) ([5550f4c](https://github.com/nikunjmavani/core-be/commit/5550f4c274b58403008bb98dd4982642565ed110))
* **api:** add frontend auth & headers integration guide ([b8ca013](https://github.com/nikunjmavani/core-be/commit/b8ca01362c4a04aa8d65e511cac136a0953b2445))
* **api:** add frontend auth & headers integration guide ([ab201e8](https://github.com/nikunjmavani/core-be/commit/ab201e8046a524ad2f5dd9868e22897d77aaf2a9))
* **audit-2026-06-04:** mark all 20 findings resolved with file:line citations ([#381](https://github.com/nikunjmavani/core-be/issues/381)) ([96dd4f7](https://github.com/nikunjmavani/core-be/commit/96dd4f74574b1dca6ee93190b59edc56ab414b1e))
* check in sync; enricher unit tests + full suite (4,516) green. ([c58d39b](https://github.com/nikunjmavani/core-be/commit/c58d39b0aa550158d3106a41fadd403c203eb4c5))
* check verified green on 0.28.1. ([514fa96](https://github.com/nikunjmavani/core-be/commit/514fa961bd392ef4583c7e148a7f47277ef23dae))
* check, tsdoc 0/0, migrate lint, env sync, validate all pass. ([3311bc0](https://github.com/nikunjmavani/core-be/commit/3311bc022f65fcbd517802cc91dcb194d5a31c0c))
* consolidate setup guide into single root SETUP.md ([#555](https://github.com/nikunjmavani/core-be/issues/555)) ([5c311a3](https://github.com/nikunjmavani/core-be/commit/5c311a3c72f1fb33cb44daa087e94ee19e2edb1c))
* **env:** standardize OPTIONAL marker for conditionally-empty env keys ([#549](https://github.com/nikunjmavani/core-be/issues/549)) ([d7155b4](https://github.com/nikunjmavani/core-be/commit/d7155b48786aee7a8ce2e306133b61398f00cf20))
* **infra:** annotate Dockerfile build-stage ENV as test-only placeholders (sec-r4-C6) ([#519](https://github.com/nikunjmavani/core-be/issues/519)) ([cdf76ef](https://github.com/nikunjmavani/core-be/commit/cdf76ef7e6a85de7e638c161d1e7ad34dd12e38a))
* **integrations:** add Codex Cloud agent environment guide and GitHub prerequisites ([#660](https://github.com/nikunjmavani/core-be/issues/660)) ([d2128de](https://github.com/nikunjmavani/core-be/commit/d2128de716f1f19c25d934c87ecb517baf05d04e))
* **integrations:** add Postman + Resend agent MCP servers ([#631](https://github.com/nikunjmavani/core-be/issues/631)) ([6966744](https://github.com/nikunjmavani/core-be/commit/6966744da40ff9887700f433f78afc1f8f313140))
* **integrations:** common Claude Code session-setup overview ([#674](https://github.com/nikunjmavani/core-be/issues/674)) ([9052152](https://github.com/nikunjmavani/core-be/commit/90521520c34495a066342656f1ba104beb827f54))
* **integrations:** expand Stripe webhook runbook + Turnstile TODO ([#635](https://github.com/nikunjmavani/core-be/issues/635)) ([be08946](https://github.com/nikunjmavani/core-be/commit/be08946a84175689883f858e61e96b928e8c222d))
* **integrations:** fix Stripe CLI/Dashboard webhook URL ([#630](https://github.com/nikunjmavani/core-be/issues/630)) ([570e58f](https://github.com/nikunjmavani/core-be/commit/570e58f79991d12dcf75781ccdc9465da2647b85))
* **integrations:** map third-party services to CLI/MCP/SDK by consumer ([#626](https://github.com/nikunjmavani/core-be/issues/626)) ([5e90f52](https://github.com/nikunjmavani/core-be/commit/5e90f522061e5de8f31cb2905b9edda43caf2bf9))
* **openapi:** drop "Public ID" from request-body/query field descriptions → "id" ([3cb01a0](https://github.com/nikunjmavani/core-be/commit/3cb01a0b294a1a47a80a25a209ab410403e38117))
* **openapi:** drop "Public ID" from request-body/query field descriptions → "id" ([c58d39b](https://github.com/nikunjmavani/core-be/commit/c58d39b0aa550158d3106a41fadd403c203eb4c5))
* **process:** add release-versioning cheat-sheet (commit prefix → bump) ([#612](https://github.com/nikunjmavani/core-be/issues/612)) ([6e58397](https://github.com/nikunjmavani/core-be/commit/6e58397013279da347bf5a56305e150ea1cc8e26))
* **process:** document "watch CI -&gt; merge when green" in git flow + pr-babysit ([#616](https://github.com/nikunjmavani/core-be/issues/616)) ([0537a8e](https://github.com/nikunjmavani/core-be/commit/0537a8e86fc135038585d78b523e648cbc289e69))
* **reviews:** add agent-os AI-tooling audit + evals session writeup ([ef55c53](https://github.com/nikunjmavani/core-be/commit/ef55c536b406a3b1aea5df055c844bd4159c7a78))
* **reviews:** agent-os AI-tooling audit + evals/enforcement session writeup ([32288fa](https://github.com/nikunjmavani/core-be/commit/32288fa07f7e0b3caa92b5325ec51938b95be557))
* **reviews:** architecture conformance audit + 8-PR follow-up plan ([#531](https://github.com/nikunjmavani/core-be/issues/531)) ([4a9264c](https://github.com/nikunjmavani/core-be/commit/4a9264cb674f57930241a8b348d12afdcc727476))
* **reviews:** correct sec-r4-A3 analysis and defer to follow-up task ([#523](https://github.com/nikunjmavani/core-be/issues/523)) ([c7e1dab](https://github.com/nikunjmavani/core-be/commit/c7e1dab9433b40eb16a7df6e28fdf317df9318b7))
* **reviews:** route-coverage audit — 129 routes, 9 deferred gaps allowlisted ([#534](https://github.com/nikunjmavani/core-be/issues/534)) ([d18ec1d](https://github.com/nikunjmavani/core-be/commit/d18ec1df87b78237c77bac6f84b1ec464ff71965))
* **runbooks:** refresh worker registry breakdown to 30 workers / 27 Postgres ([#621](https://github.com/nikunjmavani/core-be/issues/621)) ([2d4d111](https://github.com/nikunjmavani/core-be/commit/2d4d111a9578679c856367881c16a5f6d8f62cb6))
* **superpowers:** re-audit remediation design spec for 18 findings ([#451](https://github.com/nikunjmavani/core-be/issues/451)) ([1b05734](https://github.com/nikunjmavani/core-be/commit/1b05734fe69e593ae6ad9f5fb2f11e6f4a8f69f6))

## [4.5.0](https://github.com/nikunjmavani/core-be/compare/v4.4.0...v4.5.0) (2026-06-17)


### Added

* 131-route security & production-flow audit — fix all RED/AMBER findings ([#601](https://github.com/nikunjmavani/core-be/issues/601)) ([3df1fbd](https://github.com/nikunjmavani/core-be/commit/3df1fbd91ea9011a6378a6f0785200e4a5f990ed))
* **agent-os:** add PreToolUse edit-guard and SessionStart hooks ([dcf6335](https://github.com/nikunjmavani/core-be/commit/dcf6335773cb9b8d15f570d7b2afac9e2a1a284c))
* **agent-os:** add RLS/tenant-isolation and idempotency guard skills ([a94cbb5](https://github.com/nikunjmavani/core-be/commit/a94cbb52df397f1abadf3a3f411f31bf2fc6f49a))
* **agent-os:** PreToolUse edit-guard + SessionStart hooks (Move 2) ([ad2e2b3](https://github.com/nikunjmavani/core-be/commit/ad2e2b3b87051c2fe34d3005d6a84fc6e37965e0))
* **agent-os:** RLS/tenant-isolation + idempotency guard skills ([0a3b902](https://github.com/nikunjmavani/core-be/commit/0a3b902748f4fc3e84d5d971b0915496b5e4f440))
* **ai:** cross-platform AI commands, SessionStart hook, and guardrails ([#643](https://github.com/nikunjmavani/core-be/issues/643)) ([b6fccf1](https://github.com/nikunjmavani/core-be/commit/b6fccf1630257d2920ba3831f625bbeeca7cad41))
* **audit:** transactional outbox for audit.logs writes (P0-[#2](https://github.com/nikunjmavani/core-be/issues/2)) ([#557](https://github.com/nikunjmavani/core-be/issues/557)) ([4c337da](https://github.com/nikunjmavani/core-be/commit/4c337da6b81523c01d23bf8947226194ee9ad665))
* **auth:** add switch-to-personal and switch-to-organization endpoints ([79be5b0](https://github.com/nikunjmavani/core-be/commit/79be5b0fe799563e9612eaa3fc48a4a12f3ce2ae))
* **auth:** carry active organization + session version as signed JWT claims ([9864a2e](https://github.com/nikunjmavani/core-be/commit/9864a2e34917837b7102fdd72f9ba61982e4b0e0))
* **auth:** GET /auth/me/context — frontend-ready effective context ([#659](https://github.com/nikunjmavani/core-be/issues/659)) ([d08bb35](https://github.com/nikunjmavani/core-be/commit/d08bb35049c443015b3d53be0f13c7a80f4a845a))
* **auth:** mint the active-organization claim at login (default selection) ([a3a805d](https://github.com/nikunjmavani/core-be/commit/a3a805dc143b7af537c0757b4b74bfc77516d75d))
* **auth:** permission layer falls back to the org token claim (Phase 3 bridge) ([ea07091](https://github.com/nikunjmavani/core-be/commit/ea0709135504d09faa6367bfded88107cc438295))
* **auth:** permission layer reads the org token claim (Phase 3 bridge) ([6b9e7c3](https://github.com/nikunjmavani/core-be/commit/6b9e7c3458f6788b5c75b0ed4a49d3709b48d181))
* **auth:** refresh re-mints the active-organization claim ([b22f0a1](https://github.com/nikunjmavani/core-be/commit/b22f0a1712aa76b1f997257997b157025712b791))
* **auth:** switch building blocks — membership-validation resolvers + session token re-bind ([62cc944](https://github.com/nikunjmavani/core-be/commit/62cc9449314b7684007c937a9ec72b73c2d0eceb))
* **auth:** switchToOrganization / switchToPersonal service methods ([3f5ecc8](https://github.com/nikunjmavani/core-be/commit/3f5ecc84267e747d6e6d900ae5caf733f6255752))
* **billing:** flatten subscription routes onto the org token claim ([f835d60](https://github.com/nikunjmavani/core-be/commit/f835d605e0529e0e0e91ca7da1b16aa5f8940bec))
* **billing:** flatten subscription routes onto the org token claim ([df21c2c](https://github.com/nikunjmavani/core-be/commit/df21c2c62c4b65e4f1bf57228743ac2cd042a92c))
* **ci:** add PR-time Trivy IaC misconfig scan ([#388](https://github.com/nikunjmavani/core-be/issues/388)) ([e8499e0](https://github.com/nikunjmavani/core-be/commit/e8499e04b8c8d311a14fb6ac3bdd1c4a4d151a49))
* **config:** gated local-dev defaults for DB/Redis/origins/retention ([#651](https://github.com/nikunjmavani/core-be/issues/651)) ([773e427](https://github.com/nikunjmavani/core-be/commit/773e427ca11bd44d1a65fea996ebbc92a629c236))
* **infra-tests:** drop_index_without_concurrently lint rule + org slug collision-proof factory ([#526](https://github.com/nikunjmavani/core-be/issues/526)) ([0915c85](https://github.com/nikunjmavani/core-be/commit/0915c851ab7b5c8934a06108d28f8aec3662e97b))
* **load:** per-VU credential pool + realistic user-journey k6 scenario ([#342](https://github.com/nikunjmavani/core-be/issues/342)) ([a05a611](https://github.com/nikunjmavani/core-be/commit/a05a611ced68683c0855c65d572fbc5fc7d06bb1))
* **mcp,k6:** client auth-flow guide + k6 org-claim flow; fix dead idempotency exclusions ([f4bac5a](https://github.com/nikunjmavani/core-be/commit/f4bac5aa9a67f14e5ec87209e326e67b5ae15de6))
* **mcp,k6:** client auth-flow guide + k6 org-claim flow; fix idempotency exclusions; flatten stale refs ([f6e5894](https://github.com/nikunjmavani/core-be/commit/f6e5894a66cee5de1ff0790f5898b5510fd74f37))
* **mcp:** scope project MCP servers and wire MCP setup into the session-start flow ([#675](https://github.com/nikunjmavani/core-be/issues/675)) ([9ed07b4](https://github.com/nikunjmavani/core-be/commit/9ed07b4ba576db0ac5849d9c7de76b4c2c91af73))
* **notify:** flatten webhook routes onto the org token claim ([643d13a](https://github.com/nikunjmavani/core-be/commit/643d13ad09bd64e28bca029e4ed42cc40b56d04f))
* **notify:** flatten webhook routes onto the org token claim ([0bdc8ad](https://github.com/nikunjmavani/core-be/commit/0bdc8add9f37df2bd944995368be8d9f94710755))
* **notify:** time-based retention for webhook_delivery_attempts (audit-[#3](https://github.com/nikunjmavani/core-be/issues/3)) ([05d6325](https://github.com/nikunjmavani/core-be/commit/05d63258002fd9762962498b0a5059a5b971400f))
* **observability:** emit Server-Timing header for true server-side latency ([#339](https://github.com/nikunjmavani/core-be/issues/339)) ([5e78cde](https://github.com/nikunjmavani/core-be/commit/5e78cde15b30deac077cbf4e27081cf6da27e814))
* **openapi:** document the full error-status matrix; observed-vs-spec error gate ([95a71b5](https://github.com/nikunjmavani/core-be/commit/95a71b505c9d8d7f802d73c4e0841b4140bf836d))
* **openapi:** document the full error-status matrix; observed-vs-spec error gate ([5a001de](https://github.com/nikunjmavani/core-be/commit/5a001de48bb661e048e012dde8ce658bfe612f3e))
* **openapi:** embed sanitized live-call request/response examples per route and status ([3a1ddb1](https://github.com/nikunjmavani/core-be/commit/3a1ddb1e5d38b40e18b9300a14942219da6ce868))
* **openapi:** embed sanitized live-call request/response examples per route and status ([bea574c](https://github.com/nikunjmavani/core-be/commit/bea574c92291f96bd309ad1969fe38cdf756722f))
* personal & team organizations — foundation + token/switch (Phase 1-2) ([9a8b179](https://github.com/nikunjmavani/core-be/commit/9a8b179a097b615b2e7292ad6f6362011ea2563c))
* **round-5-followup:** per-org row caps (api-keys, member-roles, notification-policies) + auth/MFA route policy tests ([#528](https://github.com/nikunjmavani/core-be/issues/528)) ([19b556f](https://github.com/nikunjmavani/core-be/commit/19b556f9379a3d70889644356e9928a68de549e9))
* **round-5:** residual-risk findings — DLQ-RLS bug + 5 backlog fixes + 3 test gaps + audit doc ([#527](https://github.com/nikunjmavani/core-be/issues/527)) ([6aa6f88](https://github.com/nikunjmavani/core-be/commit/6aa6f8831e12fa7c8ef88f3d95f9e15bcd2d23d2))
* **scalar:** publish OpenAPI to Scalar Registry (CI docs pipeline + interactive setup) ([#672](https://github.com/nikunjmavani/core-be/issues/672)) ([3ddc9b2](https://github.com/nikunjmavani/core-be/commit/3ddc9b2325a8cc8417bfe679c748a64f5c510da2))
* **tenancy:** atomic org provisioning with owner role+permissions+membership ([266b22e](https://github.com/nikunjmavani/core-be/commit/266b22ebeb3604dbc45d08608efd7604df37c81e))
* **tenancy:** auto-provision personal org at signup + exclude personal from delete guard ([9daed03](https://github.com/nikunjmavani/core-be/commit/9daed03c85997744bbfeb50919681de5658cd556))
* **tenancy:** block invitations on a personal organization (capability matrix) ([cafc549](https://github.com/nikunjmavani/core-be/commit/cafc5493d497f7e99a924a152ca6a64e4f29dd0d))
* **tenancy:** cap team organizations per owner (anti-abuse) ([f71b968](https://github.com/nikunjmavani/core-be/commit/f71b968577aa19a8ce4c3b4f6ce83142c3fd51d3))
* **tenancy:** flatten organization routes onto the org token claim ([ddd1a76](https://github.com/nikunjmavani/core-be/commit/ddd1a7604f7da6dfb3a878fdb28c9e35dff086d8))
* **tenancy:** flatten organization routes onto the org token claim ([f35b74e](https://github.com/nikunjmavani/core-be/commit/f35b74eb0f14cf2e5225b3fb477ea686a82763ed))
* **tenancy:** make the personal organization immutable (no delete / no transfer) ([a726064](https://github.com/nikunjmavani/core-be/commit/a726064b5f009c1a5ccd878fe8379eb79a533a37))
* **tenancy:** org-creation per-owner cap + personal-org capability guards ([94d7715](https://github.com/nikunjmavani/core-be/commit/94d77153740b2076afb57ded14748b727367617c))
* **tenancy:** organization create accepts type + nullable slug (provisioning groundwork) ([35bc409](https://github.com/nikunjmavani/core-be/commit/35bc409c7e85453a2d294f1baf4bd38b19e26d6f))
* **tenancy:** personal-org backfill script + provisioning tests ([5a40f5d](https://github.com/nikunjmavani/core-be/commit/5a40f5d5eadfd970e712b8d4b5a7f85b86258727))
* **tenancy:** personal/team organization foundation — schema + capability flags ([11e23d9](https://github.com/nikunjmavani/core-be/commit/11e23d92fc301307638f73e3e1269a0612ddde3d))
* **testing:** route success-status registry, observed coverage ratchet, never-5xx fuzz gate ([8d88dcf](https://github.com/nikunjmavani/core-be/commit/8d88dcf0677104ce4885ad80d62543c6ec45052a))
* **testing:** route success-status registry, observed coverage ratchet, never-5xx fuzz gate ([dfe2b43](https://github.com/nikunjmavani/core-be/commit/dfe2b436d3fa28843597576d6b29f43d7932d8ab))
* **testing:** verified happy path for every route — budget 30→0; 201 creates; OAuth 404 ([01b1b77](https://github.com/nikunjmavani/core-be/commit/01b1b77cbf2f60dcafbfa1afeafab68fe1e54437))
* **testing:** verified happy path for every route — budget 30→0; 201 creates; OAuth 404 ([624c9d5](https://github.com/nikunjmavani/core-be/commit/624c9d58945e78317e39cd9a412e488454fbdf29))
* **tests:** post-load settle-and-assert-clean gate + audit-outbox drain coverage ([01258c5](https://github.com/nikunjmavani/core-be/commit/01258c5b5aa9c03f8d6e9c7c9a5218cd10d3750b))
* **tooling:** project identity refactor, 5 review agents, architecture policy tests ([#552](https://github.com/nikunjmavani/core-be/issues/552)) ([324689e](https://github.com/nikunjmavani/core-be/commit/324689e3c5027056932272f90d3495539d25ea44))
* **user:** add a scheduled reconciler that detects + alerts on stuck offboarding (audit-[#15](https://github.com/nikunjmavani/core-be/issues/15)) ([6443673](https://github.com/nikunjmavani/core-be/commit/64436733ec73792a3295b46ade51da2ceee98a53))
* **user:** expose deployment organization capabilities on /users/me ([a27f7a6](https://github.com/nikunjmavani/core-be/commit/a27f7a6d9a1a03a75e6163ab061e137d8a65e1d8))
* **user:** expose personal_organization_id on /users/me ([b725aca](https://github.com/nikunjmavani/core-be/commit/b725acad609f8a9743f2a199c4234df423ade3a5))


### Fixed

* 8th-audit concurrency races + correctness hardening (C1-C5) ([bf077b7](https://github.com/nikunjmavani/core-be/commit/bf077b743cfbe51549c39ca4d4ae28b824a1a6df))
* **api:** truthful error envelope, id-only external fields, DELETE→204 stragglers, local oasdiff gate ([25b4629](https://github.com/nikunjmavani/core-be/commit/25b46297b331681b528962246f8bee28c4695204))
* **api:** truthful error envelope, id-only external fields, DELETE→204 stragglers, local oasdiff gate ([2777308](https://github.com/nikunjmavani/core-be/commit/2777308d77c2938b0f66437a24a02b9637392b19))
* audit batch2 — WebAuthn typed DTOs, oasdiff SIGSEGV CI workaround ([6e44557](https://github.com/nikunjmavani/core-be/commit/6e4455700f39ed6cc6dee5ca71baf4eaddac49ed))
* **audit-13:** remove dead jobTimeout field from worker options — BullMQ does not enforce it ([#379](https://github.com/nikunjmavani/core-be/issues/379)) ([b393d5e](https://github.com/nikunjmavani/core-be/commit/b393d5e0add3e299de889d023056397a559b5df6))
* **audit:** cursor max-length, DLQ catch, jobTimeout, age-based queue eviction (batch5) ([#375](https://github.com/nikunjmavani/core-be/issues/375)) ([5882436](https://github.com/nikunjmavani/core-be/commit/588243618efe4be76f3b9e1d2b0c2aa851b06930))
* **audit:** MCP caller JWT forwarding and IP-level failed-login counter ([#373](https://github.com/nikunjmavani/core-be/issues/373)) ([ceee226](https://github.com/nikunjmavani/core-be/commit/ceee2269da8c40bb16f1332e56de8028de24b069))
* **audit:** omit soft-deleted orgs from audit-log public id resolution (sec-r4-D2) ([#506](https://github.com/nikunjmavani/core-be/issues/506)) ([e76a015](https://github.com/nikunjmavani/core-be/commit/e76a01530ed22da2e35d21f0080547075d0475d8))
* **audit:** rate limits, User-Agent truncation, webhook HTTPS, CAPTCHA staging (batch4) ([#374](https://github.com/nikunjmavani/core-be/issues/374)) ([4c9486a](https://github.com/nikunjmavani/core-be/commit/4c9486ac64959cea4bd308cb59c37ba858018066))
* **auth-webauthn:** require user verification at options time (sec-r4-A2) ([#514](https://github.com/nikunjmavani/core-be/issues/514)) ([38f60cf](https://github.com/nikunjmavani/core-be/commit/38f60cf8443a94ff327e95e6bad5d03d7bdf6947))
* **auth,openapi:** MFA-login org claim (H1) + captcha/bearerAuth OpenAPI accuracy ([909a5ce](https://github.com/nikunjmavani/core-be/commit/909a5ce448a362af445736e8a02cb2e18b7949b8))
* **auth,openapi:** mfa-login org claim (H1) plus captcha and bearerAuth openapi accuracy ([fc336b8](https://github.com/nikunjmavani/core-be/commit/fc336b867a9a597fb3c613aa0574a4b8e91bae60))
* **auth:** add user FK + index to mfa_methods to purge orphaned MFA secrets (reaudit-[#1](https://github.com/nikunjmavani/core-be/issues/1)) ([a5a0992](https://github.com/nikunjmavani/core-be/commit/a5a0992eb777f40851e2c97ac7c26ff371325c06))
* **auth:** atomic credential-mutation guards + lockout counter (route-audit C1, C5) ([e6e33db](https://github.com/nikunjmavani/core-be/commit/e6e33db37b405bf0c92622b3c152f35c88cbf186))
* **auth:** block revoking the current session via DELETE /me/sessions/:id (route-[#9](https://github.com/nikunjmavani/core-be/issues/9)) ([19f4bff](https://github.com/nikunjmavani/core-be/commit/19f4bff7ba7a651f630204a173f859dc40206d2b))
* **auth:** bounded refresh-token reuse grace for concurrent refreshes (audit-[#2](https://github.com/nikunjmavani/core-be/issues/2)) ([0cdd75d](https://github.com/nikunjmavani/core-be/commit/0cdd75dd8b85e880950b8a076fbadee39c01d18f))
* **auth:** close session-revoke cache repopulation race + normalize OAuth email (route-audit session-[#1](https://github.com/nikunjmavani/core-be/issues/1), oauth-[#3](https://github.com/nikunjmavani/core-be/issues/3)) ([b8303a0](https://github.com/nikunjmavani/core-be/commit/b8303a02e1e7010f9516e0e5c2df5b7777c83694))
* **auth:** close WebAuthn enumeration timing oracle + complete credential-mutation lock (route-audit D1, D2, D3) ([10e2b52](https://github.com/nikunjmavani/core-be/commit/10e2b5271c7cb454e15e99035389787e5c233c25))
* **auth:** drop SUPER_ADMIN for non-active accounts in per-request re-derive (reaudit-[#10](https://github.com/nikunjmavani/core-be/issues/10)) ([e54a97b](https://github.com/nikunjmavani/core-be/commit/e54a97bd1e643916ac3eb579eeda2dcdb1d26493))
* **auth:** fix controller unit test and ack OpenAPI breaking change for B4 ([48f8c81](https://github.com/nikunjmavani/core-be/commit/48f8c818fa14f205efe5a6e12d2528e8461f6790))
* **auth:** floor login failure branches to mask enumeration timing (audit-[#15](https://github.com/nikunjmavani/core-be/issues/15)d) ([0c4af59](https://github.com/nikunjmavani/core-be/commit/0c4af594c6aba8d84d383d20c01838ef6d134bf0))
* **auth:** key DELETE /mfa/:mfaMethodId on public id, not the sequential DB id (route-[#10](https://github.com/nikunjmavani/core-be/issues/10)) ([31bdd46](https://github.com/nikunjmavani/core-be/commit/31bdd46de650dce63aa6bc542beda50d57c0dea2))
* **auth:** make magic-link verification atomic with first-factor completion (audit-[#12](https://github.com/nikunjmavani/core-be/issues/12)) ([4350845](https://github.com/nikunjmavani/core-be/commit/435084506afc855e48169b8e26b3d87a1690f36a))
* **auth:** make MFA verification lockout counter atomic (route-audit-[#4](https://github.com/nikunjmavani/core-be/issues/4)) ([7d98218](https://github.com/nikunjmavani/core-be/commit/7d982183877aeea6cbc4531cea9eb47376c704fc))
* **auth:** make one-time-token issuance atomic with the mail-outbox insert (audit-[#11](https://github.com/nikunjmavani/core-be/issues/11)) ([f122beb](https://github.com/nikunjmavani/core-be/commit/f122beb20866aaf4748b05d29d2307f9a0768462))
* **auth:** make password change and email verification atomic with their side effects (audit-[#4](https://github.com/nikunjmavani/core-be/issues/4), [#12](https://github.com/nikunjmavani/core-be/issues/12)) ([42d7893](https://github.com/nikunjmavani/core-be/commit/42d7893572ee6e89c5bbe42a08cc18d1f33aa6e6))
* **auth:** make password reset atomic (transaction) so sessions can't survive it ([#319](https://github.com/nikunjmavani/core-be/issues/319)) ([30cffe5](https://github.com/nikunjmavani/core-be/commit/30cffe5c205fdd7d0f1a835cf335791ad78ad36e))
* **auth:** per-user MFA verification lockout (audit-[#12](https://github.com/nikunjmavani/core-be/issues/12)) ([d6331e0](https://github.com/nikunjmavani/core-be/commit/d6331e01f9a0d378096ecc26b30404f23fc20d7c))
* **auth:** persist and revalidate the active organization across refresh (audit-[#3](https://github.com/nikunjmavani/core-be/issues/3)) ([f9d8f1b](https://github.com/nikunjmavani/core-be/commit/f9d8f1b5a757c5b8dc5f267f4cf166f2e5677816))
* **auth:** re-derive any privileged JWT claim (admin + super_admin) against live state (route-[#6](https://github.com/nikunjmavani/core-be/issues/6)) ([956c43d](https://github.com/nikunjmavani/core-be/commit/956c43d855978ea9f49c573e4c8a498ae2c4309f))
* **auth:** remove silent params.id fallback in requireOrganizationPermission ([#346](https://github.com/nikunjmavani/core-be/issues/346)) ([17f4d83](https://github.com/nikunjmavani/core-be/commit/17f4d83fae5114820bf4f1c00940306628ea1228))
* **auth:** restore org-mandated MFA under FORCE RLS via SECURITY DEFINER resolvers ([#318](https://github.com/nikunjmavani/core-be/issues/318)) ([e152c0c](https://github.com/nikunjmavani/core-be/commit/e152c0c458aed788289c7d75b3e8fe0c79ec938f))
* **auth:** restrict POST /me/auth-methods to MAGIC_LINK to stop phantom-credential lockout (route-[#3](https://github.com/nikunjmavani/core-be/issues/3)) ([ee9af9a](https://github.com/nikunjmavani/core-be/commit/ee9af9a5819990189c658a69d9396e0fdb3ed7c5))
* **auth:** scope MFA lockout to TOTP so recovery codes stay usable (reaudit-[#3](https://github.com/nikunjmavani/core-be/issues/3)) ([a6d4b05](https://github.com/nikunjmavani/core-be/commit/a6d4b05530cd06f563be8a0ede17552d6831f4ac))
* **auth:** sec-new-A2 reject suspended/deleted users on bearer auth cache miss ([#474](https://github.com/nikunjmavani/core-be/issues/474)) ([eff74f4](https://github.com/nikunjmavani/core-be/commit/eff74f453a57f071258b8275aa850d375e6a67cc))
* **auth:** sec-new-A3 preserve caller session on DELETE /me/sessions ([#478](https://github.com/nikunjmavani/core-be/issues/478)) ([32936f3](https://github.com/nikunjmavani/core-be/commit/32936f3625022fcb98a3b2f681b6d19ee86a7611))
* **auth:** sec-new-A4 flip is_mfa_enabled inside deleteMfa transaction ([#479](https://github.com/nikunjmavani/core-be/issues/479)) ([a50d899](https://github.com/nikunjmavani/core-be/commit/a50d8995f7c42b08643d6a503b70971d24cbf6e9))
* **auth:** sec-new-B4 add public_id to auth_methods, stop leaking bigserial ids ([c82295d](https://github.com/nikunjmavani/core-be/commit/c82295d43b2768b8fb53160c26704e3dabadf4ce))
* **auth:** sec-new-B4 add public_id to auth_methods, stop leaking bigserial ids ([02a6ddd](https://github.com/nikunjmavani/core-be/commit/02a6ddd7b4dff060e87709bfa74dcd955a679228))
* **auth:** session-revoke cache repopulation race + OAuth email normalization ([c981c7f](https://github.com/nikunjmavani/core-be/commit/c981c7f634a1090faae6513d62aa30206e5e1778))
* **auth:** stop GET /auth/me/auth-methods leaking encrypted TOTP secret + PII ([#321](https://github.com/nikunjmavani/core-be/issues/321)) ([32cb49e](https://github.com/nikunjmavani/core-be/commit/32cb49e7b1c2039c2554adc481c2f68837720e6e))
* **auth:** switch-to-organization relies on route schema for body validation + suite green ([ab02f71](https://github.com/nikunjmavani/core-be/commit/ab02f711379690a987cf2cc7ab46139dc411adf8))
* **auth:** WebAuthn enumeration timing oracle + complete credential-mutation lock (D1/D2/D3) ([9a1f3f0](https://github.com/nikunjmavani/core-be/commit/9a1f3f0d5aef7156d4d455935f5295f20b76d257))
* backend production-readiness audit findings ([0f60e0f](https://github.com/nikunjmavani/core-be/commit/0f60e0f71d6dd0b1f7a5d9aa20bf60712c8a04cb))
* backend production-readiness re-audit findings ([6bd64bc](https://github.com/nikunjmavani/core-be/commit/6bd64bc3c47c7c28a1f1d42121867bc990f9c99c))
* **billing:** add per-route rate limit to subscription mutations (route-[#2](https://github.com/nikunjmavani/core-be/issues/2)) ([1e6975e](https://github.com/nikunjmavani/core-be/commit/1e6975e24271d14561f544981c651e254c3ef862))
* **billing:** alert on plan&lt;-&gt;Stripe price catalog drift (audit-[#13](https://github.com/nikunjmavani/core-be/issues/13)) ([3377510](https://github.com/nikunjmavani/core-be/commit/33775103b9ec7470270ff172b734b34586aebcb3))
* **billing:** bound PlanRepository.findAllActive at 100 rows (sec-r4-D3) ([#507](https://github.com/nikunjmavani/core-be/issues/507)) ([43180a9](https://github.com/nikunjmavani/core-be/commit/43180a98e2b62abdc0584460d06d455a55701900))
* **billing:** cancel the org's active subscription on organization delete (route-audit-[#2](https://github.com/nikunjmavani/core-be/issues/2)) ([718c80f](https://github.com/nikunjmavani/core-be/commit/718c80f307ae14d9db2ff77dbd26ae591f667afc))
* **billing:** cancel() releases the slot for never-activated INCOMPLETE subscriptions (reaudit-[#6](https://github.com/nikunjmavani/core-be/issues/6)) ([3d6cfe0](https://github.com/nikunjmavani/core-be/commit/3d6cfe03758b1302a8d1e7f8612d4641d381c1e8))
* **billing:** correct misleading plan route OpenAPI descriptions ([#349](https://github.com/nikunjmavani/core-be/issues/349)) ([27246ce](https://github.com/nikunjmavani/core-be/commit/27246ce78082f134005ac028852c7d95233f3c8b))
* **billing:** enforce unique subscriptions.provider_subscription_id (audit-[#10](https://github.com/nikunjmavani/core-be/issues/10)) ([acf919b](https://github.com/nikunjmavani/core-be/commit/acf919b105cbc10c502b8b197f5af1bd8782646c))
* **billing:** hide inactive plans from public GET /billing/plans/:id (route-[#7](https://github.com/nikunjmavani/core-be/issues/7)) ([0be46ed](https://github.com/nikunjmavani/core-be/commit/0be46ed971f32287ba326cdbbbb94275ca7f9465))
* **billing:** make Stripe customer creation idempotent on retry ([#326](https://github.com/nikunjmavani/core-be/issues/326)) ([8990fb3](https://github.com/nikunjmavani/core-be/commit/8990fb32b15fa133aece4ce428182d9b1996ee93))
* **billing:** make terminal subscriptions immutable (compare-and-set, B5/B6) ([5ac4328](https://github.com/nikunjmavani/core-be/commit/5ac43284d69e28101615d1a2f2caa306ab31cfe2))
* **billing:** make terminal subscriptions immutable via compare-and-set (route-audit B5, B6) ([18a3e43](https://github.com/nikunjmavani/core-be/commit/18a3e43540814b94e66ad085f40df767a32598e3))
* **billing:** persist a CANCELED tombstone for out-of-order Stripe deletions (audit-[#1](https://github.com/nikunjmavani/core-be/issues/1)) ([7862609](https://github.com/nikunjmavani/core-be/commit/7862609ed32b9c5c16d5780f4a6d7b59ba5066bb))
* **billing:** persist new Stripe subscriptions as INCOMPLETE not TRIALING (audit-[#2](https://github.com/nikunjmavani/core-be/issues/2)) ([b5a7f66](https://github.com/nikunjmavani/core-be/commit/b5a7f66537091e20632b3898364c7ac71e3f9f5f))
* **billing:** pin Stripe API version to 2026-05-27.dahlia ([#350](https://github.com/nikunjmavani/core-be/issues/350)) ([7c329bd](https://github.com/nikunjmavani/core-be/commit/7c329bd496bdff587f3c12748f923a2ef7267909))
* **billing:** release subscription slot for INCOMPLETE_EXPIRED (audit-[#1](https://github.com/nikunjmavani/core-be/issues/1)) ([14cd328](https://github.com/nikunjmavani/core-be/commit/14cd3289545d1229e72b08e16977286cde39db18))
* **billing:** remove redundant parseBullMQJobData from stripe-webhook processor (sec-r4-Q1) ([#502](https://github.com/nikunjmavani/core-be/issues/502)) ([d20c731](https://github.com/nikunjmavani/core-be/commit/d20c731dbaf5764fcb0ebf96376830c882991205))
* **billing:** sec-new-B1 guard cancel/resume/changePlan against terminal subscriptions ([#475](https://github.com/nikunjmavani/core-be/issues/475)) ([86bb32f](https://github.com/nikunjmavani/core-be/commit/86bb32f6de0ed2c3e293f2a17f979b9cfbfc3328))
* **billing:** sec-new-D1-D2 data integrity guards in billing writes ([#476](https://github.com/nikunjmavani/core-be/issues/476)) ([def085a](https://github.com/nikunjmavani/core-be/commit/def085adf233218dac8c01dad35e2efde385313b))
* **billing:** sec-new-M2 emit Deprecation+Sunset headers on deprecated /stripe/webhook alias ([#489](https://github.com/nikunjmavani/core-be/issues/489)) ([d95f4aa](https://github.com/nikunjmavani/core-be/commit/d95f4aa8becdae0454be1d727a09c1580fb1ff4d))
* **billing:** set concrete sunset for deprecated stripe webhook alias (audit-[#15](https://github.com/nikunjmavani/core-be/issues/15)a) ([4efb4a7](https://github.com/nikunjmavani/core-be/commit/4efb4a78e02af5da54c10fb04de02239120b1f79))
* **billing:** support comma-separated STRIPE_WEBHOOK_SECRET for zero-downtime rotation (sec-new-B3) ([#490](https://github.com/nikunjmavani/core-be/issues/490)) ([4be65fe](https://github.com/nikunjmavani/core-be/commit/4be65fe218a948b63f9386a09a934aa4cb4d42e5))
* block user delete when owning orgs + webhook updated_at flake ([08a5ac2](https://github.com/nikunjmavani/core-be/commit/08a5ac27734c2d3abb3604ab5e694abeb429d85e))
* **cache:** add commandTimeout to Redis client to prevent hung commands ([8cd8107](https://github.com/nikunjmavani/core-be/commit/8cd8107df573d5a8255911dc2fac8f21e676fb66))
* **ci:** dispatch stable release backmerge ([be9190f](https://github.com/nikunjmavani/core-be/commit/be9190f6ff26d04905bc46127717c96fbbe57ab0))
* **ci:** export GLOBAL_ADMIN_EMAILS in test-env so audit.test.ts super-admin paths work in Matrix Tests ([#532](https://github.com/nikunjmavani/core-be/issues/532)) ([873f59d](https://github.com/nikunjmavani/core-be/commit/873f59df59340bc182e3d8f261b5c2e435f89c63))
* **ci:** grant release-please job id-token + actions write permissions ([#536](https://github.com/nikunjmavani/core-be/issues/536)) ([b83eab2](https://github.com/nikunjmavani/core-be/commit/b83eab2d4ac3e2b46f5e77e00e34d720db6508e0))
* **ci:** publish API docs (incl. Scalar Registry) independently of release-please ([#676](https://github.com/nikunjmavani/core-be/issues/676)) ([7c4fe62](https://github.com/nikunjmavani/core-be/commit/7c4fe62027431e4d79e006afb84cc24c61e5fc67))
* **ci:** publish Scalar registry from GitHub Variables ([#677](https://github.com/nikunjmavani/core-be/issues/677)) ([cfaaef8](https://github.com/nikunjmavani/core-be/commit/cfaaef883eb57327cfd3f558597407250d3a752c))
* **ci:** use bare check-run names as ruleset required-check contexts ([#344](https://github.com/nikunjmavani/core-be/issues/344)) ([c431a63](https://github.com/nikunjmavani/core-be/commit/c431a63a292e9dcff7dc09147c9ae0fd7eb3d5d2))
* **ci:** use fetch-depth: 0 in post-merge changes job to avoid paths-filter race ([#390](https://github.com/nikunjmavani/core-be/issues/390)) ([61a2100](https://github.com/nikunjmavani/core-be/commit/61a210090ae518f75f459cc33806b10ba1442993))
* **config:** cap AUTH_SESSION_MAX_AGE_DAYS at 365 (sec-r4-C4) ([#510](https://github.com/nikunjmavani/core-be/issues/510)) ([2a48a88](https://github.com/nikunjmavani/core-be/commit/2a48a88355744445298e8fb36dda0c22fca0b472))
* **config:** make .env.local the self-contained primary local env file ([#650](https://github.com/nikunjmavani/core-be/issues/650)) ([aeb32e7](https://github.com/nikunjmavani/core-be/commit/aeb32e7c60d4686f71b2f14f46efe873404652c3))
* **config:** require legacy JWT gate closed once keyring configured in prod (audit-[#15](https://github.com/nikunjmavani/core-be/issues/15)b) ([43e5139](https://github.com/nikunjmavani/core-be/commit/43e5139de2e4b9f7e969b9832e8ffac1a0c32b89))
* **database:** keyset-page batch delete so FK-blocked rows can't infinite-loop retention ([fd9b523](https://github.com/nikunjmavani/core-be/commit/fd9b523ecaf1825d111a636d6cad954ecba6e83a))
* **database:** keyset-page batch delete so FK-blocked rows can't infinite-loop retention (route-audit A1) ([f81ca72](https://github.com/nikunjmavani/core-be/commit/f81ca724b6e5d25c158e02403ee39d7132c8c8f2))
* **database:** sec-new-Q4 apply worker statement timeout in system-table retention context ([#487](https://github.com/nikunjmavani/core-be/issues/487)) ([4e0b5c2](https://github.com/nikunjmavani/core-be/commit/4e0b5c2156544d72b9dbf51b4a3c07b77930492a))
* **db:** enforce RLS deny-all on billing.plans and tenancy.permissions (reaudit-[#9](https://github.com/nikunjmavani/core-be/issues/9)) ([2bb9476](https://github.com/nikunjmavani/core-be/commit/2bb947621fafabfd2ec03ca2d2fc9f905970c838))
* **deps:** bump esbuild override to &gt;=0.28.1 (GHSA-gv7w-rqvm-qjhr / GHSA-g7r4-m6w7-qqqr) ([514fa96](https://github.com/nikunjmavani/core-be/commit/514fa961bd392ef4583c7e148a7f47277ef23dae))
* **deps:** override @grpc/grpc-js to &gt;=1.14.4 (GHSA-5375-pq7m-f5r2) ([0a66557](https://github.com/nikunjmavani/core-be/commit/0a6655731c02a3efa03ca598c306fce4d34012c7))
* **docker:** add HEALTHCHECK to worker image (audit-[#15](https://github.com/nikunjmavani/core-be/issues/15)c) ([b4f7a67](https://github.com/nikunjmavani/core-be/commit/b4f7a67cc2072c9510f63906b2b1ec50ae114f92))
* **docker:** refresh apk index so base-image security patches install ([#607](https://github.com/nikunjmavani/core-be/issues/607)) ([a3690b9](https://github.com/nikunjmavani/core-be/commit/a3690b91f2f61f48f837553c74890e5d358fbec3))
* **docker:** worker HEALTHCHECK honors WORKER_HEALTH_PORT at runtime (reaudit-[#8](https://github.com/nikunjmavani/core-be/issues/8)) ([3530bff](https://github.com/nikunjmavani/core-be/commit/3530bff1c5cb6a65e21cc0f507018211150236a3))
* **email-templates:** escape URL fields in invitation and magic-link templates ([#364](https://github.com/nikunjmavani/core-be/issues/364)) ([26c67fa](https://github.com/nikunjmavani/core-be/commit/26c67fac20bff7ccf765c6d93a6264e35ebee079))
* **events:** capture swallowed event-bus errors in Sentry ([2a30d84](https://github.com/nikunjmavani/core-be/commit/2a30d845482dadbe97dd922a4bc54e974105655a))
* **events:** release commit-dispatch marker on rollback (in-memory leak) ([#324](https://github.com/nikunjmavani/core-be/issues/324)) ([7e3ec55](https://github.com/nikunjmavani/core-be/commit/7e3ec559455954d9aeb489e69c4bf416801d76d3))
* **finding-13:** escape title/preheader/footerText inside baseTemplate ([8996b26](https://github.com/nikunjmavani/core-be/commit/8996b2616b52de6f55b0b16315c4a439034e3fba))
* **finding-46:** validate DATABASE_HTTP_STATEMENT_TIMEOUT_MS stays within permission cache lock TTL ([#356](https://github.com/nikunjmavani/core-be/issues/356)) ([47bdab4](https://github.com/nikunjmavani/core-be/commit/47bdab435f83a307cc04f4dc8274f5407aeb8ad3))
* **finding-62:** export WEBHOOK_DELIVERY_JOB_ATTEMPTS and fix vi.mock factories ([#357](https://github.com/nikunjmavani/core-be/issues/357)) ([cd24515](https://github.com/nikunjmavani/core-be/commit/cd24515fa2acf75774da7d636ea42bc0212ec3a2))
* **finding-74:** replace unsafe Stripe object casts with proper type narrowing ([#359](https://github.com/nikunjmavani/core-be/issues/359)) ([f8f9cfe](https://github.com/nikunjmavani/core-be/commit/f8f9cfe8ae24f51ff34c92100dd31b2d1f7745fe))
* **infra:** throw on startup when monolithic worker pool demand exceeds DATABASE_POOL_MAX ([faf2fab](https://github.com/nikunjmavani/core-be/commit/faf2fab638f0b77d1ea82dd856d3cefefa893711))
* **infra:** use correct JWT env keys in docker-compose smoke profile (sec-r4-C5) ([#512](https://github.com/nikunjmavani/core-be/issues/512)) ([c9a48f1](https://github.com/nikunjmavani/core-be/commit/c9a48f107f0f89fe41814c253e4d3defc0595437))
* **lockfile:** regenerate pnpm-lock.yaml (merge produced duplicate mapping key) ([c2eba7e](https://github.com/nikunjmavani/core-be/commit/c2eba7eb879f20ee0b5ff182c5edf1ca64715308))
* **mail:** scrub secret-bearing body on terminally-failed outbox rows (audit-[#10](https://github.com/nikunjmavani/core-be/issues/10)) ([61dc948](https://github.com/nikunjmavani/core-be/commit/61dc948505b0eb6e4e7c60020d66a7c3663452bb))
* **mcp:** apply STRICT_AUTHED_RATE_LIMIT to MCP endpoint (audit finding [#7](https://github.com/nikunjmavani/core-be/issues/7)) ([#366](https://github.com/nikunjmavani/core-be/issues/366)) ([6783141](https://github.com/nikunjmavani/core-be/commit/6783141ed14cc7009e1ec2be258386fac1706ed3))
* **mcp:** strip X-Organization-Id from call_api proxied sub-requests (route-[#8](https://github.com/nikunjmavani/core-be/issues/8)) ([d5a7167](https://github.com/nikunjmavani/core-be/commit/d5a716716e8acff86e1523641e3f44620374411c))
* **migration:** make audit_logs_actor_api_key FK idempotent (unblock dev deploy) ([#385](https://github.com/nikunjmavani/core-be/issues/385)) ([b8cc4fb](https://github.com/nikunjmavani/core-be/commit/b8cc4fb70d3d3d13f31f4b67af35772ff5afdb7e))
* **migration:** make core_be_app least-privilege ALTER ROLE Neon-safe (unblocks all deploys) ([#341](https://github.com/nikunjmavani/core-be/issues/341)) ([488c793](https://github.com/nikunjmavani/core-be/commit/488c793ee93173a2b7d1cedb32879743c3136533))
* **notify:** cap webhook response body bytes read before truncation (audit-[#6](https://github.com/nikunjmavani/core-be/issues/6)) ([0f2421e](https://github.com/nikunjmavani/core-be/commit/0f2421e3b6b211f888f08a0161274063d7599cc1))
* **notify:** durability-first notification email dedup to stop lost emails (audit-[#7](https://github.com/nikunjmavani/core-be/issues/7)) ([b9d9759](https://github.com/nikunjmavani/core-be/commit/b9d9759885b92320210d681520ecc16236d70d2c))
* **notify:** durable mail-outbox dedupe key to close concurrent duplicate-email window (reaudit-[#4](https://github.com/nikunjmavani/core-be/issues/4)) ([47cd280](https://github.com/nikunjmavani/core-be/commit/47cd280504c9acdf324b2ff11ff4ca36ded05a1c))
* **notify:** enforce webhook secret-rotation eligibility in the update predicate (audit-[#9](https://github.com/nikunjmavani/core-be/issues/9)) ([d3337e0](https://github.com/nikunjmavani/core-be/commit/d3337e0c3ad3e314206cce494c23e6b644c90d03))
* **notify:** guard webhook secret re-rotation within the dual-sign overlap window ([0cfedd0](https://github.com/nikunjmavani/core-be/commit/0cfedd0d28177f40f354133a3d1f53b94002e955))
* **notify:** guard webhook secret re-rotation within the dual-sign overlap window (route-audit webhook-[#1](https://github.com/nikunjmavani/core-be/issues/1)) ([5c16f85](https://github.com/nikunjmavani/core-be/commit/5c16f8548c7c528944d937c60fe985ee887e8174))
* **notify:** route webhook handlers through zodApplication type provider ([eaa5684](https://github.com/nikunjmavani/core-be/commit/eaa5684c13253e6f5c7204a7dc8b479e4c9c5465))
* **notify:** sec-new-B2 replace bigserial with public_id in X-Webhook-Delivery-Id header ([#494](https://github.com/nikunjmavani/core-be/issues/494)) ([771954a](https://github.com/nikunjmavani/core-be/commit/771954a360383fcb797e38a6ea55b07d2055790c))
* **notify:** sec-new-D4 add status=PENDING filter to fallback SELECT in webhook delivery ([#488](https://github.com/nikunjmavani/core-be/issues/488)) ([164c6f8](https://github.com/nikunjmavani/core-be/commit/164c6f8a0bebbc89f0bb47d0b432e0db0bf453d7))
* **notify:** sec-new-N1 validate webhookId path param in all webhook handlers ([#482](https://github.com/nikunjmavani/core-be/issues/482)) ([d66099e](https://github.com/nikunjmavani/core-be/commit/d66099e00764f935260de97560e60529d61d5e53))
* **notify:** stamp webhook updated_at as greatest(created_at, now()) to fix chk_webhooks_updated flake ([988d87b](https://github.com/nikunjmavani/core-be/commit/988d87baf86a74ebb05ba9d81948e205ffcda2e3))
* **notify:** trim payload and response_body from webhook delivery list (sec-r4-D6) ([#518](https://github.com/nikunjmavani/core-be/issues/518)) ([89c24b7](https://github.com/nikunjmavani/core-be/commit/89c24b7f05dba72eba97447f746abb08130c61f6))
* **observability:** monitor every retention worker DLQ + add drift guard (reaudit-[#5](https://github.com/nikunjmavani/core-be/issues/5)) ([0e954dc](https://github.com/nikunjmavani/core-be/commit/0e954dcfe96a4c2d46c48815e963632468243236))
* **openapi:** registry-authoritative success statuses; deterministic OAuth coverage; scan cleanups ([a7cc7bd](https://github.com/nikunjmavani/core-be/commit/a7cc7bdeb47f4d9d5f5a18465470d8a9b2b86c67))
* **openapi:** registry-authoritative success statuses; deterministic OAuth coverage; scan cleanups ([1f84793](https://github.com/nikunjmavani/core-be/commit/1f84793ff6f149d7a759ac0223fb45a5d28d1942))
* **ops:** log circuit-breaker resets for attribution (route-[#5](https://github.com/nikunjmavani/core-be/issues/5)) ([eae48fe](https://github.com/nikunjmavani/core-be/commit/eae48fe4e9c937f7ca65d219acacb55832a1b218))
* **queue:** acknowledge commit-dispatch tasks after execution, not before (reaudit-[#2](https://github.com/nikunjmavani/core-be/issues/2)) ([8f399c0](https://github.com/nikunjmavani/core-be/commit/8f399c0ddaed24901f6c92445091770286c7a852))
* **queue:** bound audit.dead_letter_jobs growth via the audit-retention purge ([#322](https://github.com/nikunjmavani/core-be/issues/322)) ([06e729d](https://github.com/nikunjmavani/core-be/commit/06e729ddba34ce6d47ac3f2f7d73ad54910800a2))
* **queue:** bound commandTimeout on BullMQ producer connections (audit-[#5](https://github.com/nikunjmavani/core-be/issues/5)) ([2c4e21b](https://github.com/nikunjmavani/core-be/commit/2c4e21bf12dedc6039a0f0085379e80e8a83fee2))
* **queue:** monitor the offboarding-reconciler DLQ + exempt it from tenant-scoping policy (audit-[#15](https://github.com/nikunjmavani/core-be/issues/15)) ([f5f4ceb](https://github.com/nikunjmavani/core-be/commit/f5f4cebfbf7cc99072c06c0b7588d7c3eb4289fc))
* **queue:** sec-new-Q1 add env overrides for hardcoded cron schedules ([#484](https://github.com/nikunjmavani/core-be/issues/484)) ([d2d03e1](https://github.com/nikunjmavani/core-be/commit/d2d03e1c6a41861a22965a0c57707b8157ce66da))
* **queue:** sec-new-Q2 capture per-task failures in Sentry in recovery processor ([#485](https://github.com/nikunjmavani/core-be/issues/485)) ([b66a7a6](https://github.com/nikunjmavani/core-be/commit/b66a7a68ed27dc357b83b010e4778991fb198242))
* **queue:** stop DLQ auto-retry starvation via a resolved marker on exhausted rows ([#330](https://github.com/nikunjmavani/core-be/issues/330)) ([86c3817](https://github.com/nikunjmavani/core-be/commit/86c381769b50262e30687506b0c9ebeec9a739d9))
* **rate-limit,observability:** scope org rate-limit + error context by the org claim ([5e12926](https://github.com/nikunjmavani/core-be/commit/5e12926e869e17a3bd66e71a3d7ec87b98119132))
* **rate-limit,observability:** scope org rate-limit + error context by the org token claim ([b2caeb1](https://github.com/nikunjmavani/core-be/commit/b2caeb1be96e8fde9631028c4b92e047b14d433d))
* **rls:** pin core_be_app to NOSUPERUSER/NOBYPASSRLS + assert RLS-binding ([#334](https://github.com/nikunjmavani/core-be/issues/334)) ([18f8b9a](https://github.com/nikunjmavani/core-be/commit/18f8b9aa6f0ae44d45208dabf270a6c5a52c60ec))
* route-audit state-machine, billing, and cache-header findings ([d4b34ef](https://github.com/nikunjmavani/core-be/commit/d4b34ef388184860aece138aa10716b226562158))
* route-focused security audit findings ([1fffbf0](https://github.com/nikunjmavani/core-be/commit/1fffbf0270b20b7fdbeef5d0f3d86528e4fb11a5))
* **runtime:** real-world deep-flow inspection findings — 3 fixes + regression test ([#533](https://github.com/nikunjmavani/core-be/issues/533)) ([5a85ecd](https://github.com/nikunjmavani/core-be/commit/5a85ecd7d19303cb45231ec2d73082dfd6d4e631))
* **sec:** account-deletion safety — invalidate verification tokens + revoke-before-purge (sec-U1+U8) ([#404](https://github.com/nikunjmavani/core-be/issues/404)) ([43a1e5a](https://github.com/nikunjmavani/core-be/commit/43a1e5aedc49cd19f2e082febeb9b247a6bea3cf))
* **sec:** add captchaPreHandler to POST /mfa/login (sec-new-A1) ([85d2a89](https://github.com/nikunjmavani/core-be/commit/85d2a892decb1cf9e882922188633de6ffdea5c0))
* **sec:** add captchaPreHandler to POST /mfa/login (sec-new-A1) ([f2c02db](https://github.com/nikunjmavani/core-be/commit/f2c02db0212721ec29b99633f455f36f8e9f23c9))
* **sec:** add closeUserDataExportQueue to worker shutdown sequence (sec-r4-R1) ([#501](https://github.com/nikunjmavani/core-be/issues/501)) ([6e8e96f](https://github.com/nikunjmavani/core-be/commit/6e8e96ff11af4819d22cfb34df5b27f125518cbd))
* **sec:** add deleted_at guards to org-discovery RLS and invitation lookup (sec-r4-T1/T2) ([#500](https://github.com/nikunjmavani/core-be/issues/500)) ([b4ea6ee](https://github.com/nikunjmavani/core-be/commit/b4ea6ee0969cd5ff8da76b7abb68823e711d5939))
* **sec:** add partial index for audit.logs.actor_api_key_id (sec-D8) ([#432](https://github.com/nikunjmavani/core-be/issues/432)) ([761f28b](https://github.com/nikunjmavani/core-be/commit/761f28b96207265002e24ad2f263da00ff97eb99))
* **sec:** audit append-only DB invariant — split tenant-isolation policy + REVOKE UPDATE (sec-U3) ([#409](https://github.com/nikunjmavani/core-be/issues/409)) ([7991dfc](https://github.com/nikunjmavani/core-be/commit/7991dfc486ed22eff946b346982285c1f87fee65))
* **sec:** audit every data-export URL mint, rate-limit GET, drop TTL 24h→15min (sec-U6) ([#429](https://github.com/nikunjmavani/core-be/issues/429)) ([4943057](https://github.com/nikunjmavani/core-be/commit/4943057037519b0c294e4e46405d202008083973))
* **sec:** audit every login surface, not just password (sec-A8) ([#427](https://github.com/nikunjmavani/core-be/issues/427)) ([9872491](https://github.com/nikunjmavani/core-be/commit/9872491ad9ee8271d3a063738dd3b1423013095c))
* **sec:** audit hygiene — denylist metadata strip + admin user-mgmt audit + admin audit-read audit + permission-deny audit (sec-U2+U9+U4+U13) ([#408](https://github.com/nikunjmavani/core-be/issues/408)) ([98e60ff](https://github.com/nikunjmavani/core-be/commit/98e60ff889e7c94d716aaf235c0b782d05bd4a8f))
* **sec:** audit login failures alongside successes on every login surface (sec-A8 follow-up) ([#438](https://github.com/nikunjmavani/core-be/issues/438)) ([e4a9c2f](https://github.com/nikunjmavani/core-be/commit/e4a9c2f88925653cf12910efbb6258ba2c7c1d73))
* **sec:** audit serializer is strip-only with resolved public ids (sec-re-08) ([#458](https://github.com/nikunjmavani/core-be/issues/458)) ([5a07fdb](https://github.com/nikunjmavani/core-be/commit/5a07fdb15f4706478587523c96f090a92a8a3ce1))
* **sec:** auth defense in depth — last login-method guard + super-admin rederive + step-up on session revoke (sec-A5+A6+A7) ([#407](https://github.com/nikunjmavani/core-be/issues/407)) ([021c4b3](https://github.com/nikunjmavani/core-be/commit/021c4b31ce8d3c619f48ebcf43e4393ad2cf9b3d))
* **sec:** bind audit-list pagination cursor to its minting filter set (sec-U12) ([#434](https://github.com/nikunjmavani/core-be/issues/434)) ([f6a40e2](https://github.com/nikunjmavani/core-be/commit/f6a40e2db1fc34916c236f5fc3a478d5d09020df))
* **sec:** block update() on org-owner membership to prevent Admin lockout (sec-new-T1) ([dfa526a](https://github.com/nikunjmavani/core-be/commit/dfa526a03dafa3ddae99029e34651aeffa979d51))
* **sec:** block update() on org-owner membership to prevent Admin lockout (sec-new-T1) ([c3c6cfe](https://github.com/nikunjmavani/core-be/commit/c3c6cfe24145ab0cc3e63fe8a8d3d1a20d5a7642))
* **sec:** breach compression-skip actually engages in production (sec-re-03) ([#454](https://github.com/nikunjmavani/core-be/issues/454)) ([5039ccd](https://github.com/nikunjmavani/core-be/commit/5039ccd0699dac287c89a94b85e9c6a4f630c25e))
* **sec:** build Stripe customer email from a platform-owned domain, not tenant slug (sec-B11) ([#436](https://github.com/nikunjmavani/core-be/issues/436)) ([8bb5338](https://github.com/nikunjmavani/core-be/commit/8bb533845fcf074150dc3796e2038dcab01df372))
* **sec:** cache the i18n preHandler organization → locale lookup (sec-M1) ([#440](https://github.com/nikunjmavani/core-be/issues/440)) ([180937a](https://github.com/nikunjmavani/core-be/commit/180937a42a83ec058d0e66823c534db54270cf73))
* **sec:** collapse unmatched-route Prometheus label into __unmatched__ sentinel (sec-C2) ([#401](https://github.com/nikunjmavani/core-be/issues/401)) ([5fc8743](https://github.com/nikunjmavani/core-be/commit/5fc87432500a76271dc867df7b68851e5e68ed74))
* **sec:** config + middleware hardening (sec-cm batch) ([#449](https://github.com/nikunjmavani/core-be/issues/449)) ([b150253](https://github.com/nikunjmavani/core-be/commit/b15025363ad4af584a93572f1a0afb5dc76f1e4f))
* **sec:** config cleanup — drop JWT_SECRET + add deps:audit:prod to ci:local + ENABLE_RESPONSE_ENCRYPTION pairing refine (sec-C5+C10+C11) ([#419](https://github.com/nikunjmavani/core-be/issues/419)) ([7cab170](https://github.com/nikunjmavani/core-be/commit/7cab17038463c7a568e36c48f4c10acc0e6235f3))
* **sec:** cors exposes x-client-request-id (sec-re-17) ([#467](https://github.com/nikunjmavani/core-be/issues/467)) ([8960cfc](https://github.com/nikunjmavani/core-be/commit/8960cfcc13b33e6abb222631ff5de62f3b1d9a7b))
* **sec:** data-export request route advertises 15-minute URL lifetime (sec-re-12) ([#462](https://github.com/nikunjmavani/core-be/issues/462)) ([bc7cea3](https://github.com/nikunjmavani/core-be/commit/bc7cea3c096583e338e25edca4d58d59616718c4))
* **sec:** db retention growth — verification token sweep + AUDIT_RETENTION_DAYS cap (sec-D5+U10) ([#415](https://github.com/nikunjmavani/core-be/issues/415)) ([ab9428b](https://github.com/nikunjmavani/core-be/commit/ab9428b5a5cd93a24ce283f8598dd318e0e0ef03))
* **sec:** db stability — drop volatile chk_org_notif_muted + worker statement_timeout + audit.logs target_user_id index (sec-D1+D2+D3) ([#414](https://github.com/nikunjmavani/core-be/issues/414)) ([f77ce4a](https://github.com/nikunjmavani/core-be/commit/f77ce4aee1366eaa1ff82da6575b5011dd382ca5))
* **sec:** delete dead findActiveByUserId / findActiveByOrganizationId (sec-D12) ([#437](https://github.com/nikunjmavani/core-be/issues/437)) ([6367dd4](https://github.com/nikunjmavani/core-be/commit/6367dd45ca44614f1e0a2d10fd2dfdf0df9f390e))
* **sec:** derive invitation email from membership user on create (sec-T1 complete) ([#471](https://github.com/nikunjmavani/core-be/issues/471)) ([6d54c99](https://github.com/nikunjmavani/core-be/commit/6d54c99a15cd6c1dc48ec3b1c6357c540db4bf29))
* **sec:** dlq replay no-op + commit-dispatch cleanup + worker hardening (sec-q batch) ([#444](https://github.com/nikunjmavani/core-be/issues/444)) ([6c96a0b](https://github.com/nikunjmavani/core-be/commit/6c96a0bb1c47d016d87735cbe16ee173e7de19c4))
* **sec:** do not clear session cookie in revokeAllSessions handler (sec-r4-A1) ([#499](https://github.com/nikunjmavani/core-be/issues/499)) ([b7e3952](https://github.com/nikunjmavani/core-be/commit/b7e395262f8ec06a84a5426b9c4a9dafa85ec351))
* **sec:** docker.agent USER node + drop openssh + enforce abort timeout on retrieveStripeEvent (sec-C8 + sec-Q5 partial) ([#422](https://github.com/nikunjmavani/core-be/issues/422)) ([d10af52](https://github.com/nikunjmavani/core-be/commit/d10af524ec39a00994b041f7727d18cc6e81639b))
* **sec:** document the online-safe ALTER COLUMN pattern (sec-D6) ([#443](https://github.com/nikunjmavani/core-be/issues/443)) ([c72deb4](https://github.com/nikunjmavani/core-be/commit/c72deb4e3f9b7cdaba267b14948fd73025dce3e3))
* **sec:** document verification_tokens application-trust safety model (sec-D9) ([#441](https://github.com/nikunjmavani/core-be/issues/441)) ([e069891](https://github.com/nikunjmavani/core-be/commit/e069891909cd0487a4cd5ab523930f8b0d6e105d))
* **sec:** drop org branch from user_notification_preferences RLS + add CHECK pin (sec-U7) ([#428](https://github.com/nikunjmavani/core-be/issues/428)) ([13fc188](https://github.com/nikunjmavani/core-be/commit/13fc188e22603b55f3226994399e5564e50f5843))
* **sec:** enforce SSE-S3 on every server-side S3 write (sec-U11) ([#435](https://github.com/nikunjmavani/core-be/issues/435)) ([0792d76](https://github.com/nikunjmavani/core-be/commit/0792d76c07ece878f8adc1f282f1966efbe54ae7))
* **sec:** expose policy public_id instead of bigserial in URLs and responses (sec-T5) ([#442](https://github.com/nikunjmavani/core-be/issues/442)) ([88d5db7](https://github.com/nikunjmavani/core-be/commit/88d5db72bc21184da5ea00ec0baaa0256d0f03a9))
* **sec:** extend staging guards to ALLOWED_ORIGINS, COOKIE_SECURE, and SECRETS_ENCRYPTION_KEY (sec-r4-C1/C2/C3) ([#498](https://github.com/nikunjmavani/core-be/issues/498)) ([0efd169](https://github.com/nikunjmavani/core-be/commit/0efd169841cea7cfba5197012dfb6e3f615fe629))
* **sec:** fall back to INSERT when subscription.created arrives before local row (sec-B9) ([#439](https://github.com/nikunjmavani/core-be/issues/439)) ([fd68e66](https://github.com/nikunjmavani/core-be/commit/fd68e660e7d19d1707b0bfe97ac4fe29d08ab427))
* **sec:** harden invitation binding, webhook retry, role invariants, and upload key contract ([#470](https://github.com/nikunjmavani/core-be/issues/470)) ([65cdf2f](https://github.com/nikunjmavani/core-be/commit/65cdf2f9179ac01aa1110f95b60cb6a7fd1519db))
* **sec:** invitation accept requires auth + invitee email match (sec-T4) ([#423](https://github.com/nikunjmavani/core-be/issues/423)) ([7cdc3f8](https://github.com/nikunjmavani/core-be/commit/7cdc3f83beafaa9e682bf39348cb1caa4047c2fb))
* **sec:** mark-confirmed-by-internal-id filters deleted_at and pending (sec-re-13) ([#463](https://github.com/nikunjmavani/core-be/issues/463)) ([dbd9156](https://github.com/nikunjmavani/core-be/commit/dbd9156fd40ff4e2e92ab6ace5823b2e60279e60))
* **sec:** mfa hardening — step-up requires mfa + per-session binding + org-policy delete guard (sec-A1+A2+A4) ([#403](https://github.com/nikunjmavani/core-be/issues/403)) ([1ba5047](https://github.com/nikunjmavani/core-be/commit/1ba504726442aaaea626d2b73f542c55b8214d0a))
* **sec:** mfa is_mfa_enabled flip happens inside the enrollConfirm transaction (sec-re-06) ([#469](https://github.com/nikunjmavani/core-be/issues/469)) ([675c1f2](https://github.com/nikunjmavani/core-be/commit/675c1f257bb02ecf3967a3295ff1f6d1068da136))
* **sec:** mfa re-enroll dedups stale totp factors (sec-re-04) ([#455](https://github.com/nikunjmavani/core-be/issues/455)) ([f7a66ab](https://github.com/nikunjmavani/core-be/commit/f7a66abb8218a13bbf92472ba3fc0c3e26ab6f3e))
* **sec:** middleware observability — captcha bypass closed in staging + HSTS env gate + ALLOWED_ORIGINS canonicalization + encryption 503 (sec-M3+M5+M8+M9) ([#417](https://github.com/nikunjmavani/core-be/issues/417)) ([57abed9](https://github.com/nikunjmavani/core-be/commit/57abed9c55fa7fc50c72b1161e8270b5a64b024f))
* **sec:** notification worker user context + db integrity indexes (sec-d batch) ([#450](https://github.com/nikunjmavani/core-be/issues/450)) ([a1a8fe5](https://github.com/nikunjmavani/core-be/commit/a1a8fe5c15fd5b3c4b8437413ef40e5b4efeb821))
* **sec:** notification worker user-context fix is live wiring (sec-re-01) ([#452](https://github.com/nikunjmavani/core-be/issues/452)) ([653adf5](https://github.com/nikunjmavani/core-be/commit/653adf5653b634dcf907927ad4f6a660256f8a79))
* **sec:** notify abuse caps — per-organization webhook cap + secret-rotation overlap window (sec-N4+N8) ([#411](https://github.com/nikunjmavani/core-be/issues/411)) ([a7455f5](https://github.com/nikunjmavani/core-be/commit/a7455f5548d20fe8460b92154e17b2ca75eda24a))
* **sec:** notify durability — worker re-checks disabled/deleted + delivery-id header + event_key dedupe (sec-N1+N3+N2) ([#410](https://github.com/nikunjmavani/core-be/issues/410)) ([c09ae6c](https://github.com/nikunjmavani/core-be/commit/c09ae6c7acad9de05fe7c28f365ba9af84795c16))
* **sec:** notify recipient + idempotency canonical fingerprint + tenant authorized-org helper (sec-N7+M6+M7) ([#420](https://github.com/nikunjmavani/core-be/issues/420)) ([17a8bbd](https://github.com/nikunjmavani/core-be/commit/17a8bbdc9d364eb9b5bfa5f71d0ffbe86e30645e))
* **sec:** org-scoped audit log sanitiser + strip-only serializers (sec-t batch) ([#448](https://github.com/nikunjmavani/core-be/issues/448)) ([6019182](https://github.com/nikunjmavani/core-be/commit/6019182b695080795d232d7afe04b96659ff34d2))
* **sec:** protect owner role from permission writes via ROLE_MANAGE (sec-T2) ([#402](https://github.com/nikunjmavani/core-be/issues/402)) ([6b11b6e](https://github.com/nikunjmavani/core-be/commit/6b11b6e6da7e825d48d7348b50576861a5fc4cbc))
* **sec:** queue infrastructure — defaultJobOptions on cron queues + flip topology warn + fail boot on scheduler drift in prod (sec-Q1+Q2+Q3) ([#416](https://github.com/nikunjmavani/core-be/issues/416)) ([32b960e](https://github.com/nikunjmavani/core-be/commit/32b960e03cc6a164d137dc080f583846b93635a9))
* **sec:** rate-limit per-email bucket id is hashed (sec-re-11) ([#461](https://github.com/nikunjmavani/core-be/issues/461)) ([4239be4](https://github.com/nikunjmavani/core-be/commit/4239be4ddb5d3432295565b4bb8e110612e97012))
* **sec:** recovery-code alphabet doc reflects 31 symbols and case-insensitive hash (sec-re-14) ([#464](https://github.com/nikunjmavani/core-be/issues/464)) ([1bc8b00](https://github.com/nikunjmavani/core-be/commit/1bc8b001519154b9e5da12abf4a4d808b12cd9d8))
* **sec:** refresh stale ordering comments around the no-op RLS-transaction plugin (sec-M4) ([#433](https://github.com/nikunjmavani/core-be/issues/433)) ([1bd211e](https://github.com/nikunjmavani/core-be/commit/1bd211e288ac062486e9374667e1619401e4f666))
* **sec:** refresh-token reuse detection fires for revoked sessions (sec-re-05) ([#456](https://github.com/nikunjmavani/core-be/issues/456)) ([bf5ee5e](https://github.com/nikunjmavani/core-be/commit/bf5ee5e30c0233d13a0f28d0b9b2afff4df0da4c))
* **sec:** remove privilege-bypass arms from audit.logs INSERT RLS (sec-r4-D1) ([#497](https://github.com/nikunjmavani/core-be/issues/497)) ([787b3c8](https://github.com/nikunjmavani/core-be/commit/787b3c8d20ebb37f97ef9cd2d27aa66f992df7c3))
* **sec:** replace z.coerce.boolean() foot-gun on env booleans (sec-C1) ([#400](https://github.com/nikunjmavani/core-be/issues/400)) ([f8a49c3](https://github.com/nikunjmavani/core-be/commit/f8a49c367e9bbc5cdc7e54e9d9c988e4dbe13bca))
* **sec:** repository hygiene — atomic markAllRead count + WebAuthn counter monotonicity guard (sec-D10/D11) ([#426](https://github.com/nikunjmavani/core-be/issues/426)) ([1d817db](https://github.com/nikunjmavani/core-be/commit/1d817db6ded2820f9334b31d05ca4e4b23ae30b2))
* **sec:** require caller can grant target role permissions on membership create (sec-T1) ([#399](https://github.com/nikunjmavani/core-be/issues/399)) ([899aab3](https://github.com/nikunjmavani/core-be/commit/899aab3abcf9de727a8b0e7fe3ecdcb7ad14d654))
* **sec:** require caller to hold every code added or removed on role-permission PUT (sec-T2) ([#425](https://github.com/nikunjmavani/core-be/issues/425)) ([b9b545e](https://github.com/nikunjmavani/core-be/commit/b9b545ee4de3c1b36bd05a8d80e8ebce8f497565))
* **sec:** require live-mode + both-or-neither Stripe keys in production (sec-B5/B6) ([#424](https://github.com/nikunjmavani/core-be/issues/424)) ([2ca7f2c](https://github.com/nikunjmavani/core-be/commit/2ca7f2cdb4e411275f465164b91ae2099f98a395))
* **sec:** role-delete guards + strip is_system from createMemberRoleDto (sec-T3) ([#406](https://github.com/nikunjmavani/core-be/issues/406)) ([1b41ab9](https://github.com/nikunjmavani/core-be/commit/1b41ab98cfaedfb11a7f5f3c87c26106e8bc2373))
* **sec:** sentry/log redaction + observability — OTLP https refine + readyz verbose env gate + Sentry message/exception/user redaction + LOG_LEVEL enum (sec-C3+C4+C6+C9) ([#418](https://github.com/nikunjmavani/core-be/issues/418)) ([b0337ce](https://github.com/nikunjmavani/core-be/commit/b0337ce2ad6f21ac16b0c97fccda158e7c64dd55))
* **sec:** stripe event retrieve honours per-attempt timeout for real (sec-re-15) ([#465](https://github.com/nikunjmavani/core-be/issues/465)) ([d5640da](https://github.com/nikunjmavani/core-be/commit/d5640daf8c1bacf06e9ca92894ac4d97a9945fe3))
* **sec:** stripe ingress durability + ordering + raw-body wiring (sec-b batch) ([#446](https://github.com/nikunjmavani/core-be/issues/446)) ([8a88beb](https://github.com/nikunjmavani/core-be/commit/8a88beb6cd7ea43f4cf42d034f2a37ba6a241d9e))
* **sec:** stripe reclaim cron→worker handoff is recoverable (sec-re-02) ([#453](https://github.com/nikunjmavani/core-be/issues/453)) ([3cdce4f](https://github.com/nikunjmavani/core-be/commit/3cdce4fcaabf0b6895b73c4feb412f0edd451080))
* **sec:** stripe reconciliation — close 4 silent-divergence paths (sec-B1+B2+B3+B4) ([#405](https://github.com/nikunjmavani/core-be/issues/405)) ([87ab3fb](https://github.com/nikunjmavani/core-be/commit/87ab3fb998f712f5a1b033708c1d65b9ba4c8b82))
* **sec:** subscription response surfaces plan public id (sec-re-07) ([#457](https://github.com/nikunjmavani/core-be/issues/457)) ([537325c](https://github.com/nikunjmavani/core-be/commit/537325c9f8f71a7e7452db8126bcb5517c8b2b1b))
* **sec:** sync local plan_id from Stripe customer.subscription.updated (sec-B7) ([#430](https://github.com/nikunjmavani/core-be/issues/430)) ([bc5a21a](https://github.com/nikunjmavani/core-be/commit/bc5a21ae87d6c253ad7094e752859fe254492d0e))
* **sec:** tenant context lifts the worker statement_timeout (sec-re-16) ([#466](https://github.com/nikunjmavani/core-be/issues/466)) ([415a58e](https://github.com/nikunjmavani/core-be/commit/415a58eb3a4c8c2334d8bcd5649f1348fdf9f455))
* **sec:** tombstoneAllByOrganizationId removes S3 objects synchronously (sec-UP8) ([#421](https://github.com/nikunjmavani/core-be/issues/421)) ([186bd71](https://github.com/nikunjmavani/core-be/commit/186bd711303862d3386cc6f7391ef0dd73928613))
* **sec:** two-phase mfa enrollment + refresh reuse-detection + login uniformity (sec-a batch) ([#445](https://github.com/nikunjmavani/core-be/issues/445)) ([d1e1e59](https://github.com/nikunjmavani/core-be/commit/d1e1e593bcf31c515f22fb1e2c4d07a89c76e81c))
* **sec:** upload confirm pins copy to verified etag (sec-re-10) ([#460](https://github.com/nikunjmavani/core-be/issues/460)) ([2eb3d11](https://github.com/nikunjmavani/core-be/commit/2eb3d11ca070c52c0e4fcf2cc5c5c0c391573837))
* **sec:** upload security — refuse legacy in-place + sweep refuses SVG + assertKeyConfirmedForOwner + DOMPurify hardening (sec-UP1+UP2+UP5+UP6) ([#412](https://github.com/nikunjmavani/core-be/issues/412)) ([76e80ad](https://github.com/nikunjmavani/core-be/commit/76e80ad3617b7d87f57fc292c6e41efba7f89d89))
* **sec:** upload size/policy — organizationId regex + org pending cap + force presigned POST in prod (sec-UP3+UP4+UP10) ([#413](https://github.com/nikunjmavani/core-be/issues/413)) ([237d517](https://github.com/nikunjmavani/core-be/commit/237d517905e321c9c73c1e9cc8f9fa181a73a597))
* **security:** add maxItems array bounds and fix WebAuthn type casts ([#363](https://github.com/nikunjmavani/core-be/issues/363)) ([ab4e7c7](https://github.com/nikunjmavani/core-be/commit/ab4e7c7c6fb65f374c458b18ef7b8b5927b0e77d))
* **security:** fail closed on privileged re-derivation + bound all retention settings (audit-[#16](https://github.com/nikunjmavani/core-be/issues/16), [#14](https://github.com/nikunjmavani/core-be/issues/14)) ([65a4347](https://github.com/nikunjmavani/core-be/commit/65a4347972c7d029600559f69a080fc611bc555d))
* **security:** mark recovery-codes + presigned-URL responses no-store / non-cacheable (route-audit-[#3](https://github.com/nikunjmavani/core-be/issues/3)) ([bc67eed](https://github.com/nikunjmavani/core-be/commit/bc67eed1cc521709b36e4eca38289310276ff922))
* **security:** reject JWT tokens with unknown kid when keyring is active ([#347](https://github.com/nikunjmavani/core-be/issues/347)) ([2bedfa1](https://github.com/nikunjmavani/core-be/commit/2bedfa1fc7bfe30ebe07e3529cfe8b7c8c78a15d))
* **security:** remediate all 16 findings from the 2026-06-14 dev security audit ([01a22aa](https://github.com/nikunjmavani/core-be/commit/01a22aa5f83fbd1f784039a98b5ac4eda151efdb))
* **security:** remediate all 16 findings from the 2026-06-14 dev security audit ([#600](https://github.com/nikunjmavani/core-be/issues/600)) ([01a22aa](https://github.com/nikunjmavani/core-be/commit/01a22aa5f83fbd1f784039a98b5ac4eda151efdb))
* **security:** require explicit wildcard prefix for webhook allowlist subdomain matching ([8d79c89](https://github.com/nikunjmavani/core-be/commit/8d79c891b2a88a8a44cca1420535cfcc6a567a12))
* **security:** strip privileged headers from MCP call_api and remove unversioned aliases ([#348](https://github.com/nikunjmavani/core-be/issues/348)) ([cdaf9ce](https://github.com/nikunjmavani/core-be/commit/cdaf9cef188e146b090bf411dc21e803c53ddea7))
* **security:** strip Stripe-shaped literals from source + add regression test (GH secret-scanning) ([#529](https://github.com/nikunjmavani/core-be/issues/529)) ([f234e60](https://github.com/nikunjmavani/core-be/commit/f234e6044879c72385e3b61728ea4ba665931ae6))
* **security:** untrack agent-os/mcp/mcp.json and repair stale ai/ paths ([#560](https://github.com/nikunjmavani/core-be/issues/560)) ([b3547a4](https://github.com/nikunjmavani/core-be/commit/b3547a43172e2388c0a1a2e4fa8e0388d046b4c6))
* **sec:** validate membership and api-key path params at the boundary (sec-re-18) ([#468](https://github.com/nikunjmavani/core-be/issues/468)) ([c0ab171](https://github.com/nikunjmavani/core-be/commit/c0ab17106d8e7dd27513e3bf2f76a480775fd557))
* **sec:** validate subscriptionId path param at every billing handler (sec-B10) ([#431](https://github.com/nikunjmavani/core-be/issues/431)) ([2bbd338](https://github.com/nikunjmavani/core-be/commit/2bbd33864cd192a22d5d41f70ed7064a628a3809))
* **sec:** webhook secret strength + upload sweep file_key invariant + data-export doc (sec-up batch) ([#447](https://github.com/nikunjmavani/core-be/issues/447)) ([145c838](https://github.com/nikunjmavani/core-be/commit/145c8385ec8b02c25b0b508adbabd71c2ce8dc05))
* **setup:** activate pinned Node on PATH in agent bootstrap step 1 ([#649](https://github.com/nikunjmavani/core-be/issues/649)) ([968d54f](https://github.com/nikunjmavani/core-be/commit/968d54fae13b6e8cb9c40c39e565c116739dd479))
* **storage:** distinguish S3 not-found from transient failure (audit-[#5](https://github.com/nikunjmavani/core-be/issues/5)) ([5ba8d00](https://github.com/nikunjmavani/core-be/commit/5ba8d002a05a423b8a2e8b99e4f23c29a1d79e51))
* **storage:** enforce SSE-S3 on presigned uploads (sec-r4-E1) ([#509](https://github.com/nikunjmavani/core-be/issues/509)) ([f962d37](https://github.com/nikunjmavani/core-be/commit/f962d372565e05986fb00a2cef960694b4b35885))
* **storage:** serve public media via a distribution and refuse public URLs for private keys (audit-[#13](https://github.com/nikunjmavani/core-be/issues/13)) ([cc10be0](https://github.com/nikunjmavani/core-be/commit/cc10be00c43a9891bff17bfc097f9ba50c5a165d))
* **stripe:** tighten webhook replay window to 150 s (audit finding [#6](https://github.com/nikunjmavani/core-be/issues/6)) ([#365](https://github.com/nikunjmavani/core-be/issues/365)) ([848360d](https://github.com/nikunjmavani/core-be/commit/848360d739857212d1822c6e9e4564498649b5c3))
* **tenancy,notify:** atomic role-delete, webhook clock-skew, security_policy proto guard (route-audit C2, C3, C4) ([ddf4f35](https://github.com/nikunjmavani/core-be/commit/ddf4f35762595f2318930855bf1bfccaba3a30ed))
* **tenancy,notify:** make per-scope resource caps atomic with an advisory lock (audit-[#8](https://github.com/nikunjmavani/core-be/issues/8)) ([3681133](https://github.com/nikunjmavani/core-be/commit/3681133339f47f68570aaf54f773ae8c5964238b))
* **tenancy,security:** post-flatten audit corrections — idempotency claim scope + personal-org guards ([e105372](https://github.com/nikunjmavani/core-be/commit/e10537260c541131a4386bb37570653242fcc41b))
* **tenancy,security:** post-flatten audit corrections — idempotency claim scope, personal-org guards, dead-code cleanup ([018fb31](https://github.com/nikunjmavani/core-be/commit/018fb313308ea78843d22df4dd234dc41dea1190))
* **tenancy:** bound MemberRolePermissionRepository.findByRoleId rows per role (sec-r4-D4) ([#508](https://github.com/nikunjmavani/core-be/issues/508)) ([9218518](https://github.com/nikunjmavani/core-be/commit/92185187cd5397f4f349442626a936f55e718b7b))
* **tenancy:** emit public ids (not internal bigserial ids) in membership responses ([#329](https://github.com/nikunjmavani/core-be/issues/329)) ([3aac2ac](https://github.com/nikunjmavani/core-be/commit/3aac2ac13d072c1f41bf71bd296468de63d73b3c))
* **tenancy:** exclude soft-deleted orgs from organizations_tenant_isolation RLS policy (sec-new-D3) ([#491](https://github.com/nikunjmavani/core-be/issues/491)) ([904802a](https://github.com/nikunjmavani/core-be/commit/904802affcc95bea74e6f510b64c655ccbd46df0))
* **tenancy:** only activate INVITED memberships on invitation accept (route-audit-[#1](https://github.com/nikunjmavani/core-be/issues/1)) ([aeea26a](https://github.com/nikunjmavani/core-be/commit/aeea26af9f5346fdbf4c7dd38745de90d8951b14))
* **tenancy:** rate-limit membership lifecycle endpoints (sec-r4-I3) ([#505](https://github.com/nikunjmavani/core-be/issues/505)) ([1f0c8c0](https://github.com/nikunjmavani/core-be/commit/1f0c8c01d38bbaa6020b8a8cab7e3d5b0657b0b7))
* **tenancy:** rate-limit organization mutation endpoints (sec-r4-I2) ([#504](https://github.com/nikunjmavani/core-be/issues/504)) ([2f6bedb](https://github.com/nikunjmavani/core-be/commit/2f6bedb59ca27d9d11c68299560470d8f0418d77))
* **tenancy:** reject prototype-pollution keys in organization security_policy (route-audit hardening) ([b1eba43](https://github.com/nikunjmavani/core-be/commit/b1eba43d872fe1ff7e018edd45eb42c10f67fa3f))
* **tenancy:** revoke a removed member's API keys on membership removal (reaudit-[#7](https://github.com/nikunjmavani/core-be/issues/7)) ([1387bd3](https://github.com/nikunjmavani/core-be/commit/1387bd306046d439b5f52840e4b45ae0f0794037))
* **tenancy:** scale permission-cache stampede poll budget to lock TTL (audit-[#9](https://github.com/nikunjmavani/core-be/issues/9)) ([5322d0f](https://github.com/nikunjmavani/core-be/commit/5322d0fae4dc9043f3563eda431d880ccab74f97))
* **tenancy:** sec-new-M1 add STRICT_AUTHED_RATE_LIMIT to POST /organizations ([#477](https://github.com/nikunjmavani/core-be/issues/477)) ([dd9fd62](https://github.com/nikunjmavani/core-be/commit/dd9fd62112aefe4eaa63869ab6c37ac62ee8540c))
* **tenancy:** sec-new-T2 validate invitationId path param in all invitation handlers ([#480](https://github.com/nikunjmavani/core-be/issues/480)) ([93fa940](https://github.com/nikunjmavani/core-be/commit/93fa940a7d371acd95889257b027075d305d1e60))
* **tenancy:** sec-new-T3 validate id and roleId path params in role handlers ([#481](https://github.com/nikunjmavani/core-be/issues/481)) ([361159a](https://github.com/nikunjmavani/core-be/commit/361159aca4126ae5df7b446dd437c199082a9636))
* **tenancy:** throttle api-key last_used_at writes (audit-[#8](https://github.com/nikunjmavani/core-be/issues/8)) ([96b3e56](https://github.com/nikunjmavani/core-be/commit/96b3e562e136892ff44e5adf2f06009bdcce5a06))
* **tests:** align e2e fixtures with audit batch2 (WebAuthn typed DTO) + Stripe items.period ([#384](https://github.com/nikunjmavani/core-be/issues/384)) ([b906731](https://github.com/nikunjmavani/core-be/commit/b906731f9fdfb6813303c3f25a0ce148a1e2023a))
* **tests:** cleanupDatabase preserves schema_migrations; update tests inherited from main's B4 + sec-r4-A1 semantics ([#525](https://github.com/nikunjmavani/core-be/issues/525)) ([169327e](https://github.com/nikunjmavani/core-be/commit/169327ec7652cefd7301b8d0c1c47009caa9ae5e))
* three pre-existing dev post-merge CI failures (migration idempotency, Stripe Date bind, permission seed) ([#614](https://github.com/nikunjmavani/core-be/issues/614)) ([798cefe](https://github.com/nikunjmavani/core-be/commit/798cefe26f59b8f56c3987f437772d707a42e364))
* **upload:** add DTO-level fileSize ceiling (sec-r4-I4) ([#515](https://github.com/nikunjmavani/core-be/issues/515)) ([049f917](https://github.com/nikunjmavani/core-be/commit/049f917c71b8c043e39bbbcd40f93eec534994fc))
* **upload:** lock the organization pending-upload quota at the org scope (audit-[#7](https://github.com/nikunjmavani/core-be/issues/7)) ([171a0fc](https://github.com/nikunjmavani/core-be/commit/171a0fc4c618c93c4bc74aafe0c3ec45f6376b74))
* **upload:** reclaim orphaned avatar/logo objects + owner-binding + purpose/target check (L1/L2/L3) ([7ffef76](https://github.com/nikunjmavani/core-be/commit/7ffef768a889cab424139e42cab34e7f055f6bb9))
* **upload:** reclaim orphaned avatar/logo objects, wire owner-binding gate, validate purpose-target (route-audit L1, L2, L3) ([d9d9738](https://github.com/nikunjmavani/core-be/commit/d9d97381082b330d32843511d29e8823fde2cb56))
* **user-data-export:** bound offboarding S3 delete fan-out (sec-r4-R2) ([#513](https://github.com/nikunjmavani/core-be/issues/513)) ([6ef83de](https://github.com/nikunjmavani/core-be/commit/6ef83de5039fcb08bd4422ad04cfc4282ee53bd4))
* **user:** block admin suspend/delete of protected super-admins (route-[#1](https://github.com/nikunjmavani/core-be/issues/1)) ([b84259d](https://github.com/nikunjmavani/core-be/commit/b84259d3f6cbb34ffb2f8617e900aa0157fc5fae))
* **user:** block deleting a user who still owns organizations (route-audit-[#2](https://github.com/nikunjmavani/core-be/issues/2) follow-up) ([f94b7c9](https://github.com/nikunjmavani/core-be/commit/f94b7c9c0c95d1525ea31fe41e44970efe452f19))
* **user:** rate-limit /me profile mutation endpoints (sec-r4-I1) ([#503](https://github.com/nikunjmavani/core-be/issues/503)) ([0c745e1](https://github.com/nikunjmavani/core-be/commit/0c745e182c0c6be2de608f42e9c434212ad07c08))
* **user:** rate-limit admin user-management mutations (route-[#4](https://github.com/nikunjmavani/core-be/issues/4)) ([a0d8114](https://github.com/nikunjmavani/core-be/commit/a0d8114b28fc1730fbc982271018d64700569537))
* **user:** reject org-scoped notification preference with 400 (was raw 42501 -&gt; 500) ([#327](https://github.com/nikunjmavani/core-be/issues/327)) ([db1e7a7](https://github.com/nikunjmavani/core-be/commit/db1e7a77e3c8f464bd8354f1235a1f33c5c71967))
* **user:** sec-new-U1 cap ListUsersDto.after cursor to 512 chars ([#483](https://github.com/nikunjmavani/core-be/issues/483)) ([fae555d](https://github.com/nikunjmavani/core-be/commit/fae555dd2717a4cde9a703f64941cca09d55e33f))
* **user:** unique notification-preference natural key + input dedupe (audit-[#11](https://github.com/nikunjmavani/core-be/issues/11)) ([6805459](https://github.com/nikunjmavani/core-be/commit/68054599b5fb2a120c6fb8571f23a76dc9277e7a))
* validators (audit follow-up) — centralize AES_GCM_IV_LENGTH, allowlist 5 and 512, env-load sunset validator ([#378](https://github.com/nikunjmavani/core-be/issues/378)) ([3bae917](https://github.com/nikunjmavani/core-be/commit/3bae917577c65d11cf771725f81392a0a62ce904))


### Performance

* parallelize S3 object deletes in deleteAllExportsForUser ([#361](https://github.com/nikunjmavani/core-be/issues/361)) ([4c36173](https://github.com/nikunjmavani/core-be/commit/4c36173e703bfaa9737ed2a529f0e28e8f863046))


### Changed

* **api:** rename inbound Idempotency-Key header to X-Idempotency-Key ([#656](https://github.com/nikunjmavani/core-be/issues/656)) ([b595c1b](https://github.com/nikunjmavani/core-be/commit/b595c1b0ed35a9248f1dd53660c7b3afb849eee4))
* **api:** semantic snake_case params, prefixed public ids, uniform status policy, documented headers ([03820fb](https://github.com/nikunjmavani/core-be/commit/03820fb407116e2532f2afdf12133861b8c58497))
* **api:** semantic snake_case route params, prefixed public ids, uniform method-status policy, documented headers ([3311bc0](https://github.com/nikunjmavani/core-be/commit/3311bc022f65fcbd517802cc91dcb194d5a31c0c))
* **architecture:** move raw SQL out of stripe-webhook-organization.util into the repository (+ global gate) ([#530](https://github.com/nikunjmavani/core-be/issues/530)) ([f48fb46](https://github.com/nikunjmavani/core-be/commit/f48fb46fe1005a95adc0abf14222df8f86c030f9))
* **billing:** remove deprecated /stripe/webhook alias ([#670](https://github.com/nikunjmavani/core-be/issues/670)) ([e0a4c8b](https://github.com/nikunjmavani/core-be/commit/e0a4c8bfac04fcbe041c6b6c1e47a5585d411820))
* **constants:** centralize scope-localized config constants ([#667](https://github.com/nikunjmavani/core-be/issues/667)) ([f6dad66](https://github.com/nikunjmavani/core-be/commit/f6dad66887513bd519c020794526b3b32c8c728a))
* enforce architecture boundaries (DB-in-services, DI, controller thinness) ([#602](https://github.com/nikunjmavani/core-be/issues/602)) ([cc43b3b](https://github.com/nikunjmavani/core-be/commit/cc43b3b3f38cd94d190928ac6728f1077195bbbf))
* **quality:** clear SonarQube debt on the deployed surface ([#663](https://github.com/nikunjmavani/core-be/issues/663)) ([8f5116a](https://github.com/nikunjmavani/core-be/commit/8f5116a5ddb29ac435078922ed7188ca4f6f1df3))
* **queue:** remove redundant alert-only offboarding reconciler ([#611](https://github.com/nikunjmavani/core-be/issues/611)) ([55e979e](https://github.com/nikunjmavani/core-be/commit/55e979e10528a3b6c794aaea1595e7feeedbc7b6))
* route consistency + personal/team org model ([#658](https://github.com/nikunjmavani/core-be/issues/658)) ([d304b88](https://github.com/nikunjmavani/core-be/commit/d304b88439d8611d7b7d668f4b0d1f15c9a7a2dc))
* **tenancy:** route org-scoped controllers through claim-aware org accessor ([f4c3b54](https://github.com/nikunjmavani/core-be/commit/f4c3b54f70b5c9c49c2a03cf908f1407810138a8))
* **tenancy:** route org-scoped controllers through claim-aware org accessor ([af30b20](https://github.com/nikunjmavani/core-be/commit/af30b20e50b8c49f3c906bbbb1ca6d4093fd14ef))
* **validation:** extract shared parseWithSchema + parseCursorPaginatedQuery helpers ([#661](https://github.com/nikunjmavani/core-be/issues/661)) ([7831156](https://github.com/nikunjmavani/core-be/commit/78311567eb27b6676b63fa3dec89ab3d1bab3130))


### Documentation

* add 2026-06-04 deep audit report (20 findings) ([6515589](https://github.com/nikunjmavani/core-be/commit/65155899935406e72781fab5348f146b20b5b8e4))
* add deep backend audit report 2026-06-03 ([#362](https://github.com/nikunjmavani/core-be/issues/362)) ([3d7ae31](https://github.com/nikunjmavani/core-be/commit/3d7ae31779c7975b4b61d19c8f7867c8a58432a9))
* add remediation status tracker to 2026-06-03 audit report ([93ef121](https://github.com/nikunjmavani/core-be/commit/93ef12150cd3917f3a6ecc46c9e8da4573ada94b))
* **agent-os:** align schema skills to varchar(n) codebase convention ([#638](https://github.com/nikunjmavani/core-be/issues/638)) ([e575074](https://github.com/nikunjmavani/core-be/commit/e5750743e7a8af7a59eebd06d552ca8223a598d1))
* **agent-os:** correct stale workflow, seed, and provider paths in skills ([#641](https://github.com/nikunjmavani/core-be/issues/641)) ([5550f4c](https://github.com/nikunjmavani/core-be/commit/5550f4c274b58403008bb98dd4982642565ed110))
* **api:** add frontend auth & headers integration guide ([b8ca013](https://github.com/nikunjmavani/core-be/commit/b8ca01362c4a04aa8d65e511cac136a0953b2445))
* **api:** add frontend auth & headers integration guide ([ab201e8](https://github.com/nikunjmavani/core-be/commit/ab201e8046a524ad2f5dd9868e22897d77aaf2a9))
* **audit-2026-06-04:** mark all 20 findings resolved with file:line citations ([#381](https://github.com/nikunjmavani/core-be/issues/381)) ([96dd4f7](https://github.com/nikunjmavani/core-be/commit/96dd4f74574b1dca6ee93190b59edc56ab414b1e))
* check in sync; enricher unit tests + full suite (4,516) green. ([c58d39b](https://github.com/nikunjmavani/core-be/commit/c58d39b0aa550158d3106a41fadd403c203eb4c5))
* check verified green on 0.28.1. ([514fa96](https://github.com/nikunjmavani/core-be/commit/514fa961bd392ef4583c7e148a7f47277ef23dae))
* check, tsdoc 0/0, migrate lint, env sync, validate all pass. ([3311bc0](https://github.com/nikunjmavani/core-be/commit/3311bc022f65fcbd517802cc91dcb194d5a31c0c))
* consolidate setup guide into single root SETUP.md ([#555](https://github.com/nikunjmavani/core-be/issues/555)) ([5c311a3](https://github.com/nikunjmavani/core-be/commit/5c311a3c72f1fb33cb44daa087e94ee19e2edb1c))
* **env:** standardize OPTIONAL marker for conditionally-empty env keys ([#549](https://github.com/nikunjmavani/core-be/issues/549)) ([d7155b4](https://github.com/nikunjmavani/core-be/commit/d7155b48786aee7a8ce2e306133b61398f00cf20))
* **infra:** annotate Dockerfile build-stage ENV as test-only placeholders (sec-r4-C6) ([#519](https://github.com/nikunjmavani/core-be/issues/519)) ([cdf76ef](https://github.com/nikunjmavani/core-be/commit/cdf76ef7e6a85de7e638c161d1e7ad34dd12e38a))
* **integrations:** add Codex Cloud agent environment guide and GitHub prerequisites ([#660](https://github.com/nikunjmavani/core-be/issues/660)) ([d2128de](https://github.com/nikunjmavani/core-be/commit/d2128de716f1f19c25d934c87ecb517baf05d04e))
* **integrations:** add Postman + Resend agent MCP servers ([#631](https://github.com/nikunjmavani/core-be/issues/631)) ([6966744](https://github.com/nikunjmavani/core-be/commit/6966744da40ff9887700f433f78afc1f8f313140))
* **integrations:** common Claude Code session-setup overview ([#674](https://github.com/nikunjmavani/core-be/issues/674)) ([9052152](https://github.com/nikunjmavani/core-be/commit/90521520c34495a066342656f1ba104beb827f54))
* **integrations:** expand Stripe webhook runbook + Turnstile TODO ([#635](https://github.com/nikunjmavani/core-be/issues/635)) ([be08946](https://github.com/nikunjmavani/core-be/commit/be08946a84175689883f858e61e96b928e8c222d))
* **integrations:** fix Stripe CLI/Dashboard webhook URL ([#630](https://github.com/nikunjmavani/core-be/issues/630)) ([570e58f](https://github.com/nikunjmavani/core-be/commit/570e58f79991d12dcf75781ccdc9465da2647b85))
* **integrations:** map third-party services to CLI/MCP/SDK by consumer ([#626](https://github.com/nikunjmavani/core-be/issues/626)) ([5e90f52](https://github.com/nikunjmavani/core-be/commit/5e90f522061e5de8f31cb2905b9edda43caf2bf9))
* **openapi:** drop "Public ID" from request-body/query field descriptions → "id" ([3cb01a0](https://github.com/nikunjmavani/core-be/commit/3cb01a0b294a1a47a80a25a209ab410403e38117))
* **openapi:** drop "Public ID" from request-body/query field descriptions → "id" ([c58d39b](https://github.com/nikunjmavani/core-be/commit/c58d39b0aa550158d3106a41fadd403c203eb4c5))
* **process:** add release-versioning cheat-sheet (commit prefix → bump) ([#612](https://github.com/nikunjmavani/core-be/issues/612)) ([6e58397](https://github.com/nikunjmavani/core-be/commit/6e58397013279da347bf5a56305e150ea1cc8e26))
* **process:** document "watch CI -&gt; merge when green" in git flow + pr-babysit ([#616](https://github.com/nikunjmavani/core-be/issues/616)) ([0537a8e](https://github.com/nikunjmavani/core-be/commit/0537a8e86fc135038585d78b523e648cbc289e69))
* **reviews:** add agent-os AI-tooling audit + evals session writeup ([ef55c53](https://github.com/nikunjmavani/core-be/commit/ef55c536b406a3b1aea5df055c844bd4159c7a78))
* **reviews:** agent-os AI-tooling audit + evals/enforcement session writeup ([32288fa](https://github.com/nikunjmavani/core-be/commit/32288fa07f7e0b3caa92b5325ec51938b95be557))
* **reviews:** architecture conformance audit + 8-PR follow-up plan ([#531](https://github.com/nikunjmavani/core-be/issues/531)) ([4a9264c](https://github.com/nikunjmavani/core-be/commit/4a9264cb674f57930241a8b348d12afdcc727476))
* **reviews:** correct sec-r4-A3 analysis and defer to follow-up task ([#523](https://github.com/nikunjmavani/core-be/issues/523)) ([c7e1dab](https://github.com/nikunjmavani/core-be/commit/c7e1dab9433b40eb16a7df6e28fdf317df9318b7))
* **reviews:** route-coverage audit — 129 routes, 9 deferred gaps allowlisted ([#534](https://github.com/nikunjmavani/core-be/issues/534)) ([d18ec1d](https://github.com/nikunjmavani/core-be/commit/d18ec1df87b78237c77bac6f84b1ec464ff71965))
* **runbooks:** refresh worker registry breakdown to 30 workers / 27 Postgres ([#621](https://github.com/nikunjmavani/core-be/issues/621)) ([2d4d111](https://github.com/nikunjmavani/core-be/commit/2d4d111a9578679c856367881c16a5f6d8f62cb6))
* **superpowers:** re-audit remediation design spec for 18 findings ([#451](https://github.com/nikunjmavani/core-be/issues/451)) ([1b05734](https://github.com/nikunjmavani/core-be/commit/1b05734fe69e593ae6ad9f5fb2f11e6f4a8f69f6))

## [4.4.0](https://github.com/nikunjmavani/core-be/compare/v4.3.0...v4.4.0) (2026-06-17)


### Added

* 131-route security & production-flow audit — fix all RED/AMBER findings ([#601](https://github.com/nikunjmavani/core-be/issues/601)) ([3df1fbd](https://github.com/nikunjmavani/core-be/commit/3df1fbd91ea9011a6378a6f0785200e4a5f990ed))
* **agent-os:** add PreToolUse edit-guard and SessionStart hooks ([dcf6335](https://github.com/nikunjmavani/core-be/commit/dcf6335773cb9b8d15f570d7b2afac9e2a1a284c))
* **agent-os:** add RLS/tenant-isolation and idempotency guard skills ([a94cbb5](https://github.com/nikunjmavani/core-be/commit/a94cbb52df397f1abadf3a3f411f31bf2fc6f49a))
* **agent-os:** PreToolUse edit-guard + SessionStart hooks (Move 2) ([ad2e2b3](https://github.com/nikunjmavani/core-be/commit/ad2e2b3b87051c2fe34d3005d6a84fc6e37965e0))
* **agent-os:** RLS/tenant-isolation + idempotency guard skills ([0a3b902](https://github.com/nikunjmavani/core-be/commit/0a3b902748f4fc3e84d5d971b0915496b5e4f440))
* **ai:** cross-platform AI commands, SessionStart hook, and guardrails ([#643](https://github.com/nikunjmavani/core-be/issues/643)) ([b6fccf1](https://github.com/nikunjmavani/core-be/commit/b6fccf1630257d2920ba3831f625bbeeca7cad41))
* **audit:** transactional outbox for audit.logs writes (P0-[#2](https://github.com/nikunjmavani/core-be/issues/2)) ([#557](https://github.com/nikunjmavani/core-be/issues/557)) ([4c337da](https://github.com/nikunjmavani/core-be/commit/4c337da6b81523c01d23bf8947226194ee9ad665))
* **auth:** add switch-to-personal and switch-to-organization endpoints ([79be5b0](https://github.com/nikunjmavani/core-be/commit/79be5b0fe799563e9612eaa3fc48a4a12f3ce2ae))
* **auth:** carry active organization + session version as signed JWT claims ([9864a2e](https://github.com/nikunjmavani/core-be/commit/9864a2e34917837b7102fdd72f9ba61982e4b0e0))
* **auth:** GET /auth/me/context — frontend-ready effective context ([#659](https://github.com/nikunjmavani/core-be/issues/659)) ([d08bb35](https://github.com/nikunjmavani/core-be/commit/d08bb35049c443015b3d53be0f13c7a80f4a845a))
* **auth:** mint the active-organization claim at login (default selection) ([a3a805d](https://github.com/nikunjmavani/core-be/commit/a3a805dc143b7af537c0757b4b74bfc77516d75d))
* **auth:** permission layer falls back to the org token claim (Phase 3 bridge) ([ea07091](https://github.com/nikunjmavani/core-be/commit/ea0709135504d09faa6367bfded88107cc438295))
* **auth:** permission layer reads the org token claim (Phase 3 bridge) ([6b9e7c3](https://github.com/nikunjmavani/core-be/commit/6b9e7c3458f6788b5c75b0ed4a49d3709b48d181))
* **auth:** refresh re-mints the active-organization claim ([b22f0a1](https://github.com/nikunjmavani/core-be/commit/b22f0a1712aa76b1f997257997b157025712b791))
* **auth:** switch building blocks — membership-validation resolvers + session token re-bind ([62cc944](https://github.com/nikunjmavani/core-be/commit/62cc9449314b7684007c937a9ec72b73c2d0eceb))
* **auth:** switchToOrganization / switchToPersonal service methods ([3f5ecc8](https://github.com/nikunjmavani/core-be/commit/3f5ecc84267e747d6e6d900ae5caf733f6255752))
* **billing:** flatten subscription routes onto the org token claim ([f835d60](https://github.com/nikunjmavani/core-be/commit/f835d605e0529e0e0e91ca7da1b16aa5f8940bec))
* **billing:** flatten subscription routes onto the org token claim ([df21c2c](https://github.com/nikunjmavani/core-be/commit/df21c2c62c4b65e4f1bf57228743ac2cd042a92c))
* **ci:** add PR-time Trivy IaC misconfig scan ([#388](https://github.com/nikunjmavani/core-be/issues/388)) ([e8499e0](https://github.com/nikunjmavani/core-be/commit/e8499e04b8c8d311a14fb6ac3bdd1c4a4d151a49))
* **config:** gated local-dev defaults for DB/Redis/origins/retention ([#651](https://github.com/nikunjmavani/core-be/issues/651)) ([773e427](https://github.com/nikunjmavani/core-be/commit/773e427ca11bd44d1a65fea996ebbc92a629c236))
* **infra-tests:** drop_index_without_concurrently lint rule + org slug collision-proof factory ([#526](https://github.com/nikunjmavani/core-be/issues/526)) ([0915c85](https://github.com/nikunjmavani/core-be/commit/0915c851ab7b5c8934a06108d28f8aec3662e97b))
* **load:** per-VU credential pool + realistic user-journey k6 scenario ([#342](https://github.com/nikunjmavani/core-be/issues/342)) ([a05a611](https://github.com/nikunjmavani/core-be/commit/a05a611ced68683c0855c65d572fbc5fc7d06bb1))
* **mcp,k6:** client auth-flow guide + k6 org-claim flow; fix dead idempotency exclusions ([f4bac5a](https://github.com/nikunjmavani/core-be/commit/f4bac5aa9a67f14e5ec87209e326e67b5ae15de6))
* **mcp,k6:** client auth-flow guide + k6 org-claim flow; fix idempotency exclusions; flatten stale refs ([f6e5894](https://github.com/nikunjmavani/core-be/commit/f6e5894a66cee5de1ff0790f5898b5510fd74f37))
* **mcp:** scope project MCP servers and wire MCP setup into the session-start flow ([#675](https://github.com/nikunjmavani/core-be/issues/675)) ([9ed07b4](https://github.com/nikunjmavani/core-be/commit/9ed07b4ba576db0ac5849d9c7de76b4c2c91af73))
* **notify:** flatten webhook routes onto the org token claim ([643d13a](https://github.com/nikunjmavani/core-be/commit/643d13ad09bd64e28bca029e4ed42cc40b56d04f))
* **notify:** flatten webhook routes onto the org token claim ([0bdc8ad](https://github.com/nikunjmavani/core-be/commit/0bdc8add9f37df2bd944995368be8d9f94710755))
* **notify:** time-based retention for webhook_delivery_attempts (audit-[#3](https://github.com/nikunjmavani/core-be/issues/3)) ([05d6325](https://github.com/nikunjmavani/core-be/commit/05d63258002fd9762962498b0a5059a5b971400f))
* **observability:** emit Server-Timing header for true server-side latency ([#339](https://github.com/nikunjmavani/core-be/issues/339)) ([5e78cde](https://github.com/nikunjmavani/core-be/commit/5e78cde15b30deac077cbf4e27081cf6da27e814))
* **openapi:** document the full error-status matrix; observed-vs-spec error gate ([95a71b5](https://github.com/nikunjmavani/core-be/commit/95a71b505c9d8d7f802d73c4e0841b4140bf836d))
* **openapi:** document the full error-status matrix; observed-vs-spec error gate ([5a001de](https://github.com/nikunjmavani/core-be/commit/5a001de48bb661e048e012dde8ce658bfe612f3e))
* **openapi:** embed sanitized live-call request/response examples per route and status ([3a1ddb1](https://github.com/nikunjmavani/core-be/commit/3a1ddb1e5d38b40e18b9300a14942219da6ce868))
* **openapi:** embed sanitized live-call request/response examples per route and status ([bea574c](https://github.com/nikunjmavani/core-be/commit/bea574c92291f96bd309ad1969fe38cdf756722f))
* personal & team organizations — foundation + token/switch (Phase 1-2) ([9a8b179](https://github.com/nikunjmavani/core-be/commit/9a8b179a097b615b2e7292ad6f6362011ea2563c))
* **round-5-followup:** per-org row caps (api-keys, member-roles, notification-policies) + auth/MFA route policy tests ([#528](https://github.com/nikunjmavani/core-be/issues/528)) ([19b556f](https://github.com/nikunjmavani/core-be/commit/19b556f9379a3d70889644356e9928a68de549e9))
* **round-5:** residual-risk findings — DLQ-RLS bug + 5 backlog fixes + 3 test gaps + audit doc ([#527](https://github.com/nikunjmavani/core-be/issues/527)) ([6aa6f88](https://github.com/nikunjmavani/core-be/commit/6aa6f8831e12fa7c8ef88f3d95f9e15bcd2d23d2))
* **scalar:** publish OpenAPI to Scalar Registry (CI docs pipeline + interactive setup) ([#672](https://github.com/nikunjmavani/core-be/issues/672)) ([3ddc9b2](https://github.com/nikunjmavani/core-be/commit/3ddc9b2325a8cc8417bfe679c748a64f5c510da2))
* **tenancy:** atomic org provisioning with owner role+permissions+membership ([266b22e](https://github.com/nikunjmavani/core-be/commit/266b22ebeb3604dbc45d08608efd7604df37c81e))
* **tenancy:** auto-provision personal org at signup + exclude personal from delete guard ([9daed03](https://github.com/nikunjmavani/core-be/commit/9daed03c85997744bbfeb50919681de5658cd556))
* **tenancy:** block invitations on a personal organization (capability matrix) ([cafc549](https://github.com/nikunjmavani/core-be/commit/cafc5493d497f7e99a924a152ca6a64e4f29dd0d))
* **tenancy:** cap team organizations per owner (anti-abuse) ([f71b968](https://github.com/nikunjmavani/core-be/commit/f71b968577aa19a8ce4c3b4f6ce83142c3fd51d3))
* **tenancy:** flatten organization routes onto the org token claim ([ddd1a76](https://github.com/nikunjmavani/core-be/commit/ddd1a7604f7da6dfb3a878fdb28c9e35dff086d8))
* **tenancy:** flatten organization routes onto the org token claim ([f35b74e](https://github.com/nikunjmavani/core-be/commit/f35b74eb0f14cf2e5225b3fb477ea686a82763ed))
* **tenancy:** make the personal organization immutable (no delete / no transfer) ([a726064](https://github.com/nikunjmavani/core-be/commit/a726064b5f009c1a5ccd878fe8379eb79a533a37))
* **tenancy:** org-creation per-owner cap + personal-org capability guards ([94d7715](https://github.com/nikunjmavani/core-be/commit/94d77153740b2076afb57ded14748b727367617c))
* **tenancy:** organization create accepts type + nullable slug (provisioning groundwork) ([35bc409](https://github.com/nikunjmavani/core-be/commit/35bc409c7e85453a2d294f1baf4bd38b19e26d6f))
* **tenancy:** personal-org backfill script + provisioning tests ([5a40f5d](https://github.com/nikunjmavani/core-be/commit/5a40f5d5eadfd970e712b8d4b5a7f85b86258727))
* **tenancy:** personal/team organization foundation — schema + capability flags ([11e23d9](https://github.com/nikunjmavani/core-be/commit/11e23d92fc301307638f73e3e1269a0612ddde3d))
* **testing:** route success-status registry, observed coverage ratchet, never-5xx fuzz gate ([8d88dcf](https://github.com/nikunjmavani/core-be/commit/8d88dcf0677104ce4885ad80d62543c6ec45052a))
* **testing:** route success-status registry, observed coverage ratchet, never-5xx fuzz gate ([dfe2b43](https://github.com/nikunjmavani/core-be/commit/dfe2b436d3fa28843597576d6b29f43d7932d8ab))
* **testing:** verified happy path for every route — budget 30→0; 201 creates; OAuth 404 ([01b1b77](https://github.com/nikunjmavani/core-be/commit/01b1b77cbf2f60dcafbfa1afeafab68fe1e54437))
* **testing:** verified happy path for every route — budget 30→0; 201 creates; OAuth 404 ([624c9d5](https://github.com/nikunjmavani/core-be/commit/624c9d58945e78317e39cd9a412e488454fbdf29))
* **tests:** post-load settle-and-assert-clean gate + audit-outbox drain coverage ([01258c5](https://github.com/nikunjmavani/core-be/commit/01258c5b5aa9c03f8d6e9c7c9a5218cd10d3750b))
* **tooling:** project identity refactor, 5 review agents, architecture policy tests ([#552](https://github.com/nikunjmavani/core-be/issues/552)) ([324689e](https://github.com/nikunjmavani/core-be/commit/324689e3c5027056932272f90d3495539d25ea44))
* **user:** add a scheduled reconciler that detects + alerts on stuck offboarding (audit-[#15](https://github.com/nikunjmavani/core-be/issues/15)) ([6443673](https://github.com/nikunjmavani/core-be/commit/64436733ec73792a3295b46ade51da2ceee98a53))
* **user:** expose deployment organization capabilities on /users/me ([a27f7a6](https://github.com/nikunjmavani/core-be/commit/a27f7a6d9a1a03a75e6163ab061e137d8a65e1d8))
* **user:** expose personal_organization_id on /users/me ([b725aca](https://github.com/nikunjmavani/core-be/commit/b725acad609f8a9743f2a199c4234df423ade3a5))


### Fixed

* 8th-audit concurrency races + correctness hardening (C1-C5) ([bf077b7](https://github.com/nikunjmavani/core-be/commit/bf077b743cfbe51549c39ca4d4ae28b824a1a6df))
* **api:** truthful error envelope, id-only external fields, DELETE→204 stragglers, local oasdiff gate ([25b4629](https://github.com/nikunjmavani/core-be/commit/25b46297b331681b528962246f8bee28c4695204))
* **api:** truthful error envelope, id-only external fields, DELETE→204 stragglers, local oasdiff gate ([2777308](https://github.com/nikunjmavani/core-be/commit/2777308d77c2938b0f66437a24a02b9637392b19))
* audit batch2 — WebAuthn typed DTOs, oasdiff SIGSEGV CI workaround ([6e44557](https://github.com/nikunjmavani/core-be/commit/6e4455700f39ed6cc6dee5ca71baf4eaddac49ed))
* **audit-13:** remove dead jobTimeout field from worker options — BullMQ does not enforce it ([#379](https://github.com/nikunjmavani/core-be/issues/379)) ([b393d5e](https://github.com/nikunjmavani/core-be/commit/b393d5e0add3e299de889d023056397a559b5df6))
* **audit:** cursor max-length, DLQ catch, jobTimeout, age-based queue eviction (batch5) ([#375](https://github.com/nikunjmavani/core-be/issues/375)) ([5882436](https://github.com/nikunjmavani/core-be/commit/588243618efe4be76f3b9e1d2b0c2aa851b06930))
* **audit:** MCP caller JWT forwarding and IP-level failed-login counter ([#373](https://github.com/nikunjmavani/core-be/issues/373)) ([ceee226](https://github.com/nikunjmavani/core-be/commit/ceee2269da8c40bb16f1332e56de8028de24b069))
* **audit:** omit soft-deleted orgs from audit-log public id resolution (sec-r4-D2) ([#506](https://github.com/nikunjmavani/core-be/issues/506)) ([e76a015](https://github.com/nikunjmavani/core-be/commit/e76a01530ed22da2e35d21f0080547075d0475d8))
* **audit:** rate limits, User-Agent truncation, webhook HTTPS, CAPTCHA staging (batch4) ([#374](https://github.com/nikunjmavani/core-be/issues/374)) ([4c9486a](https://github.com/nikunjmavani/core-be/commit/4c9486ac64959cea4bd308cb59c37ba858018066))
* **auth-webauthn:** require user verification at options time (sec-r4-A2) ([#514](https://github.com/nikunjmavani/core-be/issues/514)) ([38f60cf](https://github.com/nikunjmavani/core-be/commit/38f60cf8443a94ff327e95e6bad5d03d7bdf6947))
* **auth,openapi:** MFA-login org claim (H1) + captcha/bearerAuth OpenAPI accuracy ([909a5ce](https://github.com/nikunjmavani/core-be/commit/909a5ce448a362af445736e8a02cb2e18b7949b8))
* **auth,openapi:** mfa-login org claim (H1) plus captcha and bearerAuth openapi accuracy ([fc336b8](https://github.com/nikunjmavani/core-be/commit/fc336b867a9a597fb3c613aa0574a4b8e91bae60))
* **auth:** add user FK + index to mfa_methods to purge orphaned MFA secrets (reaudit-[#1](https://github.com/nikunjmavani/core-be/issues/1)) ([a5a0992](https://github.com/nikunjmavani/core-be/commit/a5a0992eb777f40851e2c97ac7c26ff371325c06))
* **auth:** atomic credential-mutation guards + lockout counter (route-audit C1, C5) ([e6e33db](https://github.com/nikunjmavani/core-be/commit/e6e33db37b405bf0c92622b3c152f35c88cbf186))
* **auth:** block revoking the current session via DELETE /me/sessions/:id (route-[#9](https://github.com/nikunjmavani/core-be/issues/9)) ([19f4bff](https://github.com/nikunjmavani/core-be/commit/19f4bff7ba7a651f630204a173f859dc40206d2b))
* **auth:** bounded refresh-token reuse grace for concurrent refreshes (audit-[#2](https://github.com/nikunjmavani/core-be/issues/2)) ([0cdd75d](https://github.com/nikunjmavani/core-be/commit/0cdd75dd8b85e880950b8a076fbadee39c01d18f))
* **auth:** close session-revoke cache repopulation race + normalize OAuth email (route-audit session-[#1](https://github.com/nikunjmavani/core-be/issues/1), oauth-[#3](https://github.com/nikunjmavani/core-be/issues/3)) ([b8303a0](https://github.com/nikunjmavani/core-be/commit/b8303a02e1e7010f9516e0e5c2df5b7777c83694))
* **auth:** close WebAuthn enumeration timing oracle + complete credential-mutation lock (route-audit D1, D2, D3) ([10e2b52](https://github.com/nikunjmavani/core-be/commit/10e2b5271c7cb454e15e99035389787e5c233c25))
* **auth:** drop SUPER_ADMIN for non-active accounts in per-request re-derive (reaudit-[#10](https://github.com/nikunjmavani/core-be/issues/10)) ([e54a97b](https://github.com/nikunjmavani/core-be/commit/e54a97bd1e643916ac3eb579eeda2dcdb1d26493))
* **auth:** fix controller unit test and ack OpenAPI breaking change for B4 ([48f8c81](https://github.com/nikunjmavani/core-be/commit/48f8c818fa14f205efe5a6e12d2528e8461f6790))
* **auth:** floor login failure branches to mask enumeration timing (audit-[#15](https://github.com/nikunjmavani/core-be/issues/15)d) ([0c4af59](https://github.com/nikunjmavani/core-be/commit/0c4af594c6aba8d84d383d20c01838ef6d134bf0))
* **auth:** key DELETE /mfa/:mfaMethodId on public id, not the sequential DB id (route-[#10](https://github.com/nikunjmavani/core-be/issues/10)) ([31bdd46](https://github.com/nikunjmavani/core-be/commit/31bdd46de650dce63aa6bc542beda50d57c0dea2))
* **auth:** make magic-link verification atomic with first-factor completion (audit-[#12](https://github.com/nikunjmavani/core-be/issues/12)) ([4350845](https://github.com/nikunjmavani/core-be/commit/435084506afc855e48169b8e26b3d87a1690f36a))
* **auth:** make MFA verification lockout counter atomic (route-audit-[#4](https://github.com/nikunjmavani/core-be/issues/4)) ([7d98218](https://github.com/nikunjmavani/core-be/commit/7d982183877aeea6cbc4531cea9eb47376c704fc))
* **auth:** make one-time-token issuance atomic with the mail-outbox insert (audit-[#11](https://github.com/nikunjmavani/core-be/issues/11)) ([f122beb](https://github.com/nikunjmavani/core-be/commit/f122beb20866aaf4748b05d29d2307f9a0768462))
* **auth:** make password change and email verification atomic with their side effects (audit-[#4](https://github.com/nikunjmavani/core-be/issues/4), [#12](https://github.com/nikunjmavani/core-be/issues/12)) ([42d7893](https://github.com/nikunjmavani/core-be/commit/42d7893572ee6e89c5bbe42a08cc18d1f33aa6e6))
* **auth:** make password reset atomic (transaction) so sessions can't survive it ([#319](https://github.com/nikunjmavani/core-be/issues/319)) ([30cffe5](https://github.com/nikunjmavani/core-be/commit/30cffe5c205fdd7d0f1a835cf335791ad78ad36e))
* **auth:** per-user MFA verification lockout (audit-[#12](https://github.com/nikunjmavani/core-be/issues/12)) ([d6331e0](https://github.com/nikunjmavani/core-be/commit/d6331e01f9a0d378096ecc26b30404f23fc20d7c))
* **auth:** persist and revalidate the active organization across refresh (audit-[#3](https://github.com/nikunjmavani/core-be/issues/3)) ([f9d8f1b](https://github.com/nikunjmavani/core-be/commit/f9d8f1b5a757c5b8dc5f267f4cf166f2e5677816))
* **auth:** re-derive any privileged JWT claim (admin + super_admin) against live state (route-[#6](https://github.com/nikunjmavani/core-be/issues/6)) ([956c43d](https://github.com/nikunjmavani/core-be/commit/956c43d855978ea9f49c573e4c8a498ae2c4309f))
* **auth:** remove silent params.id fallback in requireOrganizationPermission ([#346](https://github.com/nikunjmavani/core-be/issues/346)) ([17f4d83](https://github.com/nikunjmavani/core-be/commit/17f4d83fae5114820bf4f1c00940306628ea1228))
* **auth:** restore org-mandated MFA under FORCE RLS via SECURITY DEFINER resolvers ([#318](https://github.com/nikunjmavani/core-be/issues/318)) ([e152c0c](https://github.com/nikunjmavani/core-be/commit/e152c0c458aed788289c7d75b3e8fe0c79ec938f))
* **auth:** restrict POST /me/auth-methods to MAGIC_LINK to stop phantom-credential lockout (route-[#3](https://github.com/nikunjmavani/core-be/issues/3)) ([ee9af9a](https://github.com/nikunjmavani/core-be/commit/ee9af9a5819990189c658a69d9396e0fdb3ed7c5))
* **auth:** scope MFA lockout to TOTP so recovery codes stay usable (reaudit-[#3](https://github.com/nikunjmavani/core-be/issues/3)) ([a6d4b05](https://github.com/nikunjmavani/core-be/commit/a6d4b05530cd06f563be8a0ede17552d6831f4ac))
* **auth:** sec-new-A2 reject suspended/deleted users on bearer auth cache miss ([#474](https://github.com/nikunjmavani/core-be/issues/474)) ([eff74f4](https://github.com/nikunjmavani/core-be/commit/eff74f453a57f071258b8275aa850d375e6a67cc))
* **auth:** sec-new-A3 preserve caller session on DELETE /me/sessions ([#478](https://github.com/nikunjmavani/core-be/issues/478)) ([32936f3](https://github.com/nikunjmavani/core-be/commit/32936f3625022fcb98a3b2f681b6d19ee86a7611))
* **auth:** sec-new-A4 flip is_mfa_enabled inside deleteMfa transaction ([#479](https://github.com/nikunjmavani/core-be/issues/479)) ([a50d899](https://github.com/nikunjmavani/core-be/commit/a50d8995f7c42b08643d6a503b70971d24cbf6e9))
* **auth:** sec-new-B4 add public_id to auth_methods, stop leaking bigserial ids ([c82295d](https://github.com/nikunjmavani/core-be/commit/c82295d43b2768b8fb53160c26704e3dabadf4ce))
* **auth:** sec-new-B4 add public_id to auth_methods, stop leaking bigserial ids ([02a6ddd](https://github.com/nikunjmavani/core-be/commit/02a6ddd7b4dff060e87709bfa74dcd955a679228))
* **auth:** session-revoke cache repopulation race + OAuth email normalization ([c981c7f](https://github.com/nikunjmavani/core-be/commit/c981c7f634a1090faae6513d62aa30206e5e1778))
* **auth:** stop GET /auth/me/auth-methods leaking encrypted TOTP secret + PII ([#321](https://github.com/nikunjmavani/core-be/issues/321)) ([32cb49e](https://github.com/nikunjmavani/core-be/commit/32cb49e7b1c2039c2554adc481c2f68837720e6e))
* **auth:** switch-to-organization relies on route schema for body validation + suite green ([ab02f71](https://github.com/nikunjmavani/core-be/commit/ab02f711379690a987cf2cc7ab46139dc411adf8))
* **auth:** WebAuthn enumeration timing oracle + complete credential-mutation lock (D1/D2/D3) ([9a1f3f0](https://github.com/nikunjmavani/core-be/commit/9a1f3f0d5aef7156d4d455935f5295f20b76d257))
* backend production-readiness audit findings ([0f60e0f](https://github.com/nikunjmavani/core-be/commit/0f60e0f71d6dd0b1f7a5d9aa20bf60712c8a04cb))
* backend production-readiness re-audit findings ([6bd64bc](https://github.com/nikunjmavani/core-be/commit/6bd64bc3c47c7c28a1f1d42121867bc990f9c99c))
* **billing:** add per-route rate limit to subscription mutations (route-[#2](https://github.com/nikunjmavani/core-be/issues/2)) ([1e6975e](https://github.com/nikunjmavani/core-be/commit/1e6975e24271d14561f544981c651e254c3ef862))
* **billing:** alert on plan&lt;-&gt;Stripe price catalog drift (audit-[#13](https://github.com/nikunjmavani/core-be/issues/13)) ([3377510](https://github.com/nikunjmavani/core-be/commit/33775103b9ec7470270ff172b734b34586aebcb3))
* **billing:** bound PlanRepository.findAllActive at 100 rows (sec-r4-D3) ([#507](https://github.com/nikunjmavani/core-be/issues/507)) ([43180a9](https://github.com/nikunjmavani/core-be/commit/43180a98e2b62abdc0584460d06d455a55701900))
* **billing:** cancel the org's active subscription on organization delete (route-audit-[#2](https://github.com/nikunjmavani/core-be/issues/2)) ([718c80f](https://github.com/nikunjmavani/core-be/commit/718c80f307ae14d9db2ff77dbd26ae591f667afc))
* **billing:** cancel() releases the slot for never-activated INCOMPLETE subscriptions (reaudit-[#6](https://github.com/nikunjmavani/core-be/issues/6)) ([3d6cfe0](https://github.com/nikunjmavani/core-be/commit/3d6cfe03758b1302a8d1e7f8612d4641d381c1e8))
* **billing:** correct misleading plan route OpenAPI descriptions ([#349](https://github.com/nikunjmavani/core-be/issues/349)) ([27246ce](https://github.com/nikunjmavani/core-be/commit/27246ce78082f134005ac028852c7d95233f3c8b))
* **billing:** enforce unique subscriptions.provider_subscription_id (audit-[#10](https://github.com/nikunjmavani/core-be/issues/10)) ([acf919b](https://github.com/nikunjmavani/core-be/commit/acf919b105cbc10c502b8b197f5af1bd8782646c))
* **billing:** hide inactive plans from public GET /billing/plans/:id (route-[#7](https://github.com/nikunjmavani/core-be/issues/7)) ([0be46ed](https://github.com/nikunjmavani/core-be/commit/0be46ed971f32287ba326cdbbbb94275ca7f9465))
* **billing:** make Stripe customer creation idempotent on retry ([#326](https://github.com/nikunjmavani/core-be/issues/326)) ([8990fb3](https://github.com/nikunjmavani/core-be/commit/8990fb32b15fa133aece4ce428182d9b1996ee93))
* **billing:** make terminal subscriptions immutable (compare-and-set, B5/B6) ([5ac4328](https://github.com/nikunjmavani/core-be/commit/5ac43284d69e28101615d1a2f2caa306ab31cfe2))
* **billing:** make terminal subscriptions immutable via compare-and-set (route-audit B5, B6) ([18a3e43](https://github.com/nikunjmavani/core-be/commit/18a3e43540814b94e66ad085f40df767a32598e3))
* **billing:** persist a CANCELED tombstone for out-of-order Stripe deletions (audit-[#1](https://github.com/nikunjmavani/core-be/issues/1)) ([7862609](https://github.com/nikunjmavani/core-be/commit/7862609ed32b9c5c16d5780f4a6d7b59ba5066bb))
* **billing:** persist new Stripe subscriptions as INCOMPLETE not TRIALING (audit-[#2](https://github.com/nikunjmavani/core-be/issues/2)) ([b5a7f66](https://github.com/nikunjmavani/core-be/commit/b5a7f66537091e20632b3898364c7ac71e3f9f5f))
* **billing:** pin Stripe API version to 2026-05-27.dahlia ([#350](https://github.com/nikunjmavani/core-be/issues/350)) ([7c329bd](https://github.com/nikunjmavani/core-be/commit/7c329bd496bdff587f3c12748f923a2ef7267909))
* **billing:** release subscription slot for INCOMPLETE_EXPIRED (audit-[#1](https://github.com/nikunjmavani/core-be/issues/1)) ([14cd328](https://github.com/nikunjmavani/core-be/commit/14cd3289545d1229e72b08e16977286cde39db18))
* **billing:** remove redundant parseBullMQJobData from stripe-webhook processor (sec-r4-Q1) ([#502](https://github.com/nikunjmavani/core-be/issues/502)) ([d20c731](https://github.com/nikunjmavani/core-be/commit/d20c731dbaf5764fcb0ebf96376830c882991205))
* **billing:** sec-new-B1 guard cancel/resume/changePlan against terminal subscriptions ([#475](https://github.com/nikunjmavani/core-be/issues/475)) ([86bb32f](https://github.com/nikunjmavani/core-be/commit/86bb32f6de0ed2c3e293f2a17f979b9cfbfc3328))
* **billing:** sec-new-D1-D2 data integrity guards in billing writes ([#476](https://github.com/nikunjmavani/core-be/issues/476)) ([def085a](https://github.com/nikunjmavani/core-be/commit/def085adf233218dac8c01dad35e2efde385313b))
* **billing:** sec-new-M2 emit Deprecation+Sunset headers on deprecated /stripe/webhook alias ([#489](https://github.com/nikunjmavani/core-be/issues/489)) ([d95f4aa](https://github.com/nikunjmavani/core-be/commit/d95f4aa8becdae0454be1d727a09c1580fb1ff4d))
* **billing:** set concrete sunset for deprecated stripe webhook alias (audit-[#15](https://github.com/nikunjmavani/core-be/issues/15)a) ([4efb4a7](https://github.com/nikunjmavani/core-be/commit/4efb4a78e02af5da54c10fb04de02239120b1f79))
* **billing:** support comma-separated STRIPE_WEBHOOK_SECRET for zero-downtime rotation (sec-new-B3) ([#490](https://github.com/nikunjmavani/core-be/issues/490)) ([4be65fe](https://github.com/nikunjmavani/core-be/commit/4be65fe218a948b63f9386a09a934aa4cb4d42e5))
* block user delete when owning orgs + webhook updated_at flake ([08a5ac2](https://github.com/nikunjmavani/core-be/commit/08a5ac27734c2d3abb3604ab5e694abeb429d85e))
* **cache:** add commandTimeout to Redis client to prevent hung commands ([8cd8107](https://github.com/nikunjmavani/core-be/commit/8cd8107df573d5a8255911dc2fac8f21e676fb66))
* **ci:** dispatch stable release backmerge ([be9190f](https://github.com/nikunjmavani/core-be/commit/be9190f6ff26d04905bc46127717c96fbbe57ab0))
* **ci:** export GLOBAL_ADMIN_EMAILS in test-env so audit.test.ts super-admin paths work in Matrix Tests ([#532](https://github.com/nikunjmavani/core-be/issues/532)) ([873f59d](https://github.com/nikunjmavani/core-be/commit/873f59df59340bc182e3d8f261b5c2e435f89c63))
* **ci:** grant release-please job id-token + actions write permissions ([#536](https://github.com/nikunjmavani/core-be/issues/536)) ([b83eab2](https://github.com/nikunjmavani/core-be/commit/b83eab2d4ac3e2b46f5e77e00e34d720db6508e0))
* **ci:** publish API docs (incl. Scalar Registry) independently of release-please ([#676](https://github.com/nikunjmavani/core-be/issues/676)) ([7c4fe62](https://github.com/nikunjmavani/core-be/commit/7c4fe62027431e4d79e006afb84cc24c61e5fc67))
* **ci:** publish Scalar registry from GitHub Variables ([#677](https://github.com/nikunjmavani/core-be/issues/677)) ([cfaaef8](https://github.com/nikunjmavani/core-be/commit/cfaaef883eb57327cfd3f558597407250d3a752c))
* **ci:** repoint 12 dead Stryker mutate paths + drift guard (security middlewares were unmutated) ([#310](https://github.com/nikunjmavani/core-be/issues/310)) ([5609146](https://github.com/nikunjmavani/core-be/commit/560914673aa37406be1ecfc570be90d1d6756122))
* **ci:** use bare check-run names as ruleset required-check contexts ([#344](https://github.com/nikunjmavani/core-be/issues/344)) ([c431a63](https://github.com/nikunjmavani/core-be/commit/c431a63a292e9dcff7dc09147c9ae0fd7eb3d5d2))
* **ci:** use fetch-depth: 0 in post-merge changes job to avoid paths-filter race ([#390](https://github.com/nikunjmavani/core-be/issues/390)) ([61a2100](https://github.com/nikunjmavani/core-be/commit/61a210090ae518f75f459cc33806b10ba1442993))
* **config:** cap AUTH_SESSION_MAX_AGE_DAYS at 365 (sec-r4-C4) ([#510](https://github.com/nikunjmavani/core-be/issues/510)) ([2a48a88](https://github.com/nikunjmavani/core-be/commit/2a48a88355744445298e8fb36dda0c22fca0b472))
* **config:** make .env.local the self-contained primary local env file ([#650](https://github.com/nikunjmavani/core-be/issues/650)) ([aeb32e7](https://github.com/nikunjmavani/core-be/commit/aeb32e7c60d4686f71b2f14f46efe873404652c3))
* **config:** require legacy JWT gate closed once keyring configured in prod (audit-[#15](https://github.com/nikunjmavani/core-be/issues/15)b) ([43e5139](https://github.com/nikunjmavani/core-be/commit/43e5139de2e4b9f7e969b9832e8ffac1a0c32b89))
* **database:** keyset-page batch delete so FK-blocked rows can't infinite-loop retention ([fd9b523](https://github.com/nikunjmavani/core-be/commit/fd9b523ecaf1825d111a636d6cad954ecba6e83a))
* **database:** keyset-page batch delete so FK-blocked rows can't infinite-loop retention (route-audit A1) ([f81ca72](https://github.com/nikunjmavani/core-be/commit/f81ca724b6e5d25c158e02403ee39d7132c8c8f2))
* **database:** sec-new-Q4 apply worker statement timeout in system-table retention context ([#487](https://github.com/nikunjmavani/core-be/issues/487)) ([4e0b5c2](https://github.com/nikunjmavani/core-be/commit/4e0b5c2156544d72b9dbf51b4a3c07b77930492a))
* **db:** enforce RLS deny-all on billing.plans and tenancy.permissions (reaudit-[#9](https://github.com/nikunjmavani/core-be/issues/9)) ([2bb9476](https://github.com/nikunjmavani/core-be/commit/2bb947621fafabfd2ec03ca2d2fc9f905970c838))
* **deps:** bump esbuild override to &gt;=0.28.1 (GHSA-gv7w-rqvm-qjhr / GHSA-g7r4-m6w7-qqqr) ([514fa96](https://github.com/nikunjmavani/core-be/commit/514fa961bd392ef4583c7e148a7f47277ef23dae))
* **deps:** override @grpc/grpc-js to &gt;=1.14.4 (GHSA-5375-pq7m-f5r2) ([0a66557](https://github.com/nikunjmavani/core-be/commit/0a6655731c02a3efa03ca598c306fce4d34012c7))
* **docker:** add HEALTHCHECK to worker image (audit-[#15](https://github.com/nikunjmavani/core-be/issues/15)c) ([b4f7a67](https://github.com/nikunjmavani/core-be/commit/b4f7a67cc2072c9510f63906b2b1ec50ae114f92))
* **docker:** refresh apk index so base-image security patches install ([#607](https://github.com/nikunjmavani/core-be/issues/607)) ([a3690b9](https://github.com/nikunjmavani/core-be/commit/a3690b91f2f61f48f837553c74890e5d358fbec3))
* **docker:** worker HEALTHCHECK honors WORKER_HEALTH_PORT at runtime (reaudit-[#8](https://github.com/nikunjmavani/core-be/issues/8)) ([3530bff](https://github.com/nikunjmavani/core-be/commit/3530bff1c5cb6a65e21cc0f507018211150236a3))
* **email-templates:** escape URL fields in invitation and magic-link templates ([#364](https://github.com/nikunjmavani/core-be/issues/364)) ([26c67fa](https://github.com/nikunjmavani/core-be/commit/26c67fac20bff7ccf765c6d93a6264e35ebee079))
* **events:** capture swallowed event-bus errors in Sentry ([2a30d84](https://github.com/nikunjmavani/core-be/commit/2a30d845482dadbe97dd922a4bc54e974105655a))
* **events:** release commit-dispatch marker on rollback (in-memory leak) ([#324](https://github.com/nikunjmavani/core-be/issues/324)) ([7e3ec55](https://github.com/nikunjmavani/core-be/commit/7e3ec559455954d9aeb489e69c4bf416801d76d3))
* **finding-13:** escape title/preheader/footerText inside baseTemplate ([8996b26](https://github.com/nikunjmavani/core-be/commit/8996b2616b52de6f55b0b16315c4a439034e3fba))
* **finding-46:** validate DATABASE_HTTP_STATEMENT_TIMEOUT_MS stays within permission cache lock TTL ([#356](https://github.com/nikunjmavani/core-be/issues/356)) ([47bdab4](https://github.com/nikunjmavani/core-be/commit/47bdab435f83a307cc04f4dc8274f5407aeb8ad3))
* **finding-62:** export WEBHOOK_DELIVERY_JOB_ATTEMPTS and fix vi.mock factories ([#357](https://github.com/nikunjmavani/core-be/issues/357)) ([cd24515](https://github.com/nikunjmavani/core-be/commit/cd24515fa2acf75774da7d636ea42bc0212ec3a2))
* **finding-74:** replace unsafe Stripe object casts with proper type narrowing ([#359](https://github.com/nikunjmavani/core-be/issues/359)) ([f8f9cfe](https://github.com/nikunjmavani/core-be/commit/f8f9cfe8ae24f51ff34c92100dd31b2d1f7745fe))
* **infra:** throw on startup when monolithic worker pool demand exceeds DATABASE_POOL_MAX ([faf2fab](https://github.com/nikunjmavani/core-be/commit/faf2fab638f0b77d1ea82dd856d3cefefa893711))
* **infra:** use correct JWT env keys in docker-compose smoke profile (sec-r4-C5) ([#512](https://github.com/nikunjmavani/core-be/issues/512)) ([c9a48f1](https://github.com/nikunjmavani/core-be/commit/c9a48f107f0f89fe41814c253e4d3defc0595437))
* **lockfile:** regenerate pnpm-lock.yaml (merge produced duplicate mapping key) ([c2eba7e](https://github.com/nikunjmavani/core-be/commit/c2eba7eb879f20ee0b5ff182c5edf1ca64715308))
* **mail:** scrub secret-bearing body on terminally-failed outbox rows (audit-[#10](https://github.com/nikunjmavani/core-be/issues/10)) ([61dc948](https://github.com/nikunjmavani/core-be/commit/61dc948505b0eb6e4e7c60020d66a7c3663452bb))
* **mcp:** apply STRICT_AUTHED_RATE_LIMIT to MCP endpoint (audit finding [#7](https://github.com/nikunjmavani/core-be/issues/7)) ([#366](https://github.com/nikunjmavani/core-be/issues/366)) ([6783141](https://github.com/nikunjmavani/core-be/commit/6783141ed14cc7009e1ec2be258386fac1706ed3))
* **mcp:** strip X-Organization-Id from call_api proxied sub-requests (route-[#8](https://github.com/nikunjmavani/core-be/issues/8)) ([d5a7167](https://github.com/nikunjmavani/core-be/commit/d5a716716e8acff86e1523641e3f44620374411c))
* **migration:** make audit_logs_actor_api_key FK idempotent (unblock dev deploy) ([#385](https://github.com/nikunjmavani/core-be/issues/385)) ([b8cc4fb](https://github.com/nikunjmavani/core-be/commit/b8cc4fb70d3d3d13f31f4b67af35772ff5afdb7e))
* **migration:** make core_be_app least-privilege ALTER ROLE Neon-safe (unblocks all deploys) ([#341](https://github.com/nikunjmavani/core-be/issues/341)) ([488c793](https://github.com/nikunjmavani/core-be/commit/488c793ee93173a2b7d1cedb32879743c3136533))
* **notify:** cap webhook response body bytes read before truncation (audit-[#6](https://github.com/nikunjmavani/core-be/issues/6)) ([0f2421e](https://github.com/nikunjmavani/core-be/commit/0f2421e3b6b211f888f08a0161274063d7599cc1))
* **notify:** durability-first notification email dedup to stop lost emails (audit-[#7](https://github.com/nikunjmavani/core-be/issues/7)) ([b9d9759](https://github.com/nikunjmavani/core-be/commit/b9d9759885b92320210d681520ecc16236d70d2c))
* **notify:** durable mail-outbox dedupe key to close concurrent duplicate-email window (reaudit-[#4](https://github.com/nikunjmavani/core-be/issues/4)) ([47cd280](https://github.com/nikunjmavani/core-be/commit/47cd280504c9acdf324b2ff11ff4ca36ded05a1c))
* **notify:** enforce webhook secret-rotation eligibility in the update predicate (audit-[#9](https://github.com/nikunjmavani/core-be/issues/9)) ([d3337e0](https://github.com/nikunjmavani/core-be/commit/d3337e0c3ad3e314206cce494c23e6b644c90d03))
* **notify:** guard webhook secret re-rotation within the dual-sign overlap window ([0cfedd0](https://github.com/nikunjmavani/core-be/commit/0cfedd0d28177f40f354133a3d1f53b94002e955))
* **notify:** guard webhook secret re-rotation within the dual-sign overlap window (route-audit webhook-[#1](https://github.com/nikunjmavani/core-be/issues/1)) ([5c16f85](https://github.com/nikunjmavani/core-be/commit/5c16f8548c7c528944d937c60fe985ee887e8174))
* **notify:** route webhook handlers through zodApplication type provider ([eaa5684](https://github.com/nikunjmavani/core-be/commit/eaa5684c13253e6f5c7204a7dc8b479e4c9c5465))
* **notify:** sec-new-B2 replace bigserial with public_id in X-Webhook-Delivery-Id header ([#494](https://github.com/nikunjmavani/core-be/issues/494)) ([771954a](https://github.com/nikunjmavani/core-be/commit/771954a360383fcb797e38a6ea55b07d2055790c))
* **notify:** sec-new-D4 add status=PENDING filter to fallback SELECT in webhook delivery ([#488](https://github.com/nikunjmavani/core-be/issues/488)) ([164c6f8](https://github.com/nikunjmavani/core-be/commit/164c6f8a0bebbc89f0bb47d0b432e0db0bf453d7))
* **notify:** sec-new-N1 validate webhookId path param in all webhook handlers ([#482](https://github.com/nikunjmavani/core-be/issues/482)) ([d66099e](https://github.com/nikunjmavani/core-be/commit/d66099e00764f935260de97560e60529d61d5e53))
* **notify:** stamp webhook updated_at as greatest(created_at, now()) to fix chk_webhooks_updated flake ([988d87b](https://github.com/nikunjmavani/core-be/commit/988d87baf86a74ebb05ba9d81948e205ffcda2e3))
* **notify:** trim payload and response_body from webhook delivery list (sec-r4-D6) ([#518](https://github.com/nikunjmavani/core-be/issues/518)) ([89c24b7](https://github.com/nikunjmavani/core-be/commit/89c24b7f05dba72eba97447f746abb08130c61f6))
* **observability:** monitor every retention worker DLQ + add drift guard (reaudit-[#5](https://github.com/nikunjmavani/core-be/issues/5)) ([0e954dc](https://github.com/nikunjmavani/core-be/commit/0e954dcfe96a4c2d46c48815e963632468243236))
* **openapi:** registry-authoritative success statuses; deterministic OAuth coverage; scan cleanups ([a7cc7bd](https://github.com/nikunjmavani/core-be/commit/a7cc7bdeb47f4d9d5f5a18465470d8a9b2b86c67))
* **openapi:** registry-authoritative success statuses; deterministic OAuth coverage; scan cleanups ([1f84793](https://github.com/nikunjmavani/core-be/commit/1f84793ff6f149d7a759ac0223fb45a5d28d1942))
* **ops:** log circuit-breaker resets for attribution (route-[#5](https://github.com/nikunjmavani/core-be/issues/5)) ([eae48fe](https://github.com/nikunjmavani/core-be/commit/eae48fe4e9c937f7ca65d219acacb55832a1b218))
* **queue:** acknowledge commit-dispatch tasks after execution, not before (reaudit-[#2](https://github.com/nikunjmavani/core-be/issues/2)) ([8f399c0](https://github.com/nikunjmavani/core-be/commit/8f399c0ddaed24901f6c92445091770286c7a852))
* **queue:** bound audit.dead_letter_jobs growth via the audit-retention purge ([#322](https://github.com/nikunjmavani/core-be/issues/322)) ([06e729d](https://github.com/nikunjmavani/core-be/commit/06e729ddba34ce6d47ac3f2f7d73ad54910800a2))
* **queue:** bound commandTimeout on BullMQ producer connections (audit-[#5](https://github.com/nikunjmavani/core-be/issues/5)) ([2c4e21b](https://github.com/nikunjmavani/core-be/commit/2c4e21bf12dedc6039a0f0085379e80e8a83fee2))
* **queue:** monitor the offboarding-reconciler DLQ + exempt it from tenant-scoping policy (audit-[#15](https://github.com/nikunjmavani/core-be/issues/15)) ([f5f4ceb](https://github.com/nikunjmavani/core-be/commit/f5f4cebfbf7cc99072c06c0b7588d7c3eb4289fc))
* **queue:** sec-new-Q1 add env overrides for hardcoded cron schedules ([#484](https://github.com/nikunjmavani/core-be/issues/484)) ([d2d03e1](https://github.com/nikunjmavani/core-be/commit/d2d03e1c6a41861a22965a0c57707b8157ce66da))
* **queue:** sec-new-Q2 capture per-task failures in Sentry in recovery processor ([#485](https://github.com/nikunjmavani/core-be/issues/485)) ([b66a7a6](https://github.com/nikunjmavani/core-be/commit/b66a7a68ed27dc357b83b010e4778991fb198242))
* **queue:** stop DLQ auto-retry starvation via a resolved marker on exhausted rows ([#330](https://github.com/nikunjmavani/core-be/issues/330)) ([86c3817](https://github.com/nikunjmavani/core-be/commit/86c381769b50262e30687506b0c9ebeec9a739d9))
* **rate-limit,observability:** scope org rate-limit + error context by the org claim ([5e12926](https://github.com/nikunjmavani/core-be/commit/5e12926e869e17a3bd66e71a3d7ec87b98119132))
* **rate-limit,observability:** scope org rate-limit + error context by the org token claim ([b2caeb1](https://github.com/nikunjmavani/core-be/commit/b2caeb1be96e8fde9631028c4b92e047b14d433d))
* **rls:** pin core_be_app to NOSUPERUSER/NOBYPASSRLS + assert RLS-binding ([#334](https://github.com/nikunjmavani/core-be/issues/334)) ([18f8b9a](https://github.com/nikunjmavani/core-be/commit/18f8b9aa6f0ae44d45208dabf270a6c5a52c60ec))
* route-audit state-machine, billing, and cache-header findings ([d4b34ef](https://github.com/nikunjmavani/core-be/commit/d4b34ef388184860aece138aa10716b226562158))
* route-focused security audit findings ([1fffbf0](https://github.com/nikunjmavani/core-be/commit/1fffbf0270b20b7fdbeef5d0f3d86528e4fb11a5))
* **runtime:** real-world deep-flow inspection findings — 3 fixes + regression test ([#533](https://github.com/nikunjmavani/core-be/issues/533)) ([5a85ecd](https://github.com/nikunjmavani/core-be/commit/5a85ecd7d19303cb45231ec2d73082dfd6d4e631))
* **sec:** account-deletion safety — invalidate verification tokens + revoke-before-purge (sec-U1+U8) ([#404](https://github.com/nikunjmavani/core-be/issues/404)) ([43a1e5a](https://github.com/nikunjmavani/core-be/commit/43a1e5aedc49cd19f2e082febeb9b247a6bea3cf))
* **sec:** add captchaPreHandler to POST /mfa/login (sec-new-A1) ([85d2a89](https://github.com/nikunjmavani/core-be/commit/85d2a892decb1cf9e882922188633de6ffdea5c0))
* **sec:** add captchaPreHandler to POST /mfa/login (sec-new-A1) ([f2c02db](https://github.com/nikunjmavani/core-be/commit/f2c02db0212721ec29b99633f455f36f8e9f23c9))
* **sec:** add closeUserDataExportQueue to worker shutdown sequence (sec-r4-R1) ([#501](https://github.com/nikunjmavani/core-be/issues/501)) ([6e8e96f](https://github.com/nikunjmavani/core-be/commit/6e8e96ff11af4819d22cfb34df5b27f125518cbd))
* **sec:** add deleted_at guards to org-discovery RLS and invitation lookup (sec-r4-T1/T2) ([#500](https://github.com/nikunjmavani/core-be/issues/500)) ([b4ea6ee](https://github.com/nikunjmavani/core-be/commit/b4ea6ee0969cd5ff8da76b7abb68823e711d5939))
* **sec:** add partial index for audit.logs.actor_api_key_id (sec-D8) ([#432](https://github.com/nikunjmavani/core-be/issues/432)) ([761f28b](https://github.com/nikunjmavani/core-be/commit/761f28b96207265002e24ad2f263da00ff97eb99))
* **sec:** audit append-only DB invariant — split tenant-isolation policy + REVOKE UPDATE (sec-U3) ([#409](https://github.com/nikunjmavani/core-be/issues/409)) ([7991dfc](https://github.com/nikunjmavani/core-be/commit/7991dfc486ed22eff946b346982285c1f87fee65))
* **sec:** audit every data-export URL mint, rate-limit GET, drop TTL 24h→15min (sec-U6) ([#429](https://github.com/nikunjmavani/core-be/issues/429)) ([4943057](https://github.com/nikunjmavani/core-be/commit/4943057037519b0c294e4e46405d202008083973))
* **sec:** audit every login surface, not just password (sec-A8) ([#427](https://github.com/nikunjmavani/core-be/issues/427)) ([9872491](https://github.com/nikunjmavani/core-be/commit/9872491ad9ee8271d3a063738dd3b1423013095c))
* **sec:** audit hygiene — denylist metadata strip + admin user-mgmt audit + admin audit-read audit + permission-deny audit (sec-U2+U9+U4+U13) ([#408](https://github.com/nikunjmavani/core-be/issues/408)) ([98e60ff](https://github.com/nikunjmavani/core-be/commit/98e60ff889e7c94d716aaf235c0b782d05bd4a8f))
* **sec:** audit login failures alongside successes on every login surface (sec-A8 follow-up) ([#438](https://github.com/nikunjmavani/core-be/issues/438)) ([e4a9c2f](https://github.com/nikunjmavani/core-be/commit/e4a9c2f88925653cf12910efbb6258ba2c7c1d73))
* **sec:** audit serializer is strip-only with resolved public ids (sec-re-08) ([#458](https://github.com/nikunjmavani/core-be/issues/458)) ([5a07fdb](https://github.com/nikunjmavani/core-be/commit/5a07fdb15f4706478587523c96f090a92a8a3ce1))
* **sec:** auth defense in depth — last login-method guard + super-admin rederive + step-up on session revoke (sec-A5+A6+A7) ([#407](https://github.com/nikunjmavani/core-be/issues/407)) ([021c4b3](https://github.com/nikunjmavani/core-be/commit/021c4b31ce8d3c619f48ebcf43e4393ad2cf9b3d))
* **sec:** bind audit-list pagination cursor to its minting filter set (sec-U12) ([#434](https://github.com/nikunjmavani/core-be/issues/434)) ([f6a40e2](https://github.com/nikunjmavani/core-be/commit/f6a40e2db1fc34916c236f5fc3a478d5d09020df))
* **sec:** block update() on org-owner membership to prevent Admin lockout (sec-new-T1) ([dfa526a](https://github.com/nikunjmavani/core-be/commit/dfa526a03dafa3ddae99029e34651aeffa979d51))
* **sec:** block update() on org-owner membership to prevent Admin lockout (sec-new-T1) ([c3c6cfe](https://github.com/nikunjmavani/core-be/commit/c3c6cfe24145ab0cc3e63fe8a8d3d1a20d5a7642))
* **sec:** breach compression-skip actually engages in production (sec-re-03) ([#454](https://github.com/nikunjmavani/core-be/issues/454)) ([5039ccd](https://github.com/nikunjmavani/core-be/commit/5039ccd0699dac287c89a94b85e9c6a4f630c25e))
* **sec:** build Stripe customer email from a platform-owned domain, not tenant slug (sec-B11) ([#436](https://github.com/nikunjmavani/core-be/issues/436)) ([8bb5338](https://github.com/nikunjmavani/core-be/commit/8bb533845fcf074150dc3796e2038dcab01df372))
* **sec:** cache the i18n preHandler organization → locale lookup (sec-M1) ([#440](https://github.com/nikunjmavani/core-be/issues/440)) ([180937a](https://github.com/nikunjmavani/core-be/commit/180937a42a83ec058d0e66823c534db54270cf73))
* **sec:** collapse unmatched-route Prometheus label into __unmatched__ sentinel (sec-C2) ([#401](https://github.com/nikunjmavani/core-be/issues/401)) ([5fc8743](https://github.com/nikunjmavani/core-be/commit/5fc87432500a76271dc867df7b68851e5e68ed74))
* **sec:** config + middleware hardening (sec-cm batch) ([#449](https://github.com/nikunjmavani/core-be/issues/449)) ([b150253](https://github.com/nikunjmavani/core-be/commit/b15025363ad4af584a93572f1a0afb5dc76f1e4f))
* **sec:** config cleanup — drop JWT_SECRET + add deps:audit:prod to ci:local + ENABLE_RESPONSE_ENCRYPTION pairing refine (sec-C5+C10+C11) ([#419](https://github.com/nikunjmavani/core-be/issues/419)) ([7cab170](https://github.com/nikunjmavani/core-be/commit/7cab17038463c7a568e36c48f4c10acc0e6235f3))
* **sec:** cors exposes x-client-request-id (sec-re-17) ([#467](https://github.com/nikunjmavani/core-be/issues/467)) ([8960cfc](https://github.com/nikunjmavani/core-be/commit/8960cfcc13b33e6abb222631ff5de62f3b1d9a7b))
* **sec:** data-export request route advertises 15-minute URL lifetime (sec-re-12) ([#462](https://github.com/nikunjmavani/core-be/issues/462)) ([bc7cea3](https://github.com/nikunjmavani/core-be/commit/bc7cea3c096583e338e25edca4d58d59616718c4))
* **sec:** db retention growth — verification token sweep + AUDIT_RETENTION_DAYS cap (sec-D5+U10) ([#415](https://github.com/nikunjmavani/core-be/issues/415)) ([ab9428b](https://github.com/nikunjmavani/core-be/commit/ab9428b5a5cd93a24ce283f8598dd318e0e0ef03))
* **sec:** db stability — drop volatile chk_org_notif_muted + worker statement_timeout + audit.logs target_user_id index (sec-D1+D2+D3) ([#414](https://github.com/nikunjmavani/core-be/issues/414)) ([f77ce4a](https://github.com/nikunjmavani/core-be/commit/f77ce4aee1366eaa1ff82da6575b5011dd382ca5))
* **sec:** delete dead findActiveByUserId / findActiveByOrganizationId (sec-D12) ([#437](https://github.com/nikunjmavani/core-be/issues/437)) ([6367dd4](https://github.com/nikunjmavani/core-be/commit/6367dd45ca44614f1e0a2d10fd2dfdf0df9f390e))
* **sec:** derive invitation email from membership user on create (sec-T1 complete) ([#471](https://github.com/nikunjmavani/core-be/issues/471)) ([6d54c99](https://github.com/nikunjmavani/core-be/commit/6d54c99a15cd6c1dc48ec3b1c6357c540db4bf29))
* **sec:** dlq replay no-op + commit-dispatch cleanup + worker hardening (sec-q batch) ([#444](https://github.com/nikunjmavani/core-be/issues/444)) ([6c96a0b](https://github.com/nikunjmavani/core-be/commit/6c96a0bb1c47d016d87735cbe16ee173e7de19c4))
* **sec:** do not clear session cookie in revokeAllSessions handler (sec-r4-A1) ([#499](https://github.com/nikunjmavani/core-be/issues/499)) ([b7e3952](https://github.com/nikunjmavani/core-be/commit/b7e395262f8ec06a84a5426b9c4a9dafa85ec351))
* **sec:** docker.agent USER node + drop openssh + enforce abort timeout on retrieveStripeEvent (sec-C8 + sec-Q5 partial) ([#422](https://github.com/nikunjmavani/core-be/issues/422)) ([d10af52](https://github.com/nikunjmavani/core-be/commit/d10af524ec39a00994b041f7727d18cc6e81639b))
* **sec:** document the online-safe ALTER COLUMN pattern (sec-D6) ([#443](https://github.com/nikunjmavani/core-be/issues/443)) ([c72deb4](https://github.com/nikunjmavani/core-be/commit/c72deb4e3f9b7cdaba267b14948fd73025dce3e3))
* **sec:** document verification_tokens application-trust safety model (sec-D9) ([#441](https://github.com/nikunjmavani/core-be/issues/441)) ([e069891](https://github.com/nikunjmavani/core-be/commit/e069891909cd0487a4cd5ab523930f8b0d6e105d))
* **sec:** drop org branch from user_notification_preferences RLS + add CHECK pin (sec-U7) ([#428](https://github.com/nikunjmavani/core-be/issues/428)) ([13fc188](https://github.com/nikunjmavani/core-be/commit/13fc188e22603b55f3226994399e5564e50f5843))
* **sec:** enforce SSE-S3 on every server-side S3 write (sec-U11) ([#435](https://github.com/nikunjmavani/core-be/issues/435)) ([0792d76](https://github.com/nikunjmavani/core-be/commit/0792d76c07ece878f8adc1f282f1966efbe54ae7))
* **sec:** expose policy public_id instead of bigserial in URLs and responses (sec-T5) ([#442](https://github.com/nikunjmavani/core-be/issues/442)) ([88d5db7](https://github.com/nikunjmavani/core-be/commit/88d5db72bc21184da5ea00ec0baaa0256d0f03a9))
* **sec:** extend staging guards to ALLOWED_ORIGINS, COOKIE_SECURE, and SECRETS_ENCRYPTION_KEY (sec-r4-C1/C2/C3) ([#498](https://github.com/nikunjmavani/core-be/issues/498)) ([0efd169](https://github.com/nikunjmavani/core-be/commit/0efd169841cea7cfba5197012dfb6e3f615fe629))
* **sec:** fall back to INSERT when subscription.created arrives before local row (sec-B9) ([#439](https://github.com/nikunjmavani/core-be/issues/439)) ([fd68e66](https://github.com/nikunjmavani/core-be/commit/fd68e660e7d19d1707b0bfe97ac4fe29d08ab427))
* **sec:** harden invitation binding, webhook retry, role invariants, and upload key contract ([#470](https://github.com/nikunjmavani/core-be/issues/470)) ([65cdf2f](https://github.com/nikunjmavani/core-be/commit/65cdf2f9179ac01aa1110f95b60cb6a7fd1519db))
* **sec:** invitation accept requires auth + invitee email match (sec-T4) ([#423](https://github.com/nikunjmavani/core-be/issues/423)) ([7cdc3f8](https://github.com/nikunjmavani/core-be/commit/7cdc3f83beafaa9e682bf39348cb1caa4047c2fb))
* **sec:** mark-confirmed-by-internal-id filters deleted_at and pending (sec-re-13) ([#463](https://github.com/nikunjmavani/core-be/issues/463)) ([dbd9156](https://github.com/nikunjmavani/core-be/commit/dbd9156fd40ff4e2e92ab6ace5823b2e60279e60))
* **sec:** mfa hardening — step-up requires mfa + per-session binding + org-policy delete guard (sec-A1+A2+A4) ([#403](https://github.com/nikunjmavani/core-be/issues/403)) ([1ba5047](https://github.com/nikunjmavani/core-be/commit/1ba504726442aaaea626d2b73f542c55b8214d0a))
* **sec:** mfa is_mfa_enabled flip happens inside the enrollConfirm transaction (sec-re-06) ([#469](https://github.com/nikunjmavani/core-be/issues/469)) ([675c1f2](https://github.com/nikunjmavani/core-be/commit/675c1f257bb02ecf3967a3295ff1f6d1068da136))
* **sec:** mfa re-enroll dedups stale totp factors (sec-re-04) ([#455](https://github.com/nikunjmavani/core-be/issues/455)) ([f7a66ab](https://github.com/nikunjmavani/core-be/commit/f7a66abb8218a13bbf92472ba3fc0c3e26ab6f3e))
* **sec:** middleware observability — captcha bypass closed in staging + HSTS env gate + ALLOWED_ORIGINS canonicalization + encryption 503 (sec-M3+M5+M8+M9) ([#417](https://github.com/nikunjmavani/core-be/issues/417)) ([57abed9](https://github.com/nikunjmavani/core-be/commit/57abed9c55fa7fc50c72b1161e8270b5a64b024f))
* **sec:** notification worker user context + db integrity indexes (sec-d batch) ([#450](https://github.com/nikunjmavani/core-be/issues/450)) ([a1a8fe5](https://github.com/nikunjmavani/core-be/commit/a1a8fe5c15fd5b3c4b8437413ef40e5b4efeb821))
* **sec:** notification worker user-context fix is live wiring (sec-re-01) ([#452](https://github.com/nikunjmavani/core-be/issues/452)) ([653adf5](https://github.com/nikunjmavani/core-be/commit/653adf5653b634dcf907927ad4f6a660256f8a79))
* **sec:** notify abuse caps — per-organization webhook cap + secret-rotation overlap window (sec-N4+N8) ([#411](https://github.com/nikunjmavani/core-be/issues/411)) ([a7455f5](https://github.com/nikunjmavani/core-be/commit/a7455f5548d20fe8460b92154e17b2ca75eda24a))
* **sec:** notify durability — worker re-checks disabled/deleted + delivery-id header + event_key dedupe (sec-N1+N3+N2) ([#410](https://github.com/nikunjmavani/core-be/issues/410)) ([c09ae6c](https://github.com/nikunjmavani/core-be/commit/c09ae6c7acad9de05fe7c28f365ba9af84795c16))
* **sec:** notify recipient + idempotency canonical fingerprint + tenant authorized-org helper (sec-N7+M6+M7) ([#420](https://github.com/nikunjmavani/core-be/issues/420)) ([17a8bbd](https://github.com/nikunjmavani/core-be/commit/17a8bbdc9d364eb9b5bfa5f71d0ffbe86e30645e))
* **sec:** org-scoped audit log sanitiser + strip-only serializers (sec-t batch) ([#448](https://github.com/nikunjmavani/core-be/issues/448)) ([6019182](https://github.com/nikunjmavani/core-be/commit/6019182b695080795d232d7afe04b96659ff34d2))
* **sec:** protect owner role from permission writes via ROLE_MANAGE (sec-T2) ([#402](https://github.com/nikunjmavani/core-be/issues/402)) ([6b11b6e](https://github.com/nikunjmavani/core-be/commit/6b11b6e6da7e825d48d7348b50576861a5fc4cbc))
* **sec:** queue infrastructure — defaultJobOptions on cron queues + flip topology warn + fail boot on scheduler drift in prod (sec-Q1+Q2+Q3) ([#416](https://github.com/nikunjmavani/core-be/issues/416)) ([32b960e](https://github.com/nikunjmavani/core-be/commit/32b960e03cc6a164d137dc080f583846b93635a9))
* **sec:** rate-limit per-email bucket id is hashed (sec-re-11) ([#461](https://github.com/nikunjmavani/core-be/issues/461)) ([4239be4](https://github.com/nikunjmavani/core-be/commit/4239be4ddb5d3432295565b4bb8e110612e97012))
* **sec:** recovery-code alphabet doc reflects 31 symbols and case-insensitive hash (sec-re-14) ([#464](https://github.com/nikunjmavani/core-be/issues/464)) ([1bc8b00](https://github.com/nikunjmavani/core-be/commit/1bc8b001519154b9e5da12abf4a4d808b12cd9d8))
* **sec:** refresh stale ordering comments around the no-op RLS-transaction plugin (sec-M4) ([#433](https://github.com/nikunjmavani/core-be/issues/433)) ([1bd211e](https://github.com/nikunjmavani/core-be/commit/1bd211e288ac062486e9374667e1619401e4f666))
* **sec:** refresh-token reuse detection fires for revoked sessions (sec-re-05) ([#456](https://github.com/nikunjmavani/core-be/issues/456)) ([bf5ee5e](https://github.com/nikunjmavani/core-be/commit/bf5ee5e30c0233d13a0f28d0b9b2afff4df0da4c))
* **sec:** remove privilege-bypass arms from audit.logs INSERT RLS (sec-r4-D1) ([#497](https://github.com/nikunjmavani/core-be/issues/497)) ([787b3c8](https://github.com/nikunjmavani/core-be/commit/787b3c8d20ebb37f97ef9cd2d27aa66f992df7c3))
* **sec:** replace z.coerce.boolean() foot-gun on env booleans (sec-C1) ([#400](https://github.com/nikunjmavani/core-be/issues/400)) ([f8a49c3](https://github.com/nikunjmavani/core-be/commit/f8a49c367e9bbc5cdc7e54e9d9c988e4dbe13bca))
* **sec:** repository hygiene — atomic markAllRead count + WebAuthn counter monotonicity guard (sec-D10/D11) ([#426](https://github.com/nikunjmavani/core-be/issues/426)) ([1d817db](https://github.com/nikunjmavani/core-be/commit/1d817db6ded2820f9334b31d05ca4e4b23ae30b2))
* **sec:** require caller can grant target role permissions on membership create (sec-T1) ([#399](https://github.com/nikunjmavani/core-be/issues/399)) ([899aab3](https://github.com/nikunjmavani/core-be/commit/899aab3abcf9de727a8b0e7fe3ecdcb7ad14d654))
* **sec:** require caller to hold every code added or removed on role-permission PUT (sec-T2) ([#425](https://github.com/nikunjmavani/core-be/issues/425)) ([b9b545e](https://github.com/nikunjmavani/core-be/commit/b9b545ee4de3c1b36bd05a8d80e8ebce8f497565))
* **sec:** require live-mode + both-or-neither Stripe keys in production (sec-B5/B6) ([#424](https://github.com/nikunjmavani/core-be/issues/424)) ([2ca7f2c](https://github.com/nikunjmavani/core-be/commit/2ca7f2cdb4e411275f465164b91ae2099f98a395))
* **sec:** role-delete guards + strip is_system from createMemberRoleDto (sec-T3) ([#406](https://github.com/nikunjmavani/core-be/issues/406)) ([1b41ab9](https://github.com/nikunjmavani/core-be/commit/1b41ab98cfaedfb11a7f5f3c87c26106e8bc2373))
* **sec:** sentry/log redaction + observability — OTLP https refine + readyz verbose env gate + Sentry message/exception/user redaction + LOG_LEVEL enum (sec-C3+C4+C6+C9) ([#418](https://github.com/nikunjmavani/core-be/issues/418)) ([b0337ce](https://github.com/nikunjmavani/core-be/commit/b0337ce2ad6f21ac16b0c97fccda158e7c64dd55))
* **sec:** stripe event retrieve honours per-attempt timeout for real (sec-re-15) ([#465](https://github.com/nikunjmavani/core-be/issues/465)) ([d5640da](https://github.com/nikunjmavani/core-be/commit/d5640daf8c1bacf06e9ca92894ac4d97a9945fe3))
* **sec:** stripe ingress durability + ordering + raw-body wiring (sec-b batch) ([#446](https://github.com/nikunjmavani/core-be/issues/446)) ([8a88beb](https://github.com/nikunjmavani/core-be/commit/8a88beb6cd7ea43f4cf42d034f2a37ba6a241d9e))
* **sec:** stripe reclaim cron→worker handoff is recoverable (sec-re-02) ([#453](https://github.com/nikunjmavani/core-be/issues/453)) ([3cdce4f](https://github.com/nikunjmavani/core-be/commit/3cdce4fcaabf0b6895b73c4feb412f0edd451080))
* **sec:** stripe reconciliation — close 4 silent-divergence paths (sec-B1+B2+B3+B4) ([#405](https://github.com/nikunjmavani/core-be/issues/405)) ([87ab3fb](https://github.com/nikunjmavani/core-be/commit/87ab3fb998f712f5a1b033708c1d65b9ba4c8b82))
* **sec:** subscription response surfaces plan public id (sec-re-07) ([#457](https://github.com/nikunjmavani/core-be/issues/457)) ([537325c](https://github.com/nikunjmavani/core-be/commit/537325c9f8f71a7e7452db8126bcb5517c8b2b1b))
* **sec:** sync local plan_id from Stripe customer.subscription.updated (sec-B7) ([#430](https://github.com/nikunjmavani/core-be/issues/430)) ([bc5a21a](https://github.com/nikunjmavani/core-be/commit/bc5a21ae87d6c253ad7094e752859fe254492d0e))
* **sec:** tenant context lifts the worker statement_timeout (sec-re-16) ([#466](https://github.com/nikunjmavani/core-be/issues/466)) ([415a58e](https://github.com/nikunjmavani/core-be/commit/415a58eb3a4c8c2334d8bcd5649f1348fdf9f455))
* **sec:** tombstoneAllByOrganizationId removes S3 objects synchronously (sec-UP8) ([#421](https://github.com/nikunjmavani/core-be/issues/421)) ([186bd71](https://github.com/nikunjmavani/core-be/commit/186bd711303862d3386cc6f7391ef0dd73928613))
* **sec:** two-phase mfa enrollment + refresh reuse-detection + login uniformity (sec-a batch) ([#445](https://github.com/nikunjmavani/core-be/issues/445)) ([d1e1e59](https://github.com/nikunjmavani/core-be/commit/d1e1e593bcf31c515f22fb1e2c4d07a89c76e81c))
* **sec:** upload confirm pins copy to verified etag (sec-re-10) ([#460](https://github.com/nikunjmavani/core-be/issues/460)) ([2eb3d11](https://github.com/nikunjmavani/core-be/commit/2eb3d11ca070c52c0e4fcf2cc5c5c0c391573837))
* **sec:** upload security — refuse legacy in-place + sweep refuses SVG + assertKeyConfirmedForOwner + DOMPurify hardening (sec-UP1+UP2+UP5+UP6) ([#412](https://github.com/nikunjmavani/core-be/issues/412)) ([76e80ad](https://github.com/nikunjmavani/core-be/commit/76e80ad3617b7d87f57fc292c6e41efba7f89d89))
* **sec:** upload size/policy — organizationId regex + org pending cap + force presigned POST in prod (sec-UP3+UP4+UP10) ([#413](https://github.com/nikunjmavani/core-be/issues/413)) ([237d517](https://github.com/nikunjmavani/core-be/commit/237d517905e321c9c73c1e9cc8f9fa181a73a597))
* **security:** add maxItems array bounds and fix WebAuthn type casts ([#363](https://github.com/nikunjmavani/core-be/issues/363)) ([ab4e7c7](https://github.com/nikunjmavani/core-be/commit/ab4e7c7c6fb65f374c458b18ef7b8b5927b0e77d))
* **security:** fail closed on privileged re-derivation + bound all retention settings (audit-[#16](https://github.com/nikunjmavani/core-be/issues/16), [#14](https://github.com/nikunjmavani/core-be/issues/14)) ([65a4347](https://github.com/nikunjmavani/core-be/commit/65a4347972c7d029600559f69a080fc611bc555d))
* **security:** mark recovery-codes + presigned-URL responses no-store / non-cacheable (route-audit-[#3](https://github.com/nikunjmavani/core-be/issues/3)) ([bc67eed](https://github.com/nikunjmavani/core-be/commit/bc67eed1cc521709b36e4eca38289310276ff922))
* **security:** reject JWT tokens with unknown kid when keyring is active ([#347](https://github.com/nikunjmavani/core-be/issues/347)) ([2bedfa1](https://github.com/nikunjmavani/core-be/commit/2bedfa1fc7bfe30ebe07e3529cfe8b7c8c78a15d))
* **security:** remediate all 16 findings from the 2026-06-14 dev security audit ([01a22aa](https://github.com/nikunjmavani/core-be/commit/01a22aa5f83fbd1f784039a98b5ac4eda151efdb))
* **security:** remediate all 16 findings from the 2026-06-14 dev security audit ([#600](https://github.com/nikunjmavani/core-be/issues/600)) ([01a22aa](https://github.com/nikunjmavani/core-be/commit/01a22aa5f83fbd1f784039a98b5ac4eda151efdb))
* **security:** require explicit wildcard prefix for webhook allowlist subdomain matching ([8d79c89](https://github.com/nikunjmavani/core-be/commit/8d79c891b2a88a8a44cca1420535cfcc6a567a12))
* **security:** strip privileged headers from MCP call_api and remove unversioned aliases ([#348](https://github.com/nikunjmavani/core-be/issues/348)) ([cdaf9ce](https://github.com/nikunjmavani/core-be/commit/cdaf9cef188e146b090bf411dc21e803c53ddea7))
* **security:** strip Stripe-shaped literals from source + add regression test (GH secret-scanning) ([#529](https://github.com/nikunjmavani/core-be/issues/529)) ([f234e60](https://github.com/nikunjmavani/core-be/commit/f234e6044879c72385e3b61728ea4ba665931ae6))
* **security:** untrack agent-os/mcp/mcp.json and repair stale ai/ paths ([#560](https://github.com/nikunjmavani/core-be/issues/560)) ([b3547a4](https://github.com/nikunjmavani/core-be/commit/b3547a43172e2388c0a1a2e4fa8e0388d046b4c6))
* **sec:** validate membership and api-key path params at the boundary (sec-re-18) ([#468](https://github.com/nikunjmavani/core-be/issues/468)) ([c0ab171](https://github.com/nikunjmavani/core-be/commit/c0ab17106d8e7dd27513e3bf2f76a480775fd557))
* **sec:** validate subscriptionId path param at every billing handler (sec-B10) ([#431](https://github.com/nikunjmavani/core-be/issues/431)) ([2bbd338](https://github.com/nikunjmavani/core-be/commit/2bbd33864cd192a22d5d41f70ed7064a628a3809))
* **sec:** webhook secret strength + upload sweep file_key invariant + data-export doc (sec-up batch) ([#447](https://github.com/nikunjmavani/core-be/issues/447)) ([145c838](https://github.com/nikunjmavani/core-be/commit/145c8385ec8b02c25b0b508adbabd71c2ce8dc05))
* **setup:** activate pinned Node on PATH in agent bootstrap step 1 ([#649](https://github.com/nikunjmavani/core-be/issues/649)) ([968d54f](https://github.com/nikunjmavani/core-be/commit/968d54fae13b6e8cb9c40c39e565c116739dd479))
* **storage:** distinguish S3 not-found from transient failure (audit-[#5](https://github.com/nikunjmavani/core-be/issues/5)) ([5ba8d00](https://github.com/nikunjmavani/core-be/commit/5ba8d002a05a423b8a2e8b99e4f23c29a1d79e51))
* **storage:** enforce SSE-S3 on presigned uploads (sec-r4-E1) ([#509](https://github.com/nikunjmavani/core-be/issues/509)) ([f962d37](https://github.com/nikunjmavani/core-be/commit/f962d372565e05986fb00a2cef960694b4b35885))
* **storage:** serve public media via a distribution and refuse public URLs for private keys (audit-[#13](https://github.com/nikunjmavani/core-be/issues/13)) ([cc10be0](https://github.com/nikunjmavani/core-be/commit/cc10be00c43a9891bff17bfc097f9ba50c5a165d))
* **stripe:** tighten webhook replay window to 150 s (audit finding [#6](https://github.com/nikunjmavani/core-be/issues/6)) ([#365](https://github.com/nikunjmavani/core-be/issues/365)) ([848360d](https://github.com/nikunjmavani/core-be/commit/848360d739857212d1822c6e9e4564498649b5c3))
* **tenancy,notify:** atomic role-delete, webhook clock-skew, security_policy proto guard (route-audit C2, C3, C4) ([ddf4f35](https://github.com/nikunjmavani/core-be/commit/ddf4f35762595f2318930855bf1bfccaba3a30ed))
* **tenancy,notify:** make per-scope resource caps atomic with an advisory lock (audit-[#8](https://github.com/nikunjmavani/core-be/issues/8)) ([3681133](https://github.com/nikunjmavani/core-be/commit/3681133339f47f68570aaf54f773ae8c5964238b))
* **tenancy,security:** post-flatten audit corrections — idempotency claim scope + personal-org guards ([e105372](https://github.com/nikunjmavani/core-be/commit/e10537260c541131a4386bb37570653242fcc41b))
* **tenancy,security:** post-flatten audit corrections — idempotency claim scope, personal-org guards, dead-code cleanup ([018fb31](https://github.com/nikunjmavani/core-be/commit/018fb313308ea78843d22df4dd234dc41dea1190))
* **tenancy:** bound MemberRolePermissionRepository.findByRoleId rows per role (sec-r4-D4) ([#508](https://github.com/nikunjmavani/core-be/issues/508)) ([9218518](https://github.com/nikunjmavani/core-be/commit/92185187cd5397f4f349442626a936f55e718b7b))
* **tenancy:** emit public ids (not internal bigserial ids) in membership responses ([#329](https://github.com/nikunjmavani/core-be/issues/329)) ([3aac2ac](https://github.com/nikunjmavani/core-be/commit/3aac2ac13d072c1f41bf71bd296468de63d73b3c))
* **tenancy:** exclude soft-deleted orgs from organizations_tenant_isolation RLS policy (sec-new-D3) ([#491](https://github.com/nikunjmavani/core-be/issues/491)) ([904802a](https://github.com/nikunjmavani/core-be/commit/904802affcc95bea74e6f510b64c655ccbd46df0))
* **tenancy:** only activate INVITED memberships on invitation accept (route-audit-[#1](https://github.com/nikunjmavani/core-be/issues/1)) ([aeea26a](https://github.com/nikunjmavani/core-be/commit/aeea26af9f5346fdbf4c7dd38745de90d8951b14))
* **tenancy:** rate-limit membership lifecycle endpoints (sec-r4-I3) ([#505](https://github.com/nikunjmavani/core-be/issues/505)) ([1f0c8c0](https://github.com/nikunjmavani/core-be/commit/1f0c8c01d38bbaa6020b8a8cab7e3d5b0657b0b7))
* **tenancy:** rate-limit organization mutation endpoints (sec-r4-I2) ([#504](https://github.com/nikunjmavani/core-be/issues/504)) ([2f6bedb](https://github.com/nikunjmavani/core-be/commit/2f6bedb59ca27d9d11c68299560470d8f0418d77))
* **tenancy:** reject prototype-pollution keys in organization security_policy (route-audit hardening) ([b1eba43](https://github.com/nikunjmavani/core-be/commit/b1eba43d872fe1ff7e018edd45eb42c10f67fa3f))
* **tenancy:** revoke a removed member's API keys on membership removal (reaudit-[#7](https://github.com/nikunjmavani/core-be/issues/7)) ([1387bd3](https://github.com/nikunjmavani/core-be/commit/1387bd306046d439b5f52840e4b45ae0f0794037))
* **tenancy:** scale permission-cache stampede poll budget to lock TTL (audit-[#9](https://github.com/nikunjmavani/core-be/issues/9)) ([5322d0f](https://github.com/nikunjmavani/core-be/commit/5322d0fae4dc9043f3563eda431d880ccab74f97))
* **tenancy:** sec-new-M1 add STRICT_AUTHED_RATE_LIMIT to POST /organizations ([#477](https://github.com/nikunjmavani/core-be/issues/477)) ([dd9fd62](https://github.com/nikunjmavani/core-be/commit/dd9fd62112aefe4eaa63869ab6c37ac62ee8540c))
* **tenancy:** sec-new-T2 validate invitationId path param in all invitation handlers ([#480](https://github.com/nikunjmavani/core-be/issues/480)) ([93fa940](https://github.com/nikunjmavani/core-be/commit/93fa940a7d371acd95889257b027075d305d1e60))
* **tenancy:** sec-new-T3 validate id and roleId path params in role handlers ([#481](https://github.com/nikunjmavani/core-be/issues/481)) ([361159a](https://github.com/nikunjmavani/core-be/commit/361159aca4126ae5df7b446dd437c199082a9636))
* **tenancy:** throttle api-key last_used_at writes (audit-[#8](https://github.com/nikunjmavani/core-be/issues/8)) ([96b3e56](https://github.com/nikunjmavani/core-be/commit/96b3e562e136892ff44e5adf2f06009bdcce5a06))
* **tests:** align e2e fixtures with audit batch2 (WebAuthn typed DTO) + Stripe items.period ([#384](https://github.com/nikunjmavani/core-be/issues/384)) ([b906731](https://github.com/nikunjmavani/core-be/commit/b906731f9fdfb6813303c3f25a0ce148a1e2023a))
* **tests:** cleanupDatabase preserves schema_migrations; update tests inherited from main's B4 + sec-r4-A1 semantics ([#525](https://github.com/nikunjmavani/core-be/issues/525)) ([169327e](https://github.com/nikunjmavani/core-be/commit/169327ec7652cefd7301b8d0c1c47009caa9ae5e))
* three pre-existing dev post-merge CI failures (migration idempotency, Stripe Date bind, permission seed) ([#614](https://github.com/nikunjmavani/core-be/issues/614)) ([798cefe](https://github.com/nikunjmavani/core-be/commit/798cefe26f59b8f56c3987f437772d707a42e364))
* **upload:** add DTO-level fileSize ceiling (sec-r4-I4) ([#515](https://github.com/nikunjmavani/core-be/issues/515)) ([049f917](https://github.com/nikunjmavani/core-be/commit/049f917c71b8c043e39bbbcd40f93eec534994fc))
* **upload:** lock the organization pending-upload quota at the org scope (audit-[#7](https://github.com/nikunjmavani/core-be/issues/7)) ([171a0fc](https://github.com/nikunjmavani/core-be/commit/171a0fc4c618c93c4bc74aafe0c3ec45f6376b74))
* **upload:** reclaim orphaned avatar/logo objects + owner-binding + purpose/target check (L1/L2/L3) ([7ffef76](https://github.com/nikunjmavani/core-be/commit/7ffef768a889cab424139e42cab34e7f055f6bb9))
* **upload:** reclaim orphaned avatar/logo objects, wire owner-binding gate, validate purpose-target (route-audit L1, L2, L3) ([d9d9738](https://github.com/nikunjmavani/core-be/commit/d9d97381082b330d32843511d29e8823fde2cb56))
* **user-data-export:** bound offboarding S3 delete fan-out (sec-r4-R2) ([#513](https://github.com/nikunjmavani/core-be/issues/513)) ([6ef83de](https://github.com/nikunjmavani/core-be/commit/6ef83de5039fcb08bd4422ad04cfc4282ee53bd4))
* **user:** block admin suspend/delete of protected super-admins (route-[#1](https://github.com/nikunjmavani/core-be/issues/1)) ([b84259d](https://github.com/nikunjmavani/core-be/commit/b84259d3f6cbb34ffb2f8617e900aa0157fc5fae))
* **user:** block deleting a user who still owns organizations (route-audit-[#2](https://github.com/nikunjmavani/core-be/issues/2) follow-up) ([f94b7c9](https://github.com/nikunjmavani/core-be/commit/f94b7c9c0c95d1525ea31fe41e44970efe452f19))
* **user:** rate-limit /me profile mutation endpoints (sec-r4-I1) ([#503](https://github.com/nikunjmavani/core-be/issues/503)) ([0c745e1](https://github.com/nikunjmavani/core-be/commit/0c745e182c0c6be2de608f42e9c434212ad07c08))
* **user:** rate-limit admin user-management mutations (route-[#4](https://github.com/nikunjmavani/core-be/issues/4)) ([a0d8114](https://github.com/nikunjmavani/core-be/commit/a0d8114b28fc1730fbc982271018d64700569537))
* **user:** reject org-scoped notification preference with 400 (was raw 42501 -&gt; 500) ([#327](https://github.com/nikunjmavani/core-be/issues/327)) ([db1e7a7](https://github.com/nikunjmavani/core-be/commit/db1e7a77e3c8f464bd8354f1235a1f33c5c71967))
* **user:** sec-new-U1 cap ListUsersDto.after cursor to 512 chars ([#483](https://github.com/nikunjmavani/core-be/issues/483)) ([fae555d](https://github.com/nikunjmavani/core-be/commit/fae555dd2717a4cde9a703f64941cca09d55e33f))
* **user:** unique notification-preference natural key + input dedupe (audit-[#11](https://github.com/nikunjmavani/core-be/issues/11)) ([6805459](https://github.com/nikunjmavani/core-be/commit/68054599b5fb2a120c6fb8571f23a76dc9277e7a))
* validators (audit follow-up) — centralize AES_GCM_IV_LENGTH, allowlist 5 and 512, env-load sunset validator ([#378](https://github.com/nikunjmavani/core-be/issues/378)) ([3bae917](https://github.com/nikunjmavani/core-be/commit/3bae917577c65d11cf771725f81392a0a62ce904))


### Performance

* parallelize S3 object deletes in deleteAllExportsForUser ([#361](https://github.com/nikunjmavani/core-be/issues/361)) ([4c36173](https://github.com/nikunjmavani/core-be/commit/4c36173e703bfaa9737ed2a529f0e28e8f863046))


### Changed

* **api:** rename inbound Idempotency-Key header to X-Idempotency-Key ([#656](https://github.com/nikunjmavani/core-be/issues/656)) ([b595c1b](https://github.com/nikunjmavani/core-be/commit/b595c1b0ed35a9248f1dd53660c7b3afb849eee4))
* **api:** semantic snake_case params, prefixed public ids, uniform status policy, documented headers ([03820fb](https://github.com/nikunjmavani/core-be/commit/03820fb407116e2532f2afdf12133861b8c58497))
* **api:** semantic snake_case route params, prefixed public ids, uniform method-status policy, documented headers ([3311bc0](https://github.com/nikunjmavani/core-be/commit/3311bc022f65fcbd517802cc91dcb194d5a31c0c))
* **architecture:** move raw SQL out of stripe-webhook-organization.util into the repository (+ global gate) ([#530](https://github.com/nikunjmavani/core-be/issues/530)) ([f48fb46](https://github.com/nikunjmavani/core-be/commit/f48fb46fe1005a95adc0abf14222df8f86c030f9))
* **billing:** remove deprecated /stripe/webhook alias ([#670](https://github.com/nikunjmavani/core-be/issues/670)) ([e0a4c8b](https://github.com/nikunjmavani/core-be/commit/e0a4c8bfac04fcbe041c6b6c1e47a5585d411820))
* **constants:** centralize scope-localized config constants ([#667](https://github.com/nikunjmavani/core-be/issues/667)) ([f6dad66](https://github.com/nikunjmavani/core-be/commit/f6dad66887513bd519c020794526b3b32c8c728a))
* enforce architecture boundaries (DB-in-services, DI, controller thinness) ([#602](https://github.com/nikunjmavani/core-be/issues/602)) ([cc43b3b](https://github.com/nikunjmavani/core-be/commit/cc43b3b3f38cd94d190928ac6728f1077195bbbf))
* **quality:** clear SonarQube debt on the deployed surface ([#663](https://github.com/nikunjmavani/core-be/issues/663)) ([8f5116a](https://github.com/nikunjmavani/core-be/commit/8f5116a5ddb29ac435078922ed7188ca4f6f1df3))
* **queue:** remove redundant alert-only offboarding reconciler ([#611](https://github.com/nikunjmavani/core-be/issues/611)) ([55e979e](https://github.com/nikunjmavani/core-be/commit/55e979e10528a3b6c794aaea1595e7feeedbc7b6))
* route consistency + personal/team org model ([#658](https://github.com/nikunjmavani/core-be/issues/658)) ([d304b88](https://github.com/nikunjmavani/core-be/commit/d304b88439d8611d7b7d668f4b0d1f15c9a7a2dc))
* **tenancy:** route org-scoped controllers through claim-aware org accessor ([f4c3b54](https://github.com/nikunjmavani/core-be/commit/f4c3b54f70b5c9c49c2a03cf908f1407810138a8))
* **tenancy:** route org-scoped controllers through claim-aware org accessor ([af30b20](https://github.com/nikunjmavani/core-be/commit/af30b20e50b8c49f3c906bbbb1ca6d4093fd14ef))
* **validation:** extract shared parseWithSchema + parseCursorPaginatedQuery helpers ([#661](https://github.com/nikunjmavani/core-be/issues/661)) ([7831156](https://github.com/nikunjmavani/core-be/commit/78311567eb27b6676b63fa3dec89ab3d1bab3130))


### Documentation

* add 2026-06-04 deep audit report (20 findings) ([6515589](https://github.com/nikunjmavani/core-be/commit/65155899935406e72781fab5348f146b20b5b8e4))
* add deep backend audit report 2026-06-03 ([#362](https://github.com/nikunjmavani/core-be/issues/362)) ([3d7ae31](https://github.com/nikunjmavani/core-be/commit/3d7ae31779c7975b4b61d19c8f7867c8a58432a9))
* add remediation status tracker to 2026-06-03 audit report ([93ef121](https://github.com/nikunjmavani/core-be/commit/93ef12150cd3917f3a6ecc46c9e8da4573ada94b))
* **agent-os:** align schema skills to varchar(n) codebase convention ([#638](https://github.com/nikunjmavani/core-be/issues/638)) ([e575074](https://github.com/nikunjmavani/core-be/commit/e5750743e7a8af7a59eebd06d552ca8223a598d1))
* **agent-os:** correct stale workflow, seed, and provider paths in skills ([#641](https://github.com/nikunjmavani/core-be/issues/641)) ([5550f4c](https://github.com/nikunjmavani/core-be/commit/5550f4c274b58403008bb98dd4982642565ed110))
* **api:** add frontend auth & headers integration guide ([b8ca013](https://github.com/nikunjmavani/core-be/commit/b8ca01362c4a04aa8d65e511cac136a0953b2445))
* **api:** add frontend auth & headers integration guide ([ab201e8](https://github.com/nikunjmavani/core-be/commit/ab201e8046a524ad2f5dd9868e22897d77aaf2a9))
* **audit-2026-06-04:** mark all 20 findings resolved with file:line citations ([#381](https://github.com/nikunjmavani/core-be/issues/381)) ([96dd4f7](https://github.com/nikunjmavani/core-be/commit/96dd4f74574b1dca6ee93190b59edc56ab414b1e))
* check in sync; enricher unit tests + full suite (4,516) green. ([c58d39b](https://github.com/nikunjmavani/core-be/commit/c58d39b0aa550158d3106a41fadd403c203eb4c5))
* check verified green on 0.28.1. ([514fa96](https://github.com/nikunjmavani/core-be/commit/514fa961bd392ef4583c7e148a7f47277ef23dae))
* check, tsdoc 0/0, migrate lint, env sync, validate all pass. ([3311bc0](https://github.com/nikunjmavani/core-be/commit/3311bc022f65fcbd517802cc91dcb194d5a31c0c))
* consolidate setup guide into single root SETUP.md ([#555](https://github.com/nikunjmavani/core-be/issues/555)) ([5c311a3](https://github.com/nikunjmavani/core-be/commit/5c311a3c72f1fb33cb44daa087e94ee19e2edb1c))
* **env:** standardize OPTIONAL marker for conditionally-empty env keys ([#549](https://github.com/nikunjmavani/core-be/issues/549)) ([d7155b4](https://github.com/nikunjmavani/core-be/commit/d7155b48786aee7a8ce2e306133b61398f00cf20))
* **infra:** annotate Dockerfile build-stage ENV as test-only placeholders (sec-r4-C6) ([#519](https://github.com/nikunjmavani/core-be/issues/519)) ([cdf76ef](https://github.com/nikunjmavani/core-be/commit/cdf76ef7e6a85de7e638c161d1e7ad34dd12e38a))
* **integrations:** add Codex Cloud agent environment guide and GitHub prerequisites ([#660](https://github.com/nikunjmavani/core-be/issues/660)) ([d2128de](https://github.com/nikunjmavani/core-be/commit/d2128de716f1f19c25d934c87ecb517baf05d04e))
* **integrations:** add Postman + Resend agent MCP servers ([#631](https://github.com/nikunjmavani/core-be/issues/631)) ([6966744](https://github.com/nikunjmavani/core-be/commit/6966744da40ff9887700f433f78afc1f8f313140))
* **integrations:** common Claude Code session-setup overview ([#674](https://github.com/nikunjmavani/core-be/issues/674)) ([9052152](https://github.com/nikunjmavani/core-be/commit/90521520c34495a066342656f1ba104beb827f54))
* **integrations:** expand Stripe webhook runbook + Turnstile TODO ([#635](https://github.com/nikunjmavani/core-be/issues/635)) ([be08946](https://github.com/nikunjmavani/core-be/commit/be08946a84175689883f858e61e96b928e8c222d))
* **integrations:** fix Stripe CLI/Dashboard webhook URL ([#630](https://github.com/nikunjmavani/core-be/issues/630)) ([570e58f](https://github.com/nikunjmavani/core-be/commit/570e58f79991d12dcf75781ccdc9465da2647b85))
* **integrations:** map third-party services to CLI/MCP/SDK by consumer ([#626](https://github.com/nikunjmavani/core-be/issues/626)) ([5e90f52](https://github.com/nikunjmavani/core-be/commit/5e90f522061e5de8f31cb2905b9edda43caf2bf9))
* **openapi:** drop "Public ID" from request-body/query field descriptions → "id" ([3cb01a0](https://github.com/nikunjmavani/core-be/commit/3cb01a0b294a1a47a80a25a209ab410403e38117))
* **openapi:** drop "Public ID" from request-body/query field descriptions → "id" ([c58d39b](https://github.com/nikunjmavani/core-be/commit/c58d39b0aa550158d3106a41fadd403c203eb4c5))
* **process:** add release-versioning cheat-sheet (commit prefix → bump) ([#612](https://github.com/nikunjmavani/core-be/issues/612)) ([6e58397](https://github.com/nikunjmavani/core-be/commit/6e58397013279da347bf5a56305e150ea1cc8e26))
* **process:** document "watch CI -&gt; merge when green" in git flow + pr-babysit ([#616](https://github.com/nikunjmavani/core-be/issues/616)) ([0537a8e](https://github.com/nikunjmavani/core-be/commit/0537a8e86fc135038585d78b523e648cbc289e69))
* **reviews:** add agent-os AI-tooling audit + evals session writeup ([ef55c53](https://github.com/nikunjmavani/core-be/commit/ef55c536b406a3b1aea5df055c844bd4159c7a78))
* **reviews:** agent-os AI-tooling audit + evals/enforcement session writeup ([32288fa](https://github.com/nikunjmavani/core-be/commit/32288fa07f7e0b3caa92b5325ec51938b95be557))
* **reviews:** architecture conformance audit + 8-PR follow-up plan ([#531](https://github.com/nikunjmavani/core-be/issues/531)) ([4a9264c](https://github.com/nikunjmavani/core-be/commit/4a9264cb674f57930241a8b348d12afdcc727476))
* **reviews:** correct sec-r4-A3 analysis and defer to follow-up task ([#523](https://github.com/nikunjmavani/core-be/issues/523)) ([c7e1dab](https://github.com/nikunjmavani/core-be/commit/c7e1dab9433b40eb16a7df6e28fdf317df9318b7))
* **reviews:** route-coverage audit — 129 routes, 9 deferred gaps allowlisted ([#534](https://github.com/nikunjmavani/core-be/issues/534)) ([d18ec1d](https://github.com/nikunjmavani/core-be/commit/d18ec1df87b78237c77bac6f84b1ec464ff71965))
* **runbooks:** refresh worker registry breakdown to 30 workers / 27 Postgres ([#621](https://github.com/nikunjmavani/core-be/issues/621)) ([2d4d111](https://github.com/nikunjmavani/core-be/commit/2d4d111a9578679c856367881c16a5f6d8f62cb6))
* **superpowers:** re-audit remediation design spec for 18 findings ([#451](https://github.com/nikunjmavani/core-be/issues/451)) ([1b05734](https://github.com/nikunjmavani/core-be/commit/1b05734fe69e593ae6ad9f5fb2f11e6f4a8f69f6))

## [4.3.0](https://github.com/nikunjmavani/core-be/compare/v4.2.0...v4.3.0) (2026-06-17)


### Added

* 131-route security & production-flow audit — fix all RED/AMBER findings ([#601](https://github.com/nikunjmavani/core-be/issues/601)) ([3df1fbd](https://github.com/nikunjmavani/core-be/commit/3df1fbd91ea9011a6378a6f0785200e4a5f990ed))
* **agent-os:** add PreToolUse edit-guard and SessionStart hooks ([dcf6335](https://github.com/nikunjmavani/core-be/commit/dcf6335773cb9b8d15f570d7b2afac9e2a1a284c))
* **agent-os:** add RLS/tenant-isolation and idempotency guard skills ([a94cbb5](https://github.com/nikunjmavani/core-be/commit/a94cbb52df397f1abadf3a3f411f31bf2fc6f49a))
* **agent-os:** PreToolUse edit-guard + SessionStart hooks (Move 2) ([ad2e2b3](https://github.com/nikunjmavani/core-be/commit/ad2e2b3b87051c2fe34d3005d6a84fc6e37965e0))
* **agent-os:** RLS/tenant-isolation + idempotency guard skills ([0a3b902](https://github.com/nikunjmavani/core-be/commit/0a3b902748f4fc3e84d5d971b0915496b5e4f440))
* **ai:** cross-platform AI commands, SessionStart hook, and guardrails ([#643](https://github.com/nikunjmavani/core-be/issues/643)) ([b6fccf1](https://github.com/nikunjmavani/core-be/commit/b6fccf1630257d2920ba3831f625bbeeca7cad41))
* **audit:** transactional outbox for audit.logs writes (P0-[#2](https://github.com/nikunjmavani/core-be/issues/2)) ([#557](https://github.com/nikunjmavani/core-be/issues/557)) ([4c337da](https://github.com/nikunjmavani/core-be/commit/4c337da6b81523c01d23bf8947226194ee9ad665))
* **auth:** add switch-to-personal and switch-to-organization endpoints ([79be5b0](https://github.com/nikunjmavani/core-be/commit/79be5b0fe799563e9612eaa3fc48a4a12f3ce2ae))
* **auth:** carry active organization + session version as signed JWT claims ([9864a2e](https://github.com/nikunjmavani/core-be/commit/9864a2e34917837b7102fdd72f9ba61982e4b0e0))
* **auth:** GET /auth/me/context — frontend-ready effective context ([#659](https://github.com/nikunjmavani/core-be/issues/659)) ([d08bb35](https://github.com/nikunjmavani/core-be/commit/d08bb35049c443015b3d53be0f13c7a80f4a845a))
* **auth:** mint the active-organization claim at login (default selection) ([a3a805d](https://github.com/nikunjmavani/core-be/commit/a3a805dc143b7af537c0757b4b74bfc77516d75d))
* **auth:** permission layer falls back to the org token claim (Phase 3 bridge) ([ea07091](https://github.com/nikunjmavani/core-be/commit/ea0709135504d09faa6367bfded88107cc438295))
* **auth:** permission layer reads the org token claim (Phase 3 bridge) ([6b9e7c3](https://github.com/nikunjmavani/core-be/commit/6b9e7c3458f6788b5c75b0ed4a49d3709b48d181))
* **auth:** refresh re-mints the active-organization claim ([b22f0a1](https://github.com/nikunjmavani/core-be/commit/b22f0a1712aa76b1f997257997b157025712b791))
* **auth:** switch building blocks — membership-validation resolvers + session token re-bind ([62cc944](https://github.com/nikunjmavani/core-be/commit/62cc9449314b7684007c937a9ec72b73c2d0eceb))
* **auth:** switchToOrganization / switchToPersonal service methods ([3f5ecc8](https://github.com/nikunjmavani/core-be/commit/3f5ecc84267e747d6e6d900ae5caf733f6255752))
* **billing:** flatten subscription routes onto the org token claim ([f835d60](https://github.com/nikunjmavani/core-be/commit/f835d605e0529e0e0e91ca7da1b16aa5f8940bec))
* **billing:** flatten subscription routes onto the org token claim ([df21c2c](https://github.com/nikunjmavani/core-be/commit/df21c2c62c4b65e4f1bf57228743ac2cd042a92c))
* **ci:** add PR-time Trivy IaC misconfig scan ([#388](https://github.com/nikunjmavani/core-be/issues/388)) ([e8499e0](https://github.com/nikunjmavani/core-be/commit/e8499e04b8c8d311a14fb6ac3bdd1c4a4d151a49))
* **config:** gated local-dev defaults for DB/Redis/origins/retention ([#651](https://github.com/nikunjmavani/core-be/issues/651)) ([773e427](https://github.com/nikunjmavani/core-be/commit/773e427ca11bd44d1a65fea996ebbc92a629c236))
* **infra-tests:** drop_index_without_concurrently lint rule + org slug collision-proof factory ([#526](https://github.com/nikunjmavani/core-be/issues/526)) ([0915c85](https://github.com/nikunjmavani/core-be/commit/0915c851ab7b5c8934a06108d28f8aec3662e97b))
* **load:** per-VU credential pool + realistic user-journey k6 scenario ([#342](https://github.com/nikunjmavani/core-be/issues/342)) ([a05a611](https://github.com/nikunjmavani/core-be/commit/a05a611ced68683c0855c65d572fbc5fc7d06bb1))
* **mcp,k6:** client auth-flow guide + k6 org-claim flow; fix dead idempotency exclusions ([f4bac5a](https://github.com/nikunjmavani/core-be/commit/f4bac5aa9a67f14e5ec87209e326e67b5ae15de6))
* **mcp,k6:** client auth-flow guide + k6 org-claim flow; fix idempotency exclusions; flatten stale refs ([f6e5894](https://github.com/nikunjmavani/core-be/commit/f6e5894a66cee5de1ff0790f5898b5510fd74f37))
* **mcp:** scope project MCP servers and wire MCP setup into the session-start flow ([#675](https://github.com/nikunjmavani/core-be/issues/675)) ([9ed07b4](https://github.com/nikunjmavani/core-be/commit/9ed07b4ba576db0ac5849d9c7de76b4c2c91af73))
* **notify:** flatten webhook routes onto the org token claim ([643d13a](https://github.com/nikunjmavani/core-be/commit/643d13ad09bd64e28bca029e4ed42cc40b56d04f))
* **notify:** flatten webhook routes onto the org token claim ([0bdc8ad](https://github.com/nikunjmavani/core-be/commit/0bdc8add9f37df2bd944995368be8d9f94710755))
* **notify:** time-based retention for webhook_delivery_attempts (audit-[#3](https://github.com/nikunjmavani/core-be/issues/3)) ([05d6325](https://github.com/nikunjmavani/core-be/commit/05d63258002fd9762962498b0a5059a5b971400f))
* **observability:** emit Server-Timing header for true server-side latency ([#339](https://github.com/nikunjmavani/core-be/issues/339)) ([5e78cde](https://github.com/nikunjmavani/core-be/commit/5e78cde15b30deac077cbf4e27081cf6da27e814))
* **openapi:** document the full error-status matrix; observed-vs-spec error gate ([95a71b5](https://github.com/nikunjmavani/core-be/commit/95a71b505c9d8d7f802d73c4e0841b4140bf836d))
* **openapi:** document the full error-status matrix; observed-vs-spec error gate ([5a001de](https://github.com/nikunjmavani/core-be/commit/5a001de48bb661e048e012dde8ce658bfe612f3e))
* **openapi:** embed sanitized live-call request/response examples per route and status ([3a1ddb1](https://github.com/nikunjmavani/core-be/commit/3a1ddb1e5d38b40e18b9300a14942219da6ce868))
* **openapi:** embed sanitized live-call request/response examples per route and status ([bea574c](https://github.com/nikunjmavani/core-be/commit/bea574c92291f96bd309ad1969fe38cdf756722f))
* personal & team organizations — foundation + token/switch (Phase 1-2) ([9a8b179](https://github.com/nikunjmavani/core-be/commit/9a8b179a097b615b2e7292ad6f6362011ea2563c))
* **round-5-followup:** per-org row caps (api-keys, member-roles, notification-policies) + auth/MFA route policy tests ([#528](https://github.com/nikunjmavani/core-be/issues/528)) ([19b556f](https://github.com/nikunjmavani/core-be/commit/19b556f9379a3d70889644356e9928a68de549e9))
* **round-5:** residual-risk findings — DLQ-RLS bug + 5 backlog fixes + 3 test gaps + audit doc ([#527](https://github.com/nikunjmavani/core-be/issues/527)) ([6aa6f88](https://github.com/nikunjmavani/core-be/commit/6aa6f8831e12fa7c8ef88f3d95f9e15bcd2d23d2))
* **scalar:** publish OpenAPI to Scalar Registry (CI docs pipeline + interactive setup) ([#672](https://github.com/nikunjmavani/core-be/issues/672)) ([3ddc9b2](https://github.com/nikunjmavani/core-be/commit/3ddc9b2325a8cc8417bfe679c748a64f5c510da2))
* **tenancy:** atomic org provisioning with owner role+permissions+membership ([266b22e](https://github.com/nikunjmavani/core-be/commit/266b22ebeb3604dbc45d08608efd7604df37c81e))
* **tenancy:** auto-provision personal org at signup + exclude personal from delete guard ([9daed03](https://github.com/nikunjmavani/core-be/commit/9daed03c85997744bbfeb50919681de5658cd556))
* **tenancy:** block invitations on a personal organization (capability matrix) ([cafc549](https://github.com/nikunjmavani/core-be/commit/cafc5493d497f7e99a924a152ca6a64e4f29dd0d))
* **tenancy:** cap team organizations per owner (anti-abuse) ([f71b968](https://github.com/nikunjmavani/core-be/commit/f71b968577aa19a8ce4c3b4f6ce83142c3fd51d3))
* **tenancy:** flatten organization routes onto the org token claim ([ddd1a76](https://github.com/nikunjmavani/core-be/commit/ddd1a7604f7da6dfb3a878fdb28c9e35dff086d8))
* **tenancy:** flatten organization routes onto the org token claim ([f35b74e](https://github.com/nikunjmavani/core-be/commit/f35b74eb0f14cf2e5225b3fb477ea686a82763ed))
* **tenancy:** make the personal organization immutable (no delete / no transfer) ([a726064](https://github.com/nikunjmavani/core-be/commit/a726064b5f009c1a5ccd878fe8379eb79a533a37))
* **tenancy:** org-creation per-owner cap + personal-org capability guards ([94d7715](https://github.com/nikunjmavani/core-be/commit/94d77153740b2076afb57ded14748b727367617c))
* **tenancy:** organization create accepts type + nullable slug (provisioning groundwork) ([35bc409](https://github.com/nikunjmavani/core-be/commit/35bc409c7e85453a2d294f1baf4bd38b19e26d6f))
* **tenancy:** personal-org backfill script + provisioning tests ([5a40f5d](https://github.com/nikunjmavani/core-be/commit/5a40f5d5eadfd970e712b8d4b5a7f85b86258727))
* **tenancy:** personal/team organization foundation — schema + capability flags ([11e23d9](https://github.com/nikunjmavani/core-be/commit/11e23d92fc301307638f73e3e1269a0612ddde3d))
* **testing:** route success-status registry, observed coverage ratchet, never-5xx fuzz gate ([8d88dcf](https://github.com/nikunjmavani/core-be/commit/8d88dcf0677104ce4885ad80d62543c6ec45052a))
* **testing:** route success-status registry, observed coverage ratchet, never-5xx fuzz gate ([dfe2b43](https://github.com/nikunjmavani/core-be/commit/dfe2b436d3fa28843597576d6b29f43d7932d8ab))
* **testing:** verified happy path for every route — budget 30→0; 201 creates; OAuth 404 ([01b1b77](https://github.com/nikunjmavani/core-be/commit/01b1b77cbf2f60dcafbfa1afeafab68fe1e54437))
* **testing:** verified happy path for every route — budget 30→0; 201 creates; OAuth 404 ([624c9d5](https://github.com/nikunjmavani/core-be/commit/624c9d58945e78317e39cd9a412e488454fbdf29))
* **tests:** post-load settle-and-assert-clean gate + audit-outbox drain coverage ([01258c5](https://github.com/nikunjmavani/core-be/commit/01258c5b5aa9c03f8d6e9c7c9a5218cd10d3750b))
* **tooling:** project identity refactor, 5 review agents, architecture policy tests ([#552](https://github.com/nikunjmavani/core-be/issues/552)) ([324689e](https://github.com/nikunjmavani/core-be/commit/324689e3c5027056932272f90d3495539d25ea44))
* **user:** add a scheduled reconciler that detects + alerts on stuck offboarding (audit-[#15](https://github.com/nikunjmavani/core-be/issues/15)) ([6443673](https://github.com/nikunjmavani/core-be/commit/64436733ec73792a3295b46ade51da2ceee98a53))
* **user:** expose deployment organization capabilities on /users/me ([a27f7a6](https://github.com/nikunjmavani/core-be/commit/a27f7a6d9a1a03a75e6163ab061e137d8a65e1d8))
* **user:** expose personal_organization_id on /users/me ([b725aca](https://github.com/nikunjmavani/core-be/commit/b725acad609f8a9743f2a199c4234df423ade3a5))


### Fixed

* 8th-audit concurrency races + correctness hardening (C1-C5) ([bf077b7](https://github.com/nikunjmavani/core-be/commit/bf077b743cfbe51549c39ca4d4ae28b824a1a6df))
* **api:** truthful error envelope, id-only external fields, DELETE→204 stragglers, local oasdiff gate ([25b4629](https://github.com/nikunjmavani/core-be/commit/25b46297b331681b528962246f8bee28c4695204))
* **api:** truthful error envelope, id-only external fields, DELETE→204 stragglers, local oasdiff gate ([2777308](https://github.com/nikunjmavani/core-be/commit/2777308d77c2938b0f66437a24a02b9637392b19))
* audit batch2 — WebAuthn typed DTOs, oasdiff SIGSEGV CI workaround ([6e44557](https://github.com/nikunjmavani/core-be/commit/6e4455700f39ed6cc6dee5ca71baf4eaddac49ed))
* **audit-13:** remove dead jobTimeout field from worker options — BullMQ does not enforce it ([#379](https://github.com/nikunjmavani/core-be/issues/379)) ([b393d5e](https://github.com/nikunjmavani/core-be/commit/b393d5e0add3e299de889d023056397a559b5df6))
* **audit:** cursor max-length, DLQ catch, jobTimeout, age-based queue eviction (batch5) ([#375](https://github.com/nikunjmavani/core-be/issues/375)) ([5882436](https://github.com/nikunjmavani/core-be/commit/588243618efe4be76f3b9e1d2b0c2aa851b06930))
* **audit:** MCP caller JWT forwarding and IP-level failed-login counter ([#373](https://github.com/nikunjmavani/core-be/issues/373)) ([ceee226](https://github.com/nikunjmavani/core-be/commit/ceee2269da8c40bb16f1332e56de8028de24b069))
* **audit:** omit soft-deleted orgs from audit-log public id resolution (sec-r4-D2) ([#506](https://github.com/nikunjmavani/core-be/issues/506)) ([e76a015](https://github.com/nikunjmavani/core-be/commit/e76a01530ed22da2e35d21f0080547075d0475d8))
* **audit:** rate limits, User-Agent truncation, webhook HTTPS, CAPTCHA staging (batch4) ([#374](https://github.com/nikunjmavani/core-be/issues/374)) ([4c9486a](https://github.com/nikunjmavani/core-be/commit/4c9486ac64959cea4bd308cb59c37ba858018066))
* **auth-webauthn:** require user verification at options time (sec-r4-A2) ([#514](https://github.com/nikunjmavani/core-be/issues/514)) ([38f60cf](https://github.com/nikunjmavani/core-be/commit/38f60cf8443a94ff327e95e6bad5d03d7bdf6947))
* **auth,openapi:** MFA-login org claim (H1) + captcha/bearerAuth OpenAPI accuracy ([909a5ce](https://github.com/nikunjmavani/core-be/commit/909a5ce448a362af445736e8a02cb2e18b7949b8))
* **auth,openapi:** mfa-login org claim (H1) plus captcha and bearerAuth openapi accuracy ([fc336b8](https://github.com/nikunjmavani/core-be/commit/fc336b867a9a597fb3c613aa0574a4b8e91bae60))
* **auth:** add user FK + index to mfa_methods to purge orphaned MFA secrets (reaudit-[#1](https://github.com/nikunjmavani/core-be/issues/1)) ([a5a0992](https://github.com/nikunjmavani/core-be/commit/a5a0992eb777f40851e2c97ac7c26ff371325c06))
* **auth:** atomic credential-mutation guards + lockout counter (route-audit C1, C5) ([e6e33db](https://github.com/nikunjmavani/core-be/commit/e6e33db37b405bf0c92622b3c152f35c88cbf186))
* **auth:** block revoking the current session via DELETE /me/sessions/:id (route-[#9](https://github.com/nikunjmavani/core-be/issues/9)) ([19f4bff](https://github.com/nikunjmavani/core-be/commit/19f4bff7ba7a651f630204a173f859dc40206d2b))
* **auth:** bounded refresh-token reuse grace for concurrent refreshes (audit-[#2](https://github.com/nikunjmavani/core-be/issues/2)) ([0cdd75d](https://github.com/nikunjmavani/core-be/commit/0cdd75dd8b85e880950b8a076fbadee39c01d18f))
* **auth:** close session-revoke cache repopulation race + normalize OAuth email (route-audit session-[#1](https://github.com/nikunjmavani/core-be/issues/1), oauth-[#3](https://github.com/nikunjmavani/core-be/issues/3)) ([b8303a0](https://github.com/nikunjmavani/core-be/commit/b8303a02e1e7010f9516e0e5c2df5b7777c83694))
* **auth:** close WebAuthn enumeration timing oracle + complete credential-mutation lock (route-audit D1, D2, D3) ([10e2b52](https://github.com/nikunjmavani/core-be/commit/10e2b5271c7cb454e15e99035389787e5c233c25))
* **auth:** drop SUPER_ADMIN for non-active accounts in per-request re-derive (reaudit-[#10](https://github.com/nikunjmavani/core-be/issues/10)) ([e54a97b](https://github.com/nikunjmavani/core-be/commit/e54a97bd1e643916ac3eb579eeda2dcdb1d26493))
* **auth:** fix controller unit test and ack OpenAPI breaking change for B4 ([48f8c81](https://github.com/nikunjmavani/core-be/commit/48f8c818fa14f205efe5a6e12d2528e8461f6790))
* **auth:** floor login failure branches to mask enumeration timing (audit-[#15](https://github.com/nikunjmavani/core-be/issues/15)d) ([0c4af59](https://github.com/nikunjmavani/core-be/commit/0c4af594c6aba8d84d383d20c01838ef6d134bf0))
* **auth:** key DELETE /mfa/:mfaMethodId on public id, not the sequential DB id (route-[#10](https://github.com/nikunjmavani/core-be/issues/10)) ([31bdd46](https://github.com/nikunjmavani/core-be/commit/31bdd46de650dce63aa6bc542beda50d57c0dea2))
* **auth:** make magic-link verification atomic with first-factor completion (audit-[#12](https://github.com/nikunjmavani/core-be/issues/12)) ([4350845](https://github.com/nikunjmavani/core-be/commit/435084506afc855e48169b8e26b3d87a1690f36a))
* **auth:** make MFA verification lockout counter atomic (route-audit-[#4](https://github.com/nikunjmavani/core-be/issues/4)) ([7d98218](https://github.com/nikunjmavani/core-be/commit/7d982183877aeea6cbc4531cea9eb47376c704fc))
* **auth:** make one-time-token issuance atomic with the mail-outbox insert (audit-[#11](https://github.com/nikunjmavani/core-be/issues/11)) ([f122beb](https://github.com/nikunjmavani/core-be/commit/f122beb20866aaf4748b05d29d2307f9a0768462))
* **auth:** make password change and email verification atomic with their side effects (audit-[#4](https://github.com/nikunjmavani/core-be/issues/4), [#12](https://github.com/nikunjmavani/core-be/issues/12)) ([42d7893](https://github.com/nikunjmavani/core-be/commit/42d7893572ee6e89c5bbe42a08cc18d1f33aa6e6))
* **auth:** make password reset atomic (transaction) so sessions can't survive it ([#319](https://github.com/nikunjmavani/core-be/issues/319)) ([30cffe5](https://github.com/nikunjmavani/core-be/commit/30cffe5c205fdd7d0f1a835cf335791ad78ad36e))
* **auth:** per-user MFA verification lockout (audit-[#12](https://github.com/nikunjmavani/core-be/issues/12)) ([d6331e0](https://github.com/nikunjmavani/core-be/commit/d6331e01f9a0d378096ecc26b30404f23fc20d7c))
* **auth:** persist and revalidate the active organization across refresh (audit-[#3](https://github.com/nikunjmavani/core-be/issues/3)) ([f9d8f1b](https://github.com/nikunjmavani/core-be/commit/f9d8f1b5a757c5b8dc5f267f4cf166f2e5677816))
* **auth:** re-derive any privileged JWT claim (admin + super_admin) against live state (route-[#6](https://github.com/nikunjmavani/core-be/issues/6)) ([956c43d](https://github.com/nikunjmavani/core-be/commit/956c43d855978ea9f49c573e4c8a498ae2c4309f))
* **auth:** remove silent params.id fallback in requireOrganizationPermission ([#346](https://github.com/nikunjmavani/core-be/issues/346)) ([17f4d83](https://github.com/nikunjmavani/core-be/commit/17f4d83fae5114820bf4f1c00940306628ea1228))
* **auth:** restore org-mandated MFA under FORCE RLS via SECURITY DEFINER resolvers ([#318](https://github.com/nikunjmavani/core-be/issues/318)) ([e152c0c](https://github.com/nikunjmavani/core-be/commit/e152c0c458aed788289c7d75b3e8fe0c79ec938f))
* **auth:** restrict POST /me/auth-methods to MAGIC_LINK to stop phantom-credential lockout (route-[#3](https://github.com/nikunjmavani/core-be/issues/3)) ([ee9af9a](https://github.com/nikunjmavani/core-be/commit/ee9af9a5819990189c658a69d9396e0fdb3ed7c5))
* **auth:** scope MFA lockout to TOTP so recovery codes stay usable (reaudit-[#3](https://github.com/nikunjmavani/core-be/issues/3)) ([a6d4b05](https://github.com/nikunjmavani/core-be/commit/a6d4b05530cd06f563be8a0ede17552d6831f4ac))
* **auth:** sec-new-A2 reject suspended/deleted users on bearer auth cache miss ([#474](https://github.com/nikunjmavani/core-be/issues/474)) ([eff74f4](https://github.com/nikunjmavani/core-be/commit/eff74f453a57f071258b8275aa850d375e6a67cc))
* **auth:** sec-new-A3 preserve caller session on DELETE /me/sessions ([#478](https://github.com/nikunjmavani/core-be/issues/478)) ([32936f3](https://github.com/nikunjmavani/core-be/commit/32936f3625022fcb98a3b2f681b6d19ee86a7611))
* **auth:** sec-new-A4 flip is_mfa_enabled inside deleteMfa transaction ([#479](https://github.com/nikunjmavani/core-be/issues/479)) ([a50d899](https://github.com/nikunjmavani/core-be/commit/a50d8995f7c42b08643d6a503b70971d24cbf6e9))
* **auth:** sec-new-B4 add public_id to auth_methods, stop leaking bigserial ids ([c82295d](https://github.com/nikunjmavani/core-be/commit/c82295d43b2768b8fb53160c26704e3dabadf4ce))
* **auth:** sec-new-B4 add public_id to auth_methods, stop leaking bigserial ids ([02a6ddd](https://github.com/nikunjmavani/core-be/commit/02a6ddd7b4dff060e87709bfa74dcd955a679228))
* **auth:** session-revoke cache repopulation race + OAuth email normalization ([c981c7f](https://github.com/nikunjmavani/core-be/commit/c981c7f634a1090faae6513d62aa30206e5e1778))
* **auth:** stop GET /auth/me/auth-methods leaking encrypted TOTP secret + PII ([#321](https://github.com/nikunjmavani/core-be/issues/321)) ([32cb49e](https://github.com/nikunjmavani/core-be/commit/32cb49e7b1c2039c2554adc481c2f68837720e6e))
* **auth:** switch-to-organization relies on route schema for body validation + suite green ([ab02f71](https://github.com/nikunjmavani/core-be/commit/ab02f711379690a987cf2cc7ab46139dc411adf8))
* **auth:** WebAuthn enumeration timing oracle + complete credential-mutation lock (D1/D2/D3) ([9a1f3f0](https://github.com/nikunjmavani/core-be/commit/9a1f3f0d5aef7156d4d455935f5295f20b76d257))
* backend production-readiness audit findings ([0f60e0f](https://github.com/nikunjmavani/core-be/commit/0f60e0f71d6dd0b1f7a5d9aa20bf60712c8a04cb))
* backend production-readiness re-audit findings ([6bd64bc](https://github.com/nikunjmavani/core-be/commit/6bd64bc3c47c7c28a1f1d42121867bc990f9c99c))
* **billing:** add per-route rate limit to subscription mutations (route-[#2](https://github.com/nikunjmavani/core-be/issues/2)) ([1e6975e](https://github.com/nikunjmavani/core-be/commit/1e6975e24271d14561f544981c651e254c3ef862))
* **billing:** alert on plan&lt;-&gt;Stripe price catalog drift (audit-[#13](https://github.com/nikunjmavani/core-be/issues/13)) ([3377510](https://github.com/nikunjmavani/core-be/commit/33775103b9ec7470270ff172b734b34586aebcb3))
* **billing:** bound PlanRepository.findAllActive at 100 rows (sec-r4-D3) ([#507](https://github.com/nikunjmavani/core-be/issues/507)) ([43180a9](https://github.com/nikunjmavani/core-be/commit/43180a98e2b62abdc0584460d06d455a55701900))
* **billing:** cancel the org's active subscription on organization delete (route-audit-[#2](https://github.com/nikunjmavani/core-be/issues/2)) ([718c80f](https://github.com/nikunjmavani/core-be/commit/718c80f307ae14d9db2ff77dbd26ae591f667afc))
* **billing:** cancel() releases the slot for never-activated INCOMPLETE subscriptions (reaudit-[#6](https://github.com/nikunjmavani/core-be/issues/6)) ([3d6cfe0](https://github.com/nikunjmavani/core-be/commit/3d6cfe03758b1302a8d1e7f8612d4641d381c1e8))
* **billing:** correct misleading plan route OpenAPI descriptions ([#349](https://github.com/nikunjmavani/core-be/issues/349)) ([27246ce](https://github.com/nikunjmavani/core-be/commit/27246ce78082f134005ac028852c7d95233f3c8b))
* **billing:** enforce unique subscriptions.provider_subscription_id (audit-[#10](https://github.com/nikunjmavani/core-be/issues/10)) ([acf919b](https://github.com/nikunjmavani/core-be/commit/acf919b105cbc10c502b8b197f5af1bd8782646c))
* **billing:** hide inactive plans from public GET /billing/plans/:id (route-[#7](https://github.com/nikunjmavani/core-be/issues/7)) ([0be46ed](https://github.com/nikunjmavani/core-be/commit/0be46ed971f32287ba326cdbbbb94275ca7f9465))
* **billing:** make Stripe customer creation idempotent on retry ([#326](https://github.com/nikunjmavani/core-be/issues/326)) ([8990fb3](https://github.com/nikunjmavani/core-be/commit/8990fb32b15fa133aece4ce428182d9b1996ee93))
* **billing:** make terminal subscriptions immutable (compare-and-set, B5/B6) ([5ac4328](https://github.com/nikunjmavani/core-be/commit/5ac43284d69e28101615d1a2f2caa306ab31cfe2))
* **billing:** make terminal subscriptions immutable via compare-and-set (route-audit B5, B6) ([18a3e43](https://github.com/nikunjmavani/core-be/commit/18a3e43540814b94e66ad085f40df767a32598e3))
* **billing:** persist a CANCELED tombstone for out-of-order Stripe deletions (audit-[#1](https://github.com/nikunjmavani/core-be/issues/1)) ([7862609](https://github.com/nikunjmavani/core-be/commit/7862609ed32b9c5c16d5780f4a6d7b59ba5066bb))
* **billing:** persist new Stripe subscriptions as INCOMPLETE not TRIALING (audit-[#2](https://github.com/nikunjmavani/core-be/issues/2)) ([b5a7f66](https://github.com/nikunjmavani/core-be/commit/b5a7f66537091e20632b3898364c7ac71e3f9f5f))
* **billing:** pin Stripe API version to 2026-05-27.dahlia ([#350](https://github.com/nikunjmavani/core-be/issues/350)) ([7c329bd](https://github.com/nikunjmavani/core-be/commit/7c329bd496bdff587f3c12748f923a2ef7267909))
* **billing:** release subscription slot for INCOMPLETE_EXPIRED (audit-[#1](https://github.com/nikunjmavani/core-be/issues/1)) ([14cd328](https://github.com/nikunjmavani/core-be/commit/14cd3289545d1229e72b08e16977286cde39db18))
* **billing:** remove redundant parseBullMQJobData from stripe-webhook processor (sec-r4-Q1) ([#502](https://github.com/nikunjmavani/core-be/issues/502)) ([d20c731](https://github.com/nikunjmavani/core-be/commit/d20c731dbaf5764fcb0ebf96376830c882991205))
* **billing:** sec-new-B1 guard cancel/resume/changePlan against terminal subscriptions ([#475](https://github.com/nikunjmavani/core-be/issues/475)) ([86bb32f](https://github.com/nikunjmavani/core-be/commit/86bb32f6de0ed2c3e293f2a17f979b9cfbfc3328))
* **billing:** sec-new-D1-D2 data integrity guards in billing writes ([#476](https://github.com/nikunjmavani/core-be/issues/476)) ([def085a](https://github.com/nikunjmavani/core-be/commit/def085adf233218dac8c01dad35e2efde385313b))
* **billing:** sec-new-M2 emit Deprecation+Sunset headers on deprecated /stripe/webhook alias ([#489](https://github.com/nikunjmavani/core-be/issues/489)) ([d95f4aa](https://github.com/nikunjmavani/core-be/commit/d95f4aa8becdae0454be1d727a09c1580fb1ff4d))
* **billing:** set concrete sunset for deprecated stripe webhook alias (audit-[#15](https://github.com/nikunjmavani/core-be/issues/15)a) ([4efb4a7](https://github.com/nikunjmavani/core-be/commit/4efb4a78e02af5da54c10fb04de02239120b1f79))
* **billing:** support comma-separated STRIPE_WEBHOOK_SECRET for zero-downtime rotation (sec-new-B3) ([#490](https://github.com/nikunjmavani/core-be/issues/490)) ([4be65fe](https://github.com/nikunjmavani/core-be/commit/4be65fe218a948b63f9386a09a934aa4cb4d42e5))
* block user delete when owning orgs + webhook updated_at flake ([08a5ac2](https://github.com/nikunjmavani/core-be/commit/08a5ac27734c2d3abb3604ab5e694abeb429d85e))
* **cache:** add commandTimeout to Redis client to prevent hung commands ([8cd8107](https://github.com/nikunjmavani/core-be/commit/8cd8107df573d5a8255911dc2fac8f21e676fb66))
* **ci:** dispatch stable release backmerge ([be9190f](https://github.com/nikunjmavani/core-be/commit/be9190f6ff26d04905bc46127717c96fbbe57ab0))
* **ci:** export GLOBAL_ADMIN_EMAILS in test-env so audit.test.ts super-admin paths work in Matrix Tests ([#532](https://github.com/nikunjmavani/core-be/issues/532)) ([873f59d](https://github.com/nikunjmavani/core-be/commit/873f59df59340bc182e3d8f261b5c2e435f89c63))
* **ci:** grant release-please job id-token + actions write permissions ([#536](https://github.com/nikunjmavani/core-be/issues/536)) ([b83eab2](https://github.com/nikunjmavani/core-be/commit/b83eab2d4ac3e2b46f5e77e00e34d720db6508e0))
* **ci:** publish API docs (incl. Scalar Registry) independently of release-please ([#676](https://github.com/nikunjmavani/core-be/issues/676)) ([7c4fe62](https://github.com/nikunjmavani/core-be/commit/7c4fe62027431e4d79e006afb84cc24c61e5fc67))
* **ci:** publish Scalar registry from GitHub Variables ([#677](https://github.com/nikunjmavani/core-be/issues/677)) ([cfaaef8](https://github.com/nikunjmavani/core-be/commit/cfaaef883eb57327cfd3f558597407250d3a752c))
* **ci:** repoint 12 dead Stryker mutate paths + drift guard (security middlewares were unmutated) ([#310](https://github.com/nikunjmavani/core-be/issues/310)) ([5609146](https://github.com/nikunjmavani/core-be/commit/560914673aa37406be1ecfc570be90d1d6756122))
* **ci:** use bare check-run names as ruleset required-check contexts ([#344](https://github.com/nikunjmavani/core-be/issues/344)) ([c431a63](https://github.com/nikunjmavani/core-be/commit/c431a63a292e9dcff7dc09147c9ae0fd7eb3d5d2))
* **ci:** use fetch-depth: 0 in post-merge changes job to avoid paths-filter race ([#390](https://github.com/nikunjmavani/core-be/issues/390)) ([61a2100](https://github.com/nikunjmavani/core-be/commit/61a210090ae518f75f459cc33806b10ba1442993))
* **config:** cap AUTH_SESSION_MAX_AGE_DAYS at 365 (sec-r4-C4) ([#510](https://github.com/nikunjmavani/core-be/issues/510)) ([2a48a88](https://github.com/nikunjmavani/core-be/commit/2a48a88355744445298e8fb36dda0c22fca0b472))
* **config:** make .env.local the self-contained primary local env file ([#650](https://github.com/nikunjmavani/core-be/issues/650)) ([aeb32e7](https://github.com/nikunjmavani/core-be/commit/aeb32e7c60d4686f71b2f14f46efe873404652c3))
* **config:** require legacy JWT gate closed once keyring configured in prod (audit-[#15](https://github.com/nikunjmavani/core-be/issues/15)b) ([43e5139](https://github.com/nikunjmavani/core-be/commit/43e5139de2e4b9f7e969b9832e8ffac1a0c32b89))
* **database:** keyset-page batch delete so FK-blocked rows can't infinite-loop retention ([fd9b523](https://github.com/nikunjmavani/core-be/commit/fd9b523ecaf1825d111a636d6cad954ecba6e83a))
* **database:** keyset-page batch delete so FK-blocked rows can't infinite-loop retention (route-audit A1) ([f81ca72](https://github.com/nikunjmavani/core-be/commit/f81ca724b6e5d25c158e02403ee39d7132c8c8f2))
* **database:** sec-new-Q4 apply worker statement timeout in system-table retention context ([#487](https://github.com/nikunjmavani/core-be/issues/487)) ([4e0b5c2](https://github.com/nikunjmavani/core-be/commit/4e0b5c2156544d72b9dbf51b4a3c07b77930492a))
* **db:** enforce RLS deny-all on billing.plans and tenancy.permissions (reaudit-[#9](https://github.com/nikunjmavani/core-be/issues/9)) ([2bb9476](https://github.com/nikunjmavani/core-be/commit/2bb947621fafabfd2ec03ca2d2fc9f905970c838))
* **deps:** bump esbuild override to &gt;=0.28.1 (GHSA-gv7w-rqvm-qjhr / GHSA-g7r4-m6w7-qqqr) ([514fa96](https://github.com/nikunjmavani/core-be/commit/514fa961bd392ef4583c7e148a7f47277ef23dae))
* **deps:** override @grpc/grpc-js to &gt;=1.14.4 (GHSA-5375-pq7m-f5r2) ([0a66557](https://github.com/nikunjmavani/core-be/commit/0a6655731c02a3efa03ca598c306fce4d34012c7))
* **docker:** add HEALTHCHECK to worker image (audit-[#15](https://github.com/nikunjmavani/core-be/issues/15)c) ([b4f7a67](https://github.com/nikunjmavani/core-be/commit/b4f7a67cc2072c9510f63906b2b1ec50ae114f92))
* **docker:** refresh apk index so base-image security patches install ([#607](https://github.com/nikunjmavani/core-be/issues/607)) ([a3690b9](https://github.com/nikunjmavani/core-be/commit/a3690b91f2f61f48f837553c74890e5d358fbec3))
* **docker:** worker HEALTHCHECK honors WORKER_HEALTH_PORT at runtime (reaudit-[#8](https://github.com/nikunjmavani/core-be/issues/8)) ([3530bff](https://github.com/nikunjmavani/core-be/commit/3530bff1c5cb6a65e21cc0f507018211150236a3))
* **email-templates:** escape URL fields in invitation and magic-link templates ([#364](https://github.com/nikunjmavani/core-be/issues/364)) ([26c67fa](https://github.com/nikunjmavani/core-be/commit/26c67fac20bff7ccf765c6d93a6264e35ebee079))
* **events:** capture swallowed event-bus errors in Sentry ([2a30d84](https://github.com/nikunjmavani/core-be/commit/2a30d845482dadbe97dd922a4bc54e974105655a))
* **events:** release commit-dispatch marker on rollback (in-memory leak) ([#324](https://github.com/nikunjmavani/core-be/issues/324)) ([7e3ec55](https://github.com/nikunjmavani/core-be/commit/7e3ec559455954d9aeb489e69c4bf416801d76d3))
* **finding-13:** escape title/preheader/footerText inside baseTemplate ([8996b26](https://github.com/nikunjmavani/core-be/commit/8996b2616b52de6f55b0b16315c4a439034e3fba))
* **finding-46:** validate DATABASE_HTTP_STATEMENT_TIMEOUT_MS stays within permission cache lock TTL ([#356](https://github.com/nikunjmavani/core-be/issues/356)) ([47bdab4](https://github.com/nikunjmavani/core-be/commit/47bdab435f83a307cc04f4dc8274f5407aeb8ad3))
* **finding-62:** export WEBHOOK_DELIVERY_JOB_ATTEMPTS and fix vi.mock factories ([#357](https://github.com/nikunjmavani/core-be/issues/357)) ([cd24515](https://github.com/nikunjmavani/core-be/commit/cd24515fa2acf75774da7d636ea42bc0212ec3a2))
* **finding-74:** replace unsafe Stripe object casts with proper type narrowing ([#359](https://github.com/nikunjmavani/core-be/issues/359)) ([f8f9cfe](https://github.com/nikunjmavani/core-be/commit/f8f9cfe8ae24f51ff34c92100dd31b2d1f7745fe))
* **infra:** throw on startup when monolithic worker pool demand exceeds DATABASE_POOL_MAX ([faf2fab](https://github.com/nikunjmavani/core-be/commit/faf2fab638f0b77d1ea82dd856d3cefefa893711))
* **infra:** use correct JWT env keys in docker-compose smoke profile (sec-r4-C5) ([#512](https://github.com/nikunjmavani/core-be/issues/512)) ([c9a48f1](https://github.com/nikunjmavani/core-be/commit/c9a48f107f0f89fe41814c253e4d3defc0595437))
* **lockfile:** regenerate pnpm-lock.yaml (merge produced duplicate mapping key) ([c2eba7e](https://github.com/nikunjmavani/core-be/commit/c2eba7eb879f20ee0b5ff182c5edf1ca64715308))
* **mail:** scrub secret-bearing body on terminally-failed outbox rows (audit-[#10](https://github.com/nikunjmavani/core-be/issues/10)) ([61dc948](https://github.com/nikunjmavani/core-be/commit/61dc948505b0eb6e4e7c60020d66a7c3663452bb))
* **mcp:** apply STRICT_AUTHED_RATE_LIMIT to MCP endpoint (audit finding [#7](https://github.com/nikunjmavani/core-be/issues/7)) ([#366](https://github.com/nikunjmavani/core-be/issues/366)) ([6783141](https://github.com/nikunjmavani/core-be/commit/6783141ed14cc7009e1ec2be258386fac1706ed3))
* **mcp:** strip X-Organization-Id from call_api proxied sub-requests (route-[#8](https://github.com/nikunjmavani/core-be/issues/8)) ([d5a7167](https://github.com/nikunjmavani/core-be/commit/d5a716716e8acff86e1523641e3f44620374411c))
* **migration:** make audit_logs_actor_api_key FK idempotent (unblock dev deploy) ([#385](https://github.com/nikunjmavani/core-be/issues/385)) ([b8cc4fb](https://github.com/nikunjmavani/core-be/commit/b8cc4fb70d3d3d13f31f4b67af35772ff5afdb7e))
* **migration:** make core_be_app least-privilege ALTER ROLE Neon-safe (unblocks all deploys) ([#341](https://github.com/nikunjmavani/core-be/issues/341)) ([488c793](https://github.com/nikunjmavani/core-be/commit/488c793ee93173a2b7d1cedb32879743c3136533))
* **notify:** cap webhook response body bytes read before truncation (audit-[#6](https://github.com/nikunjmavani/core-be/issues/6)) ([0f2421e](https://github.com/nikunjmavani/core-be/commit/0f2421e3b6b211f888f08a0161274063d7599cc1))
* **notify:** durability-first notification email dedup to stop lost emails (audit-[#7](https://github.com/nikunjmavani/core-be/issues/7)) ([b9d9759](https://github.com/nikunjmavani/core-be/commit/b9d9759885b92320210d681520ecc16236d70d2c))
* **notify:** durable mail-outbox dedupe key to close concurrent duplicate-email window (reaudit-[#4](https://github.com/nikunjmavani/core-be/issues/4)) ([47cd280](https://github.com/nikunjmavani/core-be/commit/47cd280504c9acdf324b2ff11ff4ca36ded05a1c))
* **notify:** enforce webhook secret-rotation eligibility in the update predicate (audit-[#9](https://github.com/nikunjmavani/core-be/issues/9)) ([d3337e0](https://github.com/nikunjmavani/core-be/commit/d3337e0c3ad3e314206cce494c23e6b644c90d03))
* **notify:** guard webhook secret re-rotation within the dual-sign overlap window ([0cfedd0](https://github.com/nikunjmavani/core-be/commit/0cfedd0d28177f40f354133a3d1f53b94002e955))
* **notify:** guard webhook secret re-rotation within the dual-sign overlap window (route-audit webhook-[#1](https://github.com/nikunjmavani/core-be/issues/1)) ([5c16f85](https://github.com/nikunjmavani/core-be/commit/5c16f8548c7c528944d937c60fe985ee887e8174))
* **notify:** route webhook handlers through zodApplication type provider ([eaa5684](https://github.com/nikunjmavani/core-be/commit/eaa5684c13253e6f5c7204a7dc8b479e4c9c5465))
* **notify:** sec-new-B2 replace bigserial with public_id in X-Webhook-Delivery-Id header ([#494](https://github.com/nikunjmavani/core-be/issues/494)) ([771954a](https://github.com/nikunjmavani/core-be/commit/771954a360383fcb797e38a6ea55b07d2055790c))
* **notify:** sec-new-D4 add status=PENDING filter to fallback SELECT in webhook delivery ([#488](https://github.com/nikunjmavani/core-be/issues/488)) ([164c6f8](https://github.com/nikunjmavani/core-be/commit/164c6f8a0bebbc89f0bb47d0b432e0db0bf453d7))
* **notify:** sec-new-N1 validate webhookId path param in all webhook handlers ([#482](https://github.com/nikunjmavani/core-be/issues/482)) ([d66099e](https://github.com/nikunjmavani/core-be/commit/d66099e00764f935260de97560e60529d61d5e53))
* **notify:** stamp webhook updated_at as greatest(created_at, now()) to fix chk_webhooks_updated flake ([988d87b](https://github.com/nikunjmavani/core-be/commit/988d87baf86a74ebb05ba9d81948e205ffcda2e3))
* **notify:** trim payload and response_body from webhook delivery list (sec-r4-D6) ([#518](https://github.com/nikunjmavani/core-be/issues/518)) ([89c24b7](https://github.com/nikunjmavani/core-be/commit/89c24b7f05dba72eba97447f746abb08130c61f6))
* **observability:** monitor every retention worker DLQ + add drift guard (reaudit-[#5](https://github.com/nikunjmavani/core-be/issues/5)) ([0e954dc](https://github.com/nikunjmavani/core-be/commit/0e954dcfe96a4c2d46c48815e963632468243236))
* **openapi:** registry-authoritative success statuses; deterministic OAuth coverage; scan cleanups ([a7cc7bd](https://github.com/nikunjmavani/core-be/commit/a7cc7bdeb47f4d9d5f5a18465470d8a9b2b86c67))
* **openapi:** registry-authoritative success statuses; deterministic OAuth coverage; scan cleanups ([1f84793](https://github.com/nikunjmavani/core-be/commit/1f84793ff6f149d7a759ac0223fb45a5d28d1942))
* **ops:** log circuit-breaker resets for attribution (route-[#5](https://github.com/nikunjmavani/core-be/issues/5)) ([eae48fe](https://github.com/nikunjmavani/core-be/commit/eae48fe4e9c937f7ca65d219acacb55832a1b218))
* **queue:** acknowledge commit-dispatch tasks after execution, not before (reaudit-[#2](https://github.com/nikunjmavani/core-be/issues/2)) ([8f399c0](https://github.com/nikunjmavani/core-be/commit/8f399c0ddaed24901f6c92445091770286c7a852))
* **queue:** bound audit.dead_letter_jobs growth via the audit-retention purge ([#322](https://github.com/nikunjmavani/core-be/issues/322)) ([06e729d](https://github.com/nikunjmavani/core-be/commit/06e729ddba34ce6d47ac3f2f7d73ad54910800a2))
* **queue:** bound commandTimeout on BullMQ producer connections (audit-[#5](https://github.com/nikunjmavani/core-be/issues/5)) ([2c4e21b](https://github.com/nikunjmavani/core-be/commit/2c4e21bf12dedc6039a0f0085379e80e8a83fee2))
* **queue:** monitor the offboarding-reconciler DLQ + exempt it from tenant-scoping policy (audit-[#15](https://github.com/nikunjmavani/core-be/issues/15)) ([f5f4ceb](https://github.com/nikunjmavani/core-be/commit/f5f4cebfbf7cc99072c06c0b7588d7c3eb4289fc))
* **queue:** sec-new-Q1 add env overrides for hardcoded cron schedules ([#484](https://github.com/nikunjmavani/core-be/issues/484)) ([d2d03e1](https://github.com/nikunjmavani/core-be/commit/d2d03e1c6a41861a22965a0c57707b8157ce66da))
* **queue:** sec-new-Q2 capture per-task failures in Sentry in recovery processor ([#485](https://github.com/nikunjmavani/core-be/issues/485)) ([b66a7a6](https://github.com/nikunjmavani/core-be/commit/b66a7a68ed27dc357b83b010e4778991fb198242))
* **queue:** stop DLQ auto-retry starvation via a resolved marker on exhausted rows ([#330](https://github.com/nikunjmavani/core-be/issues/330)) ([86c3817](https://github.com/nikunjmavani/core-be/commit/86c381769b50262e30687506b0c9ebeec9a739d9))
* **rate-limit,observability:** scope org rate-limit + error context by the org claim ([5e12926](https://github.com/nikunjmavani/core-be/commit/5e12926e869e17a3bd66e71a3d7ec87b98119132))
* **rate-limit,observability:** scope org rate-limit + error context by the org token claim ([b2caeb1](https://github.com/nikunjmavani/core-be/commit/b2caeb1be96e8fde9631028c4b92e047b14d433d))
* **rls:** pin core_be_app to NOSUPERUSER/NOBYPASSRLS + assert RLS-binding ([#334](https://github.com/nikunjmavani/core-be/issues/334)) ([18f8b9a](https://github.com/nikunjmavani/core-be/commit/18f8b9aa6f0ae44d45208dabf270a6c5a52c60ec))
* route-audit state-machine, billing, and cache-header findings ([d4b34ef](https://github.com/nikunjmavani/core-be/commit/d4b34ef388184860aece138aa10716b226562158))
* route-focused security audit findings ([1fffbf0](https://github.com/nikunjmavani/core-be/commit/1fffbf0270b20b7fdbeef5d0f3d86528e4fb11a5))
* **runtime:** real-world deep-flow inspection findings — 3 fixes + regression test ([#533](https://github.com/nikunjmavani/core-be/issues/533)) ([5a85ecd](https://github.com/nikunjmavani/core-be/commit/5a85ecd7d19303cb45231ec2d73082dfd6d4e631))
* **sec:** account-deletion safety — invalidate verification tokens + revoke-before-purge (sec-U1+U8) ([#404](https://github.com/nikunjmavani/core-be/issues/404)) ([43a1e5a](https://github.com/nikunjmavani/core-be/commit/43a1e5aedc49cd19f2e082febeb9b247a6bea3cf))
* **sec:** add captchaPreHandler to POST /mfa/login (sec-new-A1) ([85d2a89](https://github.com/nikunjmavani/core-be/commit/85d2a892decb1cf9e882922188633de6ffdea5c0))
* **sec:** add captchaPreHandler to POST /mfa/login (sec-new-A1) ([f2c02db](https://github.com/nikunjmavani/core-be/commit/f2c02db0212721ec29b99633f455f36f8e9f23c9))
* **sec:** add closeUserDataExportQueue to worker shutdown sequence (sec-r4-R1) ([#501](https://github.com/nikunjmavani/core-be/issues/501)) ([6e8e96f](https://github.com/nikunjmavani/core-be/commit/6e8e96ff11af4819d22cfb34df5b27f125518cbd))
* **sec:** add deleted_at guards to org-discovery RLS and invitation lookup (sec-r4-T1/T2) ([#500](https://github.com/nikunjmavani/core-be/issues/500)) ([b4ea6ee](https://github.com/nikunjmavani/core-be/commit/b4ea6ee0969cd5ff8da76b7abb68823e711d5939))
* **sec:** add partial index for audit.logs.actor_api_key_id (sec-D8) ([#432](https://github.com/nikunjmavani/core-be/issues/432)) ([761f28b](https://github.com/nikunjmavani/core-be/commit/761f28b96207265002e24ad2f263da00ff97eb99))
* **sec:** audit append-only DB invariant — split tenant-isolation policy + REVOKE UPDATE (sec-U3) ([#409](https://github.com/nikunjmavani/core-be/issues/409)) ([7991dfc](https://github.com/nikunjmavani/core-be/commit/7991dfc486ed22eff946b346982285c1f87fee65))
* **sec:** audit every data-export URL mint, rate-limit GET, drop TTL 24h→15min (sec-U6) ([#429](https://github.com/nikunjmavani/core-be/issues/429)) ([4943057](https://github.com/nikunjmavani/core-be/commit/4943057037519b0c294e4e46405d202008083973))
* **sec:** audit every login surface, not just password (sec-A8) ([#427](https://github.com/nikunjmavani/core-be/issues/427)) ([9872491](https://github.com/nikunjmavani/core-be/commit/9872491ad9ee8271d3a063738dd3b1423013095c))
* **sec:** audit hygiene — denylist metadata strip + admin user-mgmt audit + admin audit-read audit + permission-deny audit (sec-U2+U9+U4+U13) ([#408](https://github.com/nikunjmavani/core-be/issues/408)) ([98e60ff](https://github.com/nikunjmavani/core-be/commit/98e60ff889e7c94d716aaf235c0b782d05bd4a8f))
* **sec:** audit login failures alongside successes on every login surface (sec-A8 follow-up) ([#438](https://github.com/nikunjmavani/core-be/issues/438)) ([e4a9c2f](https://github.com/nikunjmavani/core-be/commit/e4a9c2f88925653cf12910efbb6258ba2c7c1d73))
* **sec:** audit serializer is strip-only with resolved public ids (sec-re-08) ([#458](https://github.com/nikunjmavani/core-be/issues/458)) ([5a07fdb](https://github.com/nikunjmavani/core-be/commit/5a07fdb15f4706478587523c96f090a92a8a3ce1))
* **sec:** auth defense in depth — last login-method guard + super-admin rederive + step-up on session revoke (sec-A5+A6+A7) ([#407](https://github.com/nikunjmavani/core-be/issues/407)) ([021c4b3](https://github.com/nikunjmavani/core-be/commit/021c4b31ce8d3c619f48ebcf43e4393ad2cf9b3d))
* **sec:** bind audit-list pagination cursor to its minting filter set (sec-U12) ([#434](https://github.com/nikunjmavani/core-be/issues/434)) ([f6a40e2](https://github.com/nikunjmavani/core-be/commit/f6a40e2db1fc34916c236f5fc3a478d5d09020df))
* **sec:** block update() on org-owner membership to prevent Admin lockout (sec-new-T1) ([dfa526a](https://github.com/nikunjmavani/core-be/commit/dfa526a03dafa3ddae99029e34651aeffa979d51))
* **sec:** block update() on org-owner membership to prevent Admin lockout (sec-new-T1) ([c3c6cfe](https://github.com/nikunjmavani/core-be/commit/c3c6cfe24145ab0cc3e63fe8a8d3d1a20d5a7642))
* **sec:** breach compression-skip actually engages in production (sec-re-03) ([#454](https://github.com/nikunjmavani/core-be/issues/454)) ([5039ccd](https://github.com/nikunjmavani/core-be/commit/5039ccd0699dac287c89a94b85e9c6a4f630c25e))
* **sec:** build Stripe customer email from a platform-owned domain, not tenant slug (sec-B11) ([#436](https://github.com/nikunjmavani/core-be/issues/436)) ([8bb5338](https://github.com/nikunjmavani/core-be/commit/8bb533845fcf074150dc3796e2038dcab01df372))
* **sec:** cache the i18n preHandler organization → locale lookup (sec-M1) ([#440](https://github.com/nikunjmavani/core-be/issues/440)) ([180937a](https://github.com/nikunjmavani/core-be/commit/180937a42a83ec058d0e66823c534db54270cf73))
* **sec:** collapse unmatched-route Prometheus label into __unmatched__ sentinel (sec-C2) ([#401](https://github.com/nikunjmavani/core-be/issues/401)) ([5fc8743](https://github.com/nikunjmavani/core-be/commit/5fc87432500a76271dc867df7b68851e5e68ed74))
* **sec:** config + middleware hardening (sec-cm batch) ([#449](https://github.com/nikunjmavani/core-be/issues/449)) ([b150253](https://github.com/nikunjmavani/core-be/commit/b15025363ad4af584a93572f1a0afb5dc76f1e4f))
* **sec:** config cleanup — drop JWT_SECRET + add deps:audit:prod to ci:local + ENABLE_RESPONSE_ENCRYPTION pairing refine (sec-C5+C10+C11) ([#419](https://github.com/nikunjmavani/core-be/issues/419)) ([7cab170](https://github.com/nikunjmavani/core-be/commit/7cab17038463c7a568e36c48f4c10acc0e6235f3))
* **sec:** cors exposes x-client-request-id (sec-re-17) ([#467](https://github.com/nikunjmavani/core-be/issues/467)) ([8960cfc](https://github.com/nikunjmavani/core-be/commit/8960cfcc13b33e6abb222631ff5de62f3b1d9a7b))
* **sec:** data-export request route advertises 15-minute URL lifetime (sec-re-12) ([#462](https://github.com/nikunjmavani/core-be/issues/462)) ([bc7cea3](https://github.com/nikunjmavani/core-be/commit/bc7cea3c096583e338e25edca4d58d59616718c4))
* **sec:** db retention growth — verification token sweep + AUDIT_RETENTION_DAYS cap (sec-D5+U10) ([#415](https://github.com/nikunjmavani/core-be/issues/415)) ([ab9428b](https://github.com/nikunjmavani/core-be/commit/ab9428b5a5cd93a24ce283f8598dd318e0e0ef03))
* **sec:** db stability — drop volatile chk_org_notif_muted + worker statement_timeout + audit.logs target_user_id index (sec-D1+D2+D3) ([#414](https://github.com/nikunjmavani/core-be/issues/414)) ([f77ce4a](https://github.com/nikunjmavani/core-be/commit/f77ce4aee1366eaa1ff82da6575b5011dd382ca5))
* **sec:** delete dead findActiveByUserId / findActiveByOrganizationId (sec-D12) ([#437](https://github.com/nikunjmavani/core-be/issues/437)) ([6367dd4](https://github.com/nikunjmavani/core-be/commit/6367dd45ca44614f1e0a2d10fd2dfdf0df9f390e))
* **sec:** derive invitation email from membership user on create (sec-T1 complete) ([#471](https://github.com/nikunjmavani/core-be/issues/471)) ([6d54c99](https://github.com/nikunjmavani/core-be/commit/6d54c99a15cd6c1dc48ec3b1c6357c540db4bf29))
* **sec:** dlq replay no-op + commit-dispatch cleanup + worker hardening (sec-q batch) ([#444](https://github.com/nikunjmavani/core-be/issues/444)) ([6c96a0b](https://github.com/nikunjmavani/core-be/commit/6c96a0bb1c47d016d87735cbe16ee173e7de19c4))
* **sec:** do not clear session cookie in revokeAllSessions handler (sec-r4-A1) ([#499](https://github.com/nikunjmavani/core-be/issues/499)) ([b7e3952](https://github.com/nikunjmavani/core-be/commit/b7e395262f8ec06a84a5426b9c4a9dafa85ec351))
* **sec:** docker.agent USER node + drop openssh + enforce abort timeout on retrieveStripeEvent (sec-C8 + sec-Q5 partial) ([#422](https://github.com/nikunjmavani/core-be/issues/422)) ([d10af52](https://github.com/nikunjmavani/core-be/commit/d10af524ec39a00994b041f7727d18cc6e81639b))
* **sec:** document the online-safe ALTER COLUMN pattern (sec-D6) ([#443](https://github.com/nikunjmavani/core-be/issues/443)) ([c72deb4](https://github.com/nikunjmavani/core-be/commit/c72deb4e3f9b7cdaba267b14948fd73025dce3e3))
* **sec:** document verification_tokens application-trust safety model (sec-D9) ([#441](https://github.com/nikunjmavani/core-be/issues/441)) ([e069891](https://github.com/nikunjmavani/core-be/commit/e069891909cd0487a4cd5ab523930f8b0d6e105d))
* **sec:** drop org branch from user_notification_preferences RLS + add CHECK pin (sec-U7) ([#428](https://github.com/nikunjmavani/core-be/issues/428)) ([13fc188](https://github.com/nikunjmavani/core-be/commit/13fc188e22603b55f3226994399e5564e50f5843))
* **sec:** enforce SSE-S3 on every server-side S3 write (sec-U11) ([#435](https://github.com/nikunjmavani/core-be/issues/435)) ([0792d76](https://github.com/nikunjmavani/core-be/commit/0792d76c07ece878f8adc1f282f1966efbe54ae7))
* **sec:** expose policy public_id instead of bigserial in URLs and responses (sec-T5) ([#442](https://github.com/nikunjmavani/core-be/issues/442)) ([88d5db7](https://github.com/nikunjmavani/core-be/commit/88d5db72bc21184da5ea00ec0baaa0256d0f03a9))
* **sec:** extend staging guards to ALLOWED_ORIGINS, COOKIE_SECURE, and SECRETS_ENCRYPTION_KEY (sec-r4-C1/C2/C3) ([#498](https://github.com/nikunjmavani/core-be/issues/498)) ([0efd169](https://github.com/nikunjmavani/core-be/commit/0efd169841cea7cfba5197012dfb6e3f615fe629))
* **sec:** fall back to INSERT when subscription.created arrives before local row (sec-B9) ([#439](https://github.com/nikunjmavani/core-be/issues/439)) ([fd68e66](https://github.com/nikunjmavani/core-be/commit/fd68e660e7d19d1707b0bfe97ac4fe29d08ab427))
* **sec:** harden invitation binding, webhook retry, role invariants, and upload key contract ([#470](https://github.com/nikunjmavani/core-be/issues/470)) ([65cdf2f](https://github.com/nikunjmavani/core-be/commit/65cdf2f9179ac01aa1110f95b60cb6a7fd1519db))
* **sec:** invitation accept requires auth + invitee email match (sec-T4) ([#423](https://github.com/nikunjmavani/core-be/issues/423)) ([7cdc3f8](https://github.com/nikunjmavani/core-be/commit/7cdc3f83beafaa9e682bf39348cb1caa4047c2fb))
* **sec:** mark-confirmed-by-internal-id filters deleted_at and pending (sec-re-13) ([#463](https://github.com/nikunjmavani/core-be/issues/463)) ([dbd9156](https://github.com/nikunjmavani/core-be/commit/dbd9156fd40ff4e2e92ab6ace5823b2e60279e60))
* **sec:** mfa hardening — step-up requires mfa + per-session binding + org-policy delete guard (sec-A1+A2+A4) ([#403](https://github.com/nikunjmavani/core-be/issues/403)) ([1ba5047](https://github.com/nikunjmavani/core-be/commit/1ba504726442aaaea626d2b73f542c55b8214d0a))
* **sec:** mfa is_mfa_enabled flip happens inside the enrollConfirm transaction (sec-re-06) ([#469](https://github.com/nikunjmavani/core-be/issues/469)) ([675c1f2](https://github.com/nikunjmavani/core-be/commit/675c1f257bb02ecf3967a3295ff1f6d1068da136))
* **sec:** mfa re-enroll dedups stale totp factors (sec-re-04) ([#455](https://github.com/nikunjmavani/core-be/issues/455)) ([f7a66ab](https://github.com/nikunjmavani/core-be/commit/f7a66abb8218a13bbf92472ba3fc0c3e26ab6f3e))
* **sec:** middleware observability — captcha bypass closed in staging + HSTS env gate + ALLOWED_ORIGINS canonicalization + encryption 503 (sec-M3+M5+M8+M9) ([#417](https://github.com/nikunjmavani/core-be/issues/417)) ([57abed9](https://github.com/nikunjmavani/core-be/commit/57abed9c55fa7fc50c72b1161e8270b5a64b024f))
* **sec:** notification worker user context + db integrity indexes (sec-d batch) ([#450](https://github.com/nikunjmavani/core-be/issues/450)) ([a1a8fe5](https://github.com/nikunjmavani/core-be/commit/a1a8fe5c15fd5b3c4b8437413ef40e5b4efeb821))
* **sec:** notification worker user-context fix is live wiring (sec-re-01) ([#452](https://github.com/nikunjmavani/core-be/issues/452)) ([653adf5](https://github.com/nikunjmavani/core-be/commit/653adf5653b634dcf907927ad4f6a660256f8a79))
* **sec:** notify abuse caps — per-organization webhook cap + secret-rotation overlap window (sec-N4+N8) ([#411](https://github.com/nikunjmavani/core-be/issues/411)) ([a7455f5](https://github.com/nikunjmavani/core-be/commit/a7455f5548d20fe8460b92154e17b2ca75eda24a))
* **sec:** notify durability — worker re-checks disabled/deleted + delivery-id header + event_key dedupe (sec-N1+N3+N2) ([#410](https://github.com/nikunjmavani/core-be/issues/410)) ([c09ae6c](https://github.com/nikunjmavani/core-be/commit/c09ae6c7acad9de05fe7c28f365ba9af84795c16))
* **sec:** notify recipient + idempotency canonical fingerprint + tenant authorized-org helper (sec-N7+M6+M7) ([#420](https://github.com/nikunjmavani/core-be/issues/420)) ([17a8bbd](https://github.com/nikunjmavani/core-be/commit/17a8bbdc9d364eb9b5bfa5f71d0ffbe86e30645e))
* **sec:** org-scoped audit log sanitiser + strip-only serializers (sec-t batch) ([#448](https://github.com/nikunjmavani/core-be/issues/448)) ([6019182](https://github.com/nikunjmavani/core-be/commit/6019182b695080795d232d7afe04b96659ff34d2))
* **sec:** protect owner role from permission writes via ROLE_MANAGE (sec-T2) ([#402](https://github.com/nikunjmavani/core-be/issues/402)) ([6b11b6e](https://github.com/nikunjmavani/core-be/commit/6b11b6e6da7e825d48d7348b50576861a5fc4cbc))
* **sec:** queue infrastructure — defaultJobOptions on cron queues + flip topology warn + fail boot on scheduler drift in prod (sec-Q1+Q2+Q3) ([#416](https://github.com/nikunjmavani/core-be/issues/416)) ([32b960e](https://github.com/nikunjmavani/core-be/commit/32b960e03cc6a164d137dc080f583846b93635a9))
* **sec:** rate-limit per-email bucket id is hashed (sec-re-11) ([#461](https://github.com/nikunjmavani/core-be/issues/461)) ([4239be4](https://github.com/nikunjmavani/core-be/commit/4239be4ddb5d3432295565b4bb8e110612e97012))
* **sec:** recovery-code alphabet doc reflects 31 symbols and case-insensitive hash (sec-re-14) ([#464](https://github.com/nikunjmavani/core-be/issues/464)) ([1bc8b00](https://github.com/nikunjmavani/core-be/commit/1bc8b001519154b9e5da12abf4a4d808b12cd9d8))
* **sec:** refresh stale ordering comments around the no-op RLS-transaction plugin (sec-M4) ([#433](https://github.com/nikunjmavani/core-be/issues/433)) ([1bd211e](https://github.com/nikunjmavani/core-be/commit/1bd211e288ac062486e9374667e1619401e4f666))
* **sec:** refresh-token reuse detection fires for revoked sessions (sec-re-05) ([#456](https://github.com/nikunjmavani/core-be/issues/456)) ([bf5ee5e](https://github.com/nikunjmavani/core-be/commit/bf5ee5e30c0233d13a0f28d0b9b2afff4df0da4c))
* **sec:** remove privilege-bypass arms from audit.logs INSERT RLS (sec-r4-D1) ([#497](https://github.com/nikunjmavani/core-be/issues/497)) ([787b3c8](https://github.com/nikunjmavani/core-be/commit/787b3c8d20ebb37f97ef9cd2d27aa66f992df7c3))
* **sec:** replace z.coerce.boolean() foot-gun on env booleans (sec-C1) ([#400](https://github.com/nikunjmavani/core-be/issues/400)) ([f8a49c3](https://github.com/nikunjmavani/core-be/commit/f8a49c367e9bbc5cdc7e54e9d9c988e4dbe13bca))
* **sec:** repository hygiene — atomic markAllRead count + WebAuthn counter monotonicity guard (sec-D10/D11) ([#426](https://github.com/nikunjmavani/core-be/issues/426)) ([1d817db](https://github.com/nikunjmavani/core-be/commit/1d817db6ded2820f9334b31d05ca4e4b23ae30b2))
* **sec:** require caller can grant target role permissions on membership create (sec-T1) ([#399](https://github.com/nikunjmavani/core-be/issues/399)) ([899aab3](https://github.com/nikunjmavani/core-be/commit/899aab3abcf9de727a8b0e7fe3ecdcb7ad14d654))
* **sec:** require caller to hold every code added or removed on role-permission PUT (sec-T2) ([#425](https://github.com/nikunjmavani/core-be/issues/425)) ([b9b545e](https://github.com/nikunjmavani/core-be/commit/b9b545ee4de3c1b36bd05a8d80e8ebce8f497565))
* **sec:** require live-mode + both-or-neither Stripe keys in production (sec-B5/B6) ([#424](https://github.com/nikunjmavani/core-be/issues/424)) ([2ca7f2c](https://github.com/nikunjmavani/core-be/commit/2ca7f2cdb4e411275f465164b91ae2099f98a395))
* **sec:** role-delete guards + strip is_system from createMemberRoleDto (sec-T3) ([#406](https://github.com/nikunjmavani/core-be/issues/406)) ([1b41ab9](https://github.com/nikunjmavani/core-be/commit/1b41ab98cfaedfb11a7f5f3c87c26106e8bc2373))
* **sec:** sentry/log redaction + observability — OTLP https refine + readyz verbose env gate + Sentry message/exception/user redaction + LOG_LEVEL enum (sec-C3+C4+C6+C9) ([#418](https://github.com/nikunjmavani/core-be/issues/418)) ([b0337ce](https://github.com/nikunjmavani/core-be/commit/b0337ce2ad6f21ac16b0c97fccda158e7c64dd55))
* **sec:** stripe event retrieve honours per-attempt timeout for real (sec-re-15) ([#465](https://github.com/nikunjmavani/core-be/issues/465)) ([d5640da](https://github.com/nikunjmavani/core-be/commit/d5640daf8c1bacf06e9ca92894ac4d97a9945fe3))
* **sec:** stripe ingress durability + ordering + raw-body wiring (sec-b batch) ([#446](https://github.com/nikunjmavani/core-be/issues/446)) ([8a88beb](https://github.com/nikunjmavani/core-be/commit/8a88beb6cd7ea43f4cf42d034f2a37ba6a241d9e))
* **sec:** stripe reclaim cron→worker handoff is recoverable (sec-re-02) ([#453](https://github.com/nikunjmavani/core-be/issues/453)) ([3cdce4f](https://github.com/nikunjmavani/core-be/commit/3cdce4fcaabf0b6895b73c4feb412f0edd451080))
* **sec:** stripe reconciliation — close 4 silent-divergence paths (sec-B1+B2+B3+B4) ([#405](https://github.com/nikunjmavani/core-be/issues/405)) ([87ab3fb](https://github.com/nikunjmavani/core-be/commit/87ab3fb998f712f5a1b033708c1d65b9ba4c8b82))
* **sec:** subscription response surfaces plan public id (sec-re-07) ([#457](https://github.com/nikunjmavani/core-be/issues/457)) ([537325c](https://github.com/nikunjmavani/core-be/commit/537325c9f8f71a7e7452db8126bcb5517c8b2b1b))
* **sec:** sync local plan_id from Stripe customer.subscription.updated (sec-B7) ([#430](https://github.com/nikunjmavani/core-be/issues/430)) ([bc5a21a](https://github.com/nikunjmavani/core-be/commit/bc5a21ae87d6c253ad7094e752859fe254492d0e))
* **sec:** tenant context lifts the worker statement_timeout (sec-re-16) ([#466](https://github.com/nikunjmavani/core-be/issues/466)) ([415a58e](https://github.com/nikunjmavani/core-be/commit/415a58eb3a4c8c2334d8bcd5649f1348fdf9f455))
* **sec:** tombstoneAllByOrganizationId removes S3 objects synchronously (sec-UP8) ([#421](https://github.com/nikunjmavani/core-be/issues/421)) ([186bd71](https://github.com/nikunjmavani/core-be/commit/186bd711303862d3386cc6f7391ef0dd73928613))
* **sec:** two-phase mfa enrollment + refresh reuse-detection + login uniformity (sec-a batch) ([#445](https://github.com/nikunjmavani/core-be/issues/445)) ([d1e1e59](https://github.com/nikunjmavani/core-be/commit/d1e1e593bcf31c515f22fb1e2c4d07a89c76e81c))
* **sec:** upload confirm pins copy to verified etag (sec-re-10) ([#460](https://github.com/nikunjmavani/core-be/issues/460)) ([2eb3d11](https://github.com/nikunjmavani/core-be/commit/2eb3d11ca070c52c0e4fcf2cc5c5c0c391573837))
* **sec:** upload security — refuse legacy in-place + sweep refuses SVG + assertKeyConfirmedForOwner + DOMPurify hardening (sec-UP1+UP2+UP5+UP6) ([#412](https://github.com/nikunjmavani/core-be/issues/412)) ([76e80ad](https://github.com/nikunjmavani/core-be/commit/76e80ad3617b7d87f57fc292c6e41efba7f89d89))
* **sec:** upload size/policy — organizationId regex + org pending cap + force presigned POST in prod (sec-UP3+UP4+UP10) ([#413](https://github.com/nikunjmavani/core-be/issues/413)) ([237d517](https://github.com/nikunjmavani/core-be/commit/237d517905e321c9c73c1e9cc8f9fa181a73a597))
* **security:** add maxItems array bounds and fix WebAuthn type casts ([#363](https://github.com/nikunjmavani/core-be/issues/363)) ([ab4e7c7](https://github.com/nikunjmavani/core-be/commit/ab4e7c7c6fb65f374c458b18ef7b8b5927b0e77d))
* **security:** fail closed on privileged re-derivation + bound all retention settings (audit-[#16](https://github.com/nikunjmavani/core-be/issues/16), [#14](https://github.com/nikunjmavani/core-be/issues/14)) ([65a4347](https://github.com/nikunjmavani/core-be/commit/65a4347972c7d029600559f69a080fc611bc555d))
* **security:** mark recovery-codes + presigned-URL responses no-store / non-cacheable (route-audit-[#3](https://github.com/nikunjmavani/core-be/issues/3)) ([bc67eed](https://github.com/nikunjmavani/core-be/commit/bc67eed1cc521709b36e4eca38289310276ff922))
* **security:** reject JWT tokens with unknown kid when keyring is active ([#347](https://github.com/nikunjmavani/core-be/issues/347)) ([2bedfa1](https://github.com/nikunjmavani/core-be/commit/2bedfa1fc7bfe30ebe07e3529cfe8b7c8c78a15d))
* **security:** remediate all 16 findings from the 2026-06-14 dev security audit ([01a22aa](https://github.com/nikunjmavani/core-be/commit/01a22aa5f83fbd1f784039a98b5ac4eda151efdb))
* **security:** remediate all 16 findings from the 2026-06-14 dev security audit ([#600](https://github.com/nikunjmavani/core-be/issues/600)) ([01a22aa](https://github.com/nikunjmavani/core-be/commit/01a22aa5f83fbd1f784039a98b5ac4eda151efdb))
* **security:** require explicit wildcard prefix for webhook allowlist subdomain matching ([8d79c89](https://github.com/nikunjmavani/core-be/commit/8d79c891b2a88a8a44cca1420535cfcc6a567a12))
* **security:** strip privileged headers from MCP call_api and remove unversioned aliases ([#348](https://github.com/nikunjmavani/core-be/issues/348)) ([cdaf9ce](https://github.com/nikunjmavani/core-be/commit/cdaf9cef188e146b090bf411dc21e803c53ddea7))
* **security:** strip Stripe-shaped literals from source + add regression test (GH secret-scanning) ([#529](https://github.com/nikunjmavani/core-be/issues/529)) ([f234e60](https://github.com/nikunjmavani/core-be/commit/f234e6044879c72385e3b61728ea4ba665931ae6))
* **security:** untrack agent-os/mcp/mcp.json and repair stale ai/ paths ([#560](https://github.com/nikunjmavani/core-be/issues/560)) ([b3547a4](https://github.com/nikunjmavani/core-be/commit/b3547a43172e2388c0a1a2e4fa8e0388d046b4c6))
* **sec:** validate membership and api-key path params at the boundary (sec-re-18) ([#468](https://github.com/nikunjmavani/core-be/issues/468)) ([c0ab171](https://github.com/nikunjmavani/core-be/commit/c0ab17106d8e7dd27513e3bf2f76a480775fd557))
* **sec:** validate subscriptionId path param at every billing handler (sec-B10) ([#431](https://github.com/nikunjmavani/core-be/issues/431)) ([2bbd338](https://github.com/nikunjmavani/core-be/commit/2bbd33864cd192a22d5d41f70ed7064a628a3809))
* **sec:** webhook secret strength + upload sweep file_key invariant + data-export doc (sec-up batch) ([#447](https://github.com/nikunjmavani/core-be/issues/447)) ([145c838](https://github.com/nikunjmavani/core-be/commit/145c8385ec8b02c25b0b508adbabd71c2ce8dc05))
* **setup:** activate pinned Node on PATH in agent bootstrap step 1 ([#649](https://github.com/nikunjmavani/core-be/issues/649)) ([968d54f](https://github.com/nikunjmavani/core-be/commit/968d54fae13b6e8cb9c40c39e565c116739dd479))
* **storage:** distinguish S3 not-found from transient failure (audit-[#5](https://github.com/nikunjmavani/core-be/issues/5)) ([5ba8d00](https://github.com/nikunjmavani/core-be/commit/5ba8d002a05a423b8a2e8b99e4f23c29a1d79e51))
* **storage:** enforce SSE-S3 on presigned uploads (sec-r4-E1) ([#509](https://github.com/nikunjmavani/core-be/issues/509)) ([f962d37](https://github.com/nikunjmavani/core-be/commit/f962d372565e05986fb00a2cef960694b4b35885))
* **storage:** serve public media via a distribution and refuse public URLs for private keys (audit-[#13](https://github.com/nikunjmavani/core-be/issues/13)) ([cc10be0](https://github.com/nikunjmavani/core-be/commit/cc10be00c43a9891bff17bfc097f9ba50c5a165d))
* **stripe:** tighten webhook replay window to 150 s (audit finding [#6](https://github.com/nikunjmavani/core-be/issues/6)) ([#365](https://github.com/nikunjmavani/core-be/issues/365)) ([848360d](https://github.com/nikunjmavani/core-be/commit/848360d739857212d1822c6e9e4564498649b5c3))
* **tenancy,notify:** atomic role-delete, webhook clock-skew, security_policy proto guard (route-audit C2, C3, C4) ([ddf4f35](https://github.com/nikunjmavani/core-be/commit/ddf4f35762595f2318930855bf1bfccaba3a30ed))
* **tenancy,notify:** make per-scope resource caps atomic with an advisory lock (audit-[#8](https://github.com/nikunjmavani/core-be/issues/8)) ([3681133](https://github.com/nikunjmavani/core-be/commit/3681133339f47f68570aaf54f773ae8c5964238b))
* **tenancy,security:** post-flatten audit corrections — idempotency claim scope + personal-org guards ([e105372](https://github.com/nikunjmavani/core-be/commit/e10537260c541131a4386bb37570653242fcc41b))
* **tenancy,security:** post-flatten audit corrections — idempotency claim scope, personal-org guards, dead-code cleanup ([018fb31](https://github.com/nikunjmavani/core-be/commit/018fb313308ea78843d22df4dd234dc41dea1190))
* **tenancy:** bound MemberRolePermissionRepository.findByRoleId rows per role (sec-r4-D4) ([#508](https://github.com/nikunjmavani/core-be/issues/508)) ([9218518](https://github.com/nikunjmavani/core-be/commit/92185187cd5397f4f349442626a936f55e718b7b))
* **tenancy:** emit public ids (not internal bigserial ids) in membership responses ([#329](https://github.com/nikunjmavani/core-be/issues/329)) ([3aac2ac](https://github.com/nikunjmavani/core-be/commit/3aac2ac13d072c1f41bf71bd296468de63d73b3c))
* **tenancy:** exclude soft-deleted orgs from organizations_tenant_isolation RLS policy (sec-new-D3) ([#491](https://github.com/nikunjmavani/core-be/issues/491)) ([904802a](https://github.com/nikunjmavani/core-be/commit/904802affcc95bea74e6f510b64c655ccbd46df0))
* **tenancy:** make API-key rotation atomic against concurrent rotations ([#307](https://github.com/nikunjmavani/core-be/issues/307)) ([dc0aaa3](https://github.com/nikunjmavani/core-be/commit/dc0aaa326109b5acaeafbe7b7be5f8c5573cd01e))
* **tenancy:** only activate INVITED memberships on invitation accept (route-audit-[#1](https://github.com/nikunjmavani/core-be/issues/1)) ([aeea26a](https://github.com/nikunjmavani/core-be/commit/aeea26af9f5346fdbf4c7dd38745de90d8951b14))
* **tenancy:** rate-limit membership lifecycle endpoints (sec-r4-I3) ([#505](https://github.com/nikunjmavani/core-be/issues/505)) ([1f0c8c0](https://github.com/nikunjmavani/core-be/commit/1f0c8c01d38bbaa6020b8a8cab7e3d5b0657b0b7))
* **tenancy:** rate-limit organization mutation endpoints (sec-r4-I2) ([#504](https://github.com/nikunjmavani/core-be/issues/504)) ([2f6bedb](https://github.com/nikunjmavani/core-be/commit/2f6bedb59ca27d9d11c68299560470d8f0418d77))
* **tenancy:** reject prototype-pollution keys in organization security_policy (route-audit hardening) ([b1eba43](https://github.com/nikunjmavani/core-be/commit/b1eba43d872fe1ff7e018edd45eb42c10f67fa3f))
* **tenancy:** revoke a removed member's API keys on membership removal (reaudit-[#7](https://github.com/nikunjmavani/core-be/issues/7)) ([1387bd3](https://github.com/nikunjmavani/core-be/commit/1387bd306046d439b5f52840e4b45ae0f0794037))
* **tenancy:** scale permission-cache stampede poll budget to lock TTL (audit-[#9](https://github.com/nikunjmavani/core-be/issues/9)) ([5322d0f](https://github.com/nikunjmavani/core-be/commit/5322d0fae4dc9043f3563eda431d880ccab74f97))
* **tenancy:** sec-new-M1 add STRICT_AUTHED_RATE_LIMIT to POST /organizations ([#477](https://github.com/nikunjmavani/core-be/issues/477)) ([dd9fd62](https://github.com/nikunjmavani/core-be/commit/dd9fd62112aefe4eaa63869ab6c37ac62ee8540c))
* **tenancy:** sec-new-T2 validate invitationId path param in all invitation handlers ([#480](https://github.com/nikunjmavani/core-be/issues/480)) ([93fa940](https://github.com/nikunjmavani/core-be/commit/93fa940a7d371acd95889257b027075d305d1e60))
* **tenancy:** sec-new-T3 validate id and roleId path params in role handlers ([#481](https://github.com/nikunjmavani/core-be/issues/481)) ([361159a](https://github.com/nikunjmavani/core-be/commit/361159aca4126ae5df7b446dd437c199082a9636))
* **tenancy:** throttle api-key last_used_at writes (audit-[#8](https://github.com/nikunjmavani/core-be/issues/8)) ([96b3e56](https://github.com/nikunjmavani/core-be/commit/96b3e562e136892ff44e5adf2f06009bdcce5a06))
* **tests:** align e2e fixtures with audit batch2 (WebAuthn typed DTO) + Stripe items.period ([#384](https://github.com/nikunjmavani/core-be/issues/384)) ([b906731](https://github.com/nikunjmavani/core-be/commit/b906731f9fdfb6813303c3f25a0ce148a1e2023a))
* **tests:** cleanupDatabase preserves schema_migrations; update tests inherited from main's B4 + sec-r4-A1 semantics ([#525](https://github.com/nikunjmavani/core-be/issues/525)) ([169327e](https://github.com/nikunjmavani/core-be/commit/169327ec7652cefd7301b8d0c1c47009caa9ae5e))
* three pre-existing dev post-merge CI failures (migration idempotency, Stripe Date bind, permission seed) ([#614](https://github.com/nikunjmavani/core-be/issues/614)) ([798cefe](https://github.com/nikunjmavani/core-be/commit/798cefe26f59b8f56c3987f437772d707a42e364))
* **upload:** add DTO-level fileSize ceiling (sec-r4-I4) ([#515](https://github.com/nikunjmavani/core-be/issues/515)) ([049f917](https://github.com/nikunjmavani/core-be/commit/049f917c71b8c043e39bbbcd40f93eec534994fc))
* **upload:** lock the organization pending-upload quota at the org scope (audit-[#7](https://github.com/nikunjmavani/core-be/issues/7)) ([171a0fc](https://github.com/nikunjmavani/core-be/commit/171a0fc4c618c93c4bc74aafe0c3ec45f6376b74))
* **upload:** reclaim orphaned avatar/logo objects + owner-binding + purpose/target check (L1/L2/L3) ([7ffef76](https://github.com/nikunjmavani/core-be/commit/7ffef768a889cab424139e42cab34e7f055f6bb9))
* **upload:** reclaim orphaned avatar/logo objects, wire owner-binding gate, validate purpose-target (route-audit L1, L2, L3) ([d9d9738](https://github.com/nikunjmavani/core-be/commit/d9d97381082b330d32843511d29e8823fde2cb56))
* **user-data-export:** bound offboarding S3 delete fan-out (sec-r4-R2) ([#513](https://github.com/nikunjmavani/core-be/issues/513)) ([6ef83de](https://github.com/nikunjmavani/core-be/commit/6ef83de5039fcb08bd4422ad04cfc4282ee53bd4))
* **user:** block admin suspend/delete of protected super-admins (route-[#1](https://github.com/nikunjmavani/core-be/issues/1)) ([b84259d](https://github.com/nikunjmavani/core-be/commit/b84259d3f6cbb34ffb2f8617e900aa0157fc5fae))
* **user:** block deleting a user who still owns organizations (route-audit-[#2](https://github.com/nikunjmavani/core-be/issues/2) follow-up) ([f94b7c9](https://github.com/nikunjmavani/core-be/commit/f94b7c9c0c95d1525ea31fe41e44970efe452f19))
* **user:** rate-limit /me profile mutation endpoints (sec-r4-I1) ([#503](https://github.com/nikunjmavani/core-be/issues/503)) ([0c745e1](https://github.com/nikunjmavani/core-be/commit/0c745e182c0c6be2de608f42e9c434212ad07c08))
* **user:** rate-limit admin user-management mutations (route-[#4](https://github.com/nikunjmavani/core-be/issues/4)) ([a0d8114](https://github.com/nikunjmavani/core-be/commit/a0d8114b28fc1730fbc982271018d64700569537))
* **user:** reject org-scoped notification preference with 400 (was raw 42501 -&gt; 500) ([#327](https://github.com/nikunjmavani/core-be/issues/327)) ([db1e7a7](https://github.com/nikunjmavani/core-be/commit/db1e7a77e3c8f464bd8354f1235a1f33c5c71967))
* **user:** sec-new-U1 cap ListUsersDto.after cursor to 512 chars ([#483](https://github.com/nikunjmavani/core-be/issues/483)) ([fae555d](https://github.com/nikunjmavani/core-be/commit/fae555dd2717a4cde9a703f64941cca09d55e33f))
* **user:** unique notification-preference natural key + input dedupe (audit-[#11](https://github.com/nikunjmavani/core-be/issues/11)) ([6805459](https://github.com/nikunjmavani/core-be/commit/68054599b5fb2a120c6fb8571f23a76dc9277e7a))
* validators (audit follow-up) — centralize AES_GCM_IV_LENGTH, allowlist 5 and 512, env-load sunset validator ([#378](https://github.com/nikunjmavani/core-be/issues/378)) ([3bae917](https://github.com/nikunjmavani/core-be/commit/3bae917577c65d11cf771725f81392a0a62ce904))


### Performance

* parallelize S3 object deletes in deleteAllExportsForUser ([#361](https://github.com/nikunjmavani/core-be/issues/361)) ([4c36173](https://github.com/nikunjmavani/core-be/commit/4c36173e703bfaa9737ed2a529f0e28e8f863046))


### Changed

* **api:** rename inbound Idempotency-Key header to X-Idempotency-Key ([#656](https://github.com/nikunjmavani/core-be/issues/656)) ([b595c1b](https://github.com/nikunjmavani/core-be/commit/b595c1b0ed35a9248f1dd53660c7b3afb849eee4))
* **api:** semantic snake_case params, prefixed public ids, uniform status policy, documented headers ([03820fb](https://github.com/nikunjmavani/core-be/commit/03820fb407116e2532f2afdf12133861b8c58497))
* **api:** semantic snake_case route params, prefixed public ids, uniform method-status policy, documented headers ([3311bc0](https://github.com/nikunjmavani/core-be/commit/3311bc022f65fcbd517802cc91dcb194d5a31c0c))
* **architecture:** move raw SQL out of stripe-webhook-organization.util into the repository (+ global gate) ([#530](https://github.com/nikunjmavani/core-be/issues/530)) ([f48fb46](https://github.com/nikunjmavani/core-be/commit/f48fb46fe1005a95adc0abf14222df8f86c030f9))
* **billing:** remove deprecated /stripe/webhook alias ([#670](https://github.com/nikunjmavani/core-be/issues/670)) ([e0a4c8b](https://github.com/nikunjmavani/core-be/commit/e0a4c8bfac04fcbe041c6b6c1e47a5585d411820))
* **constants:** centralize scope-localized config constants ([#667](https://github.com/nikunjmavani/core-be/issues/667)) ([f6dad66](https://github.com/nikunjmavani/core-be/commit/f6dad66887513bd519c020794526b3b32c8c728a))
* enforce architecture boundaries (DB-in-services, DI, controller thinness) ([#602](https://github.com/nikunjmavani/core-be/issues/602)) ([cc43b3b](https://github.com/nikunjmavani/core-be/commit/cc43b3b3f38cd94d190928ac6728f1077195bbbf))
* **quality:** clear SonarQube debt on the deployed surface ([#663](https://github.com/nikunjmavani/core-be/issues/663)) ([8f5116a](https://github.com/nikunjmavani/core-be/commit/8f5116a5ddb29ac435078922ed7188ca4f6f1df3))
* **queue:** remove redundant alert-only offboarding reconciler ([#611](https://github.com/nikunjmavani/core-be/issues/611)) ([55e979e](https://github.com/nikunjmavani/core-be/commit/55e979e10528a3b6c794aaea1595e7feeedbc7b6))
* route consistency + personal/team org model ([#658](https://github.com/nikunjmavani/core-be/issues/658)) ([d304b88](https://github.com/nikunjmavani/core-be/commit/d304b88439d8611d7b7d668f4b0d1f15c9a7a2dc))
* **tenancy:** route org-scoped controllers through claim-aware org accessor ([f4c3b54](https://github.com/nikunjmavani/core-be/commit/f4c3b54f70b5c9c49c2a03cf908f1407810138a8))
* **tenancy:** route org-scoped controllers through claim-aware org accessor ([af30b20](https://github.com/nikunjmavani/core-be/commit/af30b20e50b8c49f3c906bbbb1ca6d4093fd14ef))
* **validation:** extract shared parseWithSchema + parseCursorPaginatedQuery helpers ([#661](https://github.com/nikunjmavani/core-be/issues/661)) ([7831156](https://github.com/nikunjmavani/core-be/commit/78311567eb27b6676b63fa3dec89ab3d1bab3130))


### Documentation

* add 2026-06-04 deep audit report (20 findings) ([6515589](https://github.com/nikunjmavani/core-be/commit/65155899935406e72781fab5348f146b20b5b8e4))
* add deep backend audit report 2026-06-03 ([#362](https://github.com/nikunjmavani/core-be/issues/362)) ([3d7ae31](https://github.com/nikunjmavani/core-be/commit/3d7ae31779c7975b4b61d19c8f7867c8a58432a9))
* add remediation status tracker to 2026-06-03 audit report ([93ef121](https://github.com/nikunjmavani/core-be/commit/93ef12150cd3917f3a6ecc46c9e8da4573ada94b))
* **agent-os:** align schema skills to varchar(n) codebase convention ([#638](https://github.com/nikunjmavani/core-be/issues/638)) ([e575074](https://github.com/nikunjmavani/core-be/commit/e5750743e7a8af7a59eebd06d552ca8223a598d1))
* **agent-os:** correct stale workflow, seed, and provider paths in skills ([#641](https://github.com/nikunjmavani/core-be/issues/641)) ([5550f4c](https://github.com/nikunjmavani/core-be/commit/5550f4c274b58403008bb98dd4982642565ed110))
* **api:** add frontend auth & headers integration guide ([b8ca013](https://github.com/nikunjmavani/core-be/commit/b8ca01362c4a04aa8d65e511cac136a0953b2445))
* **api:** add frontend auth & headers integration guide ([ab201e8](https://github.com/nikunjmavani/core-be/commit/ab201e8046a524ad2f5dd9868e22897d77aaf2a9))
* **audit-2026-06-04:** mark all 20 findings resolved with file:line citations ([#381](https://github.com/nikunjmavani/core-be/issues/381)) ([96dd4f7](https://github.com/nikunjmavani/core-be/commit/96dd4f74574b1dca6ee93190b59edc56ab414b1e))
* check in sync; enricher unit tests + full suite (4,516) green. ([c58d39b](https://github.com/nikunjmavani/core-be/commit/c58d39b0aa550158d3106a41fadd403c203eb4c5))
* check verified green on 0.28.1. ([514fa96](https://github.com/nikunjmavani/core-be/commit/514fa961bd392ef4583c7e148a7f47277ef23dae))
* check, tsdoc 0/0, migrate lint, env sync, validate all pass. ([3311bc0](https://github.com/nikunjmavani/core-be/commit/3311bc022f65fcbd517802cc91dcb194d5a31c0c))
* consolidate setup guide into single root SETUP.md ([#555](https://github.com/nikunjmavani/core-be/issues/555)) ([5c311a3](https://github.com/nikunjmavani/core-be/commit/5c311a3c72f1fb33cb44daa087e94ee19e2edb1c))
* **env:** standardize OPTIONAL marker for conditionally-empty env keys ([#549](https://github.com/nikunjmavani/core-be/issues/549)) ([d7155b4](https://github.com/nikunjmavani/core-be/commit/d7155b48786aee7a8ce2e306133b61398f00cf20))
* **infra:** annotate Dockerfile build-stage ENV as test-only placeholders (sec-r4-C6) ([#519](https://github.com/nikunjmavani/core-be/issues/519)) ([cdf76ef](https://github.com/nikunjmavani/core-be/commit/cdf76ef7e6a85de7e638c161d1e7ad34dd12e38a))
* **integrations:** add Codex Cloud agent environment guide and GitHub prerequisites ([#660](https://github.com/nikunjmavani/core-be/issues/660)) ([d2128de](https://github.com/nikunjmavani/core-be/commit/d2128de716f1f19c25d934c87ecb517baf05d04e))
* **integrations:** add Postman + Resend agent MCP servers ([#631](https://github.com/nikunjmavani/core-be/issues/631)) ([6966744](https://github.com/nikunjmavani/core-be/commit/6966744da40ff9887700f433f78afc1f8f313140))
* **integrations:** common Claude Code session-setup overview ([#674](https://github.com/nikunjmavani/core-be/issues/674)) ([9052152](https://github.com/nikunjmavani/core-be/commit/90521520c34495a066342656f1ba104beb827f54))
* **integrations:** expand Stripe webhook runbook + Turnstile TODO ([#635](https://github.com/nikunjmavani/core-be/issues/635)) ([be08946](https://github.com/nikunjmavani/core-be/commit/be08946a84175689883f858e61e96b928e8c222d))
* **integrations:** fix Stripe CLI/Dashboard webhook URL ([#630](https://github.com/nikunjmavani/core-be/issues/630)) ([570e58f](https://github.com/nikunjmavani/core-be/commit/570e58f79991d12dcf75781ccdc9465da2647b85))
* **integrations:** map third-party services to CLI/MCP/SDK by consumer ([#626](https://github.com/nikunjmavani/core-be/issues/626)) ([5e90f52](https://github.com/nikunjmavani/core-be/commit/5e90f522061e5de8f31cb2905b9edda43caf2bf9))
* **openapi:** drop "Public ID" from request-body/query field descriptions → "id" ([3cb01a0](https://github.com/nikunjmavani/core-be/commit/3cb01a0b294a1a47a80a25a209ab410403e38117))
* **openapi:** drop "Public ID" from request-body/query field descriptions → "id" ([c58d39b](https://github.com/nikunjmavani/core-be/commit/c58d39b0aa550158d3106a41fadd403c203eb4c5))
* **process:** add release-versioning cheat-sheet (commit prefix → bump) ([#612](https://github.com/nikunjmavani/core-be/issues/612)) ([6e58397](https://github.com/nikunjmavani/core-be/commit/6e58397013279da347bf5a56305e150ea1cc8e26))
* **process:** document "watch CI -&gt; merge when green" in git flow + pr-babysit ([#616](https://github.com/nikunjmavani/core-be/issues/616)) ([0537a8e](https://github.com/nikunjmavani/core-be/commit/0537a8e86fc135038585d78b523e648cbc289e69))
* **reviews:** add agent-os AI-tooling audit + evals session writeup ([ef55c53](https://github.com/nikunjmavani/core-be/commit/ef55c536b406a3b1aea5df055c844bd4159c7a78))
* **reviews:** agent-os AI-tooling audit + evals/enforcement session writeup ([32288fa](https://github.com/nikunjmavani/core-be/commit/32288fa07f7e0b3caa92b5325ec51938b95be557))
* **reviews:** architecture conformance audit + 8-PR follow-up plan ([#531](https://github.com/nikunjmavani/core-be/issues/531)) ([4a9264c](https://github.com/nikunjmavani/core-be/commit/4a9264cb674f57930241a8b348d12afdcc727476))
* **reviews:** correct sec-r4-A3 analysis and defer to follow-up task ([#523](https://github.com/nikunjmavani/core-be/issues/523)) ([c7e1dab](https://github.com/nikunjmavani/core-be/commit/c7e1dab9433b40eb16a7df6e28fdf317df9318b7))
* **reviews:** route-coverage audit — 129 routes, 9 deferred gaps allowlisted ([#534](https://github.com/nikunjmavani/core-be/issues/534)) ([d18ec1d](https://github.com/nikunjmavani/core-be/commit/d18ec1df87b78237c77bac6f84b1ec464ff71965))
* **runbooks:** refresh worker registry breakdown to 30 workers / 27 Postgres ([#621](https://github.com/nikunjmavani/core-be/issues/621)) ([2d4d111](https://github.com/nikunjmavani/core-be/commit/2d4d111a9578679c856367881c16a5f6d8f62cb6))
* **superpowers:** re-audit remediation design spec for 18 findings ([#451](https://github.com/nikunjmavani/core-be/issues/451)) ([1b05734](https://github.com/nikunjmavani/core-be/commit/1b05734fe69e593ae6ad9f5fb2f11e6f4a8f69f6))

## [4.2.0](https://github.com/nikunjmavani/core-be/compare/v4.1.0...v4.2.0) (2026-06-17)


### Added

* 131-route security & production-flow audit — fix all RED/AMBER findings ([#601](https://github.com/nikunjmavani/core-be/issues/601)) ([3df1fbd](https://github.com/nikunjmavani/core-be/commit/3df1fbd91ea9011a6378a6f0785200e4a5f990ed))
* **agent-os:** add PreToolUse edit-guard and SessionStart hooks ([dcf6335](https://github.com/nikunjmavani/core-be/commit/dcf6335773cb9b8d15f570d7b2afac9e2a1a284c))
* **agent-os:** add RLS/tenant-isolation and idempotency guard skills ([a94cbb5](https://github.com/nikunjmavani/core-be/commit/a94cbb52df397f1abadf3a3f411f31bf2fc6f49a))
* **agent-os:** PreToolUse edit-guard + SessionStart hooks (Move 2) ([ad2e2b3](https://github.com/nikunjmavani/core-be/commit/ad2e2b3b87051c2fe34d3005d6a84fc6e37965e0))
* **agent-os:** RLS/tenant-isolation + idempotency guard skills ([0a3b902](https://github.com/nikunjmavani/core-be/commit/0a3b902748f4fc3e84d5d971b0915496b5e4f440))
* **ai:** cross-platform AI commands, SessionStart hook, and guardrails ([#643](https://github.com/nikunjmavani/core-be/issues/643)) ([b6fccf1](https://github.com/nikunjmavani/core-be/commit/b6fccf1630257d2920ba3831f625bbeeca7cad41))
* **auth:** add switch-to-personal and switch-to-organization endpoints ([79be5b0](https://github.com/nikunjmavani/core-be/commit/79be5b0fe799563e9612eaa3fc48a4a12f3ce2ae))
* **auth:** carry active organization + session version as signed JWT claims ([9864a2e](https://github.com/nikunjmavani/core-be/commit/9864a2e34917837b7102fdd72f9ba61982e4b0e0))
* **auth:** GET /auth/me/context — frontend-ready effective context ([#659](https://github.com/nikunjmavani/core-be/issues/659)) ([d08bb35](https://github.com/nikunjmavani/core-be/commit/d08bb35049c443015b3d53be0f13c7a80f4a845a))
* **auth:** mint the active-organization claim at login (default selection) ([a3a805d](https://github.com/nikunjmavani/core-be/commit/a3a805dc143b7af537c0757b4b74bfc77516d75d))
* **auth:** permission layer falls back to the org token claim (Phase 3 bridge) ([ea07091](https://github.com/nikunjmavani/core-be/commit/ea0709135504d09faa6367bfded88107cc438295))
* **auth:** permission layer reads the org token claim (Phase 3 bridge) ([6b9e7c3](https://github.com/nikunjmavani/core-be/commit/6b9e7c3458f6788b5c75b0ed4a49d3709b48d181))
* **auth:** refresh re-mints the active-organization claim ([b22f0a1](https://github.com/nikunjmavani/core-be/commit/b22f0a1712aa76b1f997257997b157025712b791))
* **auth:** switch building blocks — membership-validation resolvers + session token re-bind ([62cc944](https://github.com/nikunjmavani/core-be/commit/62cc9449314b7684007c937a9ec72b73c2d0eceb))
* **auth:** switchToOrganization / switchToPersonal service methods ([3f5ecc8](https://github.com/nikunjmavani/core-be/commit/3f5ecc84267e747d6e6d900ae5caf733f6255752))
* **billing:** flatten subscription routes onto the org token claim ([f835d60](https://github.com/nikunjmavani/core-be/commit/f835d605e0529e0e0e91ca7da1b16aa5f8940bec))
* **billing:** flatten subscription routes onto the org token claim ([df21c2c](https://github.com/nikunjmavani/core-be/commit/df21c2c62c4b65e4f1bf57228743ac2cd042a92c))
* **config:** gated local-dev defaults for DB/Redis/origins/retention ([#651](https://github.com/nikunjmavani/core-be/issues/651)) ([773e427](https://github.com/nikunjmavani/core-be/commit/773e427ca11bd44d1a65fea996ebbc92a629c236))
* **mcp,k6:** client auth-flow guide + k6 org-claim flow; fix dead idempotency exclusions ([f4bac5a](https://github.com/nikunjmavani/core-be/commit/f4bac5aa9a67f14e5ec87209e326e67b5ae15de6))
* **mcp,k6:** client auth-flow guide + k6 org-claim flow; fix idempotency exclusions; flatten stale refs ([f6e5894](https://github.com/nikunjmavani/core-be/commit/f6e5894a66cee5de1ff0790f5898b5510fd74f37))
* **mcp:** scope project MCP servers and wire MCP setup into the session-start flow ([#675](https://github.com/nikunjmavani/core-be/issues/675)) ([9ed07b4](https://github.com/nikunjmavani/core-be/commit/9ed07b4ba576db0ac5849d9c7de76b4c2c91af73))
* **notify:** flatten webhook routes onto the org token claim ([643d13a](https://github.com/nikunjmavani/core-be/commit/643d13ad09bd64e28bca029e4ed42cc40b56d04f))
* **notify:** flatten webhook routes onto the org token claim ([0bdc8ad](https://github.com/nikunjmavani/core-be/commit/0bdc8add9f37df2bd944995368be8d9f94710755))
* **notify:** time-based retention for webhook_delivery_attempts (audit-[#3](https://github.com/nikunjmavani/core-be/issues/3)) ([05d6325](https://github.com/nikunjmavani/core-be/commit/05d63258002fd9762962498b0a5059a5b971400f))
* **openapi:** document the full error-status matrix; observed-vs-spec error gate ([95a71b5](https://github.com/nikunjmavani/core-be/commit/95a71b505c9d8d7f802d73c4e0841b4140bf836d))
* **openapi:** document the full error-status matrix; observed-vs-spec error gate ([5a001de](https://github.com/nikunjmavani/core-be/commit/5a001de48bb661e048e012dde8ce658bfe612f3e))
* **openapi:** embed sanitized live-call request/response examples per route and status ([3a1ddb1](https://github.com/nikunjmavani/core-be/commit/3a1ddb1e5d38b40e18b9300a14942219da6ce868))
* **openapi:** embed sanitized live-call request/response examples per route and status ([bea574c](https://github.com/nikunjmavani/core-be/commit/bea574c92291f96bd309ad1969fe38cdf756722f))
* personal & team organizations — foundation + token/switch (Phase 1-2) ([9a8b179](https://github.com/nikunjmavani/core-be/commit/9a8b179a097b615b2e7292ad6f6362011ea2563c))
* **scalar:** publish OpenAPI to Scalar Registry (CI docs pipeline + interactive setup) ([#672](https://github.com/nikunjmavani/core-be/issues/672)) ([3ddc9b2](https://github.com/nikunjmavani/core-be/commit/3ddc9b2325a8cc8417bfe679c748a64f5c510da2))
* **tenancy:** atomic org provisioning with owner role+permissions+membership ([266b22e](https://github.com/nikunjmavani/core-be/commit/266b22ebeb3604dbc45d08608efd7604df37c81e))
* **tenancy:** auto-provision personal org at signup + exclude personal from delete guard ([9daed03](https://github.com/nikunjmavani/core-be/commit/9daed03c85997744bbfeb50919681de5658cd556))
* **tenancy:** block invitations on a personal organization (capability matrix) ([cafc549](https://github.com/nikunjmavani/core-be/commit/cafc5493d497f7e99a924a152ca6a64e4f29dd0d))
* **tenancy:** cap team organizations per owner (anti-abuse) ([f71b968](https://github.com/nikunjmavani/core-be/commit/f71b968577aa19a8ce4c3b4f6ce83142c3fd51d3))
* **tenancy:** flatten organization routes onto the org token claim ([ddd1a76](https://github.com/nikunjmavani/core-be/commit/ddd1a7604f7da6dfb3a878fdb28c9e35dff086d8))
* **tenancy:** flatten organization routes onto the org token claim ([f35b74e](https://github.com/nikunjmavani/core-be/commit/f35b74eb0f14cf2e5225b3fb477ea686a82763ed))
* **tenancy:** make the personal organization immutable (no delete / no transfer) ([a726064](https://github.com/nikunjmavani/core-be/commit/a726064b5f009c1a5ccd878fe8379eb79a533a37))
* **tenancy:** org-creation per-owner cap + personal-org capability guards ([94d7715](https://github.com/nikunjmavani/core-be/commit/94d77153740b2076afb57ded14748b727367617c))
* **tenancy:** organization create accepts type + nullable slug (provisioning groundwork) ([35bc409](https://github.com/nikunjmavani/core-be/commit/35bc409c7e85453a2d294f1baf4bd38b19e26d6f))
* **tenancy:** personal-org backfill script + provisioning tests ([5a40f5d](https://github.com/nikunjmavani/core-be/commit/5a40f5d5eadfd970e712b8d4b5a7f85b86258727))
* **tenancy:** personal/team organization foundation — schema + capability flags ([11e23d9](https://github.com/nikunjmavani/core-be/commit/11e23d92fc301307638f73e3e1269a0612ddde3d))
* **testing:** route success-status registry, observed coverage ratchet, never-5xx fuzz gate ([8d88dcf](https://github.com/nikunjmavani/core-be/commit/8d88dcf0677104ce4885ad80d62543c6ec45052a))
* **testing:** route success-status registry, observed coverage ratchet, never-5xx fuzz gate ([dfe2b43](https://github.com/nikunjmavani/core-be/commit/dfe2b436d3fa28843597576d6b29f43d7932d8ab))
* **testing:** verified happy path for every route — budget 30→0; 201 creates; OAuth 404 ([01b1b77](https://github.com/nikunjmavani/core-be/commit/01b1b77cbf2f60dcafbfa1afeafab68fe1e54437))
* **testing:** verified happy path for every route — budget 30→0; 201 creates; OAuth 404 ([624c9d5](https://github.com/nikunjmavani/core-be/commit/624c9d58945e78317e39cd9a412e488454fbdf29))
* **tests:** post-load settle-and-assert-clean gate + audit-outbox drain coverage ([01258c5](https://github.com/nikunjmavani/core-be/commit/01258c5b5aa9c03f8d6e9c7c9a5218cd10d3750b))
* **user:** add a scheduled reconciler that detects + alerts on stuck offboarding (audit-[#15](https://github.com/nikunjmavani/core-be/issues/15)) ([6443673](https://github.com/nikunjmavani/core-be/commit/64436733ec73792a3295b46ade51da2ceee98a53))
* **user:** expose deployment organization capabilities on /users/me ([a27f7a6](https://github.com/nikunjmavani/core-be/commit/a27f7a6d9a1a03a75e6163ab061e137d8a65e1d8))
* **user:** expose personal_organization_id on /users/me ([b725aca](https://github.com/nikunjmavani/core-be/commit/b725acad609f8a9743f2a199c4234df423ade3a5))


### Fixed

* 8th-audit concurrency races + correctness hardening (C1-C5) ([bf077b7](https://github.com/nikunjmavani/core-be/commit/bf077b743cfbe51549c39ca4d4ae28b824a1a6df))
* **api:** truthful error envelope, id-only external fields, DELETE→204 stragglers, local oasdiff gate ([25b4629](https://github.com/nikunjmavani/core-be/commit/25b46297b331681b528962246f8bee28c4695204))
* **api:** truthful error envelope, id-only external fields, DELETE→204 stragglers, local oasdiff gate ([2777308](https://github.com/nikunjmavani/core-be/commit/2777308d77c2938b0f66437a24a02b9637392b19))
* **auth,openapi:** MFA-login org claim (H1) + captcha/bearerAuth OpenAPI accuracy ([909a5ce](https://github.com/nikunjmavani/core-be/commit/909a5ce448a362af445736e8a02cb2e18b7949b8))
* **auth,openapi:** mfa-login org claim (H1) plus captcha and bearerAuth openapi accuracy ([fc336b8](https://github.com/nikunjmavani/core-be/commit/fc336b867a9a597fb3c613aa0574a4b8e91bae60))
* **auth:** add user FK + index to mfa_methods to purge orphaned MFA secrets (reaudit-[#1](https://github.com/nikunjmavani/core-be/issues/1)) ([a5a0992](https://github.com/nikunjmavani/core-be/commit/a5a0992eb777f40851e2c97ac7c26ff371325c06))
* **auth:** atomic credential-mutation guards + lockout counter (route-audit C1, C5) ([e6e33db](https://github.com/nikunjmavani/core-be/commit/e6e33db37b405bf0c92622b3c152f35c88cbf186))
* **auth:** block revoking the current session via DELETE /me/sessions/:id (route-[#9](https://github.com/nikunjmavani/core-be/issues/9)) ([19f4bff](https://github.com/nikunjmavani/core-be/commit/19f4bff7ba7a651f630204a173f859dc40206d2b))
* **auth:** bounded refresh-token reuse grace for concurrent refreshes (audit-[#2](https://github.com/nikunjmavani/core-be/issues/2)) ([0cdd75d](https://github.com/nikunjmavani/core-be/commit/0cdd75dd8b85e880950b8a076fbadee39c01d18f))
* **auth:** close session-revoke cache repopulation race + normalize OAuth email (route-audit session-[#1](https://github.com/nikunjmavani/core-be/issues/1), oauth-[#3](https://github.com/nikunjmavani/core-be/issues/3)) ([b8303a0](https://github.com/nikunjmavani/core-be/commit/b8303a02e1e7010f9516e0e5c2df5b7777c83694))
* **auth:** close WebAuthn enumeration timing oracle + complete credential-mutation lock (route-audit D1, D2, D3) ([10e2b52](https://github.com/nikunjmavani/core-be/commit/10e2b5271c7cb454e15e99035389787e5c233c25))
* **auth:** drop SUPER_ADMIN for non-active accounts in per-request re-derive (reaudit-[#10](https://github.com/nikunjmavani/core-be/issues/10)) ([e54a97b](https://github.com/nikunjmavani/core-be/commit/e54a97bd1e643916ac3eb579eeda2dcdb1d26493))
* **auth:** floor login failure branches to mask enumeration timing (audit-[#15](https://github.com/nikunjmavani/core-be/issues/15)d) ([0c4af59](https://github.com/nikunjmavani/core-be/commit/0c4af594c6aba8d84d383d20c01838ef6d134bf0))
* **auth:** key DELETE /mfa/:mfaMethodId on public id, not the sequential DB id (route-[#10](https://github.com/nikunjmavani/core-be/issues/10)) ([31bdd46](https://github.com/nikunjmavani/core-be/commit/31bdd46de650dce63aa6bc542beda50d57c0dea2))
* **auth:** make magic-link verification atomic with first-factor completion (audit-[#12](https://github.com/nikunjmavani/core-be/issues/12)) ([4350845](https://github.com/nikunjmavani/core-be/commit/435084506afc855e48169b8e26b3d87a1690f36a))
* **auth:** make MFA verification lockout counter atomic (route-audit-[#4](https://github.com/nikunjmavani/core-be/issues/4)) ([7d98218](https://github.com/nikunjmavani/core-be/commit/7d982183877aeea6cbc4531cea9eb47376c704fc))
* **auth:** make one-time-token issuance atomic with the mail-outbox insert (audit-[#11](https://github.com/nikunjmavani/core-be/issues/11)) ([f122beb](https://github.com/nikunjmavani/core-be/commit/f122beb20866aaf4748b05d29d2307f9a0768462))
* **auth:** make password change and email verification atomic with their side effects (audit-[#4](https://github.com/nikunjmavani/core-be/issues/4), [#12](https://github.com/nikunjmavani/core-be/issues/12)) ([42d7893](https://github.com/nikunjmavani/core-be/commit/42d7893572ee6e89c5bbe42a08cc18d1f33aa6e6))
* **auth:** per-user MFA verification lockout (audit-[#12](https://github.com/nikunjmavani/core-be/issues/12)) ([d6331e0](https://github.com/nikunjmavani/core-be/commit/d6331e01f9a0d378096ecc26b30404f23fc20d7c))
* **auth:** persist and revalidate the active organization across refresh (audit-[#3](https://github.com/nikunjmavani/core-be/issues/3)) ([f9d8f1b](https://github.com/nikunjmavani/core-be/commit/f9d8f1b5a757c5b8dc5f267f4cf166f2e5677816))
* **auth:** re-derive any privileged JWT claim (admin + super_admin) against live state (route-[#6](https://github.com/nikunjmavani/core-be/issues/6)) ([956c43d](https://github.com/nikunjmavani/core-be/commit/956c43d855978ea9f49c573e4c8a498ae2c4309f))
* **auth:** restrict POST /me/auth-methods to MAGIC_LINK to stop phantom-credential lockout (route-[#3](https://github.com/nikunjmavani/core-be/issues/3)) ([ee9af9a](https://github.com/nikunjmavani/core-be/commit/ee9af9a5819990189c658a69d9396e0fdb3ed7c5))
* **auth:** scope MFA lockout to TOTP so recovery codes stay usable (reaudit-[#3](https://github.com/nikunjmavani/core-be/issues/3)) ([a6d4b05](https://github.com/nikunjmavani/core-be/commit/a6d4b05530cd06f563be8a0ede17552d6831f4ac))
* **auth:** session-revoke cache repopulation race + OAuth email normalization ([c981c7f](https://github.com/nikunjmavani/core-be/commit/c981c7f634a1090faae6513d62aa30206e5e1778))
* **auth:** switch-to-organization relies on route schema for body validation + suite green ([ab02f71](https://github.com/nikunjmavani/core-be/commit/ab02f711379690a987cf2cc7ab46139dc411adf8))
* **auth:** WebAuthn enumeration timing oracle + complete credential-mutation lock (D1/D2/D3) ([9a1f3f0](https://github.com/nikunjmavani/core-be/commit/9a1f3f0d5aef7156d4d455935f5295f20b76d257))
* backend production-readiness audit findings ([0f60e0f](https://github.com/nikunjmavani/core-be/commit/0f60e0f71d6dd0b1f7a5d9aa20bf60712c8a04cb))
* backend production-readiness re-audit findings ([6bd64bc](https://github.com/nikunjmavani/core-be/commit/6bd64bc3c47c7c28a1f1d42121867bc990f9c99c))
* **billing:** add per-route rate limit to subscription mutations (route-[#2](https://github.com/nikunjmavani/core-be/issues/2)) ([1e6975e](https://github.com/nikunjmavani/core-be/commit/1e6975e24271d14561f544981c651e254c3ef862))
* **billing:** alert on plan&lt;-&gt;Stripe price catalog drift (audit-[#13](https://github.com/nikunjmavani/core-be/issues/13)) ([3377510](https://github.com/nikunjmavani/core-be/commit/33775103b9ec7470270ff172b734b34586aebcb3))
* **billing:** cancel the org's active subscription on organization delete (route-audit-[#2](https://github.com/nikunjmavani/core-be/issues/2)) ([718c80f](https://github.com/nikunjmavani/core-be/commit/718c80f307ae14d9db2ff77dbd26ae591f667afc))
* **billing:** cancel() releases the slot for never-activated INCOMPLETE subscriptions (reaudit-[#6](https://github.com/nikunjmavani/core-be/issues/6)) ([3d6cfe0](https://github.com/nikunjmavani/core-be/commit/3d6cfe03758b1302a8d1e7f8612d4641d381c1e8))
* **billing:** enforce unique subscriptions.provider_subscription_id (audit-[#10](https://github.com/nikunjmavani/core-be/issues/10)) ([acf919b](https://github.com/nikunjmavani/core-be/commit/acf919b105cbc10c502b8b197f5af1bd8782646c))
* **billing:** hide inactive plans from public GET /billing/plans/:id (route-[#7](https://github.com/nikunjmavani/core-be/issues/7)) ([0be46ed](https://github.com/nikunjmavani/core-be/commit/0be46ed971f32287ba326cdbbbb94275ca7f9465))
* **billing:** make terminal subscriptions immutable (compare-and-set, B5/B6) ([5ac4328](https://github.com/nikunjmavani/core-be/commit/5ac43284d69e28101615d1a2f2caa306ab31cfe2))
* **billing:** make terminal subscriptions immutable via compare-and-set (route-audit B5, B6) ([18a3e43](https://github.com/nikunjmavani/core-be/commit/18a3e43540814b94e66ad085f40df767a32598e3))
* **billing:** persist a CANCELED tombstone for out-of-order Stripe deletions (audit-[#1](https://github.com/nikunjmavani/core-be/issues/1)) ([7862609](https://github.com/nikunjmavani/core-be/commit/7862609ed32b9c5c16d5780f4a6d7b59ba5066bb))
* **billing:** persist new Stripe subscriptions as INCOMPLETE not TRIALING (audit-[#2](https://github.com/nikunjmavani/core-be/issues/2)) ([b5a7f66](https://github.com/nikunjmavani/core-be/commit/b5a7f66537091e20632b3898364c7ac71e3f9f5f))
* **billing:** release subscription slot for INCOMPLETE_EXPIRED (audit-[#1](https://github.com/nikunjmavani/core-be/issues/1)) ([14cd328](https://github.com/nikunjmavani/core-be/commit/14cd3289545d1229e72b08e16977286cde39db18))
* **billing:** set concrete sunset for deprecated stripe webhook alias (audit-[#15](https://github.com/nikunjmavani/core-be/issues/15)a) ([4efb4a7](https://github.com/nikunjmavani/core-be/commit/4efb4a78e02af5da54c10fb04de02239120b1f79))
* block user delete when owning orgs + webhook updated_at flake ([08a5ac2](https://github.com/nikunjmavani/core-be/commit/08a5ac27734c2d3abb3604ab5e694abeb429d85e))
* **ci:** publish API docs (incl. Scalar Registry) independently of release-please ([#676](https://github.com/nikunjmavani/core-be/issues/676)) ([7c4fe62](https://github.com/nikunjmavani/core-be/commit/7c4fe62027431e4d79e006afb84cc24c61e5fc67))
* **ci:** publish Scalar registry from GitHub Variables ([#677](https://github.com/nikunjmavani/core-be/issues/677)) ([cfaaef8](https://github.com/nikunjmavani/core-be/commit/cfaaef883eb57327cfd3f558597407250d3a752c))
* **config:** make .env.local the self-contained primary local env file ([#650](https://github.com/nikunjmavani/core-be/issues/650)) ([aeb32e7](https://github.com/nikunjmavani/core-be/commit/aeb32e7c60d4686f71b2f14f46efe873404652c3))
* **config:** require legacy JWT gate closed once keyring configured in prod (audit-[#15](https://github.com/nikunjmavani/core-be/issues/15)b) ([43e5139](https://github.com/nikunjmavani/core-be/commit/43e5139de2e4b9f7e969b9832e8ffac1a0c32b89))
* **database:** keyset-page batch delete so FK-blocked rows can't infinite-loop retention ([fd9b523](https://github.com/nikunjmavani/core-be/commit/fd9b523ecaf1825d111a636d6cad954ecba6e83a))
* **database:** keyset-page batch delete so FK-blocked rows can't infinite-loop retention (route-audit A1) ([f81ca72](https://github.com/nikunjmavani/core-be/commit/f81ca724b6e5d25c158e02403ee39d7132c8c8f2))
* **db:** enforce RLS deny-all on billing.plans and tenancy.permissions (reaudit-[#9](https://github.com/nikunjmavani/core-be/issues/9)) ([2bb9476](https://github.com/nikunjmavani/core-be/commit/2bb947621fafabfd2ec03ca2d2fc9f905970c838))
* **deps:** bump esbuild override to &gt;=0.28.1 (GHSA-gv7w-rqvm-qjhr / GHSA-g7r4-m6w7-qqqr) ([514fa96](https://github.com/nikunjmavani/core-be/commit/514fa961bd392ef4583c7e148a7f47277ef23dae))
* **deps:** override @grpc/grpc-js to &gt;=1.14.4 (GHSA-5375-pq7m-f5r2) ([0a66557](https://github.com/nikunjmavani/core-be/commit/0a6655731c02a3efa03ca598c306fce4d34012c7))
* **docker:** add HEALTHCHECK to worker image (audit-[#15](https://github.com/nikunjmavani/core-be/issues/15)c) ([b4f7a67](https://github.com/nikunjmavani/core-be/commit/b4f7a67cc2072c9510f63906b2b1ec50ae114f92))
* **docker:** refresh apk index so base-image security patches install ([#607](https://github.com/nikunjmavani/core-be/issues/607)) ([a3690b9](https://github.com/nikunjmavani/core-be/commit/a3690b91f2f61f48f837553c74890e5d358fbec3))
* **docker:** worker HEALTHCHECK honors WORKER_HEALTH_PORT at runtime (reaudit-[#8](https://github.com/nikunjmavani/core-be/issues/8)) ([3530bff](https://github.com/nikunjmavani/core-be/commit/3530bff1c5cb6a65e21cc0f507018211150236a3))
* **mail:** scrub secret-bearing body on terminally-failed outbox rows (audit-[#10](https://github.com/nikunjmavani/core-be/issues/10)) ([61dc948](https://github.com/nikunjmavani/core-be/commit/61dc948505b0eb6e4e7c60020d66a7c3663452bb))
* **mcp:** strip X-Organization-Id from call_api proxied sub-requests (route-[#8](https://github.com/nikunjmavani/core-be/issues/8)) ([d5a7167](https://github.com/nikunjmavani/core-be/commit/d5a716716e8acff86e1523641e3f44620374411c))
* **notify:** cap webhook response body bytes read before truncation (audit-[#6](https://github.com/nikunjmavani/core-be/issues/6)) ([0f2421e](https://github.com/nikunjmavani/core-be/commit/0f2421e3b6b211f888f08a0161274063d7599cc1))
* **notify:** durability-first notification email dedup to stop lost emails (audit-[#7](https://github.com/nikunjmavani/core-be/issues/7)) ([b9d9759](https://github.com/nikunjmavani/core-be/commit/b9d9759885b92320210d681520ecc16236d70d2c))
* **notify:** durable mail-outbox dedupe key to close concurrent duplicate-email window (reaudit-[#4](https://github.com/nikunjmavani/core-be/issues/4)) ([47cd280](https://github.com/nikunjmavani/core-be/commit/47cd280504c9acdf324b2ff11ff4ca36ded05a1c))
* **notify:** enforce webhook secret-rotation eligibility in the update predicate (audit-[#9](https://github.com/nikunjmavani/core-be/issues/9)) ([d3337e0](https://github.com/nikunjmavani/core-be/commit/d3337e0c3ad3e314206cce494c23e6b644c90d03))
* **notify:** guard webhook secret re-rotation within the dual-sign overlap window ([0cfedd0](https://github.com/nikunjmavani/core-be/commit/0cfedd0d28177f40f354133a3d1f53b94002e955))
* **notify:** guard webhook secret re-rotation within the dual-sign overlap window (route-audit webhook-[#1](https://github.com/nikunjmavani/core-be/issues/1)) ([5c16f85](https://github.com/nikunjmavani/core-be/commit/5c16f8548c7c528944d937c60fe985ee887e8174))
* **notify:** route webhook handlers through zodApplication type provider ([eaa5684](https://github.com/nikunjmavani/core-be/commit/eaa5684c13253e6f5c7204a7dc8b479e4c9c5465))
* **notify:** stamp webhook updated_at as greatest(created_at, now()) to fix chk_webhooks_updated flake ([988d87b](https://github.com/nikunjmavani/core-be/commit/988d87baf86a74ebb05ba9d81948e205ffcda2e3))
* **observability:** monitor every retention worker DLQ + add drift guard (reaudit-[#5](https://github.com/nikunjmavani/core-be/issues/5)) ([0e954dc](https://github.com/nikunjmavani/core-be/commit/0e954dcfe96a4c2d46c48815e963632468243236))
* **openapi:** registry-authoritative success statuses; deterministic OAuth coverage; scan cleanups ([a7cc7bd](https://github.com/nikunjmavani/core-be/commit/a7cc7bdeb47f4d9d5f5a18465470d8a9b2b86c67))
* **openapi:** registry-authoritative success statuses; deterministic OAuth coverage; scan cleanups ([1f84793](https://github.com/nikunjmavani/core-be/commit/1f84793ff6f149d7a759ac0223fb45a5d28d1942))
* **ops:** log circuit-breaker resets for attribution (route-[#5](https://github.com/nikunjmavani/core-be/issues/5)) ([eae48fe](https://github.com/nikunjmavani/core-be/commit/eae48fe4e9c937f7ca65d219acacb55832a1b218))
* **queue:** acknowledge commit-dispatch tasks after execution, not before (reaudit-[#2](https://github.com/nikunjmavani/core-be/issues/2)) ([8f399c0](https://github.com/nikunjmavani/core-be/commit/8f399c0ddaed24901f6c92445091770286c7a852))
* **queue:** bound commandTimeout on BullMQ producer connections (audit-[#5](https://github.com/nikunjmavani/core-be/issues/5)) ([2c4e21b](https://github.com/nikunjmavani/core-be/commit/2c4e21bf12dedc6039a0f0085379e80e8a83fee2))
* **queue:** monitor the offboarding-reconciler DLQ + exempt it from tenant-scoping policy (audit-[#15](https://github.com/nikunjmavani/core-be/issues/15)) ([f5f4ceb](https://github.com/nikunjmavani/core-be/commit/f5f4cebfbf7cc99072c06c0b7588d7c3eb4289fc))
* **rate-limit,observability:** scope org rate-limit + error context by the org claim ([5e12926](https://github.com/nikunjmavani/core-be/commit/5e12926e869e17a3bd66e71a3d7ec87b98119132))
* **rate-limit,observability:** scope org rate-limit + error context by the org token claim ([b2caeb1](https://github.com/nikunjmavani/core-be/commit/b2caeb1be96e8fde9631028c4b92e047b14d433d))
* route-audit state-machine, billing, and cache-header findings ([d4b34ef](https://github.com/nikunjmavani/core-be/commit/d4b34ef388184860aece138aa10716b226562158))
* route-focused security audit findings ([1fffbf0](https://github.com/nikunjmavani/core-be/commit/1fffbf0270b20b7fdbeef5d0f3d86528e4fb11a5))
* **security:** fail closed on privileged re-derivation + bound all retention settings (audit-[#16](https://github.com/nikunjmavani/core-be/issues/16), [#14](https://github.com/nikunjmavani/core-be/issues/14)) ([65a4347](https://github.com/nikunjmavani/core-be/commit/65a4347972c7d029600559f69a080fc611bc555d))
* **security:** mark recovery-codes + presigned-URL responses no-store / non-cacheable (route-audit-[#3](https://github.com/nikunjmavani/core-be/issues/3)) ([bc67eed](https://github.com/nikunjmavani/core-be/commit/bc67eed1cc521709b36e4eca38289310276ff922))
* **security:** remediate all 16 findings from the 2026-06-14 dev security audit ([01a22aa](https://github.com/nikunjmavani/core-be/commit/01a22aa5f83fbd1f784039a98b5ac4eda151efdb))
* **security:** remediate all 16 findings from the 2026-06-14 dev security audit ([#600](https://github.com/nikunjmavani/core-be/issues/600)) ([01a22aa](https://github.com/nikunjmavani/core-be/commit/01a22aa5f83fbd1f784039a98b5ac4eda151efdb))
* **security:** untrack agent-os/mcp/mcp.json and repair stale ai/ paths ([#560](https://github.com/nikunjmavani/core-be/issues/560)) ([b3547a4](https://github.com/nikunjmavani/core-be/commit/b3547a43172e2388c0a1a2e4fa8e0388d046b4c6))
* **setup:** activate pinned Node on PATH in agent bootstrap step 1 ([#649](https://github.com/nikunjmavani/core-be/issues/649)) ([968d54f](https://github.com/nikunjmavani/core-be/commit/968d54fae13b6e8cb9c40c39e565c116739dd479))
* **storage:** distinguish S3 not-found from transient failure (audit-[#5](https://github.com/nikunjmavani/core-be/issues/5)) ([5ba8d00](https://github.com/nikunjmavani/core-be/commit/5ba8d002a05a423b8a2e8b99e4f23c29a1d79e51))
* **storage:** serve public media via a distribution and refuse public URLs for private keys (audit-[#13](https://github.com/nikunjmavani/core-be/issues/13)) ([cc10be0](https://github.com/nikunjmavani/core-be/commit/cc10be00c43a9891bff17bfc097f9ba50c5a165d))
* **tenancy,notify:** atomic role-delete, webhook clock-skew, security_policy proto guard (route-audit C2, C3, C4) ([ddf4f35](https://github.com/nikunjmavani/core-be/commit/ddf4f35762595f2318930855bf1bfccaba3a30ed))
* **tenancy,notify:** make per-scope resource caps atomic with an advisory lock (audit-[#8](https://github.com/nikunjmavani/core-be/issues/8)) ([3681133](https://github.com/nikunjmavani/core-be/commit/3681133339f47f68570aaf54f773ae8c5964238b))
* **tenancy,security:** post-flatten audit corrections — idempotency claim scope + personal-org guards ([e105372](https://github.com/nikunjmavani/core-be/commit/e10537260c541131a4386bb37570653242fcc41b))
* **tenancy,security:** post-flatten audit corrections — idempotency claim scope, personal-org guards, dead-code cleanup ([018fb31](https://github.com/nikunjmavani/core-be/commit/018fb313308ea78843d22df4dd234dc41dea1190))
* **tenancy:** only activate INVITED memberships on invitation accept (route-audit-[#1](https://github.com/nikunjmavani/core-be/issues/1)) ([aeea26a](https://github.com/nikunjmavani/core-be/commit/aeea26af9f5346fdbf4c7dd38745de90d8951b14))
* **tenancy:** reject prototype-pollution keys in organization security_policy (route-audit hardening) ([b1eba43](https://github.com/nikunjmavani/core-be/commit/b1eba43d872fe1ff7e018edd45eb42c10f67fa3f))
* **tenancy:** revoke a removed member's API keys on membership removal (reaudit-[#7](https://github.com/nikunjmavani/core-be/issues/7)) ([1387bd3](https://github.com/nikunjmavani/core-be/commit/1387bd306046d439b5f52840e4b45ae0f0794037))
* **tenancy:** scale permission-cache stampede poll budget to lock TTL (audit-[#9](https://github.com/nikunjmavani/core-be/issues/9)) ([5322d0f](https://github.com/nikunjmavani/core-be/commit/5322d0fae4dc9043f3563eda431d880ccab74f97))
* **tenancy:** throttle api-key last_used_at writes (audit-[#8](https://github.com/nikunjmavani/core-be/issues/8)) ([96b3e56](https://github.com/nikunjmavani/core-be/commit/96b3e562e136892ff44e5adf2f06009bdcce5a06))
* three pre-existing dev post-merge CI failures (migration idempotency, Stripe Date bind, permission seed) ([#614](https://github.com/nikunjmavani/core-be/issues/614)) ([798cefe](https://github.com/nikunjmavani/core-be/commit/798cefe26f59b8f56c3987f437772d707a42e364))
* **upload:** lock the organization pending-upload quota at the org scope (audit-[#7](https://github.com/nikunjmavani/core-be/issues/7)) ([171a0fc](https://github.com/nikunjmavani/core-be/commit/171a0fc4c618c93c4bc74aafe0c3ec45f6376b74))
* **upload:** reclaim orphaned avatar/logo objects + owner-binding + purpose/target check (L1/L2/L3) ([7ffef76](https://github.com/nikunjmavani/core-be/commit/7ffef768a889cab424139e42cab34e7f055f6bb9))
* **upload:** reclaim orphaned avatar/logo objects, wire owner-binding gate, validate purpose-target (route-audit L1, L2, L3) ([d9d9738](https://github.com/nikunjmavani/core-be/commit/d9d97381082b330d32843511d29e8823fde2cb56))
* **user:** block admin suspend/delete of protected super-admins (route-[#1](https://github.com/nikunjmavani/core-be/issues/1)) ([b84259d](https://github.com/nikunjmavani/core-be/commit/b84259d3f6cbb34ffb2f8617e900aa0157fc5fae))
* **user:** block deleting a user who still owns organizations (route-audit-[#2](https://github.com/nikunjmavani/core-be/issues/2) follow-up) ([f94b7c9](https://github.com/nikunjmavani/core-be/commit/f94b7c9c0c95d1525ea31fe41e44970efe452f19))
* **user:** rate-limit admin user-management mutations (route-[#4](https://github.com/nikunjmavani/core-be/issues/4)) ([a0d8114](https://github.com/nikunjmavani/core-be/commit/a0d8114b28fc1730fbc982271018d64700569537))
* **user:** unique notification-preference natural key + input dedupe (audit-[#11](https://github.com/nikunjmavani/core-be/issues/11)) ([6805459](https://github.com/nikunjmavani/core-be/commit/68054599b5fb2a120c6fb8571f23a76dc9277e7a))


### Changed

* **api:** rename inbound Idempotency-Key header to X-Idempotency-Key ([#656](https://github.com/nikunjmavani/core-be/issues/656)) ([b595c1b](https://github.com/nikunjmavani/core-be/commit/b595c1b0ed35a9248f1dd53660c7b3afb849eee4))
* **api:** semantic snake_case params, prefixed public ids, uniform status policy, documented headers ([03820fb](https://github.com/nikunjmavani/core-be/commit/03820fb407116e2532f2afdf12133861b8c58497))
* **api:** semantic snake_case route params, prefixed public ids, uniform method-status policy, documented headers ([3311bc0](https://github.com/nikunjmavani/core-be/commit/3311bc022f65fcbd517802cc91dcb194d5a31c0c))
* **billing:** remove deprecated /stripe/webhook alias ([#670](https://github.com/nikunjmavani/core-be/issues/670)) ([e0a4c8b](https://github.com/nikunjmavani/core-be/commit/e0a4c8bfac04fcbe041c6b6c1e47a5585d411820))
* **constants:** centralize scope-localized config constants ([#667](https://github.com/nikunjmavani/core-be/issues/667)) ([f6dad66](https://github.com/nikunjmavani/core-be/commit/f6dad66887513bd519c020794526b3b32c8c728a))
* enforce architecture boundaries (DB-in-services, DI, controller thinness) ([#602](https://github.com/nikunjmavani/core-be/issues/602)) ([cc43b3b](https://github.com/nikunjmavani/core-be/commit/cc43b3b3f38cd94d190928ac6728f1077195bbbf))
* **quality:** clear SonarQube debt on the deployed surface ([#663](https://github.com/nikunjmavani/core-be/issues/663)) ([8f5116a](https://github.com/nikunjmavani/core-be/commit/8f5116a5ddb29ac435078922ed7188ca4f6f1df3))
* **queue:** remove redundant alert-only offboarding reconciler ([#611](https://github.com/nikunjmavani/core-be/issues/611)) ([55e979e](https://github.com/nikunjmavani/core-be/commit/55e979e10528a3b6c794aaea1595e7feeedbc7b6))
* route consistency + personal/team org model ([#658](https://github.com/nikunjmavani/core-be/issues/658)) ([d304b88](https://github.com/nikunjmavani/core-be/commit/d304b88439d8611d7b7d668f4b0d1f15c9a7a2dc))
* **tenancy:** route org-scoped controllers through claim-aware org accessor ([f4c3b54](https://github.com/nikunjmavani/core-be/commit/f4c3b54f70b5c9c49c2a03cf908f1407810138a8))
* **tenancy:** route org-scoped controllers through claim-aware org accessor ([af30b20](https://github.com/nikunjmavani/core-be/commit/af30b20e50b8c49f3c906bbbb1ca6d4093fd14ef))
* **validation:** extract shared parseWithSchema + parseCursorPaginatedQuery helpers ([#661](https://github.com/nikunjmavani/core-be/issues/661)) ([7831156](https://github.com/nikunjmavani/core-be/commit/78311567eb27b6676b63fa3dec89ab3d1bab3130))


### Documentation

* **agent-os:** align schema skills to varchar(n) codebase convention ([#638](https://github.com/nikunjmavani/core-be/issues/638)) ([e575074](https://github.com/nikunjmavani/core-be/commit/e5750743e7a8af7a59eebd06d552ca8223a598d1))
* **agent-os:** correct stale workflow, seed, and provider paths in skills ([#641](https://github.com/nikunjmavani/core-be/issues/641)) ([5550f4c](https://github.com/nikunjmavani/core-be/commit/5550f4c274b58403008bb98dd4982642565ed110))
* **api:** add frontend auth & headers integration guide ([b8ca013](https://github.com/nikunjmavani/core-be/commit/b8ca01362c4a04aa8d65e511cac136a0953b2445))
* **api:** add frontend auth & headers integration guide ([ab201e8](https://github.com/nikunjmavani/core-be/commit/ab201e8046a524ad2f5dd9868e22897d77aaf2a9))
* check in sync; enricher unit tests + full suite (4,516) green. ([c58d39b](https://github.com/nikunjmavani/core-be/commit/c58d39b0aa550158d3106a41fadd403c203eb4c5))
* check verified green on 0.28.1. ([514fa96](https://github.com/nikunjmavani/core-be/commit/514fa961bd392ef4583c7e148a7f47277ef23dae))
* check, tsdoc 0/0, migrate lint, env sync, validate all pass. ([3311bc0](https://github.com/nikunjmavani/core-be/commit/3311bc022f65fcbd517802cc91dcb194d5a31c0c))
* **integrations:** add Codex Cloud agent environment guide and GitHub prerequisites ([#660](https://github.com/nikunjmavani/core-be/issues/660)) ([d2128de](https://github.com/nikunjmavani/core-be/commit/d2128de716f1f19c25d934c87ecb517baf05d04e))
* **integrations:** add Postman + Resend agent MCP servers ([#631](https://github.com/nikunjmavani/core-be/issues/631)) ([6966744](https://github.com/nikunjmavani/core-be/commit/6966744da40ff9887700f433f78afc1f8f313140))
* **integrations:** common Claude Code session-setup overview ([#674](https://github.com/nikunjmavani/core-be/issues/674)) ([9052152](https://github.com/nikunjmavani/core-be/commit/90521520c34495a066342656f1ba104beb827f54))
* **integrations:** expand Stripe webhook runbook + Turnstile TODO ([#635](https://github.com/nikunjmavani/core-be/issues/635)) ([be08946](https://github.com/nikunjmavani/core-be/commit/be08946a84175689883f858e61e96b928e8c222d))
* **integrations:** fix Stripe CLI/Dashboard webhook URL ([#630](https://github.com/nikunjmavani/core-be/issues/630)) ([570e58f](https://github.com/nikunjmavani/core-be/commit/570e58f79991d12dcf75781ccdc9465da2647b85))
* **integrations:** map third-party services to CLI/MCP/SDK by consumer ([#626](https://github.com/nikunjmavani/core-be/issues/626)) ([5e90f52](https://github.com/nikunjmavani/core-be/commit/5e90f522061e5de8f31cb2905b9edda43caf2bf9))
* **openapi:** drop "Public ID" from request-body/query field descriptions → "id" ([3cb01a0](https://github.com/nikunjmavani/core-be/commit/3cb01a0b294a1a47a80a25a209ab410403e38117))
* **openapi:** drop "Public ID" from request-body/query field descriptions → "id" ([c58d39b](https://github.com/nikunjmavani/core-be/commit/c58d39b0aa550158d3106a41fadd403c203eb4c5))
* **process:** add release-versioning cheat-sheet (commit prefix → bump) ([#612](https://github.com/nikunjmavani/core-be/issues/612)) ([6e58397](https://github.com/nikunjmavani/core-be/commit/6e58397013279da347bf5a56305e150ea1cc8e26))
* **process:** document "watch CI -&gt; merge when green" in git flow + pr-babysit ([#616](https://github.com/nikunjmavani/core-be/issues/616)) ([0537a8e](https://github.com/nikunjmavani/core-be/commit/0537a8e86fc135038585d78b523e648cbc289e69))
* **reviews:** add agent-os AI-tooling audit + evals session writeup ([ef55c53](https://github.com/nikunjmavani/core-be/commit/ef55c536b406a3b1aea5df055c844bd4159c7a78))
* **reviews:** agent-os AI-tooling audit + evals/enforcement session writeup ([32288fa](https://github.com/nikunjmavani/core-be/commit/32288fa07f7e0b3caa92b5325ec51938b95be557))
* **runbooks:** refresh worker registry breakdown to 30 workers / 27 Postgres ([#621](https://github.com/nikunjmavani/core-be/issues/621)) ([2d4d111](https://github.com/nikunjmavani/core-be/commit/2d4d111a9578679c856367881c16a5f6d8f62cb6))

## [4.1.0](https://github.com/nikunjmavani/core-be/compare/v4.0.0...v4.1.0) (2026-06-09)


### Added

* **infra-tests:** drop_index_without_concurrently lint rule + org slug collision-proof factory ([#526](https://github.com/nikunjmavani/core-be/issues/526)) ([0915c85](https://github.com/nikunjmavani/core-be/commit/0915c851ab7b5c8934a06108d28f8aec3662e97b))
* **round-5-followup:** per-org row caps (api-keys, member-roles, notification-policies) + auth/MFA route policy tests ([#528](https://github.com/nikunjmavani/core-be/issues/528)) ([19b556f](https://github.com/nikunjmavani/core-be/commit/19b556f9379a3d70889644356e9928a68de549e9))
* **round-5:** residual-risk findings — DLQ-RLS bug + 5 backlog fixes + 3 test gaps + audit doc ([#527](https://github.com/nikunjmavani/core-be/issues/527)) ([6aa6f88](https://github.com/nikunjmavani/core-be/commit/6aa6f8831e12fa7c8ef88f3d95f9e15bcd2d23d2))


### Fixed

* **audit:** omit soft-deleted orgs from audit-log public id resolution (sec-r4-D2) ([#506](https://github.com/nikunjmavani/core-be/issues/506)) ([e76a015](https://github.com/nikunjmavani/core-be/commit/e76a01530ed22da2e35d21f0080547075d0475d8))
* **auth-webauthn:** require user verification at options time (sec-r4-A2) ([#514](https://github.com/nikunjmavani/core-be/issues/514)) ([38f60cf](https://github.com/nikunjmavani/core-be/commit/38f60cf8443a94ff327e95e6bad5d03d7bdf6947))
* **auth:** fix controller unit test and ack OpenAPI breaking change for B4 ([48f8c81](https://github.com/nikunjmavani/core-be/commit/48f8c818fa14f205efe5a6e12d2528e8461f6790))
* **auth:** sec-new-A2 reject suspended/deleted users on bearer auth cache miss ([#474](https://github.com/nikunjmavani/core-be/issues/474)) ([eff74f4](https://github.com/nikunjmavani/core-be/commit/eff74f453a57f071258b8275aa850d375e6a67cc))
* **auth:** sec-new-A3 preserve caller session on DELETE /me/sessions ([#478](https://github.com/nikunjmavani/core-be/issues/478)) ([32936f3](https://github.com/nikunjmavani/core-be/commit/32936f3625022fcb98a3b2f681b6d19ee86a7611))
* **auth:** sec-new-A4 flip is_mfa_enabled inside deleteMfa transaction ([#479](https://github.com/nikunjmavani/core-be/issues/479)) ([a50d899](https://github.com/nikunjmavani/core-be/commit/a50d8995f7c42b08643d6a503b70971d24cbf6e9))
* **auth:** sec-new-B4 add public_id to auth_methods, stop leaking bigserial ids ([c82295d](https://github.com/nikunjmavani/core-be/commit/c82295d43b2768b8fb53160c26704e3dabadf4ce))
* **auth:** sec-new-B4 add public_id to auth_methods, stop leaking bigserial ids ([02a6ddd](https://github.com/nikunjmavani/core-be/commit/02a6ddd7b4dff060e87709bfa74dcd955a679228))
* **billing:** bound PlanRepository.findAllActive at 100 rows (sec-r4-D3) ([#507](https://github.com/nikunjmavani/core-be/issues/507)) ([43180a9](https://github.com/nikunjmavani/core-be/commit/43180a98e2b62abdc0584460d06d455a55701900))
* **billing:** remove redundant parseBullMQJobData from stripe-webhook processor (sec-r4-Q1) ([#502](https://github.com/nikunjmavani/core-be/issues/502)) ([d20c731](https://github.com/nikunjmavani/core-be/commit/d20c731dbaf5764fcb0ebf96376830c882991205))
* **billing:** sec-new-B1 guard cancel/resume/changePlan against terminal subscriptions ([#475](https://github.com/nikunjmavani/core-be/issues/475)) ([86bb32f](https://github.com/nikunjmavani/core-be/commit/86bb32f6de0ed2c3e293f2a17f979b9cfbfc3328))
* **billing:** sec-new-D1-D2 data integrity guards in billing writes ([#476](https://github.com/nikunjmavani/core-be/issues/476)) ([def085a](https://github.com/nikunjmavani/core-be/commit/def085adf233218dac8c01dad35e2efde385313b))
* **billing:** sec-new-M2 emit Deprecation+Sunset headers on deprecated /stripe/webhook alias ([#489](https://github.com/nikunjmavani/core-be/issues/489)) ([d95f4aa](https://github.com/nikunjmavani/core-be/commit/d95f4aa8becdae0454be1d727a09c1580fb1ff4d))
* **billing:** support comma-separated STRIPE_WEBHOOK_SECRET for zero-downtime rotation (sec-new-B3) ([#490](https://github.com/nikunjmavani/core-be/issues/490)) ([4be65fe](https://github.com/nikunjmavani/core-be/commit/4be65fe218a948b63f9386a09a934aa4cb4d42e5))
* **ci:** dispatch stable release backmerge ([be9190f](https://github.com/nikunjmavani/core-be/commit/be9190f6ff26d04905bc46127717c96fbbe57ab0))
* **ci:** export GLOBAL_ADMIN_EMAILS in test-env so audit.test.ts super-admin paths work in Matrix Tests ([#532](https://github.com/nikunjmavani/core-be/issues/532)) ([873f59d](https://github.com/nikunjmavani/core-be/commit/873f59df59340bc182e3d8f261b5c2e435f89c63))
* **ci:** grant release-please job id-token + actions write permissions ([#536](https://github.com/nikunjmavani/core-be/issues/536)) ([b83eab2](https://github.com/nikunjmavani/core-be/commit/b83eab2d4ac3e2b46f5e77e00e34d720db6508e0))
* **config:** cap AUTH_SESSION_MAX_AGE_DAYS at 365 (sec-r4-C4) ([#510](https://github.com/nikunjmavani/core-be/issues/510)) ([2a48a88](https://github.com/nikunjmavani/core-be/commit/2a48a88355744445298e8fb36dda0c22fca0b472))
* **database:** sec-new-Q4 apply worker statement timeout in system-table retention context ([#487](https://github.com/nikunjmavani/core-be/issues/487)) ([4e0b5c2](https://github.com/nikunjmavani/core-be/commit/4e0b5c2156544d72b9dbf51b4a3c07b77930492a))
* **infra:** use correct JWT env keys in docker-compose smoke profile (sec-r4-C5) ([#512](https://github.com/nikunjmavani/core-be/issues/512)) ([c9a48f1](https://github.com/nikunjmavani/core-be/commit/c9a48f107f0f89fe41814c253e4d3defc0595437))
* **notify:** sec-new-B2 replace bigserial with public_id in X-Webhook-Delivery-Id header ([#494](https://github.com/nikunjmavani/core-be/issues/494)) ([771954a](https://github.com/nikunjmavani/core-be/commit/771954a360383fcb797e38a6ea55b07d2055790c))
* **notify:** sec-new-D4 add status=PENDING filter to fallback SELECT in webhook delivery ([#488](https://github.com/nikunjmavani/core-be/issues/488)) ([164c6f8](https://github.com/nikunjmavani/core-be/commit/164c6f8a0bebbc89f0bb47d0b432e0db0bf453d7))
* **notify:** sec-new-N1 validate webhookId path param in all webhook handlers ([#482](https://github.com/nikunjmavani/core-be/issues/482)) ([d66099e](https://github.com/nikunjmavani/core-be/commit/d66099e00764f935260de97560e60529d61d5e53))
* **notify:** trim payload and response_body from webhook delivery list (sec-r4-D6) ([#518](https://github.com/nikunjmavani/core-be/issues/518)) ([89c24b7](https://github.com/nikunjmavani/core-be/commit/89c24b7f05dba72eba97447f746abb08130c61f6))
* **queue:** sec-new-Q1 add env overrides for hardcoded cron schedules ([#484](https://github.com/nikunjmavani/core-be/issues/484)) ([d2d03e1](https://github.com/nikunjmavani/core-be/commit/d2d03e1c6a41861a22965a0c57707b8157ce66da))
* **queue:** sec-new-Q2 capture per-task failures in Sentry in recovery processor ([#485](https://github.com/nikunjmavani/core-be/issues/485)) ([b66a7a6](https://github.com/nikunjmavani/core-be/commit/b66a7a68ed27dc357b83b010e4778991fb198242))
* **runtime:** real-world deep-flow inspection findings — 3 fixes + regression test ([#533](https://github.com/nikunjmavani/core-be/issues/533)) ([5a85ecd](https://github.com/nikunjmavani/core-be/commit/5a85ecd7d19303cb45231ec2d73082dfd6d4e631))
* **sec:** account-deletion safety — invalidate verification tokens + revoke-before-purge (sec-U1+U8) ([#404](https://github.com/nikunjmavani/core-be/issues/404)) ([43a1e5a](https://github.com/nikunjmavani/core-be/commit/43a1e5aedc49cd19f2e082febeb9b247a6bea3cf))
* **sec:** add captchaPreHandler to POST /mfa/login (sec-new-A1) ([85d2a89](https://github.com/nikunjmavani/core-be/commit/85d2a892decb1cf9e882922188633de6ffdea5c0))
* **sec:** add captchaPreHandler to POST /mfa/login (sec-new-A1) ([f2c02db](https://github.com/nikunjmavani/core-be/commit/f2c02db0212721ec29b99633f455f36f8e9f23c9))
* **sec:** add closeUserDataExportQueue to worker shutdown sequence (sec-r4-R1) ([#501](https://github.com/nikunjmavani/core-be/issues/501)) ([6e8e96f](https://github.com/nikunjmavani/core-be/commit/6e8e96ff11af4819d22cfb34df5b27f125518cbd))
* **sec:** add deleted_at guards to org-discovery RLS and invitation lookup (sec-r4-T1/T2) ([#500](https://github.com/nikunjmavani/core-be/issues/500)) ([b4ea6ee](https://github.com/nikunjmavani/core-be/commit/b4ea6ee0969cd5ff8da76b7abb68823e711d5939))
* **sec:** add partial index for audit.logs.actor_api_key_id (sec-D8) ([#432](https://github.com/nikunjmavani/core-be/issues/432)) ([761f28b](https://github.com/nikunjmavani/core-be/commit/761f28b96207265002e24ad2f263da00ff97eb99))
* **sec:** audit append-only DB invariant — split tenant-isolation policy + REVOKE UPDATE (sec-U3) ([#409](https://github.com/nikunjmavani/core-be/issues/409)) ([7991dfc](https://github.com/nikunjmavani/core-be/commit/7991dfc486ed22eff946b346982285c1f87fee65))
* **sec:** audit every data-export URL mint, rate-limit GET, drop TTL 24h→15min (sec-U6) ([#429](https://github.com/nikunjmavani/core-be/issues/429)) ([4943057](https://github.com/nikunjmavani/core-be/commit/4943057037519b0c294e4e46405d202008083973))
* **sec:** audit every login surface, not just password (sec-A8) ([#427](https://github.com/nikunjmavani/core-be/issues/427)) ([9872491](https://github.com/nikunjmavani/core-be/commit/9872491ad9ee8271d3a063738dd3b1423013095c))
* **sec:** audit hygiene — denylist metadata strip + admin user-mgmt audit + admin audit-read audit + permission-deny audit (sec-U2+U9+U4+U13) ([#408](https://github.com/nikunjmavani/core-be/issues/408)) ([98e60ff](https://github.com/nikunjmavani/core-be/commit/98e60ff889e7c94d716aaf235c0b782d05bd4a8f))
* **sec:** audit login failures alongside successes on every login surface (sec-A8 follow-up) ([#438](https://github.com/nikunjmavani/core-be/issues/438)) ([e4a9c2f](https://github.com/nikunjmavani/core-be/commit/e4a9c2f88925653cf12910efbb6258ba2c7c1d73))
* **sec:** audit serializer is strip-only with resolved public ids (sec-re-08) ([#458](https://github.com/nikunjmavani/core-be/issues/458)) ([5a07fdb](https://github.com/nikunjmavani/core-be/commit/5a07fdb15f4706478587523c96f090a92a8a3ce1))
* **sec:** auth defense in depth — last login-method guard + super-admin rederive + step-up on session revoke (sec-A5+A6+A7) ([#407](https://github.com/nikunjmavani/core-be/issues/407)) ([021c4b3](https://github.com/nikunjmavani/core-be/commit/021c4b31ce8d3c619f48ebcf43e4393ad2cf9b3d))
* **sec:** bind audit-list pagination cursor to its minting filter set (sec-U12) ([#434](https://github.com/nikunjmavani/core-be/issues/434)) ([f6a40e2](https://github.com/nikunjmavani/core-be/commit/f6a40e2db1fc34916c236f5fc3a478d5d09020df))
* **sec:** block update() on org-owner membership to prevent Admin lockout (sec-new-T1) ([dfa526a](https://github.com/nikunjmavani/core-be/commit/dfa526a03dafa3ddae99029e34651aeffa979d51))
* **sec:** block update() on org-owner membership to prevent Admin lockout (sec-new-T1) ([c3c6cfe](https://github.com/nikunjmavani/core-be/commit/c3c6cfe24145ab0cc3e63fe8a8d3d1a20d5a7642))
* **sec:** breach compression-skip actually engages in production (sec-re-03) ([#454](https://github.com/nikunjmavani/core-be/issues/454)) ([5039ccd](https://github.com/nikunjmavani/core-be/commit/5039ccd0699dac287c89a94b85e9c6a4f630c25e))
* **sec:** build Stripe customer email from a platform-owned domain, not tenant slug (sec-B11) ([#436](https://github.com/nikunjmavani/core-be/issues/436)) ([8bb5338](https://github.com/nikunjmavani/core-be/commit/8bb533845fcf074150dc3796e2038dcab01df372))
* **sec:** cache the i18n preHandler organization → locale lookup (sec-M1) ([#440](https://github.com/nikunjmavani/core-be/issues/440)) ([180937a](https://github.com/nikunjmavani/core-be/commit/180937a42a83ec058d0e66823c534db54270cf73))
* **sec:** collapse unmatched-route Prometheus label into __unmatched__ sentinel (sec-C2) ([#401](https://github.com/nikunjmavani/core-be/issues/401)) ([5fc8743](https://github.com/nikunjmavani/core-be/commit/5fc87432500a76271dc867df7b68851e5e68ed74))
* **sec:** config + middleware hardening (sec-cm batch) ([#449](https://github.com/nikunjmavani/core-be/issues/449)) ([b150253](https://github.com/nikunjmavani/core-be/commit/b15025363ad4af584a93572f1a0afb5dc76f1e4f))
* **sec:** config cleanup — drop JWT_SECRET + add deps:audit:prod to ci:local + ENABLE_RESPONSE_ENCRYPTION pairing refine (sec-C5+C10+C11) ([#419](https://github.com/nikunjmavani/core-be/issues/419)) ([7cab170](https://github.com/nikunjmavani/core-be/commit/7cab17038463c7a568e36c48f4c10acc0e6235f3))
* **sec:** cors exposes x-client-request-id (sec-re-17) ([#467](https://github.com/nikunjmavani/core-be/issues/467)) ([8960cfc](https://github.com/nikunjmavani/core-be/commit/8960cfcc13b33e6abb222631ff5de62f3b1d9a7b))
* **sec:** data-export request route advertises 15-minute URL lifetime (sec-re-12) ([#462](https://github.com/nikunjmavani/core-be/issues/462)) ([bc7cea3](https://github.com/nikunjmavani/core-be/commit/bc7cea3c096583e338e25edca4d58d59616718c4))
* **sec:** db retention growth — verification token sweep + AUDIT_RETENTION_DAYS cap (sec-D5+U10) ([#415](https://github.com/nikunjmavani/core-be/issues/415)) ([ab9428b](https://github.com/nikunjmavani/core-be/commit/ab9428b5a5cd93a24ce283f8598dd318e0e0ef03))
* **sec:** db stability — drop volatile chk_org_notif_muted + worker statement_timeout + audit.logs target_user_id index (sec-D1+D2+D3) ([#414](https://github.com/nikunjmavani/core-be/issues/414)) ([f77ce4a](https://github.com/nikunjmavani/core-be/commit/f77ce4aee1366eaa1ff82da6575b5011dd382ca5))
* **sec:** delete dead findActiveByUserId / findActiveByOrganizationId (sec-D12) ([#437](https://github.com/nikunjmavani/core-be/issues/437)) ([6367dd4](https://github.com/nikunjmavani/core-be/commit/6367dd45ca44614f1e0a2d10fd2dfdf0df9f390e))
* **sec:** derive invitation email from membership user on create (sec-T1 complete) ([#471](https://github.com/nikunjmavani/core-be/issues/471)) ([6d54c99](https://github.com/nikunjmavani/core-be/commit/6d54c99a15cd6c1dc48ec3b1c6357c540db4bf29))
* **sec:** dlq replay no-op + commit-dispatch cleanup + worker hardening (sec-q batch) ([#444](https://github.com/nikunjmavani/core-be/issues/444)) ([6c96a0b](https://github.com/nikunjmavani/core-be/commit/6c96a0bb1c47d016d87735cbe16ee173e7de19c4))
* **sec:** do not clear session cookie in revokeAllSessions handler (sec-r4-A1) ([#499](https://github.com/nikunjmavani/core-be/issues/499)) ([b7e3952](https://github.com/nikunjmavani/core-be/commit/b7e395262f8ec06a84a5426b9c4a9dafa85ec351))
* **sec:** docker.agent USER node + drop openssh + enforce abort timeout on retrieveStripeEvent (sec-C8 + sec-Q5 partial) ([#422](https://github.com/nikunjmavani/core-be/issues/422)) ([d10af52](https://github.com/nikunjmavani/core-be/commit/d10af524ec39a00994b041f7727d18cc6e81639b))
* **sec:** document the online-safe ALTER COLUMN pattern (sec-D6) ([#443](https://github.com/nikunjmavani/core-be/issues/443)) ([c72deb4](https://github.com/nikunjmavani/core-be/commit/c72deb4e3f9b7cdaba267b14948fd73025dce3e3))
* **sec:** document verification_tokens application-trust safety model (sec-D9) ([#441](https://github.com/nikunjmavani/core-be/issues/441)) ([e069891](https://github.com/nikunjmavani/core-be/commit/e069891909cd0487a4cd5ab523930f8b0d6e105d))
* **sec:** drop org branch from user_notification_preferences RLS + add CHECK pin (sec-U7) ([#428](https://github.com/nikunjmavani/core-be/issues/428)) ([13fc188](https://github.com/nikunjmavani/core-be/commit/13fc188e22603b55f3226994399e5564e50f5843))
* **sec:** enforce SSE-S3 on every server-side S3 write (sec-U11) ([#435](https://github.com/nikunjmavani/core-be/issues/435)) ([0792d76](https://github.com/nikunjmavani/core-be/commit/0792d76c07ece878f8adc1f282f1966efbe54ae7))
* **sec:** expose policy public_id instead of bigserial in URLs and responses (sec-T5) ([#442](https://github.com/nikunjmavani/core-be/issues/442)) ([88d5db7](https://github.com/nikunjmavani/core-be/commit/88d5db72bc21184da5ea00ec0baaa0256d0f03a9))
* **sec:** extend staging guards to ALLOWED_ORIGINS, COOKIE_SECURE, and SECRETS_ENCRYPTION_KEY (sec-r4-C1/C2/C3) ([#498](https://github.com/nikunjmavani/core-be/issues/498)) ([0efd169](https://github.com/nikunjmavani/core-be/commit/0efd169841cea7cfba5197012dfb6e3f615fe629))
* **sec:** fall back to INSERT when subscription.created arrives before local row (sec-B9) ([#439](https://github.com/nikunjmavani/core-be/issues/439)) ([fd68e66](https://github.com/nikunjmavani/core-be/commit/fd68e660e7d19d1707b0bfe97ac4fe29d08ab427))
* **sec:** harden invitation binding, webhook retry, role invariants, and upload key contract ([#470](https://github.com/nikunjmavani/core-be/issues/470)) ([65cdf2f](https://github.com/nikunjmavani/core-be/commit/65cdf2f9179ac01aa1110f95b60cb6a7fd1519db))
* **sec:** invitation accept requires auth + invitee email match (sec-T4) ([#423](https://github.com/nikunjmavani/core-be/issues/423)) ([7cdc3f8](https://github.com/nikunjmavani/core-be/commit/7cdc3f83beafaa9e682bf39348cb1caa4047c2fb))
* **sec:** mark-confirmed-by-internal-id filters deleted_at and pending (sec-re-13) ([#463](https://github.com/nikunjmavani/core-be/issues/463)) ([dbd9156](https://github.com/nikunjmavani/core-be/commit/dbd9156fd40ff4e2e92ab6ace5823b2e60279e60))
* **sec:** mfa hardening — step-up requires mfa + per-session binding + org-policy delete guard (sec-A1+A2+A4) ([#403](https://github.com/nikunjmavani/core-be/issues/403)) ([1ba5047](https://github.com/nikunjmavani/core-be/commit/1ba504726442aaaea626d2b73f542c55b8214d0a))
* **sec:** mfa is_mfa_enabled flip happens inside the enrollConfirm transaction (sec-re-06) ([#469](https://github.com/nikunjmavani/core-be/issues/469)) ([675c1f2](https://github.com/nikunjmavani/core-be/commit/675c1f257bb02ecf3967a3295ff1f6d1068da136))
* **sec:** mfa re-enroll dedups stale totp factors (sec-re-04) ([#455](https://github.com/nikunjmavani/core-be/issues/455)) ([f7a66ab](https://github.com/nikunjmavani/core-be/commit/f7a66abb8218a13bbf92472ba3fc0c3e26ab6f3e))
* **sec:** middleware observability — captcha bypass closed in staging + HSTS env gate + ALLOWED_ORIGINS canonicalization + encryption 503 (sec-M3+M5+M8+M9) ([#417](https://github.com/nikunjmavani/core-be/issues/417)) ([57abed9](https://github.com/nikunjmavani/core-be/commit/57abed9c55fa7fc50c72b1161e8270b5a64b024f))
* **sec:** notification worker user context + db integrity indexes (sec-d batch) ([#450](https://github.com/nikunjmavani/core-be/issues/450)) ([a1a8fe5](https://github.com/nikunjmavani/core-be/commit/a1a8fe5c15fd5b3c4b8437413ef40e5b4efeb821))
* **sec:** notification worker user-context fix is live wiring (sec-re-01) ([#452](https://github.com/nikunjmavani/core-be/issues/452)) ([653adf5](https://github.com/nikunjmavani/core-be/commit/653adf5653b634dcf907927ad4f6a660256f8a79))
* **sec:** notify abuse caps — per-organization webhook cap + secret-rotation overlap window (sec-N4+N8) ([#411](https://github.com/nikunjmavani/core-be/issues/411)) ([a7455f5](https://github.com/nikunjmavani/core-be/commit/a7455f5548d20fe8460b92154e17b2ca75eda24a))
* **sec:** notify durability — worker re-checks disabled/deleted + delivery-id header + event_key dedupe (sec-N1+N3+N2) ([#410](https://github.com/nikunjmavani/core-be/issues/410)) ([c09ae6c](https://github.com/nikunjmavani/core-be/commit/c09ae6c7acad9de05fe7c28f365ba9af84795c16))
* **sec:** notify recipient + idempotency canonical fingerprint + tenant authorized-org helper (sec-N7+M6+M7) ([#420](https://github.com/nikunjmavani/core-be/issues/420)) ([17a8bbd](https://github.com/nikunjmavani/core-be/commit/17a8bbdc9d364eb9b5bfa5f71d0ffbe86e30645e))
* **sec:** org-scoped audit log sanitiser + strip-only serializers (sec-t batch) ([#448](https://github.com/nikunjmavani/core-be/issues/448)) ([6019182](https://github.com/nikunjmavani/core-be/commit/6019182b695080795d232d7afe04b96659ff34d2))
* **sec:** protect owner role from permission writes via ROLE_MANAGE (sec-T2) ([#402](https://github.com/nikunjmavani/core-be/issues/402)) ([6b11b6e](https://github.com/nikunjmavani/core-be/commit/6b11b6e6da7e825d48d7348b50576861a5fc4cbc))
* **sec:** queue infrastructure — defaultJobOptions on cron queues + flip topology warn + fail boot on scheduler drift in prod (sec-Q1+Q2+Q3) ([#416](https://github.com/nikunjmavani/core-be/issues/416)) ([32b960e](https://github.com/nikunjmavani/core-be/commit/32b960e03cc6a164d137dc080f583846b93635a9))
* **sec:** rate-limit per-email bucket id is hashed (sec-re-11) ([#461](https://github.com/nikunjmavani/core-be/issues/461)) ([4239be4](https://github.com/nikunjmavani/core-be/commit/4239be4ddb5d3432295565b4bb8e110612e97012))
* **sec:** recovery-code alphabet doc reflects 31 symbols and case-insensitive hash (sec-re-14) ([#464](https://github.com/nikunjmavani/core-be/issues/464)) ([1bc8b00](https://github.com/nikunjmavani/core-be/commit/1bc8b001519154b9e5da12abf4a4d808b12cd9d8))
* **sec:** refresh stale ordering comments around the no-op RLS-transaction plugin (sec-M4) ([#433](https://github.com/nikunjmavani/core-be/issues/433)) ([1bd211e](https://github.com/nikunjmavani/core-be/commit/1bd211e288ac062486e9374667e1619401e4f666))
* **sec:** refresh-token reuse detection fires for revoked sessions (sec-re-05) ([#456](https://github.com/nikunjmavani/core-be/issues/456)) ([bf5ee5e](https://github.com/nikunjmavani/core-be/commit/bf5ee5e30c0233d13a0f28d0b9b2afff4df0da4c))
* **sec:** remove privilege-bypass arms from audit.logs INSERT RLS (sec-r4-D1) ([#497](https://github.com/nikunjmavani/core-be/issues/497)) ([787b3c8](https://github.com/nikunjmavani/core-be/commit/787b3c8d20ebb37f97ef9cd2d27aa66f992df7c3))
* **sec:** replace z.coerce.boolean() foot-gun on env booleans (sec-C1) ([#400](https://github.com/nikunjmavani/core-be/issues/400)) ([f8a49c3](https://github.com/nikunjmavani/core-be/commit/f8a49c367e9bbc5cdc7e54e9d9c988e4dbe13bca))
* **sec:** repository hygiene — atomic markAllRead count + WebAuthn counter monotonicity guard (sec-D10/D11) ([#426](https://github.com/nikunjmavani/core-be/issues/426)) ([1d817db](https://github.com/nikunjmavani/core-be/commit/1d817db6ded2820f9334b31d05ca4e4b23ae30b2))
* **sec:** require caller can grant target role permissions on membership create (sec-T1) ([#399](https://github.com/nikunjmavani/core-be/issues/399)) ([899aab3](https://github.com/nikunjmavani/core-be/commit/899aab3abcf9de727a8b0e7fe3ecdcb7ad14d654))
* **sec:** require caller to hold every code added or removed on role-permission PUT (sec-T2) ([#425](https://github.com/nikunjmavani/core-be/issues/425)) ([b9b545e](https://github.com/nikunjmavani/core-be/commit/b9b545ee4de3c1b36bd05a8d80e8ebce8f497565))
* **sec:** require live-mode + both-or-neither Stripe keys in production (sec-B5/B6) ([#424](https://github.com/nikunjmavani/core-be/issues/424)) ([2ca7f2c](https://github.com/nikunjmavani/core-be/commit/2ca7f2cdb4e411275f465164b91ae2099f98a395))
* **sec:** role-delete guards + strip is_system from createMemberRoleDto (sec-T3) ([#406](https://github.com/nikunjmavani/core-be/issues/406)) ([1b41ab9](https://github.com/nikunjmavani/core-be/commit/1b41ab98cfaedfb11a7f5f3c87c26106e8bc2373))
* **sec:** sentry/log redaction + observability — OTLP https refine + readyz verbose env gate + Sentry message/exception/user redaction + LOG_LEVEL enum (sec-C3+C4+C6+C9) ([#418](https://github.com/nikunjmavani/core-be/issues/418)) ([b0337ce](https://github.com/nikunjmavani/core-be/commit/b0337ce2ad6f21ac16b0c97fccda158e7c64dd55))
* **sec:** stripe event retrieve honours per-attempt timeout for real (sec-re-15) ([#465](https://github.com/nikunjmavani/core-be/issues/465)) ([d5640da](https://github.com/nikunjmavani/core-be/commit/d5640daf8c1bacf06e9ca92894ac4d97a9945fe3))
* **sec:** stripe ingress durability + ordering + raw-body wiring (sec-b batch) ([#446](https://github.com/nikunjmavani/core-be/issues/446)) ([8a88beb](https://github.com/nikunjmavani/core-be/commit/8a88beb6cd7ea43f4cf42d034f2a37ba6a241d9e))
* **sec:** stripe reclaim cron→worker handoff is recoverable (sec-re-02) ([#453](https://github.com/nikunjmavani/core-be/issues/453)) ([3cdce4f](https://github.com/nikunjmavani/core-be/commit/3cdce4fcaabf0b6895b73c4feb412f0edd451080))
* **sec:** stripe reconciliation — close 4 silent-divergence paths (sec-B1+B2+B3+B4) ([#405](https://github.com/nikunjmavani/core-be/issues/405)) ([87ab3fb](https://github.com/nikunjmavani/core-be/commit/87ab3fb998f712f5a1b033708c1d65b9ba4c8b82))
* **sec:** subscription response surfaces plan public id (sec-re-07) ([#457](https://github.com/nikunjmavani/core-be/issues/457)) ([537325c](https://github.com/nikunjmavani/core-be/commit/537325c9f8f71a7e7452db8126bcb5517c8b2b1b))
* **sec:** sync local plan_id from Stripe customer.subscription.updated (sec-B7) ([#430](https://github.com/nikunjmavani/core-be/issues/430)) ([bc5a21a](https://github.com/nikunjmavani/core-be/commit/bc5a21ae87d6c253ad7094e752859fe254492d0e))
* **sec:** tenant context lifts the worker statement_timeout (sec-re-16) ([#466](https://github.com/nikunjmavani/core-be/issues/466)) ([415a58e](https://github.com/nikunjmavani/core-be/commit/415a58eb3a4c8c2334d8bcd5649f1348fdf9f455))
* **sec:** tombstoneAllByOrganizationId removes S3 objects synchronously (sec-UP8) ([#421](https://github.com/nikunjmavani/core-be/issues/421)) ([186bd71](https://github.com/nikunjmavani/core-be/commit/186bd711303862d3386cc6f7391ef0dd73928613))
* **sec:** two-phase mfa enrollment + refresh reuse-detection + login uniformity (sec-a batch) ([#445](https://github.com/nikunjmavani/core-be/issues/445)) ([d1e1e59](https://github.com/nikunjmavani/core-be/commit/d1e1e593bcf31c515f22fb1e2c4d07a89c76e81c))
* **sec:** upload confirm pins copy to verified etag (sec-re-10) ([#460](https://github.com/nikunjmavani/core-be/issues/460)) ([2eb3d11](https://github.com/nikunjmavani/core-be/commit/2eb3d11ca070c52c0e4fcf2cc5c5c0c391573837))
* **sec:** upload security — refuse legacy in-place + sweep refuses SVG + assertKeyConfirmedForOwner + DOMPurify hardening (sec-UP1+UP2+UP5+UP6) ([#412](https://github.com/nikunjmavani/core-be/issues/412)) ([76e80ad](https://github.com/nikunjmavani/core-be/commit/76e80ad3617b7d87f57fc292c6e41efba7f89d89))
* **sec:** upload size/policy — organizationId regex + org pending cap + force presigned POST in prod (sec-UP3+UP4+UP10) ([#413](https://github.com/nikunjmavani/core-be/issues/413)) ([237d517](https://github.com/nikunjmavani/core-be/commit/237d517905e321c9c73c1e9cc8f9fa181a73a597))
* **security:** strip Stripe-shaped literals from source + add regression test (GH secret-scanning) ([#529](https://github.com/nikunjmavani/core-be/issues/529)) ([f234e60](https://github.com/nikunjmavani/core-be/commit/f234e6044879c72385e3b61728ea4ba665931ae6))
* **sec:** validate membership and api-key path params at the boundary (sec-re-18) ([#468](https://github.com/nikunjmavani/core-be/issues/468)) ([c0ab171](https://github.com/nikunjmavani/core-be/commit/c0ab17106d8e7dd27513e3bf2f76a480775fd557))
* **sec:** validate subscriptionId path param at every billing handler (sec-B10) ([#431](https://github.com/nikunjmavani/core-be/issues/431)) ([2bbd338](https://github.com/nikunjmavani/core-be/commit/2bbd33864cd192a22d5d41f70ed7064a628a3809))
* **sec:** webhook secret strength + upload sweep file_key invariant + data-export doc (sec-up batch) ([#447](https://github.com/nikunjmavani/core-be/issues/447)) ([145c838](https://github.com/nikunjmavani/core-be/commit/145c8385ec8b02c25b0b508adbabd71c2ce8dc05))
* **storage:** enforce SSE-S3 on presigned uploads (sec-r4-E1) ([#509](https://github.com/nikunjmavani/core-be/issues/509)) ([f962d37](https://github.com/nikunjmavani/core-be/commit/f962d372565e05986fb00a2cef960694b4b35885))
* **tenancy:** bound MemberRolePermissionRepository.findByRoleId rows per role (sec-r4-D4) ([#508](https://github.com/nikunjmavani/core-be/issues/508)) ([9218518](https://github.com/nikunjmavani/core-be/commit/92185187cd5397f4f349442626a936f55e718b7b))
* **tenancy:** exclude soft-deleted orgs from organizations_tenant_isolation RLS policy (sec-new-D3) ([#491](https://github.com/nikunjmavani/core-be/issues/491)) ([904802a](https://github.com/nikunjmavani/core-be/commit/904802affcc95bea74e6f510b64c655ccbd46df0))
* **tenancy:** rate-limit membership lifecycle endpoints (sec-r4-I3) ([#505](https://github.com/nikunjmavani/core-be/issues/505)) ([1f0c8c0](https://github.com/nikunjmavani/core-be/commit/1f0c8c01d38bbaa6020b8a8cab7e3d5b0657b0b7))
* **tenancy:** rate-limit organization mutation endpoints (sec-r4-I2) ([#504](https://github.com/nikunjmavani/core-be/issues/504)) ([2f6bedb](https://github.com/nikunjmavani/core-be/commit/2f6bedb59ca27d9d11c68299560470d8f0418d77))
* **tenancy:** sec-new-M1 add STRICT_AUTHED_RATE_LIMIT to POST /organizations ([#477](https://github.com/nikunjmavani/core-be/issues/477)) ([dd9fd62](https://github.com/nikunjmavani/core-be/commit/dd9fd62112aefe4eaa63869ab6c37ac62ee8540c))
* **tenancy:** sec-new-T2 validate invitationId path param in all invitation handlers ([#480](https://github.com/nikunjmavani/core-be/issues/480)) ([93fa940](https://github.com/nikunjmavani/core-be/commit/93fa940a7d371acd95889257b027075d305d1e60))
* **tenancy:** sec-new-T3 validate id and roleId path params in role handlers ([#481](https://github.com/nikunjmavani/core-be/issues/481)) ([361159a](https://github.com/nikunjmavani/core-be/commit/361159aca4126ae5df7b446dd437c199082a9636))
* **tests:** cleanupDatabase preserves schema_migrations; update tests inherited from main's B4 + sec-r4-A1 semantics ([#525](https://github.com/nikunjmavani/core-be/issues/525)) ([169327e](https://github.com/nikunjmavani/core-be/commit/169327ec7652cefd7301b8d0c1c47009caa9ae5e))
* **upload:** add DTO-level fileSize ceiling (sec-r4-I4) ([#515](https://github.com/nikunjmavani/core-be/issues/515)) ([049f917](https://github.com/nikunjmavani/core-be/commit/049f917c71b8c043e39bbbcd40f93eec534994fc))
* **user-data-export:** bound offboarding S3 delete fan-out (sec-r4-R2) ([#513](https://github.com/nikunjmavani/core-be/issues/513)) ([6ef83de](https://github.com/nikunjmavani/core-be/commit/6ef83de5039fcb08bd4422ad04cfc4282ee53bd4))
* **user:** rate-limit /me profile mutation endpoints (sec-r4-I1) ([#503](https://github.com/nikunjmavani/core-be/issues/503)) ([0c745e1](https://github.com/nikunjmavani/core-be/commit/0c745e182c0c6be2de608f42e9c434212ad07c08))
* **user:** sec-new-U1 cap ListUsersDto.after cursor to 512 chars ([#483](https://github.com/nikunjmavani/core-be/issues/483)) ([fae555d](https://github.com/nikunjmavani/core-be/commit/fae555dd2717a4cde9a703f64941cca09d55e33f))


### Changed

* **architecture:** move raw SQL out of stripe-webhook-organization.util into the repository (+ global gate) ([#530](https://github.com/nikunjmavani/core-be/issues/530)) ([f48fb46](https://github.com/nikunjmavani/core-be/commit/f48fb46fe1005a95adc0abf14222df8f86c030f9))


### Documentation

* **infra:** annotate Dockerfile build-stage ENV as test-only placeholders (sec-r4-C6) ([#519](https://github.com/nikunjmavani/core-be/issues/519)) ([cdf76ef](https://github.com/nikunjmavani/core-be/commit/cdf76ef7e6a85de7e638c161d1e7ad34dd12e38a))
* **reviews:** architecture conformance audit + 8-PR follow-up plan ([#531](https://github.com/nikunjmavani/core-be/issues/531)) ([4a9264c](https://github.com/nikunjmavani/core-be/commit/4a9264cb674f57930241a8b348d12afdcc727476))
* **reviews:** correct sec-r4-A3 analysis and defer to follow-up task ([#523](https://github.com/nikunjmavani/core-be/issues/523)) ([c7e1dab](https://github.com/nikunjmavani/core-be/commit/c7e1dab9433b40eb16a7df6e28fdf317df9318b7))
* **reviews:** route-coverage audit — 129 routes, 9 deferred gaps allowlisted ([#534](https://github.com/nikunjmavani/core-be/issues/534)) ([d18ec1d](https://github.com/nikunjmavani/core-be/commit/d18ec1df87b78237c77bac6f84b1ec464ff71965))
* **superpowers:** re-audit remediation design spec for 18 findings ([#451](https://github.com/nikunjmavani/core-be/issues/451)) ([1b05734](https://github.com/nikunjmavani/core-be/commit/1b05734fe69e593ae6ad9f5fb2f11e6f4a8f69f6))

## [4.0.0](https://github.com/nikunjmavani/core-be/compare/v3.0.0...v4.0.0) (2026-06-05)


### ⚠ BREAKING CHANGES

* **error-handler:** honor 4xx Fastify framework errors + DoS hardening tests ([#276](https://github.com/nikunjmavani/core-be/issues/276))

### Added

* add environment-managed Railway and Postman secrets ([#77](https://github.com/nikunjmavani/core-be/issues/77)) ([339eee6](https://github.com/nikunjmavani/core-be/commit/339eee628862b20fa1474537526736e37449ebf1))
* **ci:** add PR-time Trivy IaC misconfig scan ([#388](https://github.com/nikunjmavani/core-be/issues/388)) ([e8499e0](https://github.com/nikunjmavani/core-be/commit/e8499e04b8c8d311a14fb6ac3bdd1c4a4d151a49))
* **ci:** auto-merge release-please PRs ([#57](https://github.com/nikunjmavani/core-be/issues/57)) ([30204d8](https://github.com/nikunjmavani/core-be/commit/30204d8d3ee02f8e20b2b3969e80519d3e50ced1))
* **ci:** wire route-HTTP-coverage gate + close mcp/ops gaps (H1) ([#306](https://github.com/nikunjmavani/core-be/issues/306)) ([ef6eefb](https://github.com/nikunjmavani/core-be/commit/ef6eefbc6c311aecec5b9532d2700a48d705654c))
* **coverage:** add patch (differential) coverage tool + document the real coverage policy ([#266](https://github.com/nikunjmavani/core-be/issues/266)) ([73ccfe3](https://github.com/nikunjmavani/core-be/commit/73ccfe3ffd107fc273479d08c76f05a14ec7e73f))
* **env, ci:** Railway deploy secrets in env schema + Node 24 workflow policy bumps ([#75](https://github.com/nikunjmavani/core-be/issues/75)) ([fe7d7eb](https://github.com/nikunjmavani/core-be/commit/fe7d7eb9c28dc885872ed6b202b12a6f51e48158))
* **load:** per-VU credential pool + realistic user-journey k6 scenario ([#342](https://github.com/nikunjmavani/core-be/issues/342)) ([a05a611](https://github.com/nikunjmavani/core-be/commit/a05a611ced68683c0855c65d572fbc5fc7d06bb1))
* **observability:** emit Server-Timing header for true server-side latency ([#339](https://github.com/nikunjmavani/core-be/issues/339)) ([5e78cde](https://github.com/nikunjmavani/core-be/commit/5e78cde15b30deac077cbf4e27081cf6da27e814))
* **outbound:** centralize timeout, retry, circuit, redaction, request-id ([#39](https://github.com/nikunjmavani/core-be/issues/39)) ([ce65bc1](https://github.com/nikunjmavani/core-be/commit/ce65bc14bce3749b952a61d2ddaea600ab29b556))
* production readiness items 3-8 (idempotency, rate-limit obs, sunset CI, restore drill, SBOM, ops scripts) ([#180](https://github.com/nikunjmavani/core-be/issues/180)) ([77792e6](https://github.com/nikunjmavani/core-be/commit/77792e632ea826dd369a1f3abb5d6d1d27e9c718))
* **reliability:** crash-safe dispatch, DLQ auto-retry, and ops improvements ([#214](https://github.com/nikunjmavani/core-be/issues/214)) ([ffdff4d](https://github.com/nikunjmavani/core-be/commit/ffdff4d0eaade870eb50198e0afdb769d72917df))
* **seed:** configurable bulk seeder (shared orchestrator + per-domain seed/ dirs) ([#227](https://github.com/nikunjmavani/core-be/issues/227)) ([d7285a1](https://github.com/nikunjmavani/core-be/commit/d7285a19cd9f29c05092903139156916da29a7c4))
* **seed:** orchestration wiring smoke test + docs/skills/rules ([#238](https://github.com/nikunjmavani/core-be/issues/238)) ([09ee7ef](https://github.com/nikunjmavani/core-be/commit/09ee7ef517075142e587838da5c0df6110504eaa))
* **setup-domain:** rename to setup:domain, fix imports, add poll + batch + runbook ([#153](https://github.com/nikunjmavani/core-be/issues/153)) ([f6b2a10](https://github.com/nikunjmavani/core-be/commit/f6b2a10a16fd827828571e1823584a8c5bfba053))
* **setup-railway:** support RAILWAY_API_TOKEN + mint per-environment project tokens ([#269](https://github.com/nikunjmavani/core-be/issues/269)) ([f73d0dc](https://github.com/nikunjmavani/core-be/commit/f73d0dc4b42667e50a7605637ace43060e661b38))
* **setup:** dynamic rate-limit-aware delay for GitHub env sync + Railway preflight log tweak ([#86](https://github.com/nikunjmavani/core-be/issues/86)) ([7276574](https://github.com/nikunjmavani/core-be/commit/72765742f50a7ee386e5a2cd780edbc6e54dca0c))
* **setup:** harden GitHub env sync and Railway deploy diagnostics ([#88](https://github.com/nikunjmavani/core-be/issues/88)) ([040bfa9](https://github.com/nikunjmavani/core-be/commit/040bfa9919819b3b836e1070a5e4d390da7636cb))
* **setup:** provision Railway Redis with concrete URLs ([#108](https://github.com/nikunjmavani/core-be/issues/108)) ([f2228ca](https://github.com/nikunjmavani/core-be/commit/f2228ca8ebdb44553ca48f59db8cafa7574951e9))
* **sonar:** local SonarQube pre-push quality gate ([#253](https://github.com/nikunjmavani/core-be/issues/253)) ([383ef5e](https://github.com/nikunjmavani/core-be/commit/383ef5e8b0701218e8f020dc534d258df3886279))
* **tooling:** centralize project identity in setup.config.json ([#200](https://github.com/nikunjmavani/core-be/issues/200)) ([c313290](https://github.com/nikunjmavani/core-be/commit/c313290101b3fc845389fd77ac6fefa117f5b168))
* **upload:** confirmation route ([#6](https://github.com/nikunjmavani/core-be/issues/6)) + presigned POST size enforcement ([#7](https://github.com/nikunjmavani/core-be/issues/7)) ([#19](https://github.com/nikunjmavani/core-be/issues/19)) ([236a036](https://github.com/nikunjmavani/core-be/commit/236a036ee4626229128c6be82b85fe7e866a3667))
* **upload:** hardening — filename extension, PENDING sweeper, per-user quota, S3 adapter contract test ([#28](https://github.com/nikunjmavani/core-be/issues/28)) ([bddb789](https://github.com/nikunjmavani/core-be/commit/bddb78904e286d3fcab00692e921d635b0676bac))
* **upload:** reject path-traversal / control-char filenames + upload attack tests ([#279](https://github.com/nikunjmavani/core-be/issues/279)) ([f26a1a9](https://github.com/nikunjmavani/core-be/commit/f26a1a9dd3f9f4660ab42a4f250f254d5e0b9760))


### Fixed

* add keyset pagination for large lists ([#36](https://github.com/nikunjmavani/core-be/issues/36)) ([35ca54d](https://github.com/nikunjmavani/core-be/commit/35ca54dbfe05e6ddf7cf2259273475f72db58f72))
* align worker connection budget with registered queues ([#30](https://github.com/nikunjmavani/core-be/issues/30)) ([86e927d](https://github.com/nikunjmavani/core-be/commit/86e927d2c8d6d65a857e430a7abc0dc2dc02d21e))
* audit batch2 — WebAuthn typed DTOs, oasdiff SIGSEGV CI workaround ([6e44557](https://github.com/nikunjmavani/core-be/commit/6e4455700f39ed6cc6dee5ca71baf4eaddac49ed))
* **audit-13:** remove dead jobTimeout field from worker options — BullMQ does not enforce it ([#379](https://github.com/nikunjmavani/core-be/issues/379)) ([b393d5e](https://github.com/nikunjmavani/core-be/commit/b393d5e0add3e299de889d023056397a559b5df6))
* **audit:** cursor max-length, DLQ catch, jobTimeout, age-based queue eviction (batch5) ([#375](https://github.com/nikunjmavani/core-be/issues/375)) ([5882436](https://github.com/nikunjmavani/core-be/commit/588243618efe4be76f3b9e1d2b0c2aa851b06930))
* **audit:** MCP caller JWT forwarding and IP-level failed-login counter ([#373](https://github.com/nikunjmavani/core-be/issues/373)) ([ceee226](https://github.com/nikunjmavani/core-be/commit/ceee2269da8c40bb16f1332e56de8028de24b069))
* **audit:** rate limits, User-Agent truncation, webhook HTTPS, CAPTCHA staging (batch4) ([#374](https://github.com/nikunjmavani/core-be/issues/374)) ([4c9486a](https://github.com/nikunjmavani/core-be/commit/4c9486ac64959cea4bd308cb59c37ba858018066))
* **auth:** atomically increment the failed-login counter (close lost-update race) ([#303](https://github.com/nikunjmavani/core-be/issues/303)) ([53147a6](https://github.com/nikunjmavani/core-be/commit/53147a65bb78c68ed9e0a94ff2955ca5d21604ee))
* **auth:** email verification fail-closed + remediation tracker ([#188](https://github.com/nikunjmavani/core-be/issues/188)) ([e1dcac5](https://github.com/nikunjmavani/core-be/commit/e1dcac58aca03c5aa66bceb0ab93f4e6e43fed75))
* **auth:** make password reset atomic (transaction) so sessions can't survive it ([#319](https://github.com/nikunjmavani/core-be/issues/319)) ([30cffe5](https://github.com/nikunjmavani/core-be/commit/30cffe5c205fdd7d0f1a835cf335791ad78ad36e))
* **auth:** map duplicate passkey registration to 409 instead of 500 ([#295](https://github.com/nikunjmavani/core-be/issues/295)) ([66b4e1a](https://github.com/nikunjmavani/core-be/commit/66b4e1aa52e3fe59af283b777f8b486d89dce1a2))
* **auth:** remove silent params.id fallback in requireOrganizationPermission ([#346](https://github.com/nikunjmavani/core-be/issues/346)) ([17f4d83](https://github.com/nikunjmavani/core-be/commit/17f4d83fae5114820bf4f1c00940306628ea1228))
* **auth:** restore org-mandated MFA under FORCE RLS via SECURITY DEFINER resolvers ([#318](https://github.com/nikunjmavani/core-be/issues/318)) ([e152c0c](https://github.com/nikunjmavani/core-be/commit/e152c0c458aed788289c7d75b3e8fe0c79ec938f))
* **auth:** stop GET /auth/me/auth-methods leaking encrypted TOTP secret + PII ([#321](https://github.com/nikunjmavani/core-be/issues/321)) ([32cb49e](https://github.com/nikunjmavani/core-be/commit/32cb49e7b1c2039c2554adc481c2f68837720e6e))
* **auth:** stop GET /auth/me/sessions leaking session token hashes ([#287](https://github.com/nikunjmavani/core-be/issues/287)) ([877fe63](https://github.com/nikunjmavani/core-be/commit/877fe63dca1f43a046ad68910df0beba73530ded))
* **billing:** correct misleading plan route OpenAPI descriptions ([#349](https://github.com/nikunjmavani/core-be/issues/349)) ([27246ce](https://github.com/nikunjmavani/core-be/commit/27246ce78082f134005ac028852c7d95233f3c8b))
* **billing:** make Stripe customer creation idempotent on retry ([#326](https://github.com/nikunjmavani/core-be/issues/326)) ([8990fb3](https://github.com/nikunjmavani/core-be/commit/8990fb32b15fa133aece4ce428182d9b1996ee93))
* **billing:** pin Stripe API version to 2026-05-27.dahlia ([#350](https://github.com/nikunjmavani/core-be/issues/350)) ([7c329bd](https://github.com/nikunjmavani/core-be/commit/7c329bd496bdff587f3c12748f923a2ef7267909))
* **cache:** add commandTimeout to Redis client to prevent hung commands ([8cd8107](https://github.com/nikunjmavani/core-be/commit/8cd8107df573d5a8255911dc2fac8f21e676fb66))
* **ci:** align post-deploy checks to /health contract ([#103](https://github.com/nikunjmavani/core-be/issues/103)) ([c7e7728](https://github.com/nikunjmavani/core-be/commit/c7e7728ca3c995323b82a35e753ebd1bf9fec338))
* **ci:** authenticate Railway project tokens in image deploy tool ([#100](https://github.com/nikunjmavani/core-be/issues/100)) ([6ebfd13](https://github.com/nikunjmavani/core-be/commit/6ebfd13d632c39b146fe0767d104acc204cd7846))
* **ci:** batch Railway env push, retry timeouts, exclude all RAILWAY_* ([#92](https://github.com/nikunjmavani/core-be/issues/92)) ([f27128e](https://github.com/nikunjmavani/core-be/commit/f27128e182d995767c630a9b0dfcf634fc7a0cc1))
* **ci:** bootstrap initial Railway deployments when redeploy has no history ([#94](https://github.com/nikunjmavani/core-be/issues/94)) ([61eb364](https://github.com/nikunjmavani/core-be/commit/61eb364e9051b8454cda3ef3124a888a231bf359))
* **ci:** correct post-merge-ci branch context handling ([#53](https://github.com/nikunjmavani/core-be/issues/53)) ([82a359f](https://github.com/nikunjmavani/core-be/commit/82a359f55994f5ce9daf612c2c97c94533290007))
* **ci:** deploy freshly built GHCR image via Railway GraphQL API ([#98](https://github.com/nikunjmavani/core-be/issues/98)) ([fe65954](https://github.com/nikunjmavani/core-be/commit/fe65954aee768faa040bfb08d8535fcf60fc7c59))
* **ci:** drop worker-readiness probe from deploy workflow ([#119](https://github.com/nikunjmavani/core-be/issues/119)) ([57cc48e](https://github.com/nikunjmavani/core-be/commit/57cc48e7cb9815f183a3abf7de2df1646d8648e3))
* **ci:** fail Railway deploy early on invalid RAILWAY_TOKEN ([#79](https://github.com/nikunjmavani/core-be/issues/79)) ([6b5eda1](https://github.com/nikunjmavani/core-be/commit/6b5eda17a2f5f088e8b2850463d5eae3a6071332))
* **ci:** fail-fast on missing Railway deploy secrets ([667bbbe](https://github.com/nikunjmavani/core-be/commit/667bbbe771ec877c890b9da1fc2714e7dbf585f0))
* **ci:** fail-fast on missing Railway deploy secrets ([d10d464](https://github.com/nikunjmavani/core-be/commit/d10d464191786df6a61f83e7898f629e9dba3f2c))
* **ci:** probe worker readiness via Redis instead of public /health ([#117](https://github.com/nikunjmavani/core-be/issues/117)) ([9bc7bb5](https://github.com/nikunjmavani/core-be/commit/9bc7bb5c55305ab75d3317a69fe01708ec52a392))
* **ci:** Railway deploy bootstrap, Docker cache mounts, and CHANGELOG lint ([#96](https://github.com/nikunjmavani/core-be/issues/96)) ([556e75b](https://github.com/nikunjmavani/core-be/commit/556e75b3f2bb4e995b3d7e677168d68476bf12b2))
* **ci:** remove invalid secrets inherit from cd workflow_call ([#48](https://github.com/nikunjmavani/core-be/issues/48)) ([685aa75](https://github.com/nikunjmavani/core-be/commit/685aa75fc66b31d9affb0ffc7adecb7b0b6eccc5))
* **ci:** repair post-merge deploy env wiring ([#56](https://github.com/nikunjmavani/core-be/issues/56)) ([eb59666](https://github.com/nikunjmavani/core-be/commit/eb596666afb9e4c0ac154e0ea3efa0cb76ee8c51))
* **ci:** repair post-merge pipeline failures ([072392e](https://github.com/nikunjmavani/core-be/commit/072392e111af9364076135036ddf53b8c454ba6a))
* **ci:** repair post-merge pipeline failures ([003ffbe](https://github.com/nikunjmavani/core-be/commit/003ffbe44f5721203fcbbb9fc91fe57308e17d5a))
* **ci:** replace invalid env context in post-merge workflow calls ([#50](https://github.com/nikunjmavani/core-be/issues/50)) ([802b772](https://github.com/nikunjmavani/core-be/commit/802b772eca33178319fa33d0857aadd18f1358be))
* **ci:** repoint 12 dead Stryker mutate paths + drift guard (security middlewares were unmutated) ([#310](https://github.com/nikunjmavani/core-be/issues/310)) ([5609146](https://github.com/nikunjmavani/core-be/commit/560914673aa37406be1ecfc570be90d1d6756122))
* **ci:** restore CodeQL tuning lost in [#220](https://github.com/nikunjmavani/core-be/issues/220) squash; unbreak node24 policy ([#221](https://github.com/nikunjmavani/core-be/issues/221)) ([68aec6f](https://github.com/nikunjmavani/core-be/commit/68aec6f4a54572dd082efcdbb08c163b1ec291e7))
* **ci:** run post-merge only on protected branches ([#52](https://github.com/nikunjmavani/core-be/issues/52)) ([3cf2215](https://github.com/nikunjmavani/core-be/commit/3cf2215935c26a3cd48921693f4fb40ed4cb2c90))
* **ci:** share Railway deploy flow and harden GraphQL calls ([#107](https://github.com/nikunjmavani/core-be/issues/107)) ([b11d881](https://github.com/nikunjmavani/core-be/commit/b11d8815cf435938e4ac312fe7c5a5f66a7cad2e))
* **ci:** stabilize post-deploy health probes ([#105](https://github.com/nikunjmavani/core-be/issues/105)) ([e835b35](https://github.com/nikunjmavani/core-be/commit/e835b354f83d063d41e35d157f9d06817cb9e3bd))
* **ci:** stabilize post-merge deploy flow ([#60](https://github.com/nikunjmavani/core-be/issues/60)) ([96fcba3](https://github.com/nikunjmavani/core-be/commit/96fcba3d1ef7c5e3c32b649447ecf97259285ded))
* **ci:** stabilize post-merge flow and pre-push gating ([#54](https://github.com/nikunjmavani/core-be/issues/54)) ([40dc82e](https://github.com/nikunjmavani/core-be/commit/40dc82eca77460e71d7dcbbdabd7a5ef6a2285ff))
* **ci:** unblock dev-&gt;main promotion (PR [#157](https://github.com/nikunjmavani/core-be/issues/157)) ([#222](https://github.com/nikunjmavani/core-be/issues/222)) ([dc0efec](https://github.com/nikunjmavani/core-be/commit/dc0efec1303fd2abf83402698f47881a6368210f))
* **ci:** use bare check-run names as ruleset required-check contexts ([#344](https://github.com/nikunjmavani/core-be/issues/344)) ([c431a63](https://github.com/nikunjmavani/core-be/commit/c431a63a292e9dcff7dc09147c9ae0fd7eb3d5d2))
* **ci:** use fetch-depth: 0 in post-merge changes job to avoid paths-filter race ([#390](https://github.com/nikunjmavani/core-be/issues/390)) ([61a2100](https://github.com/nikunjmavani/core-be/commit/61a210090ae518f75f459cc33806b10ba1442993))
* **ci:** use railway status in deploy token preflight ([#84](https://github.com/nikunjmavani/core-be/issues/84)) ([99d97dd](https://github.com/nikunjmavani/core-be/commit/99d97ddf478991824847ff921c6a587c30deadff))
* **ci:** use supported Railway redeploy command ([#90](https://github.com/nikunjmavani/core-be/issues/90)) ([d7eb03e](https://github.com/nikunjmavani/core-be/commit/d7eb03eec711f4ee7e35839a09c36d231d1c9dd2))
* **database:** fail closed on RLS-bypassing runtime roles ([#164](https://github.com/nikunjmavani/core-be/issues/164)) ([55f13ca](https://github.com/nikunjmavani/core-be/commit/55f13cab619e0341d4085bbe3d0842c16532548c))
* **database:** zero-downtime index migrations via concurrent non-transactional lane (audit [#6](https://github.com/nikunjmavani/core-be/issues/6)) ([#176](https://github.com/nikunjmavani/core-be/issues/176)) ([c38671b](https://github.com/nikunjmavani/core-be/commit/c38671ba372ea2faef593f3806c61b146d4f25d2))
* **db:** correct concurrent unique-violation handling (org-slug race → 500) ([#285](https://github.com/nikunjmavani/core-be/issues/285)) ([8183f71](https://github.com/nikunjmavani/core-be/commit/8183f71fd5096f0be0a793db57770cf76eb99c4f))
* **db:** make audit_logs actor_api_key FK partitioned-table safe ([#225](https://github.com/nikunjmavani/core-be/issues/225)) ([f93c695](https://github.com/nikunjmavani/core-be/commit/f93c6950d5eff54935f79ba7c788e95cc954b3ba))
* document CAPTCHA production guard ([#27](https://github.com/nikunjmavani/core-be/issues/27)) ([d426f1d](https://github.com/nikunjmavani/core-be/commit/d426f1d7235033fa3e5fcde6e56c1178d5ed5544))
* **email-templates:** escape URL fields in invitation and magic-link templates ([#364](https://github.com/nikunjmavani/core-be/issues/364)) ([26c67fa](https://github.com/nikunjmavani/core-be/commit/26c67fac20bff7ccf765c6d93a6264e35ebee079))
* enforce RS256-only JWT policy ([#32](https://github.com/nikunjmavani/core-be/issues/32)) ([293efc1](https://github.com/nikunjmavani/core-be/commit/293efc11157bf1b7cb0c633976b7c5165b8dd0d8))
* **error-handler:** honor 4xx Fastify framework errors + DoS hardening tests ([#276](https://github.com/nikunjmavani/core-be/issues/276)) ([cb21ce4](https://github.com/nikunjmavani/core-be/commit/cb21ce446747b8d66ec8ca45f7d2f2352fd77cde))
* **events:** capture swallowed event-bus errors in Sentry ([2a30d84](https://github.com/nikunjmavani/core-be/commit/2a30d845482dadbe97dd922a4bc54e974105655a))
* **events:** release commit-dispatch marker on rollback (in-memory leak) ([#324](https://github.com/nikunjmavani/core-be/issues/324)) ([7e3ec55](https://github.com/nikunjmavani/core-be/commit/7e3ec559455954d9aeb489e69c4bf416801d76d3))
* **finding-13:** escape title/preheader/footerText inside baseTemplate ([8996b26](https://github.com/nikunjmavani/core-be/commit/8996b2616b52de6f55b0b16315c4a439034e3fba))
* **finding-46:** validate DATABASE_HTTP_STATEMENT_TIMEOUT_MS stays within permission cache lock TTL ([#356](https://github.com/nikunjmavani/core-be/issues/356)) ([47bdab4](https://github.com/nikunjmavani/core-be/commit/47bdab435f83a307cc04f4dc8274f5407aeb8ad3))
* **finding-62:** export WEBHOOK_DELIVERY_JOB_ATTEMPTS and fix vi.mock factories ([#357](https://github.com/nikunjmavani/core-be/issues/357)) ([cd24515](https://github.com/nikunjmavani/core-be/commit/cd24515fa2acf75774da7d636ea42bc0212ec3a2))
* **finding-74:** replace unsafe Stripe object casts with proper type narrowing ([#359](https://github.com/nikunjmavani/core-be/issues/359)) ([f8f9cfe](https://github.com/nikunjmavani/core-be/commit/f8f9cfe8ae24f51ff34c92100dd31b2d1f7745fe))
* gate post-response side effects after commit ([#25](https://github.com/nikunjmavani/core-be/issues/25)) ([1d020f2](https://github.com/nikunjmavani/core-be/commit/1d020f23e42617a6212f1089b738a93ef439d2f7))
* harden observability secret redaction ([#31](https://github.com/nikunjmavani/core-be/issues/31)) ([b293c5c](https://github.com/nikunjmavani/core-be/commit/b293c5c09341224539534f756de4d8bc7179255b))
* include svg sanitizer in runtime dependencies ([1f47aed](https://github.com/nikunjmavani/core-be/commit/1f47aed1b8d84ead3de873531a8199a590f8b33e))
* **infra:** throw on startup when monolithic worker pool demand exceeds DATABASE_POOL_MAX ([faf2fab](https://github.com/nikunjmavani/core-be/commit/faf2fab638f0b77d1ea82dd856d3cefefa893711))
* key global rate limit by IP ([#160](https://github.com/nikunjmavani/core-be/issues/160)) ([c9d8e88](https://github.com/nikunjmavani/core-be/commit/c9d8e88e7fad60ba19c7a9f6a21580682052a939))
* **lockfile:** regenerate pnpm-lock.yaml (merge produced duplicate mapping key) ([c2eba7e](https://github.com/nikunjmavani/core-be/commit/c2eba7eb879f20ee0b5ff182c5edf1ca64715308))
* map remaining unique violations to 409 instead of 500 ([#294](https://github.com/nikunjmavani/core-be/issues/294)) ([7a74b3c](https://github.com/nikunjmavani/core-be/commit/7a74b3c24cbfe90041cb51e3ba5e293110e9039f))
* **mcp:** apply STRICT_AUTHED_RATE_LIMIT to MCP endpoint (audit finding [#7](https://github.com/nikunjmavani/core-be/issues/7)) ([#366](https://github.com/nikunjmavani/core-be/issues/366)) ([6783141](https://github.com/nikunjmavani/core-be/commit/6783141ed14cc7009e1ec2be258386fac1706ed3))
* **migration:** make audit_logs_actor_api_key FK idempotent (unblock dev deploy) ([#385](https://github.com/nikunjmavani/core-be/issues/385)) ([b8cc4fb](https://github.com/nikunjmavani/core-be/commit/b8cc4fb70d3d3d13f31f4b67af35772ff5afdb7e))
* **migration:** make core_be_app least-privilege ALTER ROLE Neon-safe (unblocks all deploys) ([#341](https://github.com/nikunjmavani/core-be/issues/341)) ([488c793](https://github.com/nikunjmavani/core-be/commit/488c793ee93173a2b7d1cedb32879743c3136533))
* **observability:** lazy-load metrics scrape dependencies ([#156](https://github.com/nikunjmavani/core-be/issues/156)) ([9388f34](https://github.com/nikunjmavani/core-be/commit/9388f34e69946da8a092bc189bfb6c796bcf2e18))
* **observability:** track RLS checkout hold time ([#162](https://github.com/nikunjmavani/core-be/issues/162)) ([611cec9](https://github.com/nikunjmavani/core-be/commit/611cec9d9c6fceeb9936f109ee1c5e738aab73d9))
* production audit hardening — upload revocation, auth, billing, notify ([#186](https://github.com/nikunjmavani/core-be/issues/186)) ([3a0f605](https://github.com/nikunjmavani/core-be/commit/3a0f605f77afe6aabf41e307794077063f51b218))
* production hardening — permission RLS resolver, refresh-token reuse detection, billing/notify fail-closed ([#193](https://github.com/nikunjmavani/core-be/issues/193)) ([6d0c8eb](https://github.com/nikunjmavani/core-be/commit/6d0c8eb067cbae422d8d68fcd5a312961f79feae))
* production readiness findings 1–6 (audit, export, billing, webhooks) ([#207](https://github.com/nikunjmavani/core-be/issues/207)) ([7a3094b](https://github.com/nikunjmavani/core-be/commit/7a3094bc85004e51be9d90422df3d1cf124182b4))
* production-readiness audit remediation — auth/RLS, billing, queue/DLQ, uploads, security hardening ([#182](https://github.com/nikunjmavani/core-be/issues/182)) ([91ea552](https://github.com/nikunjmavani/core-be/commit/91ea552d25c3312628005d6e0e77e755a67d1d2c))
* production-readiness hardening (audit [#7](https://github.com/nikunjmavani/core-be/issues/7)-[#16](https://github.com/nikunjmavani/core-be/issues/16)) and /health to /livez+/readyz ([#178](https://github.com/nikunjmavani/core-be/issues/178)) ([146155b](https://github.com/nikunjmavani/core-be/commit/146155b39085e9be3bd96295f5c0e7bba720c9b7))
* **queue:** bound audit.dead_letter_jobs growth via the audit-retention purge ([#322](https://github.com/nikunjmavani/core-be/issues/322)) ([06e729d](https://github.com/nikunjmavani/core-be/commit/06e729ddba34ce6d47ac3f2f7d73ad54910800a2))
* **queue:** preserve rediss TLS for BullMQ Redis options ([#102](https://github.com/nikunjmavani/core-be/issues/102)) ([037c8f5](https://github.com/nikunjmavani/core-be/commit/037c8f52cdaa91c1c49b46de03e221fa7839f012))
* **queue:** stop DLQ auto-retry starvation via a resolved marker on exhausted rows ([#330](https://github.com/nikunjmavani/core-be/issues/330)) ([86c3817](https://github.com/nikunjmavani/core-be/commit/86c381769b50262e30687506b0c9ebeec9a739d9))
* **redis:** use IPv6 dual-stack and drop TLS for Railway private network ([#113](https://github.com/nikunjmavani/core-be/issues/113)) ([00dd3d6](https://github.com/nikunjmavani/core-be/commit/00dd3d6a9d3fa5f3217002bc603758efcfda67fe))
* reduce agent system drift in skills, rules, and docs ([#205](https://github.com/nikunjmavani/core-be/issues/205)) ([2f570a0](https://github.com/nikunjmavani/core-be/commit/2f570a028946e3664e5794bf9cd79b306bd82f74))
* regression residual findings P2–P5 (export, audit, lint) ([#212](https://github.com/nikunjmavani/core-be/issues/212)) ([69a02f2](https://github.com/nikunjmavani/core-be/commit/69a02f24627c009b8b3baedb3eb44b4dc7a9c719))
* **reliability:** complete audit findings 5 and 14 ([#189](https://github.com/nikunjmavani/core-be/issues/189)) ([995325f](https://github.com/nikunjmavani/core-be/commit/995325f41ed89a3dad42137795da22d76908d44d))
* **reliability:** fail-open global rate limiter on Redis store error ([#165](https://github.com/nikunjmavani/core-be/issues/165)) ([f7b189c](https://github.com/nikunjmavani/core-be/commit/f7b189c2a3129f2d6d2e76878abef8acf6b5bb5d))
* require measured DR restore RTO ([#29](https://github.com/nikunjmavani/core-be/issues/29)) ([91c01ec](https://github.com/nikunjmavani/core-be/commit/91c01ec32b018af02141b44e53cfd3de63c563c9))
* resolve major production-hardening issues (13 of 16 + partial [#2](https://github.com/nikunjmavani/core-be/issues/2)) ([#17](https://github.com/nikunjmavani/core-be/issues/17)) ([c0c6620](https://github.com/nikunjmavani/core-be/commit/c0c6620098af677bb6e49418d8aef485238beaf3))
* **rls:** pin core_be_app to NOSUPERUSER/NOBYPASSRLS + assert RLS-binding ([#334](https://github.com/nikunjmavani/core-be/issues/334)) ([18f8b9a](https://github.com/nikunjmavani/core-be/commit/18f8b9aa6f0ae44d45208dabf270a6c5a52c60ec))
* security and stability audit findings (2, 4, 5, 8, 10) ([#199](https://github.com/nikunjmavani/core-be/issues/199)) ([b5c7d1b](https://github.com/nikunjmavani/core-be/commit/b5c7d1b24398d4ca35988be07067813b0ef9929f))
* security hardening follow-up fixes ([#218](https://github.com/nikunjmavani/core-be/issues/218)) ([b3a27e0](https://github.com/nikunjmavani/core-be/commit/b3a27e0f31561681a4f9891d7b9cd24e4274cba6))
* **security:** add maxItems array bounds and fix WebAuthn type casts ([#363](https://github.com/nikunjmavani/core-be/issues/363)) ([ab4e7c7](https://github.com/nikunjmavani/core-be/commit/ab4e7c7c6fb65f374c458b18ef7b8b5927b0e77d))
* **security:** audit remediation — 30 findings + 10 critical fixes ([#196](https://github.com/nikunjmavani/core-be/issues/196)) ([d8d1172](https://github.com/nikunjmavani/core-be/commit/d8d11724d7769ab8076ec42fba8e13525435f36b))
* **security:** production audit hardening — idempotency, auth escalation, RLS, and queue reliability ([#184](https://github.com/nikunjmavani/core-be/issues/184)) ([e8004b3](https://github.com/nikunjmavani/core-be/commit/e8004b3425dcde8c9bbc5d6e839cc63619a0c9d8))
* **security:** reject JWT tokens with unknown kid when keyring is active ([#347](https://github.com/nikunjmavani/core-be/issues/347)) ([2bedfa1](https://github.com/nikunjmavani/core-be/commit/2bedfa1fc7bfe30ebe07e3529cfe8b7c8c78a15d))
* **security:** require explicit wildcard prefix for webhook allowlist subdomain matching ([8d79c89](https://github.com/nikunjmavani/core-be/commit/8d79c891b2a88a8a44cca1420535cfcc6a567a12))
* **security:** require trust proxy hop count ([#168](https://github.com/nikunjmavani/core-be/issues/168)) ([5b0e4c8](https://github.com/nikunjmavani/core-be/commit/5b0e4c81acb644601b6a4fe45a467d3a3fb8c9b8))
* **security:** residual-findings remediation (auth principal, idempotency, audit, upload, degraded-mode) ([#219](https://github.com/nikunjmavani/core-be/issues/219)) ([cddfb4b](https://github.com/nikunjmavani/core-be/commit/cddfb4b251f5247346156c46c458a2b0a2d160f5))
* **security:** strip privileged headers from MCP call_api and remove unversioned aliases ([#348](https://github.com/nikunjmavani/core-be/issues/348)) ([cdaf9ce](https://github.com/nikunjmavani/core-be/commit/cdaf9cef188e146b090bf411dc21e803c53ddea7))
* **setup-infra:** Neon branch/role separation + pnpm 11 upgrade ([#150](https://github.com/nikunjmavani/core-be/issues/150)) ([2fe3515](https://github.com/nikunjmavani/core-be/commit/2fe35157bf2ee417128e6de418de0a3b15ec0308))
* **setup-neon:** create runtime role via SQL to avoid Neon's implicit BYPASSRLS ([#267](https://github.com/nikunjmavani/core-be/issues/267)) ([29b9d77](https://github.com/nikunjmavani/core-be/commit/29b9d77d1176ee0cd304277d80359e94a827a1e2))
* **setup:infra:** switch Railway Redis to template + stop GitHub env duplicates ([#115](https://github.com/nikunjmavani/core-be/issues/115)) ([ee57292](https://github.com/nikunjmavani/core-be/commit/ee572922ea4961e951a6917610665d66ec1b4aa8))
* **sonar:** add localeCompare compare fn to Array.sort() on strings (S2871) ([#230](https://github.com/nikunjmavani/core-be/issues/230)) ([1060614](https://github.com/nikunjmavani/core-be/commit/106061468e94c46bbd91adee85996259d5ea3047))
* **sonar:** group regex alternation for explicit precedence (S5850) ([#229](https://github.com/nikunjmavani/core-be/issues/229)) ([8d74a5e](https://github.com/nikunjmavani/core-be/commit/8d74a5ea8f715b6db79d77b4af99ef8bdccd750e))
* **sonar:** harden auth-header regexes + URL-based Redis redaction (S5852) ([#235](https://github.com/nikunjmavani/core-be/issues/235)) ([ee8ae73](https://github.com/nikunjmavani/core-be/commit/ee8ae7399ce9622317733dfd9032b1569a227192))
* **sonar:** make issueMagicLinkIfUserExists return void (S3516) ([#247](https://github.com/nikunjmavani/core-be/issues/247)) ([96c05c8](https://github.com/nikunjmavani/core-be/commit/96c05c8f9d1209e64f63b58a376a6d0796e69933))
* **sonar:** migrate response encryption to AES-256-GCM (S5542) ([#232](https://github.com/nikunjmavani/core-be/issues/232)) ([7b55853](https://github.com/nikunjmavani/core-be/commit/7b558530aa0f36dea375437079f63cb4596b5329))
* **sonar:** un-nest ternaries + drop redundant cast introduced by [#245](https://github.com/nikunjmavani/core-be/issues/245) ([#246](https://github.com/nikunjmavani/core-be/issues/246)) ([f604a08](https://github.com/nikunjmavani/core-be/commit/f604a08ab2fef5cdbdeac1fa234006437a9e7a4d))
* **sonar:** use crypto.randomInt for jitter/shard selection (S2245) ([#234](https://github.com/nikunjmavani/core-be/issues/234)) ([d586f23](https://github.com/nikunjmavani/core-be/commit/d586f2378b4085889d7025f5476790e6c90adb69))
* **stripe:** tighten webhook replay window to 150 s (audit finding [#6](https://github.com/nikunjmavani/core-be/issues/6)) ([#365](https://github.com/nikunjmavani/core-be/issues/365)) ([848360d](https://github.com/nikunjmavani/core-be/commit/848360d739857212d1822c6e9e4564498649b5c3))
* support scoped RLS contexts ([#26](https://github.com/nikunjmavani/core-be/issues/26)) ([5ecd60c](https://github.com/nikunjmavani/core-be/commit/5ecd60c4f81d38fd6523200ad84d02ea68ce7ed0))
* **tenancy:** emit public ids (not internal bigserial ids) in membership responses ([#329](https://github.com/nikunjmavani/core-be/issues/329)) ([3aac2ac](https://github.com/nikunjmavani/core-be/commit/3aac2ac13d072c1f41bf71bd296468de63d73b3c))
* **tenancy:** make API-key rotation atomic against concurrent rotations ([#307](https://github.com/nikunjmavani/core-be/issues/307)) ([dc0aaa3](https://github.com/nikunjmavani/core-be/commit/dc0aaa326109b5acaeafbe7b7be5f8c5573cd01e))
* **tenancy:** make ownership transfer atomic against a concurrent suspend (TOCTOU) ([#304](https://github.com/nikunjmavani/core-be/issues/304)) ([b6a44b1](https://github.com/nikunjmavani/core-be/commit/b6a44b1e4d9f8eb9a0ecc262c8e5bbf227fb6f4f))
* **tenancy:** map concurrent org slug-update collision to 409 instead of 500 ([#302](https://github.com/nikunjmavani/core-be/issues/302)) ([b8bd666](https://github.com/nikunjmavani/core-be/commit/b8bd666a065cfe8a6ca786c3dd4c95340c72061d))
* **tenancy:** map duplicate role name to 409 instead of 500 ([#292](https://github.com/nikunjmavani/core-be/issues/292)) ([e1a72b3](https://github.com/nikunjmavani/core-be/commit/e1a72b3287103165df7c0eaf32bf9c2f081d45d0))
* **tenancy:** never soft-delete the organization owner's membership (close orphan race) ([#305](https://github.com/nikunjmavani/core-be/issues/305)) ([0262116](https://github.com/nikunjmavani/core-be/commit/026211696fed6522832cd4c04d939d28c3c108ca))
* **tenancy:** reject direct ACTIVE membership create with 403 instead of 500 ([#298](https://github.com/nikunjmavani/core-be/issues/298)) ([dbb8197](https://github.com/nikunjmavani/core-be/commit/dbb819779e766e059a708078d1921c33adfb35e7))
* **test:** enable metrics in test env so local coverage mirrors CI ([#271](https://github.com/nikunjmavani/core-be/issues/271)) ([e0380b6](https://github.com/nikunjmavani/core-be/commit/e0380b655eca210688bf7559fe1fe3e26f53e1ba))
* **test:** make billing mutation + session-revoke integration tests deterministic ([#264](https://github.com/nikunjmavani/core-be/issues/264)) ([d031718](https://github.com/nikunjmavani/core-be/commit/d0317188babbb9c3c788e8ac59613b4a306f230a))
* **tests:** align e2e fixtures with audit batch2 (WebAuthn typed DTO) + Stripe items.period ([#384](https://github.com/nikunjmavani/core-be/issues/384)) ([b906731](https://github.com/nikunjmavani/core-be/commit/b906731f9fdfb6813303c3f25a0ce148a1e2023a))
* **upload:** stop exposing internal storage key + bucket in upload detail ([#288](https://github.com/nikunjmavani/core-be/issues/288)) ([2a3758f](https://github.com/nikunjmavani/core-be/commit/2a3758f42704cbb2bd79d26930340554b0c99737))
* use keyset pagination for large lists ([#35](https://github.com/nikunjmavani/core-be/issues/35)) ([f874a89](https://github.com/nikunjmavani/core-be/commit/f874a89415fe2a2fbbb29d4c09459af781f34f62))
* **user:** reject org-scoped notification preference with 400 (was raw 42501 -&gt; 500) ([#327](https://github.com/nikunjmavani/core-be/issues/327)) ([db1e7a7](https://github.com/nikunjmavani/core-be/commit/db1e7a77e3c8f464bd8354f1235a1f33c5c71967))
* validate notification channel as an enum (422) instead of 500 ([#300](https://github.com/nikunjmavani/core-be/issues/300)) ([a7a50f0](https://github.com/nikunjmavani/core-be/commit/a7a50f09efe961a49ead72bca5def0da94dfefc7))
* validators (audit follow-up) — centralize AES_GCM_IV_LENGTH, allowlist 5 and 512, env-load sunset validator ([#378](https://github.com/nikunjmavani/core-be/issues/378)) ([3bae917](https://github.com/nikunjmavani/core-be/commit/3bae917577c65d11cf771725f81392a0a62ce904))
* webhook SSRF and reliability hardening (9 audit issues) ([#192](https://github.com/nikunjmavani/core-be/issues/192)) ([ae0c0d2](https://github.com/nikunjmavani/core-be/commit/ae0c0d24d60399966a790b7bf526ac3cdc17bb79))


### Performance

* parallelize S3 object deletes in deleteAllExportsForUser ([#361](https://github.com/nikunjmavani/core-be/issues/361)) ([4c36173](https://github.com/nikunjmavani/core-be/commit/4c36173e703bfaa9737ed2a529f0e28e8f863046))


### Changed

* **ci:** align post-merge sequence with release-first flow ([#51](https://github.com/nikunjmavani/core-be/issues/51)) ([4bb98b4](https://github.com/nikunjmavani/core-be/commit/4bb98b42ea4a2c5f9a1ca89d0c5e887eac4ddc1b))
* **ci:** make Railway deploy schema-driven and injection-safe ([#81](https://github.com/nikunjmavani/core-be/issues/81)) ([709c8bb](https://github.com/nikunjmavani/core-be/commit/709c8bb04b23b7df7dfe281301e99ad8087afd35))
* **ci:** rename cd workflow, restrict post-merge to merged PRs, optimize flow ([#49](https://github.com/nikunjmavani/core-be/issues/49)) ([26e49d2](https://github.com/nikunjmavani/core-be/commit/26e49d2d49f52ecddaf14c99df6033bb7e753f8e))
* complete src directory restructure program ([#209](https://github.com/nikunjmavani/core-be/issues/209)) ([d34be1d](https://github.com/nikunjmavani/core-be/commit/d34be1d123e9b1a8325433d8112c8307c8674ca2))
* enforce strict @/ and @tooling/ import paths ([#203](https://github.com/nikunjmavani/core-be/issues/203)) ([09b4bc6](https://github.com/nikunjmavani/core-be/commit/09b4bc6166f6904adce92e20b0ca5abf7d37324d))
* **setup:** redesign setup infra workflow ([#23](https://github.com/nikunjmavani/core-be/issues/23)) ([bb7273f](https://github.com/nikunjmavani/core-be/commit/bb7273f2d9c335b5e201dc7a24cbc4b2238cfaba))
* **sonar:** reduce cognitive complexity of 7 functions (S3776) ([#249](https://github.com/nikunjmavani/core-be/issues/249)) ([1ed41da](https://github.com/nikunjmavani/core-be/commit/1ed41da6232496617897ef977deb3cbeca8d9ace))
* **sonar:** remove redundant WorkerContainers alias (S6564) ([#251](https://github.com/nikunjmavani/core-be/issues/251)) ([4dff585](https://github.com/nikunjmavani/core-be/commit/4dff58590a6b6aef0f08585bc26b93ac51d182b2))
* **user:** route GDPR export through cross-domain services ([#201](https://github.com/nikunjmavani/core-be/issues/201)) ([8428600](https://github.com/nikunjmavani/core-be/commit/84286000a6f1f8573a7171d20936c72f2b1e0c5a))


### Documentation

* add 2026-06-04 deep audit report (20 findings) ([6515589](https://github.com/nikunjmavani/core-be/commit/65155899935406e72781fab5348f146b20b5b8e4))
* add deep backend audit report 2026-06-03 ([#362](https://github.com/nikunjmavani/core-be/issues/362)) ([3d7ae31](https://github.com/nikunjmavani/core-be/commit/3d7ae31779c7975b4b61d19c8f7867c8a58432a9))
* add PR review and intake defaults ([#144](https://github.com/nikunjmavani/core-be/issues/144)) ([fc89a49](https://github.com/nikunjmavani/core-be/commit/fc89a49da75e780ee525ea8b9d9c057b0a1befb2))
* add production readiness audit ([#167](https://github.com/nikunjmavani/core-be/issues/167)) ([baf5e96](https://github.com/nikunjmavani/core-be/commit/baf5e9694400fb55d662d754afc70aca3d293589))
* add production readiness audit ([#171](https://github.com/nikunjmavani/core-be/issues/171)) ([e8fd25f](https://github.com/nikunjmavani/core-be/commit/e8fd25f6288f42999c1637b12f2c767c52df16c0))
* add remediation status tracker to 2026-06-03 audit report ([93ef121](https://github.com/nikunjmavani/core-be/commit/93ef12150cd3917f3a6ecc46c9e8da4573ada94b))
* add Understand Anything learning curve guide ([#172](https://github.com/nikunjmavani/core-be/issues/172)) ([39f8090](https://github.com/nikunjmavani/core-be/commit/39f80907a4cfb1bc97fccf80016ab7a5faee8b8e))
* align OVERVIEWs and security docs with audit hardening behavior ([#197](https://github.com/nikunjmavani/core-be/issues/197)) ([5f28cfb](https://github.com/nikunjmavani/core-be/commit/5f28cfbcfc2bc463da3bb0c1f5ef72fe1ba86f70))
* **audit-2026-06-04:** mark all 20 findings resolved with file:line citations ([#381](https://github.com/nikunjmavani/core-be/issues/381)) ([96dd4f7](https://github.com/nikunjmavani/core-be/commit/96dd4f74574b1dca6ee93190b59edc56ab414b1e))
* **audit:** document audit.logs storage (plain table; hosted partitioning is out-of-band) ([#257](https://github.com/nikunjmavani/core-be/issues/257)) ([26e3f09](https://github.com/nikunjmavani/core-be/commit/26e3f0926e3b280a5ce7a16122b38295509f5c25))
* **audit:** expand AuditService.record JSDoc comment ([#12](https://github.com/nikunjmavani/core-be/issues/12)) ([d01dcf0](https://github.com/nikunjmavani/core-be/commit/d01dcf0157140ae03953e4b4660f465b450ec770))
* clarify CONTRIBUTING intro wording ([#110](https://github.com/nikunjmavani/core-be/issues/110)) ([36dc9e6](https://github.com/nikunjmavani/core-be/commit/36dc9e689179635b37a0d1188d811778873290fc))
* fix stale scripts/dev path in structure-maintainer skill ([#131](https://github.com/nikunjmavani/core-be/issues/131)) ([a787a8a](https://github.com/nikunjmavani/core-be/commit/a787a8a4ac406c4ab0dfaedd62d53a9fe54032af))
* refresh project readme ([#151](https://github.com/nikunjmavani/core-be/issues/151)) ([6a221d3](https://github.com/nikunjmavani/core-be/commit/6a221d3dd69996e176cb20208d3cc746c5fb79f5))
* remove redirect stub docs/index.md (use docs/README.md as canonical index) ([#128](https://github.com/nikunjmavani/core-be/issues/128)) ([2cb1c88](https://github.com/nikunjmavani/core-be/commit/2cb1c88c3e4239da60ae956a445a4ebb31dedf2a))
* **tsdoc:** drive coverage budget to 0/0 ([#148](https://github.com/nikunjmavani/core-be/issues/148)) ([f40408d](https://github.com/nikunjmavani/core-be/commit/f40408d7d58560c67b476e7d5a5db5a94c787780))

## [2.0.0] - 2026-05-16

### BREAKING CHANGES

- **Row-level security (RLS)** organization isolation is enforced at the database layer (`enable_rls`, `notifications_rls` migrations). HTTP requests must flow through tenant middleware so Postgres session variable `app.current_organization_id` is set; **workers and scripts must pass organization identifiers explicitly in queries** — do not rely on RLS session context outside HTTP (see `CLAUDE.md`).

### Security

- **RLS**: Policies enabled across tenancy, auth, billing, notify, audit, and related schemas so row access is scoped by organization where applicable.
- **Notifications RLS**: Notify schema tables participate in organization-scoped RLS.

### Added

- **API keys**: Persistence and domain support for organization API keys (`create_api_keys` migration).
- **Billing domain**: Plans, subscriptions, Stripe customer linkage, and Stripe webhook handling (`add_stripe_customer_id` migration and `src/domains/billing/`).
- **Notify domain**: Notifications and outbound webhooks (`src/domains/notify/`).
- **Audit domain**: Audit logging and retention worker (`src/domains/audit/`, including `audit-retention.worker.ts`).
- **Upload domain**: File upload flows (`src/domains/upload/`).
- **Verification tokens**: Schema support for verification-token flows (`create_verification_tokens` migration).

### Changed

- **Permissions**: Reference permission seed migration aligns baseline roles and permissions (`seed_permissions` migration).
- **Webhooks**: Organization-scoped uniqueness for webhook URLs (`webhooks_org_url_unique` migration).
- **Webhooks**: Soft-delete support for webhooks (`webhooks_soft_delete` migration).
- **Organization notification policies**: Soft-delete support (`organization_notification_policies_soft_delete` migration).

## [1.0.0] - 2025-02-18

### Security

- **SSRF protection**: Webhook URLs validated against private IP ranges; blocks localhost, link-local, and internal networks
- **OAuth CSRF protection**: State parameter stored in Redis with 10-min TTL; validated and consumed on callback
- **OAuth timeouts**: All OAuth provider fetch calls use 10s timeout
- **Webhook response truncation**: Test webhook response body truncated to 500 chars to prevent sensitive data leakage
- **Production JWT**: RS256 required in production (JWT_PRIVATE_KEY and JWT_PUBLIC_KEY must be set)
- **Logger redaction**: Added api_key, access_key_id, secret_access_key to Pino redaction paths
- **Seed password**: Demo password from TEST_PASSWORD env or randomly generated (no hardcoded fallback)

### Fixed

- **Worker shutdown**: RSS monitoring interval cleared on worker shutdown to prevent memory leak

### Added

- **File magic bytes**: Utility for validating upload content-type via magic bytes (PNG, JPEG, WebP, PDF)


---

## Archived prerelease history (`-dev.N` channel, retired 2026-07-07)

> The dual-channel `dev` prerelease line was collapsed into a single stable release channel
> during the delivery-model migration. The entries below are the historical `-dev.N`
> changelog, preserved verbatim for provenance. New releases are stable-only and appear at the
> top of this file. Some work here is also rolled up into the first post-migration stable release.

# Changelog

> Note: Entries below `3.0.0-dev.0` were cut as stable-style `vX.Y.Z` tags
> while the dev channel's `prerelease: true` config was a no-op (manifest
> was seeded without a `-dev.N` suffix). From `3.0.0-dev.0` onward this
> channel publishes proper `vX.Y.Z-dev.N` prereleases; the matching stable
> `vX.Y.Z` tag is cut on `main` when the prerelease cycle is promoted.

## [4.10.0-dev.31](https://github.com/nikunjmavani/core-be/compare/v4.10.0-dev.30...v4.10.0-dev.31) (2026-07-07)


### Fixed

* **tenancy:** make personal-org self-heal read-safe + seed permissions in e2e ([#867](https://github.com/nikunjmavani/core-be/issues/867)) ([8749a90](https://github.com/nikunjmavani/core-be/commit/8749a901c9ba011512eb5ffd030c728685680f1c))
* **tenancy:** self-heal missing personal organization on read ([#865](https://github.com/nikunjmavani/core-be/issues/865)) ([ceb81a4](https://github.com/nikunjmavani/core-be/commit/ceb81a4ce56ab78123dc192d714f38cd81bda183))

## [4.10.0-dev.30](https://github.com/nikunjmavani/core-be/compare/v4.10.0-dev.29...v4.10.0-dev.30) (2026-07-06)


### Added

* **user:** add job_title to user profile update ([d916eb7](https://github.com/nikunjmavani/core-be/commit/d916eb7381d9a910275ae98cbf8ae56be6c7c0ba))
* **user:** add job_title to user profile update ([739b109](https://github.com/nikunjmavani/core-be/commit/739b1099c845719a703a21e1beccc1a78da262c5))

## [4.10.0-dev.29](https://github.com/nikunjmavani/core-be/compare/v4.10.0-dev.28...v4.10.0-dev.29) (2026-07-06)


### Fixed

* **cors:** wrap cors middleware in fastify-plugin so actual responses carry CORS headers ([b744877](https://github.com/nikunjmavani/core-be/commit/b74487750e2a8ff02419be9573bdf78dc4920238))
* **cors:** wrap cors middleware in fastify-plugin so actual responses carry CORS headers ([0b049ce](https://github.com/nikunjmavani/core-be/commit/0b049ce250cf781f299aa7ec13f69695cdcfa3b8))

## [4.10.0-dev.28](https://github.com/nikunjmavani/core-be/compare/v4.10.0-dev.27...v4.10.0-dev.28) (2026-07-06)


### Fixed

* **ci:** relax hardened boot-safety flags in the docker smoke boot ([2fc586f](https://github.com/nikunjmavani/core-be/commit/2fc586f13b06f81af25964077c23f9f75e200a7b))
* **ci:** relax hardened boot-safety flags in the docker smoke boot ([894f247](https://github.com/nikunjmavani/core-be/commit/894f247ef7df295226878e5044f2ae1556e9f8bb))

## [4.10.0-dev.27](https://github.com/nikunjmavani/core-be/compare/v4.10.0-dev.26...v4.10.0-dev.27) (2026-07-05)


### Changed

* **config:** drive all env behavior via flags; NODE_ENV=development|production only ([00d77f6](https://github.com/nikunjmavani/core-be/commit/00d77f6588828563b0c14807445e392f14864f4d))
* **config:** drive all env behavior via flags; NODE_ENV=development|production only ([9de0a67](https://github.com/nikunjmavani/core-be/commit/9de0a678666aac4129a67ea2ae04c9e4642e48e2))

## [4.10.0-dev.26](https://github.com/nikunjmavani/core-be/compare/v4.10.0-dev.25...v4.10.0-dev.26) (2026-07-05)


### Fixed

* **config:** point development frontend + CORS origins at deployed Netlify FE ([be1da34](https://github.com/nikunjmavani/core-be/commit/be1da3437f4505a79632a39db3a9768aaf797b8c))
* **config:** point development frontend + CORS origins at deployed Netlify FE ([8e451d7](https://github.com/nikunjmavani/core-be/commit/8e451d7290c87b76f7a1c731f9dc30c45e99809e))

## [4.10.0-dev.25](https://github.com/nikunjmavani/core-be/compare/v4.10.0-dev.24...v4.10.0-dev.25) (2026-07-04)


### Fixed

* **cors:** allow X-Requested-With in preflight to restore silent auth refresh ([39edab8](https://github.com/nikunjmavani/core-be/commit/39edab831072a827fb35c5a865d027876cbfffec))
* **cors:** allow X-Requested-With in preflight to restore silent auth refresh ([2eb29a0](https://github.com/nikunjmavani/core-be/commit/2eb29a0638fbc9cc192c743dfd932fb06245d5d0))

## [4.10.0-dev.24](https://github.com/nikunjmavani/core-be/compare/v4.10.0-dev.23...v4.10.0-dev.24) (2026-07-04)


### Added

* **tenancy:** server-side sort of org memberships list by member name ([ead8d6c](https://github.com/nikunjmavani/core-be/commit/ead8d6c248409569cd63a4c79ca56dc743d417e5))
* **tenancy:** server-side sort of org memberships list by member name ([6e679bf](https://github.com/nikunjmavani/core-be/commit/6e679bf91bf0b8c46c91c8e1f1a61d82cc938e3a))


### Fixed

* **sonar:** clear pre-existing quality-gate findings on the deployed surface ([8641ea2](https://github.com/nikunjmavani/core-be/commit/8641ea24b719d35c5ba03e3755761a83c7c22d85))

## [4.10.0-dev.23](https://github.com/nikunjmavani/core-be/compare/v4.10.0-dev.22...v4.10.0-dev.23) (2026-07-03)


### Added

* **auth:** replace magic-link with email verification-code login ([#814](https://github.com/nikunjmavani/core-be/issues/814)) ([cce59f3](https://github.com/nikunjmavani/core-be/commit/cce59f3e77befd181dc9dda45227cbc94e9b378b))
* **billing:** paginate invoices via Stripe cursor (limit + starting_after + has_more) ([#824](https://github.com/nikunjmavani/core-be/issues/824)) ([761ca72](https://github.com/nikunjmavani/core-be/commit/761ca72f4427a73c1d6db3cfa3bb46c87ca8c204))
* common server-side search/sort for org list endpoints (roles, api-keys) ([#823](https://github.com/nikunjmavani/core-be/issues/823)) ([d097af7](https://github.com/nikunjmavani/core-be/commit/d097af7876998f3075f96cf8539f301335e4c3d2))
* **observability:** add PostHog analytics and sync env schema/config ([#815](https://github.com/nikunjmavani/core-be/issues/815)) ([7fca1b1](https://github.com/nikunjmavani/core-be/commit/7fca1b1a74296ae5b4c52d6f89911f2286c107da))
* **tenancy:** server-side member search (q over email/name) ([#825](https://github.com/nikunjmavani/core-be/issues/825)) ([9c56489](https://github.com/nikunjmavani/core-be/commit/9c5648982dcad45022d12f5a155c6d32e44de264))


### Fixed

* **auth:** require verified email before MFA/WebAuthn enrollment (account pre-hijacking) ([dba4577](https://github.com/nikunjmavani/core-be/commit/dba4577a6e8d23d15f9865c984770ec8ef35eed4))
* **auth:** require verified email before MFA/WebAuthn enrollment (account pre-hijacking) ([90c9bef](https://github.com/nikunjmavani/core-be/commit/90c9bef8089b37b4f82536d8bf4fc98657ce47df))
* **ci:** call core-infra's validate:github-environments in Railway deploy ([26696f1](https://github.com/nikunjmavani/core-be/commit/26696f13d60e782eb3affad48d1232bc135fe343))
* **ci:** correct core-infra validate script name in Railway deploy ([cab27b2](https://github.com/nikunjmavani/core-be/commit/cab27b26b81db286fff1bccb9c3109a8353b9781))
* **load:** align k6 journey with idempotency and invitation API ([#813](https://github.com/nikunjmavani/core-be/issues/813)) ([4456a29](https://github.com/nikunjmavani/core-be/commit/4456a293861aed6b06f6091b718fb499d6828de8))
* **tests:** seed full permission catalog + verified-email MFA fixture; fix fastify 5.9 drain regression ([#832](https://github.com/nikunjmavani/core-be/issues/832)) ([4a9fc73](https://github.com/nikunjmavani/core-be/commit/4a9fc73ab0c8963520b981d9bc690129c840053d))


### Changed

* **setup:** extract setup:infra into standalone core-infra repo ([#820](https://github.com/nikunjmavani/core-be/issues/820)) ([25083c3](https://github.com/nikunjmavani/core-be/commit/25083c37ba7a4e7624998f7fb11d0b8772a9bc71))


### Documentation

* **agent-os:** codify list search/sort/pagination + FORCE-RLS search conventions ([#826](https://github.com/nikunjmavani/core-be/issues/826)) ([0e12e36](https://github.com/nikunjmavani/core-be/commit/0e12e3699e6d954337807d50226cfb068b84cebb))
* breaking (no unaccepted breaking changes). Third and final deferred follow-up. ([9c56489](https://github.com/nikunjmavani/core-be/commit/9c5648982dcad45022d12f5a155c6d32e44de264))

## [4.10.0-dev.22](https://github.com/nikunjmavani/core-be/compare/v4.10.0-dev.21...v4.10.0-dev.22) (2026-06-26)


### Fixed

* **http:** return 400 (not 500) for a malformed JSON request body ([c44be98](https://github.com/nikunjmavani/core-be/commit/c44be9888f29b4e93354a0d87e8869c25591d3da))
* **http:** return 400 (not 500) for a malformed JSON request body ([5e06579](https://github.com/nikunjmavani/core-be/commit/5e06579d6e70bd4903c7c62a23b98ebf064943ac))
* tag the parser's error with statusCode 400 + FST_ERR_CTP_INVALID_JSON_SYNTAX so the error handler's existing 4xx-framework-error path returns a clean 400 (logged at warn, not captured to Sentry). Adds 3 regression cases to the JSON content-type parser integration suite. Verified: typecheck + biome clean; regression 6/6; live-verified on the running server. ([5e06579](https://github.com/nikunjmavani/core-be/commit/5e06579d6e70bd4903c7c62a23b98ebf064943ac))

## [4.10.0-dev.21](https://github.com/nikunjmavani/core-be/compare/v4.10.0-dev.20...v4.10.0-dev.21) (2026-06-26)


### Documentation

* **rls:** correct the SECURITY DEFINER inventory in the rls-tenant-isolation skill ([83c4f7a](https://github.com/nikunjmavani/core-be/commit/83c4f7aaed3705d963c4fec1f812894e2bc86a8c))
* **rls:** correct the SECURITY DEFINER inventory in the rls-tenant-isolation skill ([65ee120](https://github.com/nikunjmavani/core-be/commit/65ee12090ae73c5df6f4e56375f6ffded55e7544))

## [4.10.0-dev.20](https://github.com/nikunjmavani/core-be/compare/v4.10.0-dev.19...v4.10.0-dev.20) (2026-06-25)


### Fixed

* **rls:** FORCE RLS on audit.outbox + correct worker request-database import rule ([68082c4](https://github.com/nikunjmavani/core-be/commit/68082c48fe463390c3e669caadba72a0a5bfb6a5))

## [4.10.0-dev.19](https://github.com/nikunjmavani/core-be/compare/v4.10.0-dev.18...v4.10.0-dev.19) (2026-06-25)


### Fixed

* **cloud:** make startup update script work unprivileged + document bring-up caveats ([#804](https://github.com/nikunjmavani/core-be/issues/804)) ([93d7691](https://github.com/nikunjmavani/core-be/commit/93d76912a03b1d07665f2013a40ed0507bee835d))

## [4.10.0-dev.18](https://github.com/nikunjmavani/core-be/compare/v4.10.0-dev.17...v4.10.0-dev.18) (2026-06-25)


### Fixed

* **agent-os:** harden cloud Docker bootstrap fallbacks ([#801](https://github.com/nikunjmavani/core-be/issues/801)) ([43b32b0](https://github.com/nikunjmavani/core-be/commit/43b32b0809a973935b87cfc11566954063e3ea15))
* **agent-os:** restrict stack monitor tools ([#798](https://github.com/nikunjmavani/core-be/issues/798)) ([7ed9ad4](https://github.com/nikunjmavani/core-be/commit/7ed9ad40c9c0e6b0bfbdc4a895549cd54057d63f))


### Documentation

* **cloud:** scaffold default MCP pair in install and document skills/MCPs ([#803](https://github.com/nikunjmavani/core-be/issues/803)) ([405a29e](https://github.com/nikunjmavani/core-be/commit/405a29e4cf9723fae10b582ca27c3375cf6462e9))

## [4.10.0-dev.17](https://github.com/nikunjmavani/core-be/compare/v4.10.0-dev.16...v4.10.0-dev.17) (2026-06-25)


### Added

* **agent-os:** centralize cloud agent environment config ([d78c20f](https://github.com/nikunjmavani/core-be/commit/d78c20fa4f45560e8c114a58f918fe6592ee6c85))
* **agent-os:** centralize cloud agent environment config ([9126a9b](https://github.com/nikunjmavani/core-be/commit/9126a9bdd3fb262657f60c54c11b2fe97a96f1d5))

## [4.10.0-dev.16](https://github.com/nikunjmavani/core-be/compare/v4.10.0-dev.15...v4.10.0-dev.16) (2026-06-24)


### Added

* enrich sessions (device/browser/is_current), remove org capabilities object, add FE endpoint mapping doc ([c85015f](https://github.com/nikunjmavani/core-be/commit/c85015f983bdd1842767009a929260d7a725bdb8))


### Changed

* **auth:** drop session location enrichment; fix FE mapping + reset schema ([f4b7e27](https://github.com/nikunjmavani/core-be/commit/f4b7e2783b8d0f6004adf3863593133b63735814))

## [4.10.0-dev.15](https://github.com/nikunjmavani/core-be/compare/v4.10.0-dev.14...v4.10.0-dev.15) (2026-06-24)


### Documentation

* **api:** frontend auth entry flows — call-count matrix + typed landOnDashboard client ([#793](https://github.com/nikunjmavani/core-be/issues/793)) ([63b0010](https://github.com/nikunjmavani/core-be/commit/63b00100533c3fc44a7d80b04275949a44640d11))

## [4.10.0-dev.14](https://github.com/nikunjmavani/core-be/compare/v4.10.0-dev.13...v4.10.0-dev.14) (2026-06-23)


### Added

* **agent-os:** add stack-monitor sub-agent for data-driven stack monitoring ([#787](https://github.com/nikunjmavani/core-be/issues/787)) ([0d62e6d](https://github.com/nikunjmavani/core-be/commit/0d62e6d38c7b75d0942292b952322a4d84c075d9))
* **auth,tenancy:** claim invited account on signup + verified-email accept gate ([3803076](https://github.com/nikunjmavani/core-be/commit/38030763ad88db57db6dbc5c32989aab5493fded))
* **auth,tenancy:** switch endpoints return active-org delta; accept returns organization_id ([#789](https://github.com/nikunjmavani/core-be/issues/789)) ([75e3c69](https://github.com/nikunjmavani/core-be/commit/75e3c699732e20ccd9410e1f844886130ef59a76))
* **auth:** add email OTP primitive (6-digit code generation + scoped consume) ([df747c2](https://github.com/nikunjmavani/core-be/commit/df747c20e329b0c8675c0642d45938e73f85ebf9))
* **auth:** add POST /auth/signup (email/password signup with auto-login) ([0c32fb2](https://github.com/nikunjmavani/core-be/commit/0c32fb2f6b70eae69a4caf01d4460590a30c6b88))
* **auth:** audit MFA outcomes, recovery-code use, API-key lifecycle, org-switch, passkey register, reset ([9a5a3a4](https://github.com/nikunjmavani/core-be/commit/9a5a3a495078e1a170914d273ec355005edb861a))
* **auth:** auto-login after password reset (MFA-safe) + document invite-squatting risk ([22d1ce5](https://github.com/nikunjmavani/core-be/commit/22d1ce50b78dc48c21d8e059ce6e1db0b82bdd28))
* **auth:** email verification via 6-digit OTP (replaces the token link) ([e3939a1](https://github.com/nikunjmavani/core-be/commit/e3939a109a3c6c70c9329a539b191ce92c1ac506))
* **auth:** magic-link via 6-digit OTP + auto-signup ([52f87f7](https://github.com/nikunjmavani/core-be/commit/52f87f7624781c4437488d0b1768ec33d3c61249))
* **auth:** OTP login + signup, invitation onboarding, and auth security hardening ([b4faba6](https://github.com/nikunjmavani/core-be/commit/b4faba64d8c3d5710f6d89d542a7cfaf81f928f2))
* **billing:** auto-suspend excess members on over-cap downgrade (F2) ([9877d24](https://github.com/nikunjmavani/core-be/commit/9877d24b545677aa404964812a1c6320d7ff20b4))
* **billing:** auto-suspend excess members on over-cap downgrade (F2) ([f3496d5](https://github.com/nikunjmavani/core-be/commit/f3496d5a5e243da3974390424f702dd4c61deeee))
* **billing:** entitlement seat-ceiling — Free-tier cap for unsubscribed + dunning grace (F3/F4) ([8092bd0](https://github.com/nikunjmavani/core-be/commit/8092bd03d0c3bc2914d492ece991bb1293578ccb))
* **billing:** entitlement seat-ceiling — Free-tier cap for unsubscribed + dunning grace (F3/F4) ([1b808eb](https://github.com/nikunjmavani/core-be/commit/1b808eb590e7addad983e6ce37d675236b5d0329))
* **dev:** resizable + draggable dashboard panel grid (gridstack) ([#785](https://github.com/nikunjmavani/core-be/issues/785)) ([0b3b77c](https://github.com/nikunjmavani/core-be/commit/0b3b77c109a4780a649b390cc79cd9397178dc74))
* **tenancy,billing:** personal-org billing guard + can_manage_billing capability ([#788](https://github.com/nikunjmavani/core-be/issues/788)) ([3f10347](https://github.com/nikunjmavani/core-be/commit/3f10347060cd60f8b49e4b09c10bec379c562ff0))


### Fixed

* **api:** idempotency error responses emit the standard meta envelope + snake_case (audit api-contract-[#1](https://github.com/nikunjmavani/core-be/issues/1)) ([1502cc2](https://github.com/nikunjmavani/core-be/commit/1502cc2b5cc8338ad7149cd5cfdbb60dd777141e))
* **api:** idempotency error responses emit the standard meta envelope + snake_case (audit api-contract-[#1](https://github.com/nikunjmavani/core-be/issues/1)) ([a5f8a5f](https://github.com/nikunjmavani/core-be/commit/a5f8a5f65790c06a623161e535722c4528bb98e9))
* **auth:** cap concurrent sessions per user with oldest-eviction on login ([c402ad7](https://github.com/nikunjmavani/core-be/commit/c402ad792b4dbfbfee5c31341aa436aefc41d8c7))
* **auth:** cap linked auth-methods + passkeys, trim error-log free-text, guard signup over-post ([638aed7](https://github.com/nikunjmavani/core-be/commit/638aed78f20a24e0ffe355b2df4ef025938d5fa9))
* **auth:** claim bare invited accounts via OAuth + reset OTP attempt cap on resend ([d81cb45](https://github.com/nikunjmavani/core-be/commit/d81cb450a390ee136bea1f616380d260a19cc5b5))
* **auth:** count passkeys when classifying a claimable bare account ([1256247](https://github.com/nikunjmavani/core-be/commit/12562478b4e47f5fde89246bc5ab1195b2481154))
* **auth:** enforce OTP/magic-link resend cooldown (wire the dead constant) ([eef15a9](https://github.com/nikunjmavani/core-be/commit/eef15a915513e5f06e433d2a0c64a79003b2f453))
* **auth:** provision personal org after the OAuth signup commit (FK visibility) ([feda7a5](https://github.com/nikunjmavani/core-be/commit/feda7a5fb5e44aa52efc428eb4fad4a36cfbd67f))
* **auth:** provision personal org after the signup commit (FK visibility) ([6e0c626](https://github.com/nikunjmavani/core-be/commit/6e0c626af059d26bb9d45ca66de6f43ffb372e29))
* **auth:** provision personal org on first magic-link verification ([c051df5](https://github.com/nikunjmavani/core-be/commit/c051df5bfad9d397e6e1606807c50033b129e5e0))
* **auth:** re-derive super-admin with the same email-verified gate as minting ([907daf7](https://github.com/nikunjmavani/core-be/commit/907daf7fc8295e16afb37689c1126b93af981174))
* **auth:** verify email + clear failed-login lockout on password reset ([77d1594](https://github.com/nikunjmavani/core-be/commit/77d15949dc0a87292d6ac2111a39958694a91757))
* **dev:** stop a stale event-loop peak lingering on the dashboard ([#783](https://github.com/nikunjmavani/core-be/issues/783)) ([a1ac4d2](https://github.com/nikunjmavani/core-be/commit/a1ac4d2278fa89a9dd95c97728471ecdd097e970))
* magic-link Redis resilience, flaky test teardown, and local-startup blockers ([#791](https://github.com/nikunjmavani/core-be/issues/791)) ([e0917ba](https://github.com/nikunjmavani/core-be/commit/e0917ba42b136bcee4c969a4eeb2388b66279296))
* **user:** serialize concurrent notification-preferences replace (+ local dashboards hardening) ([#780](https://github.com/nikunjmavani/core-be/issues/780)) ([a617c9d](https://github.com/nikunjmavani/core-be/commit/a617c9dd1820871180d7736cfa916a8643094098))


### Performance

* **db:** index attribution FK columns for online user deletes ([#781](https://github.com/nikunjmavani/core-be/issues/781)) ([dd7efac](https://github.com/nikunjmavani/core-be/commit/dd7efac9ea5a338b650ea2147c8cdd7cf104fa74))


### Documentation

* add route-effects-by-mode table; fix switch-to-personal status ([c9125b9](https://github.com/nikunjmavani/core-be/commit/c9125b9ba685861c745c5dc6d57c23247ebc654c))
* **api-reference:** correct overview to match the implemented /reference UI ([2eda32b](https://github.com/nikunjmavani/core-be/commit/2eda32b7aafd7a23993ef737039a3a31402dc5bf))
* document organization capability flags (B2C/B2B/hybrid mode) ([dbbb193](https://github.com/nikunjmavani/core-be/commit/dbbb193f5c64dd51ab9005222fd44b114bb5d0f9))
* **frontend-auth-guide:** document the new-user invited join flow ([#790](https://github.com/nikunjmavani/core-be/issues/790)) ([f8a22e3](https://github.com/nikunjmavani/core-be/commit/f8a22e329fee5bf10fe652c842ef9540499b1ce1))
* mark seat-entitlement policy as shipped + resolve open considerations ([830b457](https://github.com/nikunjmavani/core-be/commit/830b457e4087f10ea17017e4777ce764d837363c))
* mark seat-entitlement policy as shipped + resolve open considerations ([c4f4790](https://github.com/nikunjmavani/core-be/commit/c4f47903f6c6fd97037f736567d24c27baf986a4))
* rename personal-team-organizations -&gt; personal-vs-team-organizations ([ef04d39](https://github.com/nikunjmavani/core-be/commit/ef04d39a358b7f5abeb15b0a359ce04c9c6b091f))

## [4.10.0-dev.13](https://github.com/nikunjmavani/core-be/compare/v4.10.0-dev.12...v4.10.0-dev.13) (2026-06-22)


### Added

* **auth:** passkey list + revoke management API (audit R5b / M3) ([8b7e491](https://github.com/nikunjmavani/core-be/commit/8b7e491d8961bf02f7ffb9b8f8a155488cd07fc9))
* **auth:** passkey list + revoke management API (audit R5b / M3) ([effa387](https://github.com/nikunjmavani/core-be/commit/effa387671e352bfe64bb02f8beeb7d5c9d1bc0b))
* membership management overhaul, billing seat model & API contract docs (REQ-1–7) ([#740](https://github.com/nikunjmavani/core-be/issues/740)) ([d6b3435](https://github.com/nikunjmavani/core-be/commit/d6b34355b46487a9776977a396b6cf664926dd29))


### Fixed

* **audit:** emit audit rows under the matching RLS context so they aren't dropped (audit R10) ([1ff2f1f](https://github.com/nikunjmavani/core-be/commit/1ff2f1fde5d86cf271b33d5fc10a32ab47b8b7d4))
* **audit:** emit audit rows under the matching RLS context so they aren't dropped (audit R10) ([08de0d6](https://github.com/nikunjmavani/core-be/commit/08de0d649df35e7efad1d9c7f3cd2af34ffd7c61))
* **audit:** isolate audit-outbox poison rows with a per-row savepoint (audit R7 / M2) ([bc46135](https://github.com/nikunjmavani/core-be/commit/bc46135458eec93fbecf419d0d9d0fa2fe5f362b))
* **audit:** isolate audit-outbox poison rows with a per-row savepoint (audit R7 / M2) ([6600ebc](https://github.com/nikunjmavani/core-be/commit/6600ebc21367ac15e2f619acc4d974da8fdaaca9))
* **auth:** hardening — turnstile hostname, dead-code removal, list caps (audit PR-8) ([324ced2](https://github.com/nikunjmavani/core-be/commit/324ced2c4fee7ad8433786f79575f8414564a763))
* **auth:** hardening — turnstile hostname, dead-code removal, list caps (audit PR-8) ([6554050](https://github.com/nikunjmavani/core-be/commit/65540507c81dc542f0bdac3b5744698307834335))
* **auth:** scope token consume by type + grant-guard reads fresh perms (audit R5a / L2+L3) ([63b78cb](https://github.com/nikunjmavani/core-be/commit/63b78cbc0c7282c7d55f0c6e3882e568a2c87174))
* **auth:** type-scoped token consume + grant-guard reads fresh perms (audit R5a / L2+L3) ([d41da79](https://github.com/nikunjmavani/core-be/commit/d41da791969108c848d1b16fc92dacc6eab4bb76))
* **billing:** enforce seats on member reactivation + over-cap downgrade (audit F1/F2) ([f32bd7d](https://github.com/nikunjmavani/core-be/commit/f32bd7d8567c6d155727d73bde8b3233158b5684))
* **billing:** enforce seats on member reactivation + over-cap downgrade (audit F1/F2) ([71225aa](https://github.com/nikunjmavani/core-be/commit/71225aae241c4f2d54959a6c2d1fe76f28557d59))
* **billing:** fail-closed changePlan + offboarding cancel idempotency key (audit R1) ([ab34935](https://github.com/nikunjmavani/core-be/commit/ab349355b223f2fe5c9fb8dbdd3cff8d70d8e0e1))
* **billing:** fail-closed changePlan + offboarding cancel idempotency key (audit R1) ([509a1e9](https://github.com/nikunjmavani/core-be/commit/509a1e9038289222526a114349b70ada706245f0))
* **billing:** stripe idempotency & subscription correctness (audit PR-2) ([5d32961](https://github.com/nikunjmavani/core-be/commit/5d3296110ea41cddca4ef505486f077eca5141e7))
* **billing:** stripe idempotency & subscription correctness (audit PR-2) ([5578273](https://github.com/nikunjmavani/core-be/commit/5578273313a42e4531e477e6477c8a611559535f))
* **billing:** webhook tenant-scope & subscription RLS hardening (audit PR-3) ([cd4fff3](https://github.com/nikunjmavani/core-be/commit/cd4fff3d6e71d367cc7a6872c8fe4d2f8fad78f0))
* **billing:** webhook tenant-scope & subscription RLS hardening (audit PR-3) ([3a96e66](https://github.com/nikunjmavani/core-be/commit/3a96e6663a4f26470c8afb1d6d0f577d09701f75))
* **db:** hash advisory-lock objid so bigint scope ids don't overflow int4 (audit B-1) ([256015b](https://github.com/nikunjmavani/core-be/commit/256015b2495637cf0c3e65aa9350f6b41ff1223a))
* **db:** hash advisory-lock objid so bigint scope ids don't overflow int4 (audit B-1) ([e00bc68](https://github.com/nikunjmavani/core-be/commit/e00bc6836e7bd956e5157261930d1e5f49f09e03))
* **infra:** production env-guard for Bull-Board dashboard + 403 read-only status (re-audit A1) ([7f856e0](https://github.com/nikunjmavani/core-be/commit/7f856e0a8778225f281c6dfb379d88d4ce1669cf))
* **infra:** production env-guard for Bull-Board dashboard + 403 read-only status (re-audit A1) ([ebfd821](https://github.com/nikunjmavani/core-be/commit/ebfd8214299749d3d83743351335efb9b3be598f))
* **mcp:** make call_api read-only by default + mask errors, add route allowlist (audit R14) ([cbb9dee](https://github.com/nikunjmavani/core-be/commit/cbb9dee32d05ffca545586f230a934306f376ec3))
* **mcp:** make call_api read-only by default + mask errors; route allowlist (audit R14) ([1ae019e](https://github.com/nikunjmavani/core-be/commit/1ae019e1e9d3ead0560d1fe0eaed3ffd1837d2d0))
* **notify:** delivery reliability — idempotent enqueue, bounded mark-all, honest outcomes (audit PR-5) ([10269fb](https://github.com/nikunjmavani/core-be/commit/10269fb0ced73422677bbb5c0276368d43e305c3))
* **notify:** delivery reliability — idempotent enqueue, bounded mark-all, honest outcomes (audit PR-5) ([f5649a2](https://github.com/nikunjmavani/core-be/commit/f5649a201c42f732fc0f933b35b27a411b9cdedb))
* **notify:** webhook SSRF egress hardening (audit PR-4) ([8239e08](https://github.com/nikunjmavani/core-be/commit/8239e08da0f91885be1041ce5fb42c32f13b8084))
* **notify:** webhook SSRF egress hardening (audit PR-4) ([646c697](https://github.com/nikunjmavani/core-be/commit/646c69739012ccb1fefc5e97dfaca70e13a34424))
* **observability:** initialize OpenTelemetry at runtime (audit R4 / M5) ([9f15ac9](https://github.com/nikunjmavani/core-be/commit/9f15ac9cccca77eaa32518dd7f8daefc28b8aec2))
* **observability:** initialize OpenTelemetry at runtime (audit R4 / M5) ([991414e](https://github.com/nikunjmavani/core-be/commit/991414ebd2c90255b3fddf1a4c81fabb3dbde7e7))
* **overload:** shed new requests on DB-pool saturation, not just event-loop stall (prod-readiness) ([60452e6](https://github.com/nikunjmavani/core-be/commit/60452e6d24c50fd8db40c43670d392bcbb8fb543))
* **overload:** shed new requests on DB-pool saturation, not just event-loop stall (prod-readiness) ([3b362f5](https://github.com/nikunjmavani/core-be/commit/3b362f5ece7313b42029816fbdfb06cee7933048))
* **platform:** harden middleware & boot config (audit PR-1) ([375eff8](https://github.com/nikunjmavani/core-be/commit/375eff8e43986eb37e8b7e9e5e324843244027b7))
* **platform:** harden middleware & boot config (audit PR-1) ([a1f11e3](https://github.com/nikunjmavani/core-be/commit/a1f11e34006c2dfe85ba39ccb4d6a37f3634808d))
* **rls:** propagate explicit WITH CHECK to all org-scoped policies (audit R2) ([01ef1cf](https://github.com/nikunjmavani/core-be/commit/01ef1cf717e22fd6aba4f39acb8665e8bd10eac7))
* **rls:** propagate explicit WITH CHECK to all org-scoped policies (audit R2) ([d72a187](https://github.com/nikunjmavani/core-be/commit/d72a187c877d6a12c5bdf21a6e64038bf9a90740))
* **tenancy:** concurrency & isolation hygiene (audit PR-6) ([c7dc4dc](https://github.com/nikunjmavani/core-be/commit/c7dc4dcda1155c12b613102940141a9ae587316e))
* **tenancy:** concurrency & isolation hygiene (audit PR-6) ([8a2cd9b](https://github.com/nikunjmavani/core-be/commit/8a2cd9bd1f2ef6b4655632fc50e012ca81810b61))
* **tenancy:** invalidate the permission cache after commit, not inside the write txn (audit R11) ([97f6086](https://github.com/nikunjmavani/core-be/commit/97f60868165954cd27ee85db193327649268ae89))
* **tenancy:** invalidate the permission cache after commit, not inside the write txn (audit R11) ([d6598e2](https://github.com/nikunjmavani/core-be/commit/d6598e2538b89855b3c3c114a4bdc1035d864a84))
* **tenancy:** make organizations.slug unique index partial on deleted_at (audit R9) ([2d847be](https://github.com/nikunjmavani/core-be/commit/2d847be65855d92a61cc1a2c5a132708dedff8e3))
* **tenancy:** make organizations.slug unique index partial on deleted_at (audit R9) ([4b392d5](https://github.com/nikunjmavani/core-be/commit/4b392d5d74183a56d1a5bb4061f88a8a9400f4e4))
* **upload:** reserve org-scoped upload slots under organization RLS context (R8 / M4) ([50c82b0](https://github.com/nikunjmavani/core-be/commit/50c82b00b4de3fd854be9981cbb96a0ccd84bf6a))
* **upload:** reserve org-scoped upload slots under organization RLS context (R8 / M4) ([6b7ea5a](https://github.com/nikunjmavani/core-be/commit/6b7ea5a012ddcb266f7c037cc050e20b1df6fb21))
* **user:** data-access concurrency & query hardening (audit PR-7) ([d2988a8](https://github.com/nikunjmavani/core-be/commit/d2988a8140c546d444bd9749fc591b4826a8f93b))
* **user:** data-access concurrency & query hardening (audit PR-7) ([b569c9c](https://github.com/nikunjmavani/core-be/commit/b569c9c6a94a430a14c76d4169e48549f917bb1b))
* **validation:** reject webhook-URL userinfo and traversal in storage-key DTOs (audit R13) ([a06c5d8](https://github.com/nikunjmavani/core-be/commit/a06c5d882f7709851cb4ab6b7fed2c250e8527a7))
* **validation:** reject webhook-URL userinfo and traversal in storage-key DTOs (audit R13) ([fd6e43f](https://github.com/nikunjmavani/core-be/commit/fd6e43fa26b5b0d260d22940f9b663208acafd11))


### Performance

* **tenancy:** let the keyset index drive organization discovery (audit perf-[#1](https://github.com/nikunjmavani/core-be/issues/1)) ([8837329](https://github.com/nikunjmavani/core-be/commit/8837329ada641d95ae776a1ff6376a97d786eeea))
* **tenancy:** let the keyset index drive organization discovery (audit perf-[#1](https://github.com/nikunjmavani/core-be/issues/1)) ([2a05df0](https://github.com/nikunjmavani/core-be/commit/2a05df00bc2cdeb3c5664adc81e2d4511a1b1748))


### Changed

* ponytail-audit dead-code cleanup, add ponytail skill, fix test captcha env ([#739](https://github.com/nikunjmavani/core-be/issues/739)) ([904d170](https://github.com/nikunjmavani/core-be/commit/904d1709682f6d7ad02a2c97b1472ec5943acb5c))
* **tenancy:** drop redundant org-create advisory lock, delete dead cap-lock module (audit R12) ([0d82149](https://github.com/nikunjmavani/core-be/commit/0d821495855f6b44d70c34b3a8931b30bbfa2cef))
* **tenancy:** drop redundant org-create advisory lock, delete dead cap-lock module (audit R12) ([21479a9](https://github.com/nikunjmavani/core-be/commit/21479a993d9dc4701587b759449e1a2744fecdb3))


### Documentation

* correct OVERVIEW content drift vs schema/services (audit R3) ([d1f5765](https://github.com/nikunjmavani/core-be/commit/d1f576538f31ff73d494991a7470635e1292e2d2))
* correct OVERVIEW content drift vs schema/services (audit R3) ([98f16fd](https://github.com/nikunjmavani/core-be/commit/98f16fd7eaae24d13d50f948c49148e599149f95))
* record production-audit decisions + seat-entitlement policy ([6794fef](https://github.com/nikunjmavani/core-be/commit/6794fef9258ba3bf72499589a390925348143aad))
* record production-audit decisions + seat-entitlement policy ([b12a3b3](https://github.com/nikunjmavani/core-be/commit/b12a3b3f2fa3c8276b06e4995d6bfe38e617948d))
* rename per-folder OVERVIEW.md → &lt;folder&gt;.overview.md ([94e0f05](https://github.com/nikunjmavani/core-be/commit/94e0f05b18801d22cb5688b495efb7763b0a3edc))
* rename per-folder OVERVIEW.md → &lt;folder&gt;.overview.md ([f5aa247](https://github.com/nikunjmavani/core-be/commit/f5aa247e979c77dc1eaa995681315f6576de2f00))

## [4.10.0-dev.12](https://github.com/nikunjmavani/core-be/compare/v4.9.1-dev.12...v4.10.0-dev.12) (2026-06-20)


### Added

* **tooling:** local dashboards control room (pnpm dashboards:*) ([a0ab8c9](https://github.com/nikunjmavani/core-be/commit/a0ab8c9812b1a4799c98ee2928534b39c1aa96b3))


### Fixed

* **lint:** suppress two pre-existing biome findings surfaced by the PR lint gate ([b1b444a](https://github.com/nikunjmavani/core-be/commit/b1b444a0cce44e53c8befb0a5b8d65a508529fad))


### Documentation

* sync agent-os (CLAUDE.md, docs index, skills, rules) with code ([#737](https://github.com/nikunjmavani/core-be/issues/737)) ([7918a8e](https://github.com/nikunjmavani/core-be/commit/7918a8e25a0672e89c6024b5cce704ca6560e8b9))

## [4.9.1-dev.12](https://github.com/nikunjmavani/core-be/compare/v4.9.1-dev.11...v4.9.1-dev.12) (2026-06-20)


### Fixed

* **idempotency:** enforce 16-char min key and document all 13 required writes ([#735](https://github.com/nikunjmavani/core-be/issues/735)) ([606edbb](https://github.com/nikunjmavani/core-be/commit/606edbba19a7c5234b72f1f46b036b9187d06794))

## [4.9.1-dev.11](https://github.com/nikunjmavani/core-be/compare/v4.9.1-dev.10...v4.9.1-dev.11) (2026-06-20)


### Fixed

* harden real-world edge cases — 3 fixes + 7 coverage guards ([#732](https://github.com/nikunjmavani/core-be/issues/732)) ([85ca439](https://github.com/nikunjmavani/core-be/commit/85ca439d4fd05dbd25b55b3803565062c7643de9))

## [4.9.1-dev.10](https://github.com/nikunjmavani/core-be/compare/v4.9.1-dev.9...v4.9.1-dev.10) (2026-06-20)


### Documentation

* add handoff summary, enforcement gates, and version override to release-dev-to-production ([#727](https://github.com/nikunjmavani/core-be/issues/727)) ([812afba](https://github.com/nikunjmavani/core-be/commit/812afbaf98b421cb516cd8cf50f6f00b3b825d2c))

## [4.9.1-dev.9](https://github.com/nikunjmavani/core-be/compare/v4.9.1-dev.8...v4.9.1-dev.9) (2026-06-20)


### Fixed

* audit remediation — verified production-hardening items ([#725](https://github.com/nikunjmavani/core-be/issues/725)) ([bdaabac](https://github.com/nikunjmavani/core-be/commit/bdaabacd88cf643d2093d68b16bf0d68d2ccd253))

## [4.9.1-dev.8](https://github.com/nikunjmavani/core-be/compare/v4.9.1-dev.7...v4.9.1-dev.8) (2026-06-19)


### Fixed

* **seed:** idempotent demo seed helpers + smoke test status fixes ([#723](https://github.com/nikunjmavani/core-be/issues/723)) ([3d3a998](https://github.com/nikunjmavani/core-be/commit/3d3a998e169a7fc111ec1e9790f9ad10b90b1924))


### Documentation

* **load-testing:** document co-located load-generation caveat ([#722](https://github.com/nikunjmavani/core-be/issues/722)) ([1df13ae](https://github.com/nikunjmavani/core-be/commit/1df13aec72510e73763537c3615424bafc9d2f90))

## [4.9.1-dev.7](https://github.com/nikunjmavani/core-be/compare/v4.9.1-dev.6...v4.9.1-dev.7) (2026-06-19)


### Documentation

* archive Codex Cloud setup ([#719](https://github.com/nikunjmavani/core-be/issues/719)) ([831865e](https://github.com/nikunjmavani/core-be/commit/831865e05d9a770eabe031f638c18fac95889ca3))

## [4.9.1-dev.6](https://github.com/nikunjmavani/core-be/compare/v4.9.1-dev.5...v4.9.1-dev.6) (2026-06-19)


### Fixed

* use shared cloud agent docker fallback ([#716](https://github.com/nikunjmavani/core-be/issues/716)) ([7ab2c17](https://github.com/nikunjmavani/core-be/commit/7ab2c176ca2c58082e61c20b75c8b801ee3534a1))

## [4.9.1-dev.5](https://github.com/nikunjmavani/core-be/compare/v4.9.1-dev.4...v4.9.1-dev.5) (2026-06-19)


### Fixed

* add Codex Docker vfs fallback ([#715](https://github.com/nikunjmavani/core-be/issues/715)) ([f61b64e](https://github.com/nikunjmavani/core-be/commit/f61b64eaf8794d403bf6752c3660fdf2bbf2de1e))

## [4.9.1-dev.4](https://github.com/nikunjmavani/core-be/compare/v4.9.1-dev.3...v4.9.1-dev.4) (2026-06-18)


### Fixed

* start docker daemon before cloud compose ([6c93d3e](https://github.com/nikunjmavani/core-be/commit/6c93d3eaa30a0a9cd9227d4703527331c83e99a5))

## [4.9.1-dev.3](https://github.com/nikunjmavani/core-be/compare/v4.9.1-dev.2...v4.9.1-dev.3) (2026-06-18)


### Fixed

* install docker for cloud bootstrap ([2055ce5](https://github.com/nikunjmavani/core-be/commit/2055ce51b545d74b41dc933970ea06006cbbb76f))

## [4.9.1-dev.2](https://github.com/nikunjmavani/core-be/compare/v4.9.1-dev.1...v4.9.1-dev.2) (2026-06-18)


### Documentation

* **agent-os:** document dev production release command ([7d023a2](https://github.com/nikunjmavani/core-be/commit/7d023a203df9dc7bc81020428c24eb4e78a1b31d))

## [4.9.1-dev.1](https://github.com/nikunjmavani/core-be/compare/v4.9.1-dev.0...v4.9.1-dev.1) (2026-06-18)


### Fixed

* **ci:** correct release-please flow ([#698](https://github.com/nikunjmavani/core-be/issues/698)) ([c5e2e4d](https://github.com/nikunjmavani/core-be/commit/c5e2e4db4ef6d94d47c020dd7d7ecd7dcd6e1247))

## [4.9.1-dev.0](https://github.com/nikunjmavani/core-be/compare/v4.9.0-dev.0...v4.9.1-dev.0) (2026-06-18)


### Fixed

* address route audit findings ([#697](https://github.com/nikunjmavani/core-be/issues/697)) ([751e329](https://github.com/nikunjmavani/core-be/commit/751e3291f3b76f02b9e5665dd7ba899219c2c33f))

## [4.9.0-dev.0](https://github.com/nikunjmavani/core-be/compare/v4.8.2-dev.0...v4.9.0-dev.0) (2026-06-18)


### Added

* **agent-os:** single-source backbone + agent read-only + skill orchestration ([#693](https://github.com/nikunjmavani/core-be/issues/693)) ([a7cbb66](https://github.com/nikunjmavani/core-be/commit/a7cbb66544aff822176920be37d341b3717ce757))


### Performance

* **http:** reduce idle P99 + comprehensive journey load-test harness ([#694](https://github.com/nikunjmavani/core-be/issues/694)) ([e0385d3](https://github.com/nikunjmavani/core-be/commit/e0385d362ee64cda4c8f9fda8e418e71cda48771))

## [4.8.2-dev.0](https://github.com/nikunjmavani/core-be/compare/v4.8.1-dev.0...v4.8.2-dev.0) (2026-06-17)


### Changed

* **api:** semantic path params, single-tag operations, invitation grouping ([#691](https://github.com/nikunjmavani/core-be/issues/691)) ([94f4ecb](https://github.com/nikunjmavani/core-be/commit/94f4ecb4adf2e28f2a905f3d5b4c0696619cf2f2))

## [4.8.1-dev.0](https://github.com/nikunjmavani/core-be/compare/v4.8.0-dev.0...v4.8.1-dev.0) (2026-06-17)


### Performance

* **http:** cut per-request logging cost and add event-loop overload valve ([#687](https://github.com/nikunjmavani/core-be/issues/687)) ([3dda668](https://github.com/nikunjmavani/core-be/commit/3dda668b6aff80de7feccac8e4304a014055069c))

## [4.8.0-dev.0](https://github.com/nikunjmavani/core-be/compare/v4.7.0-dev.0...v4.8.0-dev.0) (2026-06-17)


### Added

* **mcp:** two-tier MCP setup — default codegraph+headroom pair + on-demand `pnpm mcp:setup` ([#683](https://github.com/nikunjmavani/core-be/issues/683)) ([b8331aa](https://github.com/nikunjmavani/core-be/commit/b8331aa63bb26adcfe81f55983614f31d7617b1b))

## [4.7.0-dev.0](https://github.com/nikunjmavani/core-be/compare/v4.6.9-dev.0...v4.7.0-dev.0) (2026-06-17)


### Added

* **ai:** cross-platform AI commands, SessionStart hook, and guardrails ([#643](https://github.com/nikunjmavani/core-be/issues/643)) ([b6fccf1](https://github.com/nikunjmavani/core-be/commit/b6fccf1630257d2920ba3831f625bbeeca7cad41))
* **auth:** GET /auth/me/context — frontend-ready effective context ([#659](https://github.com/nikunjmavani/core-be/issues/659)) ([d08bb35](https://github.com/nikunjmavani/core-be/commit/d08bb35049c443015b3d53be0f13c7a80f4a845a))
* **config:** gated local-dev defaults for DB/Redis/origins/retention ([#651](https://github.com/nikunjmavani/core-be/issues/651)) ([773e427](https://github.com/nikunjmavani/core-be/commit/773e427ca11bd44d1a65fea996ebbc92a629c236))
* **mcp:** scope project MCP servers and wire MCP setup into the session-start flow ([#675](https://github.com/nikunjmavani/core-be/issues/675)) ([9ed07b4](https://github.com/nikunjmavani/core-be/commit/9ed07b4ba576db0ac5849d9c7de76b4c2c91af73))
* **scalar:** publish OpenAPI to Scalar Registry (CI docs pipeline + interactive setup) ([#672](https://github.com/nikunjmavani/core-be/issues/672)) ([3ddc9b2](https://github.com/nikunjmavani/core-be/commit/3ddc9b2325a8cc8417bfe679c748a64f5c510da2))


### Fixed

* **ci:** publish API docs (incl. Scalar Registry) independently of release-please ([#676](https://github.com/nikunjmavani/core-be/issues/676)) ([7c4fe62](https://github.com/nikunjmavani/core-be/commit/7c4fe62027431e4d79e006afb84cc24c61e5fc67))
* **ci:** publish Scalar registry from GitHub Variables ([#677](https://github.com/nikunjmavani/core-be/issues/677)) ([cfaaef8](https://github.com/nikunjmavani/core-be/commit/cfaaef883eb57327cfd3f558597407250d3a752c))
* **config:** make .env.local the self-contained primary local env file ([#650](https://github.com/nikunjmavani/core-be/issues/650)) ([aeb32e7](https://github.com/nikunjmavani/core-be/commit/aeb32e7c60d4686f71b2f14f46efe873404652c3))
* **setup:** activate pinned Node on PATH in agent bootstrap step 1 ([#649](https://github.com/nikunjmavani/core-be/issues/649)) ([968d54f](https://github.com/nikunjmavani/core-be/commit/968d54fae13b6e8cb9c40c39e565c116739dd479))


### Changed

* **api:** rename inbound Idempotency-Key header to X-Idempotency-Key ([#656](https://github.com/nikunjmavani/core-be/issues/656)) ([b595c1b](https://github.com/nikunjmavani/core-be/commit/b595c1b0ed35a9248f1dd53660c7b3afb849eee4))
* **billing:** remove deprecated /stripe/webhook alias ([#670](https://github.com/nikunjmavani/core-be/issues/670)) ([e0a4c8b](https://github.com/nikunjmavani/core-be/commit/e0a4c8bfac04fcbe041c6b6c1e47a5585d411820))
* **constants:** centralize scope-localized config constants ([#667](https://github.com/nikunjmavani/core-be/issues/667)) ([f6dad66](https://github.com/nikunjmavani/core-be/commit/f6dad66887513bd519c020794526b3b32c8c728a))
* **quality:** clear SonarQube debt on the deployed surface ([#663](https://github.com/nikunjmavani/core-be/issues/663)) ([8f5116a](https://github.com/nikunjmavani/core-be/commit/8f5116a5ddb29ac435078922ed7188ca4f6f1df3))
* route consistency + personal/team org model ([#658](https://github.com/nikunjmavani/core-be/issues/658)) ([d304b88](https://github.com/nikunjmavani/core-be/commit/d304b88439d8611d7b7d668f4b0d1f15c9a7a2dc))
* **validation:** extract shared parseWithSchema + parseCursorPaginatedQuery helpers ([#661](https://github.com/nikunjmavani/core-be/issues/661)) ([7831156](https://github.com/nikunjmavani/core-be/commit/78311567eb27b6676b63fa3dec89ab3d1bab3130))


### Documentation

* **integrations:** add Codex Cloud agent environment guide and GitHub prerequisites ([#660](https://github.com/nikunjmavani/core-be/issues/660)) ([d2128de](https://github.com/nikunjmavani/core-be/commit/d2128de716f1f19c25d934c87ecb517baf05d04e))
* **integrations:** common Claude Code session-setup overview ([#674](https://github.com/nikunjmavani/core-be/issues/674)) ([9052152](https://github.com/nikunjmavani/core-be/commit/90521520c34495a066342656f1ba104beb827f54))

## [4.6.9-dev.0](https://github.com/nikunjmavani/core-be/compare/v4.6.8-dev.0...v4.6.9-dev.0) (2026-06-15)


### Documentation

* **agent-os:** correct stale workflow, seed, and provider paths in skills ([#641](https://github.com/nikunjmavani/core-be/issues/641)) ([5550f4c](https://github.com/nikunjmavani/core-be/commit/5550f4c274b58403008bb98dd4982642565ed110))

## [4.6.8-dev.0](https://github.com/nikunjmavani/core-be/compare/v4.6.7-dev.0...v4.6.8-dev.0) (2026-06-15)


### Documentation

* **agent-os:** align schema skills to varchar(n) codebase convention ([#638](https://github.com/nikunjmavani/core-be/issues/638)) ([e575074](https://github.com/nikunjmavani/core-be/commit/e5750743e7a8af7a59eebd06d552ca8223a598d1))

## [4.6.7-dev.0](https://github.com/nikunjmavani/core-be/compare/v4.6.6-dev.0...v4.6.7-dev.0) (2026-06-15)


### Documentation

* **integrations:** expand Stripe webhook runbook + Turnstile TODO ([#635](https://github.com/nikunjmavani/core-be/issues/635)) ([be08946](https://github.com/nikunjmavani/core-be/commit/be08946a84175689883f858e61e96b928e8c222d))

## [4.6.6-dev.0](https://github.com/nikunjmavani/core-be/compare/v4.6.5-dev.0...v4.6.6-dev.0) (2026-06-15)


### Documentation

* **integrations:** add Postman + Resend agent MCP servers ([#631](https://github.com/nikunjmavani/core-be/issues/631)) ([6966744](https://github.com/nikunjmavani/core-be/commit/6966744da40ff9887700f433f78afc1f8f313140))
* **integrations:** fix Stripe CLI/Dashboard webhook URL ([#630](https://github.com/nikunjmavani/core-be/issues/630)) ([570e58f](https://github.com/nikunjmavani/core-be/commit/570e58f79991d12dcf75781ccdc9465da2647b85))

## [4.6.5-dev.0](https://github.com/nikunjmavani/core-be/compare/v4.6.4-dev.0...v4.6.5-dev.0) (2026-06-15)


### Documentation

* **integrations:** map third-party services to CLI/MCP/SDK by consumer ([#626](https://github.com/nikunjmavani/core-be/issues/626)) ([5e90f52](https://github.com/nikunjmavani/core-be/commit/5e90f522061e5de8f31cb2905b9edda43caf2bf9))

## [4.6.4-dev.0](https://github.com/nikunjmavani/core-be/compare/v4.6.3-dev.0...v4.6.4-dev.0) (2026-06-15)


### Documentation

* **runbooks:** refresh worker registry breakdown to 30 workers / 27 Postgres ([#621](https://github.com/nikunjmavani/core-be/issues/621)) ([2d4d111](https://github.com/nikunjmavani/core-be/commit/2d4d111a9578679c856367881c16a5f6d8f62cb6))

## [4.6.3-dev.0](https://github.com/nikunjmavani/core-be/compare/v4.6.2-dev.0...v4.6.3-dev.0) (2026-06-14)


### Documentation

* **process:** document "watch CI -&gt; merge when green" in git flow + pr-babysit ([#616](https://github.com/nikunjmavani/core-be/issues/616)) ([0537a8e](https://github.com/nikunjmavani/core-be/commit/0537a8e86fc135038585d78b523e648cbc289e69))

## [4.6.2-dev.0](https://github.com/nikunjmavani/core-be/compare/v4.6.1-dev.0...v4.6.2-dev.0) (2026-06-14)


### Fixed

* three pre-existing dev post-merge CI failures (migration idempotency, Stripe Date bind, permission seed) ([#614](https://github.com/nikunjmavani/core-be/issues/614)) ([798cefe](https://github.com/nikunjmavani/core-be/commit/798cefe26f59b8f56c3987f437772d707a42e364))


### Documentation

* **process:** add release-versioning cheat-sheet (commit prefix → bump) ([#612](https://github.com/nikunjmavani/core-be/issues/612)) ([6e58397](https://github.com/nikunjmavani/core-be/commit/6e58397013279da347bf5a56305e150ea1cc8e26))

## [4.6.1-dev.0](https://github.com/nikunjmavani/core-be/compare/v4.6.0-dev.0...v4.6.1-dev.0) (2026-06-14)


### Changed

* **queue:** remove redundant alert-only offboarding reconciler ([#611](https://github.com/nikunjmavani/core-be/issues/611)) ([55e979e](https://github.com/nikunjmavani/core-be/commit/55e979e10528a3b6c794aaea1595e7feeedbc7b6))

## [4.6.0-dev.0](https://github.com/nikunjmavani/core-be/compare/v4.5.7-dev.0...v4.6.0-dev.0) (2026-06-14)


### Added

* 131-route security & production-flow audit — fix all RED/AMBER findings ([#601](https://github.com/nikunjmavani/core-be/issues/601)) ([3df1fbd](https://github.com/nikunjmavani/core-be/commit/3df1fbd91ea9011a6378a6f0785200e4a5f990ed))
* **agent-os:** add PreToolUse edit-guard and SessionStart hooks ([dcf6335](https://github.com/nikunjmavani/core-be/commit/dcf6335773cb9b8d15f570d7b2afac9e2a1a284c))
* **agent-os:** add RLS/tenant-isolation and idempotency guard skills ([a94cbb5](https://github.com/nikunjmavani/core-be/commit/a94cbb52df397f1abadf3a3f411f31bf2fc6f49a))
* **agent-os:** PreToolUse edit-guard + SessionStart hooks (Move 2) ([ad2e2b3](https://github.com/nikunjmavani/core-be/commit/ad2e2b3b87051c2fe34d3005d6a84fc6e37965e0))
* **agent-os:** RLS/tenant-isolation + idempotency guard skills ([0a3b902](https://github.com/nikunjmavani/core-be/commit/0a3b902748f4fc3e84d5d971b0915496b5e4f440))
* **audit:** transactional outbox for audit.logs writes (P0-[#2](https://github.com/nikunjmavani/core-be/issues/2)) ([#557](https://github.com/nikunjmavani/core-be/issues/557)) ([4c337da](https://github.com/nikunjmavani/core-be/commit/4c337da6b81523c01d23bf8947226194ee9ad665))
* **auth:** add switch-to-personal and switch-to-organization endpoints ([79be5b0](https://github.com/nikunjmavani/core-be/commit/79be5b0fe799563e9612eaa3fc48a4a12f3ce2ae))
* **auth:** carry active organization + session version as signed JWT claims ([9864a2e](https://github.com/nikunjmavani/core-be/commit/9864a2e34917837b7102fdd72f9ba61982e4b0e0))
* **auth:** mint the active-organization claim at login (default selection) ([a3a805d](https://github.com/nikunjmavani/core-be/commit/a3a805dc143b7af537c0757b4b74bfc77516d75d))
* **auth:** permission layer falls back to the org token claim (Phase 3 bridge) ([ea07091](https://github.com/nikunjmavani/core-be/commit/ea0709135504d09faa6367bfded88107cc438295))
* **auth:** permission layer reads the org token claim (Phase 3 bridge) ([6b9e7c3](https://github.com/nikunjmavani/core-be/commit/6b9e7c3458f6788b5c75b0ed4a49d3709b48d181))
* **auth:** refresh re-mints the active-organization claim ([b22f0a1](https://github.com/nikunjmavani/core-be/commit/b22f0a1712aa76b1f997257997b157025712b791))
* **auth:** switch building blocks — membership-validation resolvers + session token re-bind ([62cc944](https://github.com/nikunjmavani/core-be/commit/62cc9449314b7684007c937a9ec72b73c2d0eceb))
* **auth:** switchToOrganization / switchToPersonal service methods ([3f5ecc8](https://github.com/nikunjmavani/core-be/commit/3f5ecc84267e747d6e6d900ae5caf733f6255752))
* **billing:** flatten subscription routes onto the org token claim ([f835d60](https://github.com/nikunjmavani/core-be/commit/f835d605e0529e0e0e91ca7da1b16aa5f8940bec))
* **billing:** flatten subscription routes onto the org token claim ([df21c2c](https://github.com/nikunjmavani/core-be/commit/df21c2c62c4b65e4f1bf57228743ac2cd042a92c))
* **infra-tests:** drop_index_without_concurrently lint rule + org slug collision-proof factory ([#526](https://github.com/nikunjmavani/core-be/issues/526)) ([0915c85](https://github.com/nikunjmavani/core-be/commit/0915c851ab7b5c8934a06108d28f8aec3662e97b))
* **mcp,k6:** client auth-flow guide + k6 org-claim flow; fix dead idempotency exclusions ([f4bac5a](https://github.com/nikunjmavani/core-be/commit/f4bac5aa9a67f14e5ec87209e326e67b5ae15de6))
* **mcp,k6:** client auth-flow guide + k6 org-claim flow; fix idempotency exclusions; flatten stale refs ([f6e5894](https://github.com/nikunjmavani/core-be/commit/f6e5894a66cee5de1ff0790f5898b5510fd74f37))
* **notify:** flatten webhook routes onto the org token claim ([643d13a](https://github.com/nikunjmavani/core-be/commit/643d13ad09bd64e28bca029e4ed42cc40b56d04f))
* **notify:** flatten webhook routes onto the org token claim ([0bdc8ad](https://github.com/nikunjmavani/core-be/commit/0bdc8add9f37df2bd944995368be8d9f94710755))
* **notify:** time-based retention for webhook_delivery_attempts (audit-[#3](https://github.com/nikunjmavani/core-be/issues/3)) ([05d6325](https://github.com/nikunjmavani/core-be/commit/05d63258002fd9762962498b0a5059a5b971400f))
* **openapi:** document the full error-status matrix; observed-vs-spec error gate ([95a71b5](https://github.com/nikunjmavani/core-be/commit/95a71b505c9d8d7f802d73c4e0841b4140bf836d))
* **openapi:** document the full error-status matrix; observed-vs-spec error gate ([5a001de](https://github.com/nikunjmavani/core-be/commit/5a001de48bb661e048e012dde8ce658bfe612f3e))
* **openapi:** embed sanitized live-call request/response examples per route and status ([3a1ddb1](https://github.com/nikunjmavani/core-be/commit/3a1ddb1e5d38b40e18b9300a14942219da6ce868))
* **openapi:** embed sanitized live-call request/response examples per route and status ([bea574c](https://github.com/nikunjmavani/core-be/commit/bea574c92291f96bd309ad1969fe38cdf756722f))
* personal & team organizations — foundation + token/switch (Phase 1-2) ([9a8b179](https://github.com/nikunjmavani/core-be/commit/9a8b179a097b615b2e7292ad6f6362011ea2563c))
* **round-5-followup:** per-org row caps (api-keys, member-roles, notification-policies) + auth/MFA route policy tests ([#528](https://github.com/nikunjmavani/core-be/issues/528)) ([19b556f](https://github.com/nikunjmavani/core-be/commit/19b556f9379a3d70889644356e9928a68de549e9))
* **round-5:** residual-risk findings — DLQ-RLS bug + 5 backlog fixes + 3 test gaps + audit doc ([#527](https://github.com/nikunjmavani/core-be/issues/527)) ([6aa6f88](https://github.com/nikunjmavani/core-be/commit/6aa6f8831e12fa7c8ef88f3d95f9e15bcd2d23d2))
* **tenancy:** atomic org provisioning with owner role+permissions+membership ([266b22e](https://github.com/nikunjmavani/core-be/commit/266b22ebeb3604dbc45d08608efd7604df37c81e))
* **tenancy:** auto-provision personal org at signup + exclude personal from delete guard ([9daed03](https://github.com/nikunjmavani/core-be/commit/9daed03c85997744bbfeb50919681de5658cd556))
* **tenancy:** block invitations on a personal organization (capability matrix) ([cafc549](https://github.com/nikunjmavani/core-be/commit/cafc5493d497f7e99a924a152ca6a64e4f29dd0d))
* **tenancy:** cap team organizations per owner (anti-abuse) ([f71b968](https://github.com/nikunjmavani/core-be/commit/f71b968577aa19a8ce4c3b4f6ce83142c3fd51d3))
* **tenancy:** flatten organization routes onto the org token claim ([ddd1a76](https://github.com/nikunjmavani/core-be/commit/ddd1a7604f7da6dfb3a878fdb28c9e35dff086d8))
* **tenancy:** flatten organization routes onto the org token claim ([f35b74e](https://github.com/nikunjmavani/core-be/commit/f35b74eb0f14cf2e5225b3fb477ea686a82763ed))
* **tenancy:** make the personal organization immutable (no delete / no transfer) ([a726064](https://github.com/nikunjmavani/core-be/commit/a726064b5f009c1a5ccd878fe8379eb79a533a37))
* **tenancy:** org-creation per-owner cap + personal-org capability guards ([94d7715](https://github.com/nikunjmavani/core-be/commit/94d77153740b2076afb57ded14748b727367617c))
* **tenancy:** organization create accepts type + nullable slug (provisioning groundwork) ([35bc409](https://github.com/nikunjmavani/core-be/commit/35bc409c7e85453a2d294f1baf4bd38b19e26d6f))
* **tenancy:** personal-org backfill script + provisioning tests ([5a40f5d](https://github.com/nikunjmavani/core-be/commit/5a40f5d5eadfd970e712b8d4b5a7f85b86258727))
* **tenancy:** personal/team organization foundation — schema + capability flags ([11e23d9](https://github.com/nikunjmavani/core-be/commit/11e23d92fc301307638f73e3e1269a0612ddde3d))
* **testing:** route success-status registry, observed coverage ratchet, never-5xx fuzz gate ([8d88dcf](https://github.com/nikunjmavani/core-be/commit/8d88dcf0677104ce4885ad80d62543c6ec45052a))
* **testing:** route success-status registry, observed coverage ratchet, never-5xx fuzz gate ([dfe2b43](https://github.com/nikunjmavani/core-be/commit/dfe2b436d3fa28843597576d6b29f43d7932d8ab))
* **testing:** verified happy path for every route — budget 30→0; 201 creates; OAuth 404 ([01b1b77](https://github.com/nikunjmavani/core-be/commit/01b1b77cbf2f60dcafbfa1afeafab68fe1e54437))
* **testing:** verified happy path for every route — budget 30→0; 201 creates; OAuth 404 ([624c9d5](https://github.com/nikunjmavani/core-be/commit/624c9d58945e78317e39cd9a412e488454fbdf29))
* **tests:** post-load settle-and-assert-clean gate + audit-outbox drain coverage ([01258c5](https://github.com/nikunjmavani/core-be/commit/01258c5b5aa9c03f8d6e9c7c9a5218cd10d3750b))
* **tooling:** project identity refactor, 5 review agents, architecture policy tests ([#552](https://github.com/nikunjmavani/core-be/issues/552)) ([324689e](https://github.com/nikunjmavani/core-be/commit/324689e3c5027056932272f90d3495539d25ea44))
* **user:** add a scheduled reconciler that detects + alerts on stuck offboarding (audit-[#15](https://github.com/nikunjmavani/core-be/issues/15)) ([6443673](https://github.com/nikunjmavani/core-be/commit/64436733ec73792a3295b46ade51da2ceee98a53))
* **user:** expose deployment organization capabilities on /users/me ([a27f7a6](https://github.com/nikunjmavani/core-be/commit/a27f7a6d9a1a03a75e6163ab061e137d8a65e1d8))
* **user:** expose personal_organization_id on /users/me ([b725aca](https://github.com/nikunjmavani/core-be/commit/b725acad609f8a9743f2a199c4234df423ade3a5))


### Fixed

* 8th-audit concurrency races + correctness hardening (C1-C5) ([bf077b7](https://github.com/nikunjmavani/core-be/commit/bf077b743cfbe51549c39ca4d4ae28b824a1a6df))
* **api:** truthful error envelope, id-only external fields, DELETE→204 stragglers, local oasdiff gate ([25b4629](https://github.com/nikunjmavani/core-be/commit/25b46297b331681b528962246f8bee28c4695204))
* **api:** truthful error envelope, id-only external fields, DELETE→204 stragglers, local oasdiff gate ([2777308](https://github.com/nikunjmavani/core-be/commit/2777308d77c2938b0f66437a24a02b9637392b19))
* **auth,openapi:** MFA-login org claim (H1) + captcha/bearerAuth OpenAPI accuracy ([909a5ce](https://github.com/nikunjmavani/core-be/commit/909a5ce448a362af445736e8a02cb2e18b7949b8))
* **auth,openapi:** mfa-login org claim (H1) plus captcha and bearerAuth openapi accuracy ([fc336b8](https://github.com/nikunjmavani/core-be/commit/fc336b867a9a597fb3c613aa0574a4b8e91bae60))
* **auth:** add user FK + index to mfa_methods to purge orphaned MFA secrets (reaudit-[#1](https://github.com/nikunjmavani/core-be/issues/1)) ([a5a0992](https://github.com/nikunjmavani/core-be/commit/a5a0992eb777f40851e2c97ac7c26ff371325c06))
* **auth:** atomic credential-mutation guards + lockout counter (route-audit C1, C5) ([e6e33db](https://github.com/nikunjmavani/core-be/commit/e6e33db37b405bf0c92622b3c152f35c88cbf186))
* **auth:** block revoking the current session via DELETE /me/sessions/:id (route-[#9](https://github.com/nikunjmavani/core-be/issues/9)) ([19f4bff](https://github.com/nikunjmavani/core-be/commit/19f4bff7ba7a651f630204a173f859dc40206d2b))
* **auth:** bounded refresh-token reuse grace for concurrent refreshes (audit-[#2](https://github.com/nikunjmavani/core-be/issues/2)) ([0cdd75d](https://github.com/nikunjmavani/core-be/commit/0cdd75dd8b85e880950b8a076fbadee39c01d18f))
* **auth:** close session-revoke cache repopulation race + normalize OAuth email (route-audit session-[#1](https://github.com/nikunjmavani/core-be/issues/1), oauth-[#3](https://github.com/nikunjmavani/core-be/issues/3)) ([b8303a0](https://github.com/nikunjmavani/core-be/commit/b8303a02e1e7010f9516e0e5c2df5b7777c83694))
* **auth:** close WebAuthn enumeration timing oracle + complete credential-mutation lock (route-audit D1, D2, D3) ([10e2b52](https://github.com/nikunjmavani/core-be/commit/10e2b5271c7cb454e15e99035389787e5c233c25))
* **auth:** drop SUPER_ADMIN for non-active accounts in per-request re-derive (reaudit-[#10](https://github.com/nikunjmavani/core-be/issues/10)) ([e54a97b](https://github.com/nikunjmavani/core-be/commit/e54a97bd1e643916ac3eb579eeda2dcdb1d26493))
* **auth:** floor login failure branches to mask enumeration timing (audit-[#15](https://github.com/nikunjmavani/core-be/issues/15)d) ([0c4af59](https://github.com/nikunjmavani/core-be/commit/0c4af594c6aba8d84d383d20c01838ef6d134bf0))
* **auth:** key DELETE /mfa/:mfaMethodId on public id, not the sequential DB id (route-[#10](https://github.com/nikunjmavani/core-be/issues/10)) ([31bdd46](https://github.com/nikunjmavani/core-be/commit/31bdd46de650dce63aa6bc542beda50d57c0dea2))
* **auth:** make magic-link verification atomic with first-factor completion (audit-[#12](https://github.com/nikunjmavani/core-be/issues/12)) ([4350845](https://github.com/nikunjmavani/core-be/commit/435084506afc855e48169b8e26b3d87a1690f36a))
* **auth:** make MFA verification lockout counter atomic (route-audit-[#4](https://github.com/nikunjmavani/core-be/issues/4)) ([7d98218](https://github.com/nikunjmavani/core-be/commit/7d982183877aeea6cbc4531cea9eb47376c704fc))
* **auth:** make one-time-token issuance atomic with the mail-outbox insert (audit-[#11](https://github.com/nikunjmavani/core-be/issues/11)) ([f122beb](https://github.com/nikunjmavani/core-be/commit/f122beb20866aaf4748b05d29d2307f9a0768462))
* **auth:** make password change and email verification atomic with their side effects (audit-[#4](https://github.com/nikunjmavani/core-be/issues/4), [#12](https://github.com/nikunjmavani/core-be/issues/12)) ([42d7893](https://github.com/nikunjmavani/core-be/commit/42d7893572ee6e89c5bbe42a08cc18d1f33aa6e6))
* **auth:** per-user MFA verification lockout (audit-[#12](https://github.com/nikunjmavani/core-be/issues/12)) ([d6331e0](https://github.com/nikunjmavani/core-be/commit/d6331e01f9a0d378096ecc26b30404f23fc20d7c))
* **auth:** persist and revalidate the active organization across refresh (audit-[#3](https://github.com/nikunjmavani/core-be/issues/3)) ([f9d8f1b](https://github.com/nikunjmavani/core-be/commit/f9d8f1b5a757c5b8dc5f267f4cf166f2e5677816))
* **auth:** re-derive any privileged JWT claim (admin + super_admin) against live state (route-[#6](https://github.com/nikunjmavani/core-be/issues/6)) ([956c43d](https://github.com/nikunjmavani/core-be/commit/956c43d855978ea9f49c573e4c8a498ae2c4309f))
* **auth:** restrict POST /me/auth-methods to MAGIC_LINK to stop phantom-credential lockout (route-[#3](https://github.com/nikunjmavani/core-be/issues/3)) ([ee9af9a](https://github.com/nikunjmavani/core-be/commit/ee9af9a5819990189c658a69d9396e0fdb3ed7c5))
* **auth:** scope MFA lockout to TOTP so recovery codes stay usable (reaudit-[#3](https://github.com/nikunjmavani/core-be/issues/3)) ([a6d4b05](https://github.com/nikunjmavani/core-be/commit/a6d4b05530cd06f563be8a0ede17552d6831f4ac))
* **auth:** session-revoke cache repopulation race + OAuth email normalization ([c981c7f](https://github.com/nikunjmavani/core-be/commit/c981c7f634a1090faae6513d62aa30206e5e1778))
* **auth:** switch-to-organization relies on route schema for body validation + suite green ([ab02f71](https://github.com/nikunjmavani/core-be/commit/ab02f711379690a987cf2cc7ab46139dc411adf8))
* **auth:** WebAuthn enumeration timing oracle + complete credential-mutation lock (D1/D2/D3) ([9a1f3f0](https://github.com/nikunjmavani/core-be/commit/9a1f3f0d5aef7156d4d455935f5295f20b76d257))
* backend production-readiness audit findings ([0f60e0f](https://github.com/nikunjmavani/core-be/commit/0f60e0f71d6dd0b1f7a5d9aa20bf60712c8a04cb))
* backend production-readiness re-audit findings ([6bd64bc](https://github.com/nikunjmavani/core-be/commit/6bd64bc3c47c7c28a1f1d42121867bc990f9c99c))
* **billing:** add per-route rate limit to subscription mutations (route-[#2](https://github.com/nikunjmavani/core-be/issues/2)) ([1e6975e](https://github.com/nikunjmavani/core-be/commit/1e6975e24271d14561f544981c651e254c3ef862))
* **billing:** alert on plan&lt;-&gt;Stripe price catalog drift (audit-[#13](https://github.com/nikunjmavani/core-be/issues/13)) ([3377510](https://github.com/nikunjmavani/core-be/commit/33775103b9ec7470270ff172b734b34586aebcb3))
* **billing:** cancel the org's active subscription on organization delete (route-audit-[#2](https://github.com/nikunjmavani/core-be/issues/2)) ([718c80f](https://github.com/nikunjmavani/core-be/commit/718c80f307ae14d9db2ff77dbd26ae591f667afc))
* **billing:** cancel() releases the slot for never-activated INCOMPLETE subscriptions (reaudit-[#6](https://github.com/nikunjmavani/core-be/issues/6)) ([3d6cfe0](https://github.com/nikunjmavani/core-be/commit/3d6cfe03758b1302a8d1e7f8612d4641d381c1e8))
* **billing:** enforce unique subscriptions.provider_subscription_id (audit-[#10](https://github.com/nikunjmavani/core-be/issues/10)) ([acf919b](https://github.com/nikunjmavani/core-be/commit/acf919b105cbc10c502b8b197f5af1bd8782646c))
* **billing:** hide inactive plans from public GET /billing/plans/:id (route-[#7](https://github.com/nikunjmavani/core-be/issues/7)) ([0be46ed](https://github.com/nikunjmavani/core-be/commit/0be46ed971f32287ba326cdbbbb94275ca7f9465))
* **billing:** make terminal subscriptions immutable (compare-and-set, B5/B6) ([5ac4328](https://github.com/nikunjmavani/core-be/commit/5ac43284d69e28101615d1a2f2caa306ab31cfe2))
* **billing:** make terminal subscriptions immutable via compare-and-set (route-audit B5, B6) ([18a3e43](https://github.com/nikunjmavani/core-be/commit/18a3e43540814b94e66ad085f40df767a32598e3))
* **billing:** persist a CANCELED tombstone for out-of-order Stripe deletions (audit-[#1](https://github.com/nikunjmavani/core-be/issues/1)) ([7862609](https://github.com/nikunjmavani/core-be/commit/7862609ed32b9c5c16d5780f4a6d7b59ba5066bb))
* **billing:** persist new Stripe subscriptions as INCOMPLETE not TRIALING (audit-[#2](https://github.com/nikunjmavani/core-be/issues/2)) ([b5a7f66](https://github.com/nikunjmavani/core-be/commit/b5a7f66537091e20632b3898364c7ac71e3f9f5f))
* **billing:** release subscription slot for INCOMPLETE_EXPIRED (audit-[#1](https://github.com/nikunjmavani/core-be/issues/1)) ([14cd328](https://github.com/nikunjmavani/core-be/commit/14cd3289545d1229e72b08e16977286cde39db18))
* **billing:** set concrete sunset for deprecated stripe webhook alias (audit-[#15](https://github.com/nikunjmavani/core-be/issues/15)a) ([4efb4a7](https://github.com/nikunjmavani/core-be/commit/4efb4a78e02af5da54c10fb04de02239120b1f79))
* block user delete when owning orgs + webhook updated_at flake ([08a5ac2](https://github.com/nikunjmavani/core-be/commit/08a5ac27734c2d3abb3604ab5e694abeb429d85e))
* **ci:** export GLOBAL_ADMIN_EMAILS in test-env so audit.test.ts super-admin paths work in Matrix Tests ([#532](https://github.com/nikunjmavani/core-be/issues/532)) ([873f59d](https://github.com/nikunjmavani/core-be/commit/873f59df59340bc182e3d8f261b5c2e435f89c63))
* **ci:** grant release-please job id-token + actions write permissions ([#536](https://github.com/nikunjmavani/core-be/issues/536)) ([b83eab2](https://github.com/nikunjmavani/core-be/commit/b83eab2d4ac3e2b46f5e77e00e34d720db6508e0))
* **config:** require legacy JWT gate closed once keyring configured in prod (audit-[#15](https://github.com/nikunjmavani/core-be/issues/15)b) ([43e5139](https://github.com/nikunjmavani/core-be/commit/43e5139de2e4b9f7e969b9832e8ffac1a0c32b89))
* **database:** keyset-page batch delete so FK-blocked rows can't infinite-loop retention ([fd9b523](https://github.com/nikunjmavani/core-be/commit/fd9b523ecaf1825d111a636d6cad954ecba6e83a))
* **database:** keyset-page batch delete so FK-blocked rows can't infinite-loop retention (route-audit A1) ([f81ca72](https://github.com/nikunjmavani/core-be/commit/f81ca724b6e5d25c158e02403ee39d7132c8c8f2))
* **db:** enforce RLS deny-all on billing.plans and tenancy.permissions (reaudit-[#9](https://github.com/nikunjmavani/core-be/issues/9)) ([2bb9476](https://github.com/nikunjmavani/core-be/commit/2bb947621fafabfd2ec03ca2d2fc9f905970c838))
* **deps:** bump esbuild override to &gt;=0.28.1 (GHSA-gv7w-rqvm-qjhr / GHSA-g7r4-m6w7-qqqr) ([514fa96](https://github.com/nikunjmavani/core-be/commit/514fa961bd392ef4583c7e148a7f47277ef23dae))
* **deps:** override @grpc/grpc-js to &gt;=1.14.4 (GHSA-5375-pq7m-f5r2) ([0a66557](https://github.com/nikunjmavani/core-be/commit/0a6655731c02a3efa03ca598c306fce4d34012c7))
* **docker:** add HEALTHCHECK to worker image (audit-[#15](https://github.com/nikunjmavani/core-be/issues/15)c) ([b4f7a67](https://github.com/nikunjmavani/core-be/commit/b4f7a67cc2072c9510f63906b2b1ec50ae114f92))
* **docker:** refresh apk index so base-image security patches install ([#607](https://github.com/nikunjmavani/core-be/issues/607)) ([a3690b9](https://github.com/nikunjmavani/core-be/commit/a3690b91f2f61f48f837553c74890e5d358fbec3))
* **docker:** worker HEALTHCHECK honors WORKER_HEALTH_PORT at runtime (reaudit-[#8](https://github.com/nikunjmavani/core-be/issues/8)) ([3530bff](https://github.com/nikunjmavani/core-be/commit/3530bff1c5cb6a65e21cc0f507018211150236a3))
* **mail:** scrub secret-bearing body on terminally-failed outbox rows (audit-[#10](https://github.com/nikunjmavani/core-be/issues/10)) ([61dc948](https://github.com/nikunjmavani/core-be/commit/61dc948505b0eb6e4e7c60020d66a7c3663452bb))
* **mcp:** strip X-Organization-Id from call_api proxied sub-requests (route-[#8](https://github.com/nikunjmavani/core-be/issues/8)) ([d5a7167](https://github.com/nikunjmavani/core-be/commit/d5a716716e8acff86e1523641e3f44620374411c))
* **notify:** cap webhook response body bytes read before truncation (audit-[#6](https://github.com/nikunjmavani/core-be/issues/6)) ([0f2421e](https://github.com/nikunjmavani/core-be/commit/0f2421e3b6b211f888f08a0161274063d7599cc1))
* **notify:** durability-first notification email dedup to stop lost emails (audit-[#7](https://github.com/nikunjmavani/core-be/issues/7)) ([b9d9759](https://github.com/nikunjmavani/core-be/commit/b9d9759885b92320210d681520ecc16236d70d2c))
* **notify:** durable mail-outbox dedupe key to close concurrent duplicate-email window (reaudit-[#4](https://github.com/nikunjmavani/core-be/issues/4)) ([47cd280](https://github.com/nikunjmavani/core-be/commit/47cd280504c9acdf324b2ff11ff4ca36ded05a1c))
* **notify:** enforce webhook secret-rotation eligibility in the update predicate (audit-[#9](https://github.com/nikunjmavani/core-be/issues/9)) ([d3337e0](https://github.com/nikunjmavani/core-be/commit/d3337e0c3ad3e314206cce494c23e6b644c90d03))
* **notify:** guard webhook secret re-rotation within the dual-sign overlap window ([0cfedd0](https://github.com/nikunjmavani/core-be/commit/0cfedd0d28177f40f354133a3d1f53b94002e955))
* **notify:** guard webhook secret re-rotation within the dual-sign overlap window (route-audit webhook-[#1](https://github.com/nikunjmavani/core-be/issues/1)) ([5c16f85](https://github.com/nikunjmavani/core-be/commit/5c16f8548c7c528944d937c60fe985ee887e8174))
* **notify:** route webhook handlers through zodApplication type provider ([eaa5684](https://github.com/nikunjmavani/core-be/commit/eaa5684c13253e6f5c7204a7dc8b479e4c9c5465))
* **notify:** stamp webhook updated_at as greatest(created_at, now()) to fix chk_webhooks_updated flake ([988d87b](https://github.com/nikunjmavani/core-be/commit/988d87baf86a74ebb05ba9d81948e205ffcda2e3))
* **observability:** monitor every retention worker DLQ + add drift guard (reaudit-[#5](https://github.com/nikunjmavani/core-be/issues/5)) ([0e954dc](https://github.com/nikunjmavani/core-be/commit/0e954dcfe96a4c2d46c48815e963632468243236))
* **openapi:** registry-authoritative success statuses; deterministic OAuth coverage; scan cleanups ([a7cc7bd](https://github.com/nikunjmavani/core-be/commit/a7cc7bdeb47f4d9d5f5a18465470d8a9b2b86c67))
* **openapi:** registry-authoritative success statuses; deterministic OAuth coverage; scan cleanups ([1f84793](https://github.com/nikunjmavani/core-be/commit/1f84793ff6f149d7a759ac0223fb45a5d28d1942))
* **ops:** log circuit-breaker resets for attribution (route-[#5](https://github.com/nikunjmavani/core-be/issues/5)) ([eae48fe](https://github.com/nikunjmavani/core-be/commit/eae48fe4e9c937f7ca65d219acacb55832a1b218))
* **queue:** acknowledge commit-dispatch tasks after execution, not before (reaudit-[#2](https://github.com/nikunjmavani/core-be/issues/2)) ([8f399c0](https://github.com/nikunjmavani/core-be/commit/8f399c0ddaed24901f6c92445091770286c7a852))
* **queue:** bound commandTimeout on BullMQ producer connections (audit-[#5](https://github.com/nikunjmavani/core-be/issues/5)) ([2c4e21b](https://github.com/nikunjmavani/core-be/commit/2c4e21bf12dedc6039a0f0085379e80e8a83fee2))
* **queue:** monitor the offboarding-reconciler DLQ + exempt it from tenant-scoping policy (audit-[#15](https://github.com/nikunjmavani/core-be/issues/15)) ([f5f4ceb](https://github.com/nikunjmavani/core-be/commit/f5f4cebfbf7cc99072c06c0b7588d7c3eb4289fc))
* **rate-limit,observability:** scope org rate-limit + error context by the org claim ([5e12926](https://github.com/nikunjmavani/core-be/commit/5e12926e869e17a3bd66e71a3d7ec87b98119132))
* **rate-limit,observability:** scope org rate-limit + error context by the org token claim ([b2caeb1](https://github.com/nikunjmavani/core-be/commit/b2caeb1be96e8fde9631028c4b92e047b14d433d))
* route-audit state-machine, billing, and cache-header findings ([d4b34ef](https://github.com/nikunjmavani/core-be/commit/d4b34ef388184860aece138aa10716b226562158))
* route-focused security audit findings ([1fffbf0](https://github.com/nikunjmavani/core-be/commit/1fffbf0270b20b7fdbeef5d0f3d86528e4fb11a5))
* **runtime:** real-world deep-flow inspection findings — 3 fixes + regression test ([#533](https://github.com/nikunjmavani/core-be/issues/533)) ([5a85ecd](https://github.com/nikunjmavani/core-be/commit/5a85ecd7d19303cb45231ec2d73082dfd6d4e631))
* **security:** fail closed on privileged re-derivation + bound all retention settings (audit-[#16](https://github.com/nikunjmavani/core-be/issues/16), [#14](https://github.com/nikunjmavani/core-be/issues/14)) ([65a4347](https://github.com/nikunjmavani/core-be/commit/65a4347972c7d029600559f69a080fc611bc555d))
* **security:** mark recovery-codes + presigned-URL responses no-store / non-cacheable (route-audit-[#3](https://github.com/nikunjmavani/core-be/issues/3)) ([bc67eed](https://github.com/nikunjmavani/core-be/commit/bc67eed1cc521709b36e4eca38289310276ff922))
* **security:** remediate all 16 findings from the 2026-06-14 dev security audit ([01a22aa](https://github.com/nikunjmavani/core-be/commit/01a22aa5f83fbd1f784039a98b5ac4eda151efdb))
* **security:** remediate all 16 findings from the 2026-06-14 dev security audit ([#600](https://github.com/nikunjmavani/core-be/issues/600)) ([01a22aa](https://github.com/nikunjmavani/core-be/commit/01a22aa5f83fbd1f784039a98b5ac4eda151efdb))
* **security:** strip Stripe-shaped literals from source + add regression test (GH secret-scanning) ([#529](https://github.com/nikunjmavani/core-be/issues/529)) ([f234e60](https://github.com/nikunjmavani/core-be/commit/f234e6044879c72385e3b61728ea4ba665931ae6))
* **security:** untrack agent-os/mcp/mcp.json and repair stale ai/ paths ([#560](https://github.com/nikunjmavani/core-be/issues/560)) ([b3547a4](https://github.com/nikunjmavani/core-be/commit/b3547a43172e2388c0a1a2e4fa8e0388d046b4c6))
* **storage:** distinguish S3 not-found from transient failure (audit-[#5](https://github.com/nikunjmavani/core-be/issues/5)) ([5ba8d00](https://github.com/nikunjmavani/core-be/commit/5ba8d002a05a423b8a2e8b99e4f23c29a1d79e51))
* **storage:** serve public media via a distribution and refuse public URLs for private keys (audit-[#13](https://github.com/nikunjmavani/core-be/issues/13)) ([cc10be0](https://github.com/nikunjmavani/core-be/commit/cc10be00c43a9891bff17bfc097f9ba50c5a165d))
* **tenancy,notify:** atomic role-delete, webhook clock-skew, security_policy proto guard (route-audit C2, C3, C4) ([ddf4f35](https://github.com/nikunjmavani/core-be/commit/ddf4f35762595f2318930855bf1bfccaba3a30ed))
* **tenancy,notify:** make per-scope resource caps atomic with an advisory lock (audit-[#8](https://github.com/nikunjmavani/core-be/issues/8)) ([3681133](https://github.com/nikunjmavani/core-be/commit/3681133339f47f68570aaf54f773ae8c5964238b))
* **tenancy,security:** post-flatten audit corrections — idempotency claim scope + personal-org guards ([e105372](https://github.com/nikunjmavani/core-be/commit/e10537260c541131a4386bb37570653242fcc41b))
* **tenancy,security:** post-flatten audit corrections — idempotency claim scope, personal-org guards, dead-code cleanup ([018fb31](https://github.com/nikunjmavani/core-be/commit/018fb313308ea78843d22df4dd234dc41dea1190))
* **tenancy:** only activate INVITED memberships on invitation accept (route-audit-[#1](https://github.com/nikunjmavani/core-be/issues/1)) ([aeea26a](https://github.com/nikunjmavani/core-be/commit/aeea26af9f5346fdbf4c7dd38745de90d8951b14))
* **tenancy:** reject prototype-pollution keys in organization security_policy (route-audit hardening) ([b1eba43](https://github.com/nikunjmavani/core-be/commit/b1eba43d872fe1ff7e018edd45eb42c10f67fa3f))
* **tenancy:** revoke a removed member's API keys on membership removal (reaudit-[#7](https://github.com/nikunjmavani/core-be/issues/7)) ([1387bd3](https://github.com/nikunjmavani/core-be/commit/1387bd306046d439b5f52840e4b45ae0f0794037))
* **tenancy:** scale permission-cache stampede poll budget to lock TTL (audit-[#9](https://github.com/nikunjmavani/core-be/issues/9)) ([5322d0f](https://github.com/nikunjmavani/core-be/commit/5322d0fae4dc9043f3563eda431d880ccab74f97))
* **tenancy:** throttle api-key last_used_at writes (audit-[#8](https://github.com/nikunjmavani/core-be/issues/8)) ([96b3e56](https://github.com/nikunjmavani/core-be/commit/96b3e562e136892ff44e5adf2f06009bdcce5a06))
* **tests:** cleanupDatabase preserves schema_migrations; update tests inherited from main's B4 + sec-r4-A1 semantics ([#525](https://github.com/nikunjmavani/core-be/issues/525)) ([169327e](https://github.com/nikunjmavani/core-be/commit/169327ec7652cefd7301b8d0c1c47009caa9ae5e))
* **upload:** lock the organization pending-upload quota at the org scope (audit-[#7](https://github.com/nikunjmavani/core-be/issues/7)) ([171a0fc](https://github.com/nikunjmavani/core-be/commit/171a0fc4c618c93c4bc74aafe0c3ec45f6376b74))
* **upload:** reclaim orphaned avatar/logo objects + owner-binding + purpose/target check (L1/L2/L3) ([7ffef76](https://github.com/nikunjmavani/core-be/commit/7ffef768a889cab424139e42cab34e7f055f6bb9))
* **upload:** reclaim orphaned avatar/logo objects, wire owner-binding gate, validate purpose-target (route-audit L1, L2, L3) ([d9d9738](https://github.com/nikunjmavani/core-be/commit/d9d97381082b330d32843511d29e8823fde2cb56))
* **user:** block admin suspend/delete of protected super-admins (route-[#1](https://github.com/nikunjmavani/core-be/issues/1)) ([b84259d](https://github.com/nikunjmavani/core-be/commit/b84259d3f6cbb34ffb2f8617e900aa0157fc5fae))
* **user:** block deleting a user who still owns organizations (route-audit-[#2](https://github.com/nikunjmavani/core-be/issues/2) follow-up) ([f94b7c9](https://github.com/nikunjmavani/core-be/commit/f94b7c9c0c95d1525ea31fe41e44970efe452f19))
* **user:** rate-limit admin user-management mutations (route-[#4](https://github.com/nikunjmavani/core-be/issues/4)) ([a0d8114](https://github.com/nikunjmavani/core-be/commit/a0d8114b28fc1730fbc982271018d64700569537))
* **user:** unique notification-preference natural key + input dedupe (audit-[#11](https://github.com/nikunjmavani/core-be/issues/11)) ([6805459](https://github.com/nikunjmavani/core-be/commit/68054599b5fb2a120c6fb8571f23a76dc9277e7a))


### Changed

* **api:** semantic snake_case params, prefixed public ids, uniform status policy, documented headers ([03820fb](https://github.com/nikunjmavani/core-be/commit/03820fb407116e2532f2afdf12133861b8c58497))
* **api:** semantic snake_case route params, prefixed public ids, uniform method-status policy, documented headers ([3311bc0](https://github.com/nikunjmavani/core-be/commit/3311bc022f65fcbd517802cc91dcb194d5a31c0c))
* **architecture:** move raw SQL out of stripe-webhook-organization.util into the repository (+ global gate) ([#530](https://github.com/nikunjmavani/core-be/issues/530)) ([f48fb46](https://github.com/nikunjmavani/core-be/commit/f48fb46fe1005a95adc0abf14222df8f86c030f9))
* enforce architecture boundaries (DB-in-services, DI, controller thinness) ([#602](https://github.com/nikunjmavani/core-be/issues/602)) ([cc43b3b](https://github.com/nikunjmavani/core-be/commit/cc43b3b3f38cd94d190928ac6728f1077195bbbf))
* **tenancy:** route org-scoped controllers through claim-aware org accessor ([f4c3b54](https://github.com/nikunjmavani/core-be/commit/f4c3b54f70b5c9c49c2a03cf908f1407810138a8))
* **tenancy:** route org-scoped controllers through claim-aware org accessor ([af30b20](https://github.com/nikunjmavani/core-be/commit/af30b20e50b8c49f3c906bbbb1ca6d4093fd14ef))


### Documentation

* **api:** add frontend auth & headers integration guide ([b8ca013](https://github.com/nikunjmavani/core-be/commit/b8ca01362c4a04aa8d65e511cac136a0953b2445))
* **api:** add frontend auth & headers integration guide ([ab201e8](https://github.com/nikunjmavani/core-be/commit/ab201e8046a524ad2f5dd9868e22897d77aaf2a9))
* check in sync; enricher unit tests + full suite (4,516) green. ([c58d39b](https://github.com/nikunjmavani/core-be/commit/c58d39b0aa550158d3106a41fadd403c203eb4c5))
* check verified green on 0.28.1. ([514fa96](https://github.com/nikunjmavani/core-be/commit/514fa961bd392ef4583c7e148a7f47277ef23dae))
* check, tsdoc 0/0, migrate lint, env sync, validate all pass. ([3311bc0](https://github.com/nikunjmavani/core-be/commit/3311bc022f65fcbd517802cc91dcb194d5a31c0c))
* consolidate setup guide into single root SETUP.md ([#555](https://github.com/nikunjmavani/core-be/issues/555)) ([5c311a3](https://github.com/nikunjmavani/core-be/commit/5c311a3c72f1fb33cb44daa087e94ee19e2edb1c))
* **env:** standardize OPTIONAL marker for conditionally-empty env keys ([#549](https://github.com/nikunjmavani/core-be/issues/549)) ([d7155b4](https://github.com/nikunjmavani/core-be/commit/d7155b48786aee7a8ce2e306133b61398f00cf20))
* **openapi:** drop "Public ID" from request-body/query field descriptions → "id" ([3cb01a0](https://github.com/nikunjmavani/core-be/commit/3cb01a0b294a1a47a80a25a209ab410403e38117))
* **openapi:** drop "Public ID" from request-body/query field descriptions → "id" ([c58d39b](https://github.com/nikunjmavani/core-be/commit/c58d39b0aa550158d3106a41fadd403c203eb4c5))
* **reviews:** add agent-os AI-tooling audit + evals session writeup ([ef55c53](https://github.com/nikunjmavani/core-be/commit/ef55c536b406a3b1aea5df055c844bd4159c7a78))
* **reviews:** agent-os AI-tooling audit + evals/enforcement session writeup ([32288fa](https://github.com/nikunjmavani/core-be/commit/32288fa07f7e0b3caa92b5325ec51938b95be557))
* **reviews:** architecture conformance audit + 8-PR follow-up plan ([#531](https://github.com/nikunjmavani/core-be/issues/531)) ([4a9264c](https://github.com/nikunjmavani/core-be/commit/4a9264cb674f57930241a8b348d12afdcc727476))
* **reviews:** correct sec-r4-A3 analysis and defer to follow-up task ([#523](https://github.com/nikunjmavani/core-be/issues/523)) ([c7e1dab](https://github.com/nikunjmavani/core-be/commit/c7e1dab9433b40eb16a7df6e28fdf317df9318b7))
* **reviews:** route-coverage audit — 129 routes, 9 deferred gaps allowlisted ([#534](https://github.com/nikunjmavani/core-be/issues/534)) ([d18ec1d](https://github.com/nikunjmavani/core-be/commit/d18ec1df87b78237c77bac6f84b1ec464ff71965))

## [4.5.7-dev.0](https://github.com/nikunjmavani/core-be/compare/v4.5.6-dev.0...v4.5.7-dev.0) (2026-06-08)


### Documentation

* **infra:** annotate Dockerfile build-stage ENV as test-only placeholders (sec-r4-C6) ([#519](https://github.com/nikunjmavani/core-be/issues/519)) ([cdf76ef](https://github.com/nikunjmavani/core-be/commit/cdf76ef7e6a85de7e638c161d1e7ad34dd12e38a))

## [4.5.6-dev.0](https://github.com/nikunjmavani/core-be/compare/v4.5.5-dev.0...v4.5.6-dev.0) (2026-06-08)


### Fixed

* **notify:** trim payload and response_body from webhook delivery list (sec-r4-D6) ([#518](https://github.com/nikunjmavani/core-be/issues/518)) ([89c24b7](https://github.com/nikunjmavani/core-be/commit/89c24b7f05dba72eba97447f746abb08130c61f6))

## [4.5.5-dev.0](https://github.com/nikunjmavani/core-be/compare/v4.5.4-dev.0...v4.5.5-dev.0) (2026-06-08)


### Fixed

* **upload:** add DTO-level fileSize ceiling (sec-r4-I4) ([#515](https://github.com/nikunjmavani/core-be/issues/515)) ([049f917](https://github.com/nikunjmavani/core-be/commit/049f917c71b8c043e39bbbcd40f93eec534994fc))

## [4.5.4-dev.0](https://github.com/nikunjmavani/core-be/compare/v4.5.3-dev.0...v4.5.4-dev.0) (2026-06-08)


### Fixed

* **audit:** omit soft-deleted orgs from audit-log public id resolution (sec-r4-D2) ([#506](https://github.com/nikunjmavani/core-be/issues/506)) ([e76a015](https://github.com/nikunjmavani/core-be/commit/e76a01530ed22da2e35d21f0080547075d0475d8))
* **auth-webauthn:** require user verification at options time (sec-r4-A2) ([#514](https://github.com/nikunjmavani/core-be/issues/514)) ([38f60cf](https://github.com/nikunjmavani/core-be/commit/38f60cf8443a94ff327e95e6bad5d03d7bdf6947))
* **auth:** sec-new-A2 reject suspended/deleted users on bearer auth cache miss ([#474](https://github.com/nikunjmavani/core-be/issues/474)) ([eff74f4](https://github.com/nikunjmavani/core-be/commit/eff74f453a57f071258b8275aa850d375e6a67cc))
* **auth:** sec-new-A3 preserve caller session on DELETE /me/sessions ([#478](https://github.com/nikunjmavani/core-be/issues/478)) ([32936f3](https://github.com/nikunjmavani/core-be/commit/32936f3625022fcb98a3b2f681b6d19ee86a7611))
* **auth:** sec-new-A4 flip is_mfa_enabled inside deleteMfa transaction ([#479](https://github.com/nikunjmavani/core-be/issues/479)) ([a50d899](https://github.com/nikunjmavani/core-be/commit/a50d8995f7c42b08643d6a503b70971d24cbf6e9))
* **billing:** bound PlanRepository.findAllActive at 100 rows (sec-r4-D3) ([#507](https://github.com/nikunjmavani/core-be/issues/507)) ([43180a9](https://github.com/nikunjmavani/core-be/commit/43180a98e2b62abdc0584460d06d455a55701900))
* **billing:** remove redundant parseBullMQJobData from stripe-webhook processor (sec-r4-Q1) ([#502](https://github.com/nikunjmavani/core-be/issues/502)) ([d20c731](https://github.com/nikunjmavani/core-be/commit/d20c731dbaf5764fcb0ebf96376830c882991205))
* **billing:** sec-new-B1 guard cancel/resume/changePlan against terminal subscriptions ([#475](https://github.com/nikunjmavani/core-be/issues/475)) ([86bb32f](https://github.com/nikunjmavani/core-be/commit/86bb32f6de0ed2c3e293f2a17f979b9cfbfc3328))
* **billing:** sec-new-D1-D2 data integrity guards in billing writes ([#476](https://github.com/nikunjmavani/core-be/issues/476)) ([def085a](https://github.com/nikunjmavani/core-be/commit/def085adf233218dac8c01dad35e2efde385313b))
* **billing:** sec-new-M2 emit Deprecation+Sunset headers on deprecated /stripe/webhook alias ([#489](https://github.com/nikunjmavani/core-be/issues/489)) ([d95f4aa](https://github.com/nikunjmavani/core-be/commit/d95f4aa8becdae0454be1d727a09c1580fb1ff4d))
* **billing:** support comma-separated STRIPE_WEBHOOK_SECRET for zero-downtime rotation (sec-new-B3) ([#490](https://github.com/nikunjmavani/core-be/issues/490)) ([4be65fe](https://github.com/nikunjmavani/core-be/commit/4be65fe218a948b63f9386a09a934aa4cb4d42e5))
* **config:** cap AUTH_SESSION_MAX_AGE_DAYS at 365 (sec-r4-C4) ([#510](https://github.com/nikunjmavani/core-be/issues/510)) ([2a48a88](https://github.com/nikunjmavani/core-be/commit/2a48a88355744445298e8fb36dda0c22fca0b472))
* **database:** sec-new-Q4 apply worker statement timeout in system-table retention context ([#487](https://github.com/nikunjmavani/core-be/issues/487)) ([4e0b5c2](https://github.com/nikunjmavani/core-be/commit/4e0b5c2156544d72b9dbf51b4a3c07b77930492a))
* **infra:** use correct JWT env keys in docker-compose smoke profile (sec-r4-C5) ([#512](https://github.com/nikunjmavani/core-be/issues/512)) ([c9a48f1](https://github.com/nikunjmavani/core-be/commit/c9a48f107f0f89fe41814c253e4d3defc0595437))
* **notify:** sec-new-B2 replace bigserial with public_id in X-Webhook-Delivery-Id header ([#494](https://github.com/nikunjmavani/core-be/issues/494)) ([771954a](https://github.com/nikunjmavani/core-be/commit/771954a360383fcb797e38a6ea55b07d2055790c))
* **notify:** sec-new-D4 add status=PENDING filter to fallback SELECT in webhook delivery ([#488](https://github.com/nikunjmavani/core-be/issues/488)) ([164c6f8](https://github.com/nikunjmavani/core-be/commit/164c6f8a0bebbc89f0bb47d0b432e0db0bf453d7))
* **notify:** sec-new-N1 validate webhookId path param in all webhook handlers ([#482](https://github.com/nikunjmavani/core-be/issues/482)) ([d66099e](https://github.com/nikunjmavani/core-be/commit/d66099e00764f935260de97560e60529d61d5e53))
* **queue:** sec-new-Q1 add env overrides for hardcoded cron schedules ([#484](https://github.com/nikunjmavani/core-be/issues/484)) ([d2d03e1](https://github.com/nikunjmavani/core-be/commit/d2d03e1c6a41861a22965a0c57707b8157ce66da))
* **queue:** sec-new-Q2 capture per-task failures in Sentry in recovery processor ([#485](https://github.com/nikunjmavani/core-be/issues/485)) ([b66a7a6](https://github.com/nikunjmavani/core-be/commit/b66a7a68ed27dc357b83b010e4778991fb198242))
* **sec:** account-deletion safety — invalidate verification tokens + revoke-before-purge (sec-U1+U8) ([#404](https://github.com/nikunjmavani/core-be/issues/404)) ([43a1e5a](https://github.com/nikunjmavani/core-be/commit/43a1e5aedc49cd19f2e082febeb9b247a6bea3cf))
* **sec:** add captchaPreHandler to POST /mfa/login (sec-new-A1) ([85d2a89](https://github.com/nikunjmavani/core-be/commit/85d2a892decb1cf9e882922188633de6ffdea5c0))
* **sec:** add captchaPreHandler to POST /mfa/login (sec-new-A1) ([f2c02db](https://github.com/nikunjmavani/core-be/commit/f2c02db0212721ec29b99633f455f36f8e9f23c9))
* **sec:** add closeUserDataExportQueue to worker shutdown sequence (sec-r4-R1) ([#501](https://github.com/nikunjmavani/core-be/issues/501)) ([6e8e96f](https://github.com/nikunjmavani/core-be/commit/6e8e96ff11af4819d22cfb34df5b27f125518cbd))
* **sec:** add deleted_at guards to org-discovery RLS and invitation lookup (sec-r4-T1/T2) ([#500](https://github.com/nikunjmavani/core-be/issues/500)) ([b4ea6ee](https://github.com/nikunjmavani/core-be/commit/b4ea6ee0969cd5ff8da76b7abb68823e711d5939))
* **sec:** add partial index for audit.logs.actor_api_key_id (sec-D8) ([#432](https://github.com/nikunjmavani/core-be/issues/432)) ([761f28b](https://github.com/nikunjmavani/core-be/commit/761f28b96207265002e24ad2f263da00ff97eb99))
* **sec:** audit append-only DB invariant — split tenant-isolation policy + REVOKE UPDATE (sec-U3) ([#409](https://github.com/nikunjmavani/core-be/issues/409)) ([7991dfc](https://github.com/nikunjmavani/core-be/commit/7991dfc486ed22eff946b346982285c1f87fee65))
* **sec:** audit every data-export URL mint, rate-limit GET, drop TTL 24h→15min (sec-U6) ([#429](https://github.com/nikunjmavani/core-be/issues/429)) ([4943057](https://github.com/nikunjmavani/core-be/commit/4943057037519b0c294e4e46405d202008083973))
* **sec:** audit every login surface, not just password (sec-A8) ([#427](https://github.com/nikunjmavani/core-be/issues/427)) ([9872491](https://github.com/nikunjmavani/core-be/commit/9872491ad9ee8271d3a063738dd3b1423013095c))
* **sec:** audit hygiene — denylist metadata strip + admin user-mgmt audit + admin audit-read audit + permission-deny audit (sec-U2+U9+U4+U13) ([#408](https://github.com/nikunjmavani/core-be/issues/408)) ([98e60ff](https://github.com/nikunjmavani/core-be/commit/98e60ff889e7c94d716aaf235c0b782d05bd4a8f))
* **sec:** audit login failures alongside successes on every login surface (sec-A8 follow-up) ([#438](https://github.com/nikunjmavani/core-be/issues/438)) ([e4a9c2f](https://github.com/nikunjmavani/core-be/commit/e4a9c2f88925653cf12910efbb6258ba2c7c1d73))
* **sec:** audit serializer is strip-only with resolved public ids (sec-re-08) ([#458](https://github.com/nikunjmavani/core-be/issues/458)) ([5a07fdb](https://github.com/nikunjmavani/core-be/commit/5a07fdb15f4706478587523c96f090a92a8a3ce1))
* **sec:** auth defense in depth — last login-method guard + super-admin rederive + step-up on session revoke (sec-A5+A6+A7) ([#407](https://github.com/nikunjmavani/core-be/issues/407)) ([021c4b3](https://github.com/nikunjmavani/core-be/commit/021c4b31ce8d3c619f48ebcf43e4393ad2cf9b3d))
* **sec:** bind audit-list pagination cursor to its minting filter set (sec-U12) ([#434](https://github.com/nikunjmavani/core-be/issues/434)) ([f6a40e2](https://github.com/nikunjmavani/core-be/commit/f6a40e2db1fc34916c236f5fc3a478d5d09020df))
* **sec:** block update() on org-owner membership to prevent Admin lockout (sec-new-T1) ([dfa526a](https://github.com/nikunjmavani/core-be/commit/dfa526a03dafa3ddae99029e34651aeffa979d51))
* **sec:** block update() on org-owner membership to prevent Admin lockout (sec-new-T1) ([c3c6cfe](https://github.com/nikunjmavani/core-be/commit/c3c6cfe24145ab0cc3e63fe8a8d3d1a20d5a7642))
* **sec:** breach compression-skip actually engages in production (sec-re-03) ([#454](https://github.com/nikunjmavani/core-be/issues/454)) ([5039ccd](https://github.com/nikunjmavani/core-be/commit/5039ccd0699dac287c89a94b85e9c6a4f630c25e))
* **sec:** build Stripe customer email from a platform-owned domain, not tenant slug (sec-B11) ([#436](https://github.com/nikunjmavani/core-be/issues/436)) ([8bb5338](https://github.com/nikunjmavani/core-be/commit/8bb533845fcf074150dc3796e2038dcab01df372))
* **sec:** cache the i18n preHandler organization → locale lookup (sec-M1) ([#440](https://github.com/nikunjmavani/core-be/issues/440)) ([180937a](https://github.com/nikunjmavani/core-be/commit/180937a42a83ec058d0e66823c534db54270cf73))
* **sec:** collapse unmatched-route Prometheus label into __unmatched__ sentinel (sec-C2) ([#401](https://github.com/nikunjmavani/core-be/issues/401)) ([5fc8743](https://github.com/nikunjmavani/core-be/commit/5fc87432500a76271dc867df7b68851e5e68ed74))
* **sec:** config + middleware hardening (sec-cm batch) ([#449](https://github.com/nikunjmavani/core-be/issues/449)) ([b150253](https://github.com/nikunjmavani/core-be/commit/b15025363ad4af584a93572f1a0afb5dc76f1e4f))
* **sec:** config cleanup — drop JWT_SECRET + add deps:audit:prod to ci:local + ENABLE_RESPONSE_ENCRYPTION pairing refine (sec-C5+C10+C11) ([#419](https://github.com/nikunjmavani/core-be/issues/419)) ([7cab170](https://github.com/nikunjmavani/core-be/commit/7cab17038463c7a568e36c48f4c10acc0e6235f3))
* **sec:** cors exposes x-client-request-id (sec-re-17) ([#467](https://github.com/nikunjmavani/core-be/issues/467)) ([8960cfc](https://github.com/nikunjmavani/core-be/commit/8960cfcc13b33e6abb222631ff5de62f3b1d9a7b))
* **sec:** data-export request route advertises 15-minute URL lifetime (sec-re-12) ([#462](https://github.com/nikunjmavani/core-be/issues/462)) ([bc7cea3](https://github.com/nikunjmavani/core-be/commit/bc7cea3c096583e338e25edca4d58d59616718c4))
* **sec:** db retention growth — verification token sweep + AUDIT_RETENTION_DAYS cap (sec-D5+U10) ([#415](https://github.com/nikunjmavani/core-be/issues/415)) ([ab9428b](https://github.com/nikunjmavani/core-be/commit/ab9428b5a5cd93a24ce283f8598dd318e0e0ef03))
* **sec:** db stability — drop volatile chk_org_notif_muted + worker statement_timeout + audit.logs target_user_id index (sec-D1+D2+D3) ([#414](https://github.com/nikunjmavani/core-be/issues/414)) ([f77ce4a](https://github.com/nikunjmavani/core-be/commit/f77ce4aee1366eaa1ff82da6575b5011dd382ca5))
* **sec:** delete dead findActiveByUserId / findActiveByOrganizationId (sec-D12) ([#437](https://github.com/nikunjmavani/core-be/issues/437)) ([6367dd4](https://github.com/nikunjmavani/core-be/commit/6367dd45ca44614f1e0a2d10fd2dfdf0df9f390e))
* **sec:** derive invitation email from membership user on create (sec-T1 complete) ([#471](https://github.com/nikunjmavani/core-be/issues/471)) ([6d54c99](https://github.com/nikunjmavani/core-be/commit/6d54c99a15cd6c1dc48ec3b1c6357c540db4bf29))
* **sec:** dlq replay no-op + commit-dispatch cleanup + worker hardening (sec-q batch) ([#444](https://github.com/nikunjmavani/core-be/issues/444)) ([6c96a0b](https://github.com/nikunjmavani/core-be/commit/6c96a0bb1c47d016d87735cbe16ee173e7de19c4))
* **sec:** do not clear session cookie in revokeAllSessions handler (sec-r4-A1) ([#499](https://github.com/nikunjmavani/core-be/issues/499)) ([b7e3952](https://github.com/nikunjmavani/core-be/commit/b7e395262f8ec06a84a5426b9c4a9dafa85ec351))
* **sec:** docker.agent USER node + drop openssh + enforce abort timeout on retrieveStripeEvent (sec-C8 + sec-Q5 partial) ([#422](https://github.com/nikunjmavani/core-be/issues/422)) ([d10af52](https://github.com/nikunjmavani/core-be/commit/d10af524ec39a00994b041f7727d18cc6e81639b))
* **sec:** document the online-safe ALTER COLUMN pattern (sec-D6) ([#443](https://github.com/nikunjmavani/core-be/issues/443)) ([c72deb4](https://github.com/nikunjmavani/core-be/commit/c72deb4e3f9b7cdaba267b14948fd73025dce3e3))
* **sec:** document verification_tokens application-trust safety model (sec-D9) ([#441](https://github.com/nikunjmavani/core-be/issues/441)) ([e069891](https://github.com/nikunjmavani/core-be/commit/e069891909cd0487a4cd5ab523930f8b0d6e105d))
* **sec:** drop org branch from user_notification_preferences RLS + add CHECK pin (sec-U7) ([#428](https://github.com/nikunjmavani/core-be/issues/428)) ([13fc188](https://github.com/nikunjmavani/core-be/commit/13fc188e22603b55f3226994399e5564e50f5843))
* **sec:** enforce SSE-S3 on every server-side S3 write (sec-U11) ([#435](https://github.com/nikunjmavani/core-be/issues/435)) ([0792d76](https://github.com/nikunjmavani/core-be/commit/0792d76c07ece878f8adc1f282f1966efbe54ae7))
* **sec:** expose policy public_id instead of bigserial in URLs and responses (sec-T5) ([#442](https://github.com/nikunjmavani/core-be/issues/442)) ([88d5db7](https://github.com/nikunjmavani/core-be/commit/88d5db72bc21184da5ea00ec0baaa0256d0f03a9))
* **sec:** extend staging guards to ALLOWED_ORIGINS, COOKIE_SECURE, and SECRETS_ENCRYPTION_KEY (sec-r4-C1/C2/C3) ([#498](https://github.com/nikunjmavani/core-be/issues/498)) ([0efd169](https://github.com/nikunjmavani/core-be/commit/0efd169841cea7cfba5197012dfb6e3f615fe629))
* **sec:** fall back to INSERT when subscription.created arrives before local row (sec-B9) ([#439](https://github.com/nikunjmavani/core-be/issues/439)) ([fd68e66](https://github.com/nikunjmavani/core-be/commit/fd68e660e7d19d1707b0bfe97ac4fe29d08ab427))
* **sec:** harden invitation binding, webhook retry, role invariants, and upload key contract ([#470](https://github.com/nikunjmavani/core-be/issues/470)) ([65cdf2f](https://github.com/nikunjmavani/core-be/commit/65cdf2f9179ac01aa1110f95b60cb6a7fd1519db))
* **sec:** invitation accept requires auth + invitee email match (sec-T4) ([#423](https://github.com/nikunjmavani/core-be/issues/423)) ([7cdc3f8](https://github.com/nikunjmavani/core-be/commit/7cdc3f83beafaa9e682bf39348cb1caa4047c2fb))
* **sec:** mark-confirmed-by-internal-id filters deleted_at and pending (sec-re-13) ([#463](https://github.com/nikunjmavani/core-be/issues/463)) ([dbd9156](https://github.com/nikunjmavani/core-be/commit/dbd9156fd40ff4e2e92ab6ace5823b2e60279e60))
* **sec:** mfa hardening — step-up requires mfa + per-session binding + org-policy delete guard (sec-A1+A2+A4) ([#403](https://github.com/nikunjmavani/core-be/issues/403)) ([1ba5047](https://github.com/nikunjmavani/core-be/commit/1ba504726442aaaea626d2b73f542c55b8214d0a))
* **sec:** mfa is_mfa_enabled flip happens inside the enrollConfirm transaction (sec-re-06) ([#469](https://github.com/nikunjmavani/core-be/issues/469)) ([675c1f2](https://github.com/nikunjmavani/core-be/commit/675c1f257bb02ecf3967a3295ff1f6d1068da136))
* **sec:** mfa re-enroll dedups stale totp factors (sec-re-04) ([#455](https://github.com/nikunjmavani/core-be/issues/455)) ([f7a66ab](https://github.com/nikunjmavani/core-be/commit/f7a66abb8218a13bbf92472ba3fc0c3e26ab6f3e))
* **sec:** middleware observability — captcha bypass closed in staging + HSTS env gate + ALLOWED_ORIGINS canonicalization + encryption 503 (sec-M3+M5+M8+M9) ([#417](https://github.com/nikunjmavani/core-be/issues/417)) ([57abed9](https://github.com/nikunjmavani/core-be/commit/57abed9c55fa7fc50c72b1161e8270b5a64b024f))
* **sec:** notification worker user context + db integrity indexes (sec-d batch) ([#450](https://github.com/nikunjmavani/core-be/issues/450)) ([a1a8fe5](https://github.com/nikunjmavani/core-be/commit/a1a8fe5c15fd5b3c4b8437413ef40e5b4efeb821))
* **sec:** notification worker user-context fix is live wiring (sec-re-01) ([#452](https://github.com/nikunjmavani/core-be/issues/452)) ([653adf5](https://github.com/nikunjmavani/core-be/commit/653adf5653b634dcf907927ad4f6a660256f8a79))
* **sec:** notify abuse caps — per-organization webhook cap + secret-rotation overlap window (sec-N4+N8) ([#411](https://github.com/nikunjmavani/core-be/issues/411)) ([a7455f5](https://github.com/nikunjmavani/core-be/commit/a7455f5548d20fe8460b92154e17b2ca75eda24a))
* **sec:** notify durability — worker re-checks disabled/deleted + delivery-id header + event_key dedupe (sec-N1+N3+N2) ([#410](https://github.com/nikunjmavani/core-be/issues/410)) ([c09ae6c](https://github.com/nikunjmavani/core-be/commit/c09ae6c7acad9de05fe7c28f365ba9af84795c16))
* **sec:** notify recipient + idempotency canonical fingerprint + tenant authorized-org helper (sec-N7+M6+M7) ([#420](https://github.com/nikunjmavani/core-be/issues/420)) ([17a8bbd](https://github.com/nikunjmavani/core-be/commit/17a8bbdc9d364eb9b5bfa5f71d0ffbe86e30645e))
* **sec:** org-scoped audit log sanitiser + strip-only serializers (sec-t batch) ([#448](https://github.com/nikunjmavani/core-be/issues/448)) ([6019182](https://github.com/nikunjmavani/core-be/commit/6019182b695080795d232d7afe04b96659ff34d2))
* **sec:** protect owner role from permission writes via ROLE_MANAGE (sec-T2) ([#402](https://github.com/nikunjmavani/core-be/issues/402)) ([6b11b6e](https://github.com/nikunjmavani/core-be/commit/6b11b6e6da7e825d48d7348b50576861a5fc4cbc))
* **sec:** queue infrastructure — defaultJobOptions on cron queues + flip topology warn + fail boot on scheduler drift in prod (sec-Q1+Q2+Q3) ([#416](https://github.com/nikunjmavani/core-be/issues/416)) ([32b960e](https://github.com/nikunjmavani/core-be/commit/32b960e03cc6a164d137dc080f583846b93635a9))
* **sec:** rate-limit per-email bucket id is hashed (sec-re-11) ([#461](https://github.com/nikunjmavani/core-be/issues/461)) ([4239be4](https://github.com/nikunjmavani/core-be/commit/4239be4ddb5d3432295565b4bb8e110612e97012))
* **sec:** recovery-code alphabet doc reflects 31 symbols and case-insensitive hash (sec-re-14) ([#464](https://github.com/nikunjmavani/core-be/issues/464)) ([1bc8b00](https://github.com/nikunjmavani/core-be/commit/1bc8b001519154b9e5da12abf4a4d808b12cd9d8))
* **sec:** refresh stale ordering comments around the no-op RLS-transaction plugin (sec-M4) ([#433](https://github.com/nikunjmavani/core-be/issues/433)) ([1bd211e](https://github.com/nikunjmavani/core-be/commit/1bd211e288ac062486e9374667e1619401e4f666))
* **sec:** refresh-token reuse detection fires for revoked sessions (sec-re-05) ([#456](https://github.com/nikunjmavani/core-be/issues/456)) ([bf5ee5e](https://github.com/nikunjmavani/core-be/commit/bf5ee5e30c0233d13a0f28d0b9b2afff4df0da4c))
* **sec:** remove privilege-bypass arms from audit.logs INSERT RLS (sec-r4-D1) ([#497](https://github.com/nikunjmavani/core-be/issues/497)) ([787b3c8](https://github.com/nikunjmavani/core-be/commit/787b3c8d20ebb37f97ef9cd2d27aa66f992df7c3))
* **sec:** replace z.coerce.boolean() foot-gun on env booleans (sec-C1) ([#400](https://github.com/nikunjmavani/core-be/issues/400)) ([f8a49c3](https://github.com/nikunjmavani/core-be/commit/f8a49c367e9bbc5cdc7e54e9d9c988e4dbe13bca))
* **sec:** repository hygiene — atomic markAllRead count + WebAuthn counter monotonicity guard (sec-D10/D11) ([#426](https://github.com/nikunjmavani/core-be/issues/426)) ([1d817db](https://github.com/nikunjmavani/core-be/commit/1d817db6ded2820f9334b31d05ca4e4b23ae30b2))
* **sec:** require caller can grant target role permissions on membership create (sec-T1) ([#399](https://github.com/nikunjmavani/core-be/issues/399)) ([899aab3](https://github.com/nikunjmavani/core-be/commit/899aab3abcf9de727a8b0e7fe3ecdcb7ad14d654))
* **sec:** require caller to hold every code added or removed on role-permission PUT (sec-T2) ([#425](https://github.com/nikunjmavani/core-be/issues/425)) ([b9b545e](https://github.com/nikunjmavani/core-be/commit/b9b545ee4de3c1b36bd05a8d80e8ebce8f497565))
* **sec:** require live-mode + both-or-neither Stripe keys in production (sec-B5/B6) ([#424](https://github.com/nikunjmavani/core-be/issues/424)) ([2ca7f2c](https://github.com/nikunjmavani/core-be/commit/2ca7f2cdb4e411275f465164b91ae2099f98a395))
* **sec:** role-delete guards + strip is_system from createMemberRoleDto (sec-T3) ([#406](https://github.com/nikunjmavani/core-be/issues/406)) ([1b41ab9](https://github.com/nikunjmavani/core-be/commit/1b41ab98cfaedfb11a7f5f3c87c26106e8bc2373))
* **sec:** sentry/log redaction + observability — OTLP https refine + readyz verbose env gate + Sentry message/exception/user redaction + LOG_LEVEL enum (sec-C3+C4+C6+C9) ([#418](https://github.com/nikunjmavani/core-be/issues/418)) ([b0337ce](https://github.com/nikunjmavani/core-be/commit/b0337ce2ad6f21ac16b0c97fccda158e7c64dd55))
* **sec:** stripe event retrieve honours per-attempt timeout for real (sec-re-15) ([#465](https://github.com/nikunjmavani/core-be/issues/465)) ([d5640da](https://github.com/nikunjmavani/core-be/commit/d5640daf8c1bacf06e9ca92894ac4d97a9945fe3))
* **sec:** stripe ingress durability + ordering + raw-body wiring (sec-b batch) ([#446](https://github.com/nikunjmavani/core-be/issues/446)) ([8a88beb](https://github.com/nikunjmavani/core-be/commit/8a88beb6cd7ea43f4cf42d034f2a37ba6a241d9e))
* **sec:** stripe reclaim cron→worker handoff is recoverable (sec-re-02) ([#453](https://github.com/nikunjmavani/core-be/issues/453)) ([3cdce4f](https://github.com/nikunjmavani/core-be/commit/3cdce4fcaabf0b6895b73c4feb412f0edd451080))
* **sec:** stripe reconciliation — close 4 silent-divergence paths (sec-B1+B2+B3+B4) ([#405](https://github.com/nikunjmavani/core-be/issues/405)) ([87ab3fb](https://github.com/nikunjmavani/core-be/commit/87ab3fb998f712f5a1b033708c1d65b9ba4c8b82))
* **sec:** subscription response surfaces plan public id (sec-re-07) ([#457](https://github.com/nikunjmavani/core-be/issues/457)) ([537325c](https://github.com/nikunjmavani/core-be/commit/537325c9f8f71a7e7452db8126bcb5517c8b2b1b))
* **sec:** sync local plan_id from Stripe customer.subscription.updated (sec-B7) ([#430](https://github.com/nikunjmavani/core-be/issues/430)) ([bc5a21a](https://github.com/nikunjmavani/core-be/commit/bc5a21ae87d6c253ad7094e752859fe254492d0e))
* **sec:** tenant context lifts the worker statement_timeout (sec-re-16) ([#466](https://github.com/nikunjmavani/core-be/issues/466)) ([415a58e](https://github.com/nikunjmavani/core-be/commit/415a58eb3a4c8c2334d8bcd5649f1348fdf9f455))
* **sec:** tombstoneAllByOrganizationId removes S3 objects synchronously (sec-UP8) ([#421](https://github.com/nikunjmavani/core-be/issues/421)) ([186bd71](https://github.com/nikunjmavani/core-be/commit/186bd711303862d3386cc6f7391ef0dd73928613))
* **sec:** two-phase mfa enrollment + refresh reuse-detection + login uniformity (sec-a batch) ([#445](https://github.com/nikunjmavani/core-be/issues/445)) ([d1e1e59](https://github.com/nikunjmavani/core-be/commit/d1e1e593bcf31c515f22fb1e2c4d07a89c76e81c))
* **sec:** upload confirm pins copy to verified etag (sec-re-10) ([#460](https://github.com/nikunjmavani/core-be/issues/460)) ([2eb3d11](https://github.com/nikunjmavani/core-be/commit/2eb3d11ca070c52c0e4fcf2cc5c5c0c391573837))
* **sec:** upload security — refuse legacy in-place + sweep refuses SVG + assertKeyConfirmedForOwner + DOMPurify hardening (sec-UP1+UP2+UP5+UP6) ([#412](https://github.com/nikunjmavani/core-be/issues/412)) ([76e80ad](https://github.com/nikunjmavani/core-be/commit/76e80ad3617b7d87f57fc292c6e41efba7f89d89))
* **sec:** upload size/policy — organizationId regex + org pending cap + force presigned POST in prod (sec-UP3+UP4+UP10) ([#413](https://github.com/nikunjmavani/core-be/issues/413)) ([237d517](https://github.com/nikunjmavani/core-be/commit/237d517905e321c9c73c1e9cc8f9fa181a73a597))
* **sec:** validate membership and api-key path params at the boundary (sec-re-18) ([#468](https://github.com/nikunjmavani/core-be/issues/468)) ([c0ab171](https://github.com/nikunjmavani/core-be/commit/c0ab17106d8e7dd27513e3bf2f76a480775fd557))
* **sec:** validate subscriptionId path param at every billing handler (sec-B10) ([#431](https://github.com/nikunjmavani/core-be/issues/431)) ([2bbd338](https://github.com/nikunjmavani/core-be/commit/2bbd33864cd192a22d5d41f70ed7064a628a3809))
* **sec:** webhook secret strength + upload sweep file_key invariant + data-export doc (sec-up batch) ([#447](https://github.com/nikunjmavani/core-be/issues/447)) ([145c838](https://github.com/nikunjmavani/core-be/commit/145c8385ec8b02c25b0b508adbabd71c2ce8dc05))
* **storage:** enforce SSE-S3 on presigned uploads (sec-r4-E1) ([#509](https://github.com/nikunjmavani/core-be/issues/509)) ([f962d37](https://github.com/nikunjmavani/core-be/commit/f962d372565e05986fb00a2cef960694b4b35885))
* **tenancy:** bound MemberRolePermissionRepository.findByRoleId rows per role (sec-r4-D4) ([#508](https://github.com/nikunjmavani/core-be/issues/508)) ([9218518](https://github.com/nikunjmavani/core-be/commit/92185187cd5397f4f349442626a936f55e718b7b))
* **tenancy:** exclude soft-deleted orgs from organizations_tenant_isolation RLS policy (sec-new-D3) ([#491](https://github.com/nikunjmavani/core-be/issues/491)) ([904802a](https://github.com/nikunjmavani/core-be/commit/904802affcc95bea74e6f510b64c655ccbd46df0))
* **tenancy:** rate-limit membership lifecycle endpoints (sec-r4-I3) ([#505](https://github.com/nikunjmavani/core-be/issues/505)) ([1f0c8c0](https://github.com/nikunjmavani/core-be/commit/1f0c8c01d38bbaa6020b8a8cab7e3d5b0657b0b7))
* **tenancy:** rate-limit organization mutation endpoints (sec-r4-I2) ([#504](https://github.com/nikunjmavani/core-be/issues/504)) ([2f6bedb](https://github.com/nikunjmavani/core-be/commit/2f6bedb59ca27d9d11c68299560470d8f0418d77))
* **tenancy:** sec-new-M1 add STRICT_AUTHED_RATE_LIMIT to POST /organizations ([#477](https://github.com/nikunjmavani/core-be/issues/477)) ([dd9fd62](https://github.com/nikunjmavani/core-be/commit/dd9fd62112aefe4eaa63869ab6c37ac62ee8540c))
* **tenancy:** sec-new-T2 validate invitationId path param in all invitation handlers ([#480](https://github.com/nikunjmavani/core-be/issues/480)) ([93fa940](https://github.com/nikunjmavani/core-be/commit/93fa940a7d371acd95889257b027075d305d1e60))
* **tenancy:** sec-new-T3 validate id and roleId path params in role handlers ([#481](https://github.com/nikunjmavani/core-be/issues/481)) ([361159a](https://github.com/nikunjmavani/core-be/commit/361159aca4126ae5df7b446dd437c199082a9636))
* **user-data-export:** bound offboarding S3 delete fan-out (sec-r4-R2) ([#513](https://github.com/nikunjmavani/core-be/issues/513)) ([6ef83de](https://github.com/nikunjmavani/core-be/commit/6ef83de5039fcb08bd4422ad04cfc4282ee53bd4))
* **user:** rate-limit /me profile mutation endpoints (sec-r4-I1) ([#503](https://github.com/nikunjmavani/core-be/issues/503)) ([0c745e1](https://github.com/nikunjmavani/core-be/commit/0c745e182c0c6be2de608f42e9c434212ad07c08))
* **user:** sec-new-U1 cap ListUsersDto.after cursor to 512 chars ([#483](https://github.com/nikunjmavani/core-be/issues/483)) ([fae555d](https://github.com/nikunjmavani/core-be/commit/fae555dd2717a4cde9a703f64941cca09d55e33f))


### Documentation

* **superpowers:** re-audit remediation design spec for 18 findings ([#451](https://github.com/nikunjmavani/core-be/issues/451)) ([1b05734](https://github.com/nikunjmavani/core-be/commit/1b05734fe69e593ae6ad9f5fb2f11e6f4a8f69f6))

## [4.5.3-dev.0](https://github.com/nikunjmavani/core-be/compare/v4.5.2-dev.0...v4.5.3-dev.0) (2026-06-05)


### Fixed

* **ci:** dispatch stable release backmerge ([be9190f](https://github.com/nikunjmavani/core-be/commit/be9190f6ff26d04905bc46127717c96fbbe57ab0))

## [4.5.2-dev.0](https://github.com/nikunjmavani/core-be/compare/v4.5.1-dev.0...v4.5.2-dev.0) (2026-06-05)


### Fixed

* **lockfile:** regenerate pnpm-lock.yaml (merge produced duplicate mapping key) ([c2eba7e](https://github.com/nikunjmavani/core-be/commit/c2eba7eb879f20ee0b5ff182c5edf1ca64715308))

## [4.5.1-dev.0](https://github.com/nikunjmavani/core-be/compare/v4.5.0-dev.0...v4.5.1-dev.0) (2026-06-05)


### Fixed

* **ci:** use fetch-depth: 0 in post-merge changes job to avoid paths-filter race ([#390](https://github.com/nikunjmavani/core-be/issues/390)) ([61a2100](https://github.com/nikunjmavani/core-be/commit/61a210090ae518f75f459cc33806b10ba1442993))

## [4.5.0-dev.0](https://github.com/nikunjmavani/core-be/compare/v4.4.7-dev.0...v4.5.0-dev.0) (2026-06-05)


### Added

* **ci:** add PR-time Trivy IaC misconfig scan ([#388](https://github.com/nikunjmavani/core-be/issues/388)) ([e8499e0](https://github.com/nikunjmavani/core-be/commit/e8499e04b8c8d311a14fb6ac3bdd1c4a4d151a49))

## [4.4.7-dev.0](https://github.com/nikunjmavani/core-be/compare/v4.4.6-dev.0...v4.4.7-dev.0) (2026-06-05)


### Fixed

* **migration:** make audit_logs_actor_api_key FK idempotent (unblock dev deploy) ([#385](https://github.com/nikunjmavani/core-be/issues/385)) ([b8cc4fb](https://github.com/nikunjmavani/core-be/commit/b8cc4fb70d3d3d13f31f4b67af35772ff5afdb7e))

## [4.4.6-dev.0](https://github.com/nikunjmavani/core-be/compare/v4.4.5-dev.0...v4.4.6-dev.0) (2026-06-04)


### Fixed

* **audit-13:** remove dead jobTimeout field from worker options — BullMQ does not enforce it ([#379](https://github.com/nikunjmavani/core-be/issues/379)) ([b393d5e](https://github.com/nikunjmavani/core-be/commit/b393d5e0add3e299de889d023056397a559b5df6))
* **tests:** align e2e fixtures with audit batch2 (WebAuthn typed DTO) + Stripe items.period ([#384](https://github.com/nikunjmavani/core-be/issues/384)) ([b906731](https://github.com/nikunjmavani/core-be/commit/b906731f9fdfb6813303c3f25a0ce148a1e2023a))


### Documentation

* **audit-2026-06-04:** mark all 20 findings resolved with file:line citations ([#381](https://github.com/nikunjmavani/core-be/issues/381)) ([96dd4f7](https://github.com/nikunjmavani/core-be/commit/96dd4f74574b1dca6ee93190b59edc56ab414b1e))

## [4.4.5-dev.0](https://github.com/nikunjmavani/core-be/compare/v4.4.4-dev.0...v4.4.5-dev.0) (2026-06-04)


### Fixed

* audit batch2 — WebAuthn typed DTOs, oasdiff SIGSEGV CI workaround ([6e44557](https://github.com/nikunjmavani/core-be/commit/6e4455700f39ed6cc6dee5ca71baf4eaddac49ed))
* **audit:** cursor max-length, DLQ catch, jobTimeout, age-based queue eviction (batch5) ([#375](https://github.com/nikunjmavani/core-be/issues/375)) ([5882436](https://github.com/nikunjmavani/core-be/commit/588243618efe4be76f3b9e1d2b0c2aa851b06930))
* **audit:** MCP caller JWT forwarding and IP-level failed-login counter ([#373](https://github.com/nikunjmavani/core-be/issues/373)) ([ceee226](https://github.com/nikunjmavani/core-be/commit/ceee2269da8c40bb16f1332e56de8028de24b069))
* **audit:** rate limits, User-Agent truncation, webhook HTTPS, CAPTCHA staging (batch4) ([#374](https://github.com/nikunjmavani/core-be/issues/374)) ([4c9486a](https://github.com/nikunjmavani/core-be/commit/4c9486ac64959cea4bd308cb59c37ba858018066))
* validators (audit follow-up) — centralize AES_GCM_IV_LENGTH, allowlist 5 and 512, env-load sunset validator ([#378](https://github.com/nikunjmavani/core-be/issues/378)) ([3bae917](https://github.com/nikunjmavani/core-be/commit/3bae917577c65d11cf771725f81392a0a62ce904))

## [4.4.4-dev.0](https://github.com/nikunjmavani/core-be/compare/v4.4.3-dev.0...v4.4.4-dev.0) (2026-06-04)


### Fixed

* **email-templates:** escape URL fields in invitation and magic-link templates ([#364](https://github.com/nikunjmavani/core-be/issues/364)) ([26c67fa](https://github.com/nikunjmavani/core-be/commit/26c67fac20bff7ccf765c6d93a6264e35ebee079))
* **finding-13:** escape title/preheader/footerText inside baseTemplate ([8996b26](https://github.com/nikunjmavani/core-be/commit/8996b2616b52de6f55b0b16315c4a439034e3fba))
* **finding-74:** replace unsafe Stripe object casts with proper type narrowing ([#359](https://github.com/nikunjmavani/core-be/issues/359)) ([f8f9cfe](https://github.com/nikunjmavani/core-be/commit/f8f9cfe8ae24f51ff34c92100dd31b2d1f7745fe))
* **mcp:** apply STRICT_AUTHED_RATE_LIMIT to MCP endpoint (audit finding [#7](https://github.com/nikunjmavani/core-be/issues/7)) ([#366](https://github.com/nikunjmavani/core-be/issues/366)) ([6783141](https://github.com/nikunjmavani/core-be/commit/6783141ed14cc7009e1ec2be258386fac1706ed3))
* **security:** add maxItems array bounds and fix WebAuthn type casts ([#363](https://github.com/nikunjmavani/core-be/issues/363)) ([ab4e7c7](https://github.com/nikunjmavani/core-be/commit/ab4e7c7c6fb65f374c458b18ef7b8b5927b0e77d))
* **stripe:** tighten webhook replay window to 150 s (audit finding [#6](https://github.com/nikunjmavani/core-be/issues/6)) ([#365](https://github.com/nikunjmavani/core-be/issues/365)) ([848360d](https://github.com/nikunjmavani/core-be/commit/848360d739857212d1822c6e9e4564498649b5c3))


### Performance

* parallelize S3 object deletes in deleteAllExportsForUser ([#361](https://github.com/nikunjmavani/core-be/issues/361)) ([4c36173](https://github.com/nikunjmavani/core-be/commit/4c36173e703bfaa9737ed2a529f0e28e8f863046))


### Documentation

* add 2026-06-04 deep audit report (20 findings) ([6515589](https://github.com/nikunjmavani/core-be/commit/65155899935406e72781fab5348f146b20b5b8e4))
* add deep backend audit report 2026-06-03 ([#362](https://github.com/nikunjmavani/core-be/issues/362)) ([3d7ae31](https://github.com/nikunjmavani/core-be/commit/3d7ae31779c7975b4b61d19c8f7867c8a58432a9))
* add remediation status tracker to 2026-06-03 audit report ([93ef121](https://github.com/nikunjmavani/core-be/commit/93ef12150cd3917f3a6ecc46c9e8da4573ada94b))

## [4.4.3-dev.0](https://github.com/nikunjmavani/core-be/compare/v4.4.2-dev.0...v4.4.3-dev.0) (2026-06-03)


### Fixed

* **finding-46:** validate DATABASE_HTTP_STATEMENT_TIMEOUT_MS stays within permission cache lock TTL ([#356](https://github.com/nikunjmavani/core-be/issues/356)) ([47bdab4](https://github.com/nikunjmavani/core-be/commit/47bdab435f83a307cc04f4dc8274f5407aeb8ad3))
* **finding-62:** export WEBHOOK_DELIVERY_JOB_ATTEMPTS and fix vi.mock factories ([#357](https://github.com/nikunjmavani/core-be/issues/357)) ([cd24515](https://github.com/nikunjmavani/core-be/commit/cd24515fa2acf75774da7d636ea42bc0212ec3a2))

## [4.4.2-dev.0](https://github.com/nikunjmavani/core-be/compare/v4.4.1-dev.0...v4.4.2-dev.0) (2026-06-03)


### Fixed

* **cache:** add commandTimeout to Redis client to prevent hung commands ([8cd8107](https://github.com/nikunjmavani/core-be/commit/8cd8107df573d5a8255911dc2fac8f21e676fb66))
* **events:** capture swallowed event-bus errors in Sentry ([2a30d84](https://github.com/nikunjmavani/core-be/commit/2a30d845482dadbe97dd922a4bc54e974105655a))
* **infra:** throw on startup when monolithic worker pool demand exceeds DATABASE_POOL_MAX ([faf2fab](https://github.com/nikunjmavani/core-be/commit/faf2fab638f0b77d1ea82dd856d3cefefa893711))
* **security:** require explicit wildcard prefix for webhook allowlist subdomain matching ([8d79c89](https://github.com/nikunjmavani/core-be/commit/8d79c891b2a88a8a44cca1420535cfcc6a567a12))

## [4.4.1-dev.0](https://github.com/nikunjmavani/core-be/compare/v4.4.0-dev.0...v4.4.1-dev.0) (2026-06-03)


### Fixed

* **auth:** remove silent params.id fallback in requireOrganizationPermission ([#346](https://github.com/nikunjmavani/core-be/issues/346)) ([17f4d83](https://github.com/nikunjmavani/core-be/commit/17f4d83fae5114820bf4f1c00940306628ea1228))
* **billing:** correct misleading plan route OpenAPI descriptions ([#349](https://github.com/nikunjmavani/core-be/issues/349)) ([27246ce](https://github.com/nikunjmavani/core-be/commit/27246ce78082f134005ac028852c7d95233f3c8b))
* **billing:** pin Stripe API version to 2026-05-27.dahlia ([#350](https://github.com/nikunjmavani/core-be/issues/350)) ([7c329bd](https://github.com/nikunjmavani/core-be/commit/7c329bd496bdff587f3c12748f923a2ef7267909))
* **security:** reject JWT tokens with unknown kid when keyring is active ([#347](https://github.com/nikunjmavani/core-be/issues/347)) ([2bedfa1](https://github.com/nikunjmavani/core-be/commit/2bedfa1fc7bfe30ebe07e3529cfe8b7c8c78a15d))
* **security:** strip privileged headers from MCP call_api and remove unversioned aliases ([#348](https://github.com/nikunjmavani/core-be/issues/348)) ([cdaf9ce](https://github.com/nikunjmavani/core-be/commit/cdaf9cef188e146b090bf411dc21e803c53ddea7))

## [4.4.0-dev.0](https://github.com/nikunjmavani/core-be/compare/v4.3.0-dev.0...v4.4.0-dev.0) (2026-06-03)


### Added

* **load:** per-VU credential pool + realistic user-journey k6 scenario ([#342](https://github.com/nikunjmavani/core-be/issues/342)) ([a05a611](https://github.com/nikunjmavani/core-be/commit/a05a611ced68683c0855c65d572fbc5fc7d06bb1))


### Fixed

* **ci:** use bare check-run names as ruleset required-check contexts ([#344](https://github.com/nikunjmavani/core-be/issues/344)) ([c431a63](https://github.com/nikunjmavani/core-be/commit/c431a63a292e9dcff7dc09147c9ae0fd7eb3d5d2))
* **migration:** make core_be_app least-privilege ALTER ROLE Neon-safe (unblocks all deploys) ([#341](https://github.com/nikunjmavani/core-be/issues/341)) ([488c793](https://github.com/nikunjmavani/core-be/commit/488c793ee93173a2b7d1cedb32879743c3136533))

## [4.3.0-dev.0](https://github.com/nikunjmavani/core-be/compare/v4.2.6-dev.0...v4.3.0-dev.0) (2026-06-03)


### Added

* **observability:** emit Server-Timing header for true server-side latency ([#339](https://github.com/nikunjmavani/core-be/issues/339)) ([5e78cde](https://github.com/nikunjmavani/core-be/commit/5e78cde15b30deac077cbf4e27081cf6da27e814))

## [4.2.6-dev.0](https://github.com/nikunjmavani/core-be/compare/v4.2.5-dev.0...v4.2.6-dev.0) (2026-06-03)


### Fixed

* **rls:** pin core_be_app to NOSUPERUSER/NOBYPASSRLS + assert RLS-binding ([#334](https://github.com/nikunjmavani/core-be/issues/334)) ([18f8b9a](https://github.com/nikunjmavani/core-be/commit/18f8b9aa6f0ae44d45208dabf270a6c5a52c60ec))

## [4.2.5-dev.0](https://github.com/nikunjmavani/core-be/compare/v4.2.4-dev.0...v4.2.5-dev.0) (2026-06-03)


### Fixed

* **queue:** stop DLQ auto-retry starvation via a resolved marker on exhausted rows ([#330](https://github.com/nikunjmavani/core-be/issues/330)) ([86c3817](https://github.com/nikunjmavani/core-be/commit/86c381769b50262e30687506b0c9ebeec9a739d9))
* **tenancy:** emit public ids (not internal bigserial ids) in membership responses ([#329](https://github.com/nikunjmavani/core-be/issues/329)) ([3aac2ac](https://github.com/nikunjmavani/core-be/commit/3aac2ac13d072c1f41bf71bd296468de63d73b3c))

## [4.2.4-dev.0](https://github.com/nikunjmavani/core-be/compare/v4.2.3-dev.0...v4.2.4-dev.0) (2026-06-03)


### Fixed

* **billing:** make Stripe customer creation idempotent on retry ([#326](https://github.com/nikunjmavani/core-be/issues/326)) ([8990fb3](https://github.com/nikunjmavani/core-be/commit/8990fb32b15fa133aece4ce428182d9b1996ee93))
* **user:** reject org-scoped notification preference with 400 (was raw 42501 -&gt; 500) ([#327](https://github.com/nikunjmavani/core-be/issues/327)) ([db1e7a7](https://github.com/nikunjmavani/core-be/commit/db1e7a77e3c8f464bd8354f1235a1f33c5c71967))

## [4.2.3-dev.0](https://github.com/nikunjmavani/core-be/compare/v4.2.2-dev.0...v4.2.3-dev.0) (2026-06-03)


### Fixed

* **events:** release commit-dispatch marker on rollback (in-memory leak) ([#324](https://github.com/nikunjmavani/core-be/issues/324)) ([7e3ec55](https://github.com/nikunjmavani/core-be/commit/7e3ec559455954d9aeb489e69c4bf416801d76d3))

## [4.2.2-dev.0](https://github.com/nikunjmavani/core-be/compare/v4.2.1-dev.0...v4.2.2-dev.0) (2026-06-03)


### Fixed

* **auth:** stop GET /auth/me/auth-methods leaking encrypted TOTP secret + PII ([#321](https://github.com/nikunjmavani/core-be/issues/321)) ([32cb49e](https://github.com/nikunjmavani/core-be/commit/32cb49e7b1c2039c2554adc481c2f68837720e6e))
* **queue:** bound audit.dead_letter_jobs growth via the audit-retention purge ([#322](https://github.com/nikunjmavani/core-be/issues/322)) ([06e729d](https://github.com/nikunjmavani/core-be/commit/06e729ddba34ce6d47ac3f2f7d73ad54910800a2))

## [4.2.1-dev.0](https://github.com/nikunjmavani/core-be/compare/v4.2.0-dev.0...v4.2.1-dev.0) (2026-06-03)


### Fixed

* **auth:** make password reset atomic (transaction) so sessions can't survive it ([#319](https://github.com/nikunjmavani/core-be/issues/319)) ([30cffe5](https://github.com/nikunjmavani/core-be/commit/30cffe5c205fdd7d0f1a835cf335791ad78ad36e))
* **auth:** restore org-mandated MFA under FORCE RLS via SECURITY DEFINER resolvers ([#318](https://github.com/nikunjmavani/core-be/issues/318)) ([e152c0c](https://github.com/nikunjmavani/core-be/commit/e152c0c458aed788289c7d75b3e8fe0c79ec938f))

## [4.2.0-dev.0](https://github.com/nikunjmavani/core-be/compare/v4.1.6-dev.0...v4.2.0-dev.0) (2026-06-02)


### Added

* **ci:** wire route-HTTP-coverage gate + close mcp/ops gaps (H1) ([#306](https://github.com/nikunjmavani/core-be/issues/306)) ([ef6eefb](https://github.com/nikunjmavani/core-be/commit/ef6eefbc6c311aecec5b9532d2700a48d705654c))


### Fixed

* **auth:** atomically increment the failed-login counter (close lost-update race) ([#303](https://github.com/nikunjmavani/core-be/issues/303)) ([53147a6](https://github.com/nikunjmavani/core-be/commit/53147a65bb78c68ed9e0a94ff2955ca5d21604ee))
* **ci:** repoint 12 dead Stryker mutate paths + drift guard (security middlewares were unmutated) ([#310](https://github.com/nikunjmavani/core-be/issues/310)) ([5609146](https://github.com/nikunjmavani/core-be/commit/560914673aa37406be1ecfc570be90d1d6756122))
* **tenancy:** make API-key rotation atomic against concurrent rotations ([#307](https://github.com/nikunjmavani/core-be/issues/307)) ([dc0aaa3](https://github.com/nikunjmavani/core-be/commit/dc0aaa326109b5acaeafbe7b7be5f8c5573cd01e))
* **tenancy:** make ownership transfer atomic against a concurrent suspend (TOCTOU) ([#304](https://github.com/nikunjmavani/core-be/issues/304)) ([b6a44b1](https://github.com/nikunjmavani/core-be/commit/b6a44b1e4d9f8eb9a0ecc262c8e5bbf227fb6f4f))
* **tenancy:** map concurrent org slug-update collision to 409 instead of 500 ([#302](https://github.com/nikunjmavani/core-be/issues/302)) ([b8bd666](https://github.com/nikunjmavani/core-be/commit/b8bd666a065cfe8a6ca786c3dd4c95340c72061d))
* **tenancy:** never soft-delete the organization owner's membership (close orphan race) ([#305](https://github.com/nikunjmavani/core-be/issues/305)) ([0262116](https://github.com/nikunjmavani/core-be/commit/026211696fed6522832cd4c04d939d28c3c108ca))
* validate notification channel as an enum (422) instead of 500 ([#300](https://github.com/nikunjmavani/core-be/issues/300)) ([a7a50f0](https://github.com/nikunjmavani/core-be/commit/a7a50f09efe961a49ead72bca5def0da94dfefc7))

## [4.1.6-dev.0](https://github.com/nikunjmavani/core-be/compare/v4.1.5-dev.0...v4.1.6-dev.0) (2026-06-02)


### Fixed

* **tenancy:** reject direct ACTIVE membership create with 403 instead of 500 ([#298](https://github.com/nikunjmavani/core-be/issues/298)) ([dbb8197](https://github.com/nikunjmavani/core-be/commit/dbb819779e766e059a708078d1921c33adfb35e7))

## [4.1.5-dev.0](https://github.com/nikunjmavani/core-be/compare/v4.1.4-dev.0...v4.1.5-dev.0) (2026-06-02)


### Fixed

* **auth:** map duplicate passkey registration to 409 instead of 500 ([#295](https://github.com/nikunjmavani/core-be/issues/295)) ([66b4e1a](https://github.com/nikunjmavani/core-be/commit/66b4e1aa52e3fe59af283b777f8b486d89dce1a2))

## [4.1.4-dev.0](https://github.com/nikunjmavani/core-be/compare/v4.1.3-dev.0...v4.1.4-dev.0) (2026-06-02)


### Fixed

* map remaining unique violations to 409 instead of 500 ([#294](https://github.com/nikunjmavani/core-be/issues/294)) ([7a74b3c](https://github.com/nikunjmavani/core-be/commit/7a74b3c24cbfe90041cb51e3ba5e293110e9039f))

## [4.1.3-dev.0](https://github.com/nikunjmavani/core-be/compare/v4.1.2-dev.0...v4.1.3-dev.0) (2026-06-02)


### Fixed

* **tenancy:** map duplicate role name to 409 instead of 500 ([#292](https://github.com/nikunjmavani/core-be/issues/292)) ([e1a72b3](https://github.com/nikunjmavani/core-be/commit/e1a72b3287103165df7c0eaf32bf9c2f081d45d0))

## [4.1.2-dev.0](https://github.com/nikunjmavani/core-be/compare/v4.1.1-dev.0...v4.1.2-dev.0) (2026-06-02)


### Fixed

* **auth:** stop GET /auth/me/sessions leaking session token hashes ([#287](https://github.com/nikunjmavani/core-be/issues/287)) ([877fe63](https://github.com/nikunjmavani/core-be/commit/877fe63dca1f43a046ad68910df0beba73530ded))

## [4.1.1-dev.0](https://github.com/nikunjmavani/core-be/compare/v4.1.0-dev.0...v4.1.1-dev.0) (2026-06-02)


### Fixed

* **db:** correct concurrent unique-violation handling (org-slug race → 500) ([#285](https://github.com/nikunjmavani/core-be/issues/285)) ([8183f71](https://github.com/nikunjmavani/core-be/commit/8183f71fd5096f0be0a793db57770cf76eb99c4f))

## [4.1.0-dev.0](https://github.com/nikunjmavani/core-be/compare/v4.0.0-dev.0...v4.1.0-dev.0) (2026-06-02)


### Added

* **upload:** reject path-traversal / control-char filenames + upload attack tests ([#279](https://github.com/nikunjmavani/core-be/issues/279)) ([f26a1a9](https://github.com/nikunjmavani/core-be/commit/f26a1a9dd3f9f4660ab42a4f250f254d5e0b9760))

## [4.0.0-dev.0](https://github.com/nikunjmavani/core-be/compare/v3.10.1-dev.0...v4.0.0-dev.0) (2026-06-02)


### ⚠ BREAKING CHANGES

* **error-handler:** honor 4xx Fastify framework errors + DoS hardening tests ([#276](https://github.com/nikunjmavani/core-be/issues/276))

### Fixed

* **error-handler:** honor 4xx Fastify framework errors + DoS hardening tests ([#276](https://github.com/nikunjmavani/core-be/issues/276)) ([cb21ce4](https://github.com/nikunjmavani/core-be/commit/cb21ce446747b8d66ec8ca45f7d2f2352fd77cde))

## [3.10.1-dev.0](https://github.com/nikunjmavani/core-be/compare/v3.10.0-dev.0...v3.10.1-dev.0) (2026-06-02)


### Fixed

* **test:** enable metrics in test env so local coverage mirrors CI ([#271](https://github.com/nikunjmavani/core-be/issues/271)) ([e0380b6](https://github.com/nikunjmavani/core-be/commit/e0380b655eca210688bf7559fe1fe3e26f53e1ba))

## [3.10.0-dev.0](https://github.com/nikunjmavani/core-be/compare/v3.9.0-dev.0...v3.10.0-dev.0) (2026-06-02)


### Added

* **setup-railway:** support RAILWAY_API_TOKEN + mint per-environment project tokens ([#269](https://github.com/nikunjmavani/core-be/issues/269)) ([f73d0dc](https://github.com/nikunjmavani/core-be/commit/f73d0dc4b42667e50a7605637ace43060e661b38))

## [3.9.0-dev.0](https://github.com/nikunjmavani/core-be/compare/v3.8.2-dev.0...v3.9.0-dev.0) (2026-06-02)


### Added

* **coverage:** add patch (differential) coverage tool + document the real coverage policy ([#266](https://github.com/nikunjmavani/core-be/issues/266)) ([73ccfe3](https://github.com/nikunjmavani/core-be/commit/73ccfe3ffd107fc273479d08c76f05a14ec7e73f))


### Fixed

* **setup-neon:** create runtime role via SQL to avoid Neon's implicit BYPASSRLS ([#267](https://github.com/nikunjmavani/core-be/issues/267)) ([29b9d77](https://github.com/nikunjmavani/core-be/commit/29b9d77d1176ee0cd304277d80359e94a827a1e2))

## [3.8.2-dev.0](https://github.com/nikunjmavani/core-be/compare/v3.8.1-dev.0...v3.8.2-dev.0) (2026-06-02)


### Fixed

* **test:** make billing mutation + session-revoke integration tests deterministic ([#264](https://github.com/nikunjmavani/core-be/issues/264)) ([d031718](https://github.com/nikunjmavani/core-be/commit/d0317188babbb9c3c788e8ac59613b4a306f230a))

## [3.8.1-dev.0](https://github.com/nikunjmavani/core-be/compare/v3.8.0-dev.0...v3.8.1-dev.0) (2026-06-02)


### Documentation

* **audit:** document audit.logs storage (plain table; hosted partitioning is out-of-band) ([#257](https://github.com/nikunjmavani/core-be/issues/257)) ([26e3f09](https://github.com/nikunjmavani/core-be/commit/26e3f0926e3b280a5ce7a16122b38295509f5c25))

## [3.8.0-dev.0](https://github.com/nikunjmavani/core-be/compare/v3.7.3-dev.0...v3.8.0-dev.0) (2026-06-02)


### Added

* **sonar:** local SonarQube pre-push quality gate ([#253](https://github.com/nikunjmavani/core-be/issues/253)) ([383ef5e](https://github.com/nikunjmavani/core-be/commit/383ef5e8b0701218e8f020dc534d258df3886279))

## [3.7.3-dev.0](https://github.com/nikunjmavani/core-be/compare/v3.7.2-dev.0...v3.7.3-dev.0) (2026-06-02)


### Changed

* **sonar:** remove redundant WorkerContainers alias (S6564) ([#251](https://github.com/nikunjmavani/core-be/issues/251)) ([4dff585](https://github.com/nikunjmavani/core-be/commit/4dff58590a6b6aef0f08585bc26b93ac51d182b2))

## [3.7.2-dev.0](https://github.com/nikunjmavani/core-be/compare/v3.7.1-dev.0...v3.7.2-dev.0) (2026-06-01)


### Changed

* **sonar:** reduce cognitive complexity of 7 functions (S3776) ([#249](https://github.com/nikunjmavani/core-be/issues/249)) ([1ed41da](https://github.com/nikunjmavani/core-be/commit/1ed41da6232496617897ef977deb3cbeca8d9ace))

## [3.7.1-dev.0](https://github.com/nikunjmavani/core-be/compare/v3.7.0-dev.0...v3.7.1-dev.0) (2026-06-01)


### Fixed

* **sonar:** make issueMagicLinkIfUserExists return void (S3516) ([#247](https://github.com/nikunjmavani/core-be/issues/247)) ([96c05c8](https://github.com/nikunjmavani/core-be/commit/96c05c8f9d1209e64f63b58a376a6d0796e69933))
* **sonar:** un-nest ternaries + drop redundant cast introduced by [#245](https://github.com/nikunjmavani/core-be/issues/245) ([#246](https://github.com/nikunjmavani/core-be/issues/246)) ([f604a08](https://github.com/nikunjmavani/core-be/commit/f604a08ab2fef5cdbdeac1fa234006437a9e7a4d))

## [3.7.0-dev.0](https://github.com/nikunjmavani/core-be/compare/v3.6.3-dev.0...v3.7.0-dev.0) (2026-06-01)


### Added

* **seed:** orchestration wiring smoke test + docs/skills/rules ([#238](https://github.com/nikunjmavani/core-be/issues/238)) ([09ee7ef](https://github.com/nikunjmavani/core-be/commit/09ee7ef517075142e587838da5c0df6110504eaa))

## [3.6.3-dev.0](https://github.com/nikunjmavani/core-be/compare/v3.6.2-dev.0...v3.6.3-dev.0) (2026-06-01)


### Fixed

* **sonar:** harden auth-header regexes + URL-based Redis redaction (S5852) ([#235](https://github.com/nikunjmavani/core-be/issues/235)) ([ee8ae73](https://github.com/nikunjmavani/core-be/commit/ee8ae7399ce9622317733dfd9032b1569a227192))
* **sonar:** use crypto.randomInt for jitter/shard selection (S2245) ([#234](https://github.com/nikunjmavani/core-be/issues/234)) ([d586f23](https://github.com/nikunjmavani/core-be/commit/d586f2378b4085889d7025f5476790e6c90adb69))

## [3.6.2-dev.0](https://github.com/nikunjmavani/core-be/compare/v3.6.1-dev.0...v3.6.2-dev.0) (2026-06-01)


### Fixed

* **sonar:** migrate response encryption to AES-256-GCM (S5542) ([#232](https://github.com/nikunjmavani/core-be/issues/232)) ([7b55853](https://github.com/nikunjmavani/core-be/commit/7b558530aa0f36dea375437079f63cb4596b5329))

## [3.6.1-dev.0](https://github.com/nikunjmavani/core-be/compare/v3.6.0-dev.0...v3.6.1-dev.0) (2026-06-01)


### Fixed

* **sonar:** add localeCompare compare fn to Array.sort() on strings (S2871) ([#230](https://github.com/nikunjmavani/core-be/issues/230)) ([1060614](https://github.com/nikunjmavani/core-be/commit/106061468e94c46bbd91adee85996259d5ea3047))
* **sonar:** group regex alternation for explicit precedence (S5850) ([#229](https://github.com/nikunjmavani/core-be/issues/229)) ([8d74a5e](https://github.com/nikunjmavani/core-be/commit/8d74a5ea8f715b6db79d77b4af99ef8bdccd750e))

## [3.6.0-dev.0](https://github.com/nikunjmavani/core-be/compare/v3.5.2-dev.0...v3.6.0-dev.0) (2026-06-01)


### Added

* **seed:** configurable bulk seeder (shared orchestrator + per-domain seed/ dirs) ([#227](https://github.com/nikunjmavani/core-be/issues/227)) ([d7285a1](https://github.com/nikunjmavani/core-be/commit/d7285a19cd9f29c05092903139156916da29a7c4))

## [3.5.2-dev.0](https://github.com/nikunjmavani/core-be/compare/v3.5.1-dev.0...v3.5.2-dev.0) (2026-06-01)


### Fixed

* **db:** make audit_logs actor_api_key FK partitioned-table safe ([#225](https://github.com/nikunjmavani/core-be/issues/225)) ([f93c695](https://github.com/nikunjmavani/core-be/commit/f93c6950d5eff54935f79ba7c788e95cc954b3ba))

## [3.5.1-dev.0](https://github.com/nikunjmavani/core-be/compare/v3.5.0-dev.0...v3.5.1-dev.0) (2026-06-01)


### Fixed

* **ci:** restore CodeQL tuning lost in [#220](https://github.com/nikunjmavani/core-be/issues/220) squash; unbreak node24 policy ([#221](https://github.com/nikunjmavani/core-be/issues/221)) ([68aec6f](https://github.com/nikunjmavani/core-be/commit/68aec6f4a54572dd082efcdbb08c163b1ec291e7))
* **ci:** unblock dev-&gt;main promotion (PR [#157](https://github.com/nikunjmavani/core-be/issues/157)) ([#222](https://github.com/nikunjmavani/core-be/issues/222)) ([dc0efec](https://github.com/nikunjmavani/core-be/commit/dc0efec1303fd2abf83402698f47881a6368210f))
* security hardening follow-up fixes ([#218](https://github.com/nikunjmavani/core-be/issues/218)) ([b3a27e0](https://github.com/nikunjmavani/core-be/commit/b3a27e0f31561681a4f9891d7b9cd24e4274cba6))
* **security:** residual-findings remediation (auth principal, idempotency, audit, upload, degraded-mode) ([#219](https://github.com/nikunjmavani/core-be/issues/219)) ([cddfb4b](https://github.com/nikunjmavani/core-be/commit/cddfb4b251f5247346156c46c458a2b0a2d160f5))

## [3.5.0-dev.0](https://github.com/nikunjmavani/core-be/compare/v3.4.5-dev.0...v3.5.0-dev.0) (2026-06-01)


### Added

* **reliability:** crash-safe dispatch, DLQ auto-retry, and ops improvements ([#214](https://github.com/nikunjmavani/core-be/issues/214)) ([ffdff4d](https://github.com/nikunjmavani/core-be/commit/ffdff4d0eaade870eb50198e0afdb769d72917df))

## [3.4.5-dev.0](https://github.com/nikunjmavani/core-be/compare/v3.4.4-dev.0...v3.4.5-dev.0) (2026-05-31)


### Fixed

* regression residual findings P2–P5 (export, audit, lint) ([#212](https://github.com/nikunjmavani/core-be/issues/212)) ([69a02f2](https://github.com/nikunjmavani/core-be/commit/69a02f24627c009b8b3baedb3eb44b4dc7a9c719))

## [3.4.4-dev.0](https://github.com/nikunjmavani/core-be/compare/v3.4.3-dev.0...v3.4.4-dev.0) (2026-05-31)


### Changed

* complete src directory restructure program ([#209](https://github.com/nikunjmavani/core-be/issues/209)) ([d34be1d](https://github.com/nikunjmavani/core-be/commit/d34be1d123e9b1a8325433d8112c8307c8674ca2))

## [3.4.3-dev.0](https://github.com/nikunjmavani/core-be/compare/v3.4.2-dev.0...v3.4.3-dev.0) (2026-05-31)


### Fixed

* production readiness findings 1–6 (audit, export, billing, webhooks) ([#207](https://github.com/nikunjmavani/core-be/issues/207)) ([7a3094b](https://github.com/nikunjmavani/core-be/commit/7a3094bc85004e51be9d90422df3d1cf124182b4))

## [3.4.2-dev.0](https://github.com/nikunjmavani/core-be/compare/v3.4.1-dev.0...v3.4.2-dev.0) (2026-05-31)


### Fixed

* reduce agent system drift in skills, rules, and docs ([#205](https://github.com/nikunjmavani/core-be/issues/205)) ([2f570a0](https://github.com/nikunjmavani/core-be/commit/2f570a028946e3664e5794bf9cd79b306bd82f74))

## [3.4.1-dev.0](https://github.com/nikunjmavani/core-be/compare/v3.4.0-dev.0...v3.4.1-dev.0) (2026-05-31)


### Changed

* enforce strict @/ and @tooling/ import paths ([#203](https://github.com/nikunjmavani/core-be/issues/203)) ([09b4bc6](https://github.com/nikunjmavani/core-be/commit/09b4bc6166f6904adce92e20b0ca5abf7d37324d))

## [3.4.0-dev.0](https://github.com/nikunjmavani/core-be/compare/v3.3.7-dev.0...v3.4.0-dev.0) (2026-05-31)


### Added

* **tooling:** centralize project identity in setup.config.json ([#200](https://github.com/nikunjmavani/core-be/issues/200)) ([c313290](https://github.com/nikunjmavani/core-be/commit/c313290101b3fc845389fd77ac6fefa117f5b168))


### Fixed

* security and stability audit findings (2, 4, 5, 8, 10) ([#199](https://github.com/nikunjmavani/core-be/issues/199)) ([b5c7d1b](https://github.com/nikunjmavani/core-be/commit/b5c7d1b24398d4ca35988be07067813b0ef9929f))


### Changed

* **user:** route GDPR export through cross-domain services ([#201](https://github.com/nikunjmavani/core-be/issues/201)) ([8428600](https://github.com/nikunjmavani/core-be/commit/84286000a6f1f8573a7171d20936c72f2b1e0c5a))

## [3.3.7-dev.0](https://github.com/nikunjmavani/core-be/compare/v3.3.6-dev.0...v3.3.7-dev.0) (2026-05-31)


### Fixed

* **security:** audit remediation — 30 findings + 10 critical fixes ([#196](https://github.com/nikunjmavani/core-be/issues/196)) ([d8d1172](https://github.com/nikunjmavani/core-be/commit/d8d11724d7769ab8076ec42fba8e13525435f36b))

## [3.3.6-dev.0](https://github.com/nikunjmavani/core-be/compare/v3.3.5-dev.0...v3.3.6-dev.0) (2026-05-30)


### Fixed

* production hardening — permission RLS resolver, refresh-token reuse detection, billing/notify fail-closed ([#193](https://github.com/nikunjmavani/core-be/issues/193)) ([6d0c8eb](https://github.com/nikunjmavani/core-be/commit/6d0c8eb067cbae422d8d68fcd5a312961f79feae))
* webhook SSRF and reliability hardening (9 audit issues) ([#192](https://github.com/nikunjmavani/core-be/issues/192)) ([ae0c0d2](https://github.com/nikunjmavani/core-be/commit/ae0c0d24d60399966a790b7bf526ac3cdc17bb79))

## [3.3.5-dev.0](https://github.com/nikunjmavani/core-be/compare/v3.3.4-dev.0...v3.3.5-dev.0) (2026-05-30)


### Fixed

* **reliability:** complete audit findings 5 and 14 ([#189](https://github.com/nikunjmavani/core-be/issues/189)) ([995325f](https://github.com/nikunjmavani/core-be/commit/995325f41ed89a3dad42137795da22d76908d44d))

## [3.3.4-dev.0](https://github.com/nikunjmavani/core-be/compare/v3.3.3-dev.0...v3.3.4-dev.0) (2026-05-30)


### Fixed

* **auth:** email verification fail-closed + remediation tracker ([#188](https://github.com/nikunjmavani/core-be/issues/188)) ([e1dcac5](https://github.com/nikunjmavani/core-be/commit/e1dcac58aca03c5aa66bceb0ab93f4e6e43fed75))

## [3.3.3-dev.0](https://github.com/nikunjmavani/core-be/compare/v3.3.2-dev.0...v3.3.3-dev.0) (2026-05-30)


### Fixed

* production audit hardening — upload revocation, auth, billing, notify ([#186](https://github.com/nikunjmavani/core-be/issues/186)) ([3a0f605](https://github.com/nikunjmavani/core-be/commit/3a0f605f77afe6aabf41e307794077063f51b218))

## [3.3.2-dev.0](https://github.com/nikunjmavani/core-be/compare/v3.3.1-dev.0...v3.3.2-dev.0) (2026-05-30)


### Fixed

* **security:** production audit hardening — idempotency, auth escalation, RLS, and queue reliability ([#184](https://github.com/nikunjmavani/core-be/issues/184)) ([e8004b3](https://github.com/nikunjmavani/core-be/commit/e8004b3425dcde8c9bbc5d6e839cc63619a0c9d8))

## [3.3.1-dev.0](https://github.com/nikunjmavani/core-be/compare/v3.3.0-dev.0...v3.3.1-dev.0) (2026-05-30)


### Fixed

* production-readiness audit remediation — auth/RLS, billing, queue/DLQ, uploads, security hardening ([#182](https://github.com/nikunjmavani/core-be/issues/182)) ([91ea552](https://github.com/nikunjmavani/core-be/commit/91ea552d25c3312628005d6e0e77e755a67d1d2c))

## [3.3.0-dev.0](https://github.com/nikunjmavani/core-be/compare/v3.2.9-dev.0...v3.3.0-dev.0) (2026-05-29)


### Added

* production readiness items 3-8 (idempotency, rate-limit obs, sunset CI, restore drill, SBOM, ops scripts) ([#180](https://github.com/nikunjmavani/core-be/issues/180)) ([77792e6](https://github.com/nikunjmavani/core-be/commit/77792e632ea826dd369a1f3abb5d6d1d27e9c718))

## [3.2.9-dev.0](https://github.com/nikunjmavani/core-be/compare/v3.2.8-dev.0...v3.2.9-dev.0) (2026-05-29)


### Fixed

* production-readiness hardening (audit [#7](https://github.com/nikunjmavani/core-be/issues/7)-[#16](https://github.com/nikunjmavani/core-be/issues/16)) and /health to /livez+/readyz ([#178](https://github.com/nikunjmavani/core-be/issues/178)) ([146155b](https://github.com/nikunjmavani/core-be/commit/146155b39085e9be3bd96295f5c0e7bba720c9b7))

## [3.2.8-dev.0](https://github.com/nikunjmavani/core-be/compare/v3.2.7-dev.0...v3.2.8-dev.0) (2026-05-29)


### Fixed

* **database:** zero-downtime index migrations via concurrent non-transactional lane (audit [#6](https://github.com/nikunjmavani/core-be/issues/6)) ([#176](https://github.com/nikunjmavani/core-be/issues/176)) ([c38671b](https://github.com/nikunjmavani/core-be/commit/c38671ba372ea2faef593f3806c61b146d4f25d2))

## [3.2.7-dev.0](https://github.com/nikunjmavani/core-be/compare/v3.2.6-dev.0...v3.2.7-dev.0) (2026-05-29)


### Documentation

* add production readiness audit ([#171](https://github.com/nikunjmavani/core-be/issues/171)) ([e8fd25f](https://github.com/nikunjmavani/core-be/commit/e8fd25f6288f42999c1637b12f2c767c52df16c0))
* add Understand Anything learning curve guide ([#172](https://github.com/nikunjmavani/core-be/issues/172)) ([39f8090](https://github.com/nikunjmavani/core-be/commit/39f80907a4cfb1bc97fccf80016ab7a5faee8b8e))

## [3.2.6-dev.0](https://github.com/nikunjmavani/core-be/compare/v3.2.5-dev.0...v3.2.6-dev.0) (2026-05-29)


### Fixed

* **security:** require trust proxy hop count ([#168](https://github.com/nikunjmavani/core-be/issues/168)) ([5b0e4c8](https://github.com/nikunjmavani/core-be/commit/5b0e4c81acb644601b6a4fe45a467d3a3fb8c9b8))

## [3.2.5-dev.0](https://github.com/nikunjmavani/core-be/compare/v3.2.4-dev.0...v3.2.5-dev.0) (2026-05-29)


### Documentation

* add production readiness audit ([#167](https://github.com/nikunjmavani/core-be/issues/167)) ([baf5e96](https://github.com/nikunjmavani/core-be/commit/baf5e9694400fb55d662d754afc70aca3d293589))

## [3.2.4-dev.0](https://github.com/nikunjmavani/core-be/compare/v3.2.3-dev.0...v3.2.4-dev.0) (2026-05-29)


### Fixed

* **database:** fail closed on RLS-bypassing runtime roles ([#164](https://github.com/nikunjmavani/core-be/issues/164)) ([55f13ca](https://github.com/nikunjmavani/core-be/commit/55f13cab619e0341d4085bbe3d0842c16532548c))

## [3.2.3-dev.0](https://github.com/nikunjmavani/core-be/compare/v3.2.2-dev.0...v3.2.3-dev.0) (2026-05-29)


### Fixed

* **observability:** track RLS checkout hold time ([#162](https://github.com/nikunjmavani/core-be/issues/162)) ([611cec9](https://github.com/nikunjmavani/core-be/commit/611cec9d9c6fceeb9936f109ee1c5e738aab73d9))

## [3.2.2-dev.0](https://github.com/nikunjmavani/core-be/compare/v3.2.1-dev.0...v3.2.2-dev.0) (2026-05-29)


### Fixed

* key global rate limit by IP ([#160](https://github.com/nikunjmavani/core-be/issues/160)) ([c9d8e88](https://github.com/nikunjmavani/core-be/commit/c9d8e88e7fad60ba19c7a9f6a21580682052a939))

## [3.2.1-dev.0](https://github.com/nikunjmavani/core-be/compare/v3.2.0-dev.0...v3.2.1-dev.0) (2026-05-29)


### Fixed

* **observability:** lazy-load metrics scrape dependencies ([#156](https://github.com/nikunjmavani/core-be/issues/156)) ([9388f34](https://github.com/nikunjmavani/core-be/commit/9388f34e69946da8a092bc189bfb6c796bcf2e18))

## [3.2.0-dev.0](https://github.com/nikunjmavani/core-be/compare/v3.1.5-dev.0...v3.2.0-dev.0) (2026-05-29)


### Added

* **setup-domain:** rename to setup:domain, fix imports, add poll + batch + runbook ([#153](https://github.com/nikunjmavani/core-be/issues/153)) ([f6b2a10](https://github.com/nikunjmavani/core-be/commit/f6b2a10a16fd827828571e1823584a8c5bfba053))

## [3.1.5-dev.0](https://github.com/nikunjmavani/core-be/compare/v3.1.4-dev.0...v3.1.5-dev.0) (2026-05-28)


### Fixed

* **setup-infra:** Neon branch/role separation + pnpm 11 upgrade ([#150](https://github.com/nikunjmavani/core-be/issues/150)) ([2fe3515](https://github.com/nikunjmavani/core-be/commit/2fe35157bf2ee417128e6de418de0a3b15ec0308))


### Documentation

* refresh project readme ([#151](https://github.com/nikunjmavani/core-be/issues/151)) ([6a221d3](https://github.com/nikunjmavani/core-be/commit/6a221d3dd69996e176cb20208d3cc746c5fb79f5))

## [3.1.4-dev.0](https://github.com/nikunjmavani/core-be/compare/v3.1.3-dev.0...v3.1.4-dev.0) (2026-05-28)


### Documentation

* **tsdoc:** drive coverage budget to 0/0 ([#148](https://github.com/nikunjmavani/core-be/issues/148)) ([f40408d](https://github.com/nikunjmavani/core-be/commit/f40408d7d58560c67b476e7d5a5db5a94c787780))

## [3.1.3-dev.0](https://github.com/nikunjmavani/core-be/compare/v3.1.2-dev.0...v3.1.3-dev.0) (2026-05-28)

### Documentation

- add PR review and intake defaults ([#144](https://github.com/nikunjmavani/core-be/issues/144)) ([fc89a49](https://github.com/nikunjmavani/core-be/commit/fc89a49da75e780ee525ea8b9d9c057b0a1befb2))

## [3.1.2-dev.0](https://github.com/nikunjmavani/core-be/compare/v3.1.1-dev.0...v3.1.2-dev.0) (2026-05-28)

### Documentation

- fix stale scripts/dev path in structure-maintainer skill ([#131](https://github.com/nikunjmavani/core-be/issues/131)) ([a787a8a](https://github.com/nikunjmavani/core-be/commit/a787a8a4ac406c4ab0dfaedd62d53a9fe54032af))

## [3.1.1-dev.0](https://github.com/nikunjmavani/core-be/compare/v3.1.0-dev.0...v3.1.1-dev.0) (2026-05-28)

### Documentation

- remove redirect stub docs/index.md (use docs/README.md as canonical index) ([#128](https://github.com/nikunjmavani/core-be/issues/128)) ([2cb1c88](https://github.com/nikunjmavani/core-be/commit/2cb1c88c3e4239da60ae956a445a4ebb31dedf2a))

## [3.1.0-dev.0](https://github.com/nikunjmavani/core-be/compare/v3.0.0-dev.0...v3.1.0-dev.0) (2026-05-27)

### Added

- add environment-managed Railway and Postman secrets ([#77](https://github.com/nikunjmavani/core-be/issues/77)) ([339eee6](https://github.com/nikunjmavani/core-be/commit/339eee628862b20fa1474537526736e37449ebf1))
- **ci:** auto-merge release-please PRs ([#57](https://github.com/nikunjmavani/core-be/issues/57)) ([30204d8](https://github.com/nikunjmavani/core-be/commit/30204d8d3ee02f8e20b2b3969e80519d3e50ced1))
- **env, ci:** Railway deploy secrets in env schema + Node 24 workflow policy bumps ([#75](https://github.com/nikunjmavani/core-be/issues/75)) ([fe7d7eb](https://github.com/nikunjmavani/core-be/commit/fe7d7eb9c28dc885872ed6b202b12a6f51e48158))
- **outbound:** centralize timeout, retry, circuit, redaction, request-id ([#39](https://github.com/nikunjmavani/core-be/issues/39)) ([ce65bc1](https://github.com/nikunjmavani/core-be/commit/ce65bc14bce3749b952a61d2ddaea600ab29b556))
- **setup:** dynamic rate-limit-aware delay for GitHub env sync + Railway preflight log tweak ([#86](https://github.com/nikunjmavani/core-be/issues/86)) ([7276574](https://github.com/nikunjmavani/core-be/commit/72765742f50a7ee386e5a2cd780edbc6e54dca0c))
- **setup:** harden GitHub env sync and Railway deploy diagnostics ([#88](https://github.com/nikunjmavani/core-be/issues/88)) ([040bfa9](https://github.com/nikunjmavani/core-be/commit/040bfa9919819b3b836e1070a5e4d390da7636cb))
- **setup:** provision Railway Redis with concrete URLs ([#108](https://github.com/nikunjmavani/core-be/issues/108)) ([f2228ca](https://github.com/nikunjmavani/core-be/commit/f2228ca8ebdb44553ca48f59db8cafa7574951e9))
- **upload:** confirmation route ([#6](https://github.com/nikunjmavani/core-be/issues/6)) + presigned POST size enforcement ([#7](https://github.com/nikunjmavani/core-be/issues/7)) ([#19](https://github.com/nikunjmavani/core-be/issues/19)) ([236a036](https://github.com/nikunjmavani/core-be/commit/236a036ee4626229128c6be82b85fe7e866a3667))
- **upload:** hardening — filename extension, PENDING sweeper, per-user quota, S3 adapter contract test ([#28](https://github.com/nikunjmavani/core-be/issues/28)) ([bddb789](https://github.com/nikunjmavani/core-be/commit/bddb78904e286d3fcab00692e921d635b0676bac))

### Fixed

- add keyset pagination for large lists ([#36](https://github.com/nikunjmavani/core-be/issues/36)) ([35ca54d](https://github.com/nikunjmavani/core-be/commit/35ca54dbfe05e6ddf7cf2259273475f72db58f72))
- align worker connection budget with registered queues ([#30](https://github.com/nikunjmavani/core-be/issues/30)) ([86e927d](https://github.com/nikunjmavani/core-be/commit/86e927d2c8d6d65a857e430a7abc0dc2dc02d21e))
- **ci:** align post-deploy checks to /health contract ([#103](https://github.com/nikunjmavani/core-be/issues/103)) ([c7e7728](https://github.com/nikunjmavani/core-be/commit/c7e7728ca3c995323b82a35e753ebd1bf9fec338))
- **ci:** authenticate Railway project tokens in image deploy tool ([#100](https://github.com/nikunjmavani/core-be/issues/100)) ([6ebfd13](https://github.com/nikunjmavani/core-be/commit/6ebfd13d632c39b146fe0767d104acc204cd7846))
- **ci:** batch Railway env push, retry timeouts, exclude all RAILWAY_* ([#92](https://github.com/nikunjmavani/core-be/issues/92)) ([f27128e](https://github.com/nikunjmavani/core-be/commit/f27128e182d995767c630a9b0dfcf634fc7a0cc1))
- **ci:** bootstrap initial Railway deployments when redeploy has no history ([#94](https://github.com/nikunjmavani/core-be/issues/94)) ([61eb364](https://github.com/nikunjmavani/core-be/commit/61eb364e9051b8454cda3ef3124a888a231bf359))
- **ci:** correct post-merge-ci branch context handling ([#53](https://github.com/nikunjmavani/core-be/issues/53)) ([82a359f](https://github.com/nikunjmavani/core-be/commit/82a359f55994f5ce9daf612c2c97c94533290007))
- **ci:** deploy freshly built GHCR image via Railway GraphQL API ([#98](https://github.com/nikunjmavani/core-be/issues/98)) ([fe65954](https://github.com/nikunjmavani/core-be/commit/fe65954aee768faa040bfb08d8535fcf60fc7c59))
- **ci:** drop worker-readiness probe from deploy workflow ([#119](https://github.com/nikunjmavani/core-be/issues/119)) ([57cc48e](https://github.com/nikunjmavani/core-be/commit/57cc48e7cb9815f183a3abf7de2df1646d8648e3))
- **ci:** fail Railway deploy early on invalid RAILWAY_TOKEN ([#79](https://github.com/nikunjmavani/core-be/issues/79)) ([6b5eda1](https://github.com/nikunjmavani/core-be/commit/6b5eda17a2f5f088e8b2850463d5eae3a6071332))
- **ci:** fail-fast on missing Railway deploy secrets ([d10d464](https://github.com/nikunjmavani/core-be/commit/d10d464191786df6a61f83e7898f629e9dba3f2c))
- **ci:** probe worker readiness via Redis instead of public /health ([#117](https://github.com/nikunjmavani/core-be/issues/117)) ([9bc7bb5](https://github.com/nikunjmavani/core-be/commit/9bc7bb5c55305ab75d3317a69fe01708ec52a392))
- **ci:** Railway deploy bootstrap, Docker cache mounts, and CHANGELOG lint ([#96](https://github.com/nikunjmavani/core-be/issues/96)) ([556e75b](https://github.com/nikunjmavani/core-be/commit/556e75b3f2bb4e995b3d7e677168d68476bf12b2))
- **ci:** remove invalid secrets inherit from cd workflow_call ([#48](https://github.com/nikunjmavani/core-be/issues/48)) ([685aa75](https://github.com/nikunjmavani/core-be/commit/685aa75fc66b31d9affb0ffc7adecb7b0b6eccc5))
- **ci:** repair post-merge deploy env wiring ([#56](https://github.com/nikunjmavani/core-be/issues/56)) ([eb59666](https://github.com/nikunjmavani/core-be/commit/eb596666afb9e4c0ac154e0ea3efa0cb76ee8c51))
- **ci:** repair post-merge pipeline failures ([072392e](https://github.com/nikunjmavani/core-be/commit/072392e111af9364076135036ddf53b8c454ba6a))
- **ci:** repair post-merge pipeline failures ([003ffbe](https://github.com/nikunjmavani/core-be/commit/003ffbe44f5721203fcbbb9fc91fe57308e17d5a))
- **ci:** replace invalid env context in post-merge workflow calls ([#50](https://github.com/nikunjmavani/core-be/issues/50)) ([802b772](https://github.com/nikunjmavani/core-be/commit/802b772eca33178319fa33d0857aadd18f1358be))
- **ci:** run post-merge only on protected branches ([#52](https://github.com/nikunjmavani/core-be/issues/52)) ([3cf2215](https://github.com/nikunjmavani/core-be/commit/3cf2215935c26a3cd48921693f4fb40ed4cb2c90))
- **ci:** share Railway deploy flow and harden GraphQL calls ([#107](https://github.com/nikunjmavani/core-be/issues/107)) ([b11d881](https://github.com/nikunjmavani/core-be/commit/b11d8815cf435938e4ac312fe7c5a5f66a7cad2e))
- **ci:** stabilize post-deploy health probes ([#105](https://github.com/nikunjmavani/core-be/issues/105)) ([e835b35](https://github.com/nikunjmavani/core-be/commit/e835b354f83d063d41e35d157f9d06817cb9e3bd))
- **ci:** stabilize post-merge deploy flow ([#60](https://github.com/nikunjmavani/core-be/issues/60)) ([96fcba3](https://github.com/nikunjmavani/core-be/commit/96fcba3d1ef7c5e3c32b649447ecf97259285ded))
- **ci:** stabilize post-merge flow and pre-push gating ([#54](https://github.com/nikunjmavani/core-be/issues/54)) ([40dc82e](https://github.com/nikunjmavani/core-be/commit/40dc82eca77460e71d7dcbbdabd7a5ef6a2285ff))
- **ci:** use railway status in deploy token preflight ([#84](https://github.com/nikunjmavani/core-be/issues/84)) ([99d97dd](https://github.com/nikunjmavani/core-be/commit/99d97ddf478991824847ff921c6a587c30deadff))
- **ci:** use supported Railway redeploy command ([#90](https://github.com/nikunjmavani/core-be/issues/90)) ([d7eb03e](https://github.com/nikunjmavani/core-be/commit/d7eb03eec711f4ee7e35839a09c36d231d1c9dd2))
- document CAPTCHA production guard ([#27](https://github.com/nikunjmavani/core-be/issues/27)) ([d426f1d](https://github.com/nikunjmavani/core-be/commit/d426f1d7235033fa3e5fcde6e56c1178d5ed5544))
- enforce RS256-only JWT policy ([#32](https://github.com/nikunjmavani/core-be/issues/32)) ([293efc1](https://github.com/nikunjmavani/core-be/commit/293efc11157bf1b7cb0c633976b7c5165b8dd0d8))
- gate post-response side effects after commit ([#25](https://github.com/nikunjmavani/core-be/issues/25)) ([1d020f2](https://github.com/nikunjmavani/core-be/commit/1d020f23e42617a6212f1089b738a93ef439d2f7))
- harden observability secret redaction ([#31](https://github.com/nikunjmavani/core-be/issues/31)) ([b293c5c](https://github.com/nikunjmavani/core-be/commit/b293c5c09341224539534f756de4d8bc7179255b))
- include svg sanitizer in runtime dependencies ([1f47aed](https://github.com/nikunjmavani/core-be/commit/1f47aed1b8d84ead3de873531a8199a590f8b33e))
- **queue:** preserve rediss TLS for BullMQ Redis options ([#102](https://github.com/nikunjmavani/core-be/issues/102)) ([037c8f5](https://github.com/nikunjmavani/core-be/commit/037c8f52cdaa91c1c49b46de03e221fa7839f012))
- **redis:** use IPv6 dual-stack and drop TLS for Railway private network ([#113](https://github.com/nikunjmavani/core-be/issues/113)) ([00dd3d6](https://github.com/nikunjmavani/core-be/commit/00dd3d6a9d3fa5f3217002bc603758efcfda67fe))
- require measured DR restore RTO ([#29](https://github.com/nikunjmavani/core-be/issues/29)) ([91c01ec](https://github.com/nikunjmavani/core-be/commit/91c01ec32b018af02141b44e53cfd3de63c563c9))
- resolve major production-hardening issues (13 of 16 + partial [#2](https://github.com/nikunjmavani/core-be/issues/2)) ([#17](https://github.com/nikunjmavani/core-be/issues/17)) ([c0c6620](https://github.com/nikunjmavani/core-be/commit/c0c6620098af677bb6e49418d8aef485238beaf3))
- **setup:infra:** switch Railway Redis to template + stop GitHub env duplicates ([#115](https://github.com/nikunjmavani/core-be/issues/115)) ([ee57292](https://github.com/nikunjmavani/core-be/commit/ee572922ea4961e951a6917610665d66ec1b4aa8))
- support scoped RLS contexts ([#26](https://github.com/nikunjmavani/core-be/issues/26)) ([5ecd60c](https://github.com/nikunjmavani/core-be/commit/5ecd60c4f81d38fd6523200ad84d02ea68ce7ed0))
- use keyset pagination for large lists ([#35](https://github.com/nikunjmavani/core-be/issues/35)) ([f874a89](https://github.com/nikunjmavani/core-be/commit/f874a89415fe2a2fbbb29d4c09459af781f34f62))

### Changed

- **ci:** align post-merge sequence with release-first flow ([#51](https://github.com/nikunjmavani/core-be/issues/51)) ([4bb98b4](https://github.com/nikunjmavani/core-be/commit/4bb98b42ea4a2c5f9a1ca89d0c5e887eac4ddc1b))
- **ci:** make Railway deploy schema-driven and injection-safe ([#81](https://github.com/nikunjmavani/core-be/issues/81)) ([709c8bb](https://github.com/nikunjmavani/core-be/commit/709c8bb04b23b7df7dfe281301e99ad8087afd35))
- **ci:** rename cd workflow, restrict post-merge to merged PRs, optimize flow ([#49](https://github.com/nikunjmavani/core-be/issues/49)) ([26e49d2](https://github.com/nikunjmavani/core-be/commit/26e49d2d49f52ecddaf14c99df6033bb7e753f8e))
- **setup:** redesign setup infra workflow ([#23](https://github.com/nikunjmavani/core-be/issues/23)) ([bb7273f](https://github.com/nikunjmavani/core-be/commit/bb7273f2d9c335b5e201dc7a24cbc4b2238cfaba))

### Documentation

- **audit:** expand AuditService.record JSDoc comment ([#12](https://github.com/nikunjmavani/core-be/issues/12)) ([d01dcf0](https://github.com/nikunjmavani/core-be/commit/d01dcf0157140ae03953e4b4660f465b450ec770))
- clarify CONTRIBUTING intro wording ([#110](https://github.com/nikunjmavani/core-be/issues/110)) ([36dc9e6](https://github.com/nikunjmavani/core-be/commit/36dc9e689179635b37a0d1188d811778873290fc))

## [2.7.1](https://github.com/nikunjmavani/core-be/compare/v2.7.0...v2.7.1) (2026-05-27)

### Documentation

- clarify CONTRIBUTING intro wording ([#110](https://github.com/nikunjmavani/core-be/issues/110)) ([36dc9e6](https://github.com/nikunjmavani/core-be/commit/36dc9e689179635b37a0d1188d811778873290fc))

## [2.7.0](https://github.com/nikunjmavani/core-be/compare/v2.6.8...v2.7.0) (2026-05-27)

### Added

- **setup:** provision Railway Redis with concrete URLs ([#108](https://github.com/nikunjmavani/core-be/issues/108)) ([f2228ca](https://github.com/nikunjmavani/core-be/commit/f2228ca8ebdb44553ca48f59db8cafa7574951e9))

### Fixed

- **ci:** share Railway deploy flow and harden GraphQL calls ([#107](https://github.com/nikunjmavani/core-be/issues/107)) ([b11d881](https://github.com/nikunjmavani/core-be/commit/b11d8815cf435938e4ac312fe7c5a5f66a7cad2e))

## [2.6.8](https://github.com/nikunjmavani/core-be/compare/v2.6.7...v2.6.8) (2026-05-27)

### Fixed

- **ci:** stabilize post-deploy health probes ([#105](https://github.com/nikunjmavani/core-be/issues/105)) ([e835b35](https://github.com/nikunjmavani/core-be/commit/e835b354f83d063d41e35d157f9d06817cb9e3bd))

## [2.6.7](https://github.com/nikunjmavani/core-be/compare/v2.6.6...v2.6.7) (2026-05-27)

### Fixed

- **ci:** align post-deploy checks to /health contract ([#103](https://github.com/nikunjmavani/core-be/issues/103)) ([c7e7728](https://github.com/nikunjmavani/core-be/commit/c7e7728ca3c995323b82a35e753ebd1bf9fec338))
- **queue:** preserve rediss TLS for BullMQ Redis options ([#102](https://github.com/nikunjmavani/core-be/issues/102)) ([037c8f5](https://github.com/nikunjmavani/core-be/commit/037c8f52cdaa91c1c49b46de03e221fa7839f012))

## [2.6.6](https://github.com/nikunjmavani/core-be/compare/v2.6.5...v2.6.6) (2026-05-27)

### Fixed

- **ci:** authenticate Railway project tokens in image deploy tool ([#100](https://github.com/nikunjmavani/core-be/issues/100)) ([6ebfd13](https://github.com/nikunjmavani/core-be/commit/6ebfd13d632c39b146fe0767d104acc204cd7846))

## [2.6.5](https://github.com/nikunjmavani/core-be/compare/v2.6.4...v2.6.5) (2026-05-27)

### Fixed

- **ci:** deploy freshly built GHCR image via Railway GraphQL API ([#98](https://github.com/nikunjmavani/core-be/issues/98)) ([fe65954](https://github.com/nikunjmavani/core-be/commit/fe65954aee768faa040bfb08d8535fcf60fc7c59))

## [2.6.4](https://github.com/nikunjmavani/core-be/compare/v2.6.3...v2.6.4) (2026-05-27)

### Fixed

- **ci:** Railway deploy bootstrap, Docker cache mounts, and CHANGELOG lint ([#96](https://github.com/nikunjmavani/core-be/issues/96)) ([556e75b](https://github.com/nikunjmavani/core-be/commit/556e75b3f2bb4e995b3d7e677168d68476bf12b2))

## [2.6.3](https://github.com/nikunjmavani/core-be/compare/v2.6.2...v2.6.3) (2026-05-27)

### Fixed

- **ci:** bootstrap initial Railway deployments when redeploy has no history ([#94](https://github.com/nikunjmavani/core-be/issues/94)) ([61eb364](https://github.com/nikunjmavani/core-be/commit/61eb364e9051b8454cda3ef3124a888a231bf359))

## [2.6.2](https://github.com/nikunjmavani/core-be/compare/v2.6.1...v2.6.2) (2026-05-27)

### Fixed

- **ci:** batch Railway env push, retry timeouts, exclude all RAILWAY_* ([#92](https://github.com/nikunjmavani/core-be/issues/92)) ([f27128e](https://github.com/nikunjmavani/core-be/commit/f27128e182d995767c630a9b0dfcf634fc7a0cc1))

## [2.6.1](https://github.com/nikunjmavani/core-be/compare/v2.6.0...v2.6.1) (2026-05-27)

### Fixed

- **ci:** use supported Railway redeploy command ([#90](https://github.com/nikunjmavani/core-be/issues/90)) ([d7eb03e](https://github.com/nikunjmavani/core-be/commit/d7eb03eec711f4ee7e35839a09c36d231d1c9dd2))

## [2.6.0](https://github.com/nikunjmavani/core-be/compare/v2.5.0...v2.6.0) (2026-05-27)

### Added

- **setup:** harden GitHub env sync and Railway deploy diagnostics ([#88](https://github.com/nikunjmavani/core-be/issues/88)) ([040bfa9](https://github.com/nikunjmavani/core-be/commit/040bfa9919819b3b836e1070a5e4d390da7636cb))

## [2.5.0](https://github.com/nikunjmavani/core-be/compare/v2.4.3...v2.5.0) (2026-05-27)

### Added

- **setup:** dynamic rate-limit-aware delay for GitHub env sync + Railway preflight log tweak ([#86](https://github.com/nikunjmavani/core-be/issues/86)) ([7276574](https://github.com/nikunjmavani/core-be/commit/72765742f50a7ee386e5a2cd780edbc6e54dca0c))

## [2.4.3](https://github.com/nikunjmavani/core-be/compare/v2.4.2...v2.4.3) (2026-05-26)

### Fixed

- **ci:** use railway status in deploy token preflight ([#84](https://github.com/nikunjmavani/core-be/issues/84)) ([99d97dd](https://github.com/nikunjmavani/core-be/commit/99d97ddf478991824847ff921c6a587c30deadff))

## [2.4.2](https://github.com/nikunjmavani/core-be/compare/v2.4.1...v2.4.2) (2026-05-26)

### Changed

- **ci:** make Railway deploy schema-driven and injection-safe ([#81](https://github.com/nikunjmavani/core-be/issues/81)) ([709c8bb](https://github.com/nikunjmavani/core-be/commit/709c8bb04b23b7df7dfe281301e99ad8087afd35))

## [2.4.1](https://github.com/nikunjmavani/core-be/compare/v2.4.0...v2.4.1) (2026-05-26)

### Fixed

- **ci:** fail Railway deploy early on invalid RAILWAY_TOKEN ([#79](https://github.com/nikunjmavani/core-be/issues/79)) ([6b5eda1](https://github.com/nikunjmavani/core-be/commit/6b5eda17a2f5f088e8b2850463d5eae3a6071332))

## [2.4.0](https://github.com/nikunjmavani/core-be/compare/v2.3.0...v2.4.0) (2026-05-26)

### Added

- add environment-managed Railway and Postman secrets ([#77](https://github.com/nikunjmavani/core-be/issues/77)) ([339eee6](https://github.com/nikunjmavani/core-be/commit/339eee628862b20fa1474537526736e37449ebf1))

## [2.3.0](https://github.com/nikunjmavani/core-be/compare/v2.2.3...v2.3.0) (2026-05-26)

### Added

- **env, ci:** Railway deploy secrets in env schema + Node 24 workflow policy bumps ([#75](https://github.com/nikunjmavani/core-be/issues/75)) ([fe7d7eb](https://github.com/nikunjmavani/core-be/commit/fe7d7eb9c28dc885872ed6b202b12a6f51e48158))

## [2.2.3](https://github.com/nikunjmavani/core-be/compare/v2.2.2...v2.2.3) (2026-05-26)

### Fixed

- **ci:** fail-fast on missing Railway deploy secrets ([d10d464](https://github.com/nikunjmavani/core-be/commit/d10d464191786df6a61f83e7898f629e9dba3f2c))

## [2.2.2](https://github.com/nikunjmavani/core-be/compare/v2.2.1...v2.2.2) (2026-05-26)

### Fixed

- **ci:** repair post-merge pipeline failures ([072392e](https://github.com/nikunjmavani/core-be/commit/072392e111af9364076135036ddf53b8c454ba6a))
- **ci:** repair post-merge pipeline failures ([003ffbe](https://github.com/nikunjmavani/core-be/commit/003ffbe44f5721203fcbbb9fc91fe57308e17d5a))

## [2.2.1](https://github.com/nikunjmavani/core-be/compare/v2.2.0...v2.2.1) (2026-05-26)

### Fixed

- **ci:** stabilize post-merge deploy flow ([#60](https://github.com/nikunjmavani/core-be/issues/60)) ([96fcba3](https://github.com/nikunjmavani/core-be/commit/96fcba3d1ef7c5e3c32b649447ecf97259285ded))

## [2.2.0](https://github.com/nikunjmavani/core-be/compare/v2.1.1...v2.2.0) (2026-05-26)

### Added

- **ci:** auto-merge release-please PRs ([#57](https://github.com/nikunjmavani/core-be/issues/57)) ([30204d8](https://github.com/nikunjmavani/core-be/commit/30204d8d3ee02f8e20b2b3969e80519d3e50ced1))

### Fixed

- **ci:** repair post-merge deploy env wiring ([#56](https://github.com/nikunjmavani/core-be/issues/56)) ([eb59666](https://github.com/nikunjmavani/core-be/commit/eb596666afb9e4c0ac154e0ea3efa0cb76ee8c51))

## [2.1.0](https://github.com/nikunjmavani/core-be/compare/v2.0.0...v2.1.0) (2026-05-26)

### Added

- **outbound:** centralize timeout, retry, circuit, redaction, request-id ([#39](https://github.com/nikunjmavani/core-be/issues/39)) ([ce65bc1](https://github.com/nikunjmavani/core-be/commit/ce65bc14bce3749b952a61d2ddaea600ab29b556))
- **upload:** confirmation route ([#6](https://github.com/nikunjmavani/core-be/issues/6)) + presigned POST size enforcement ([#7](https://github.com/nikunjmavani/core-be/issues/7)) ([#19](https://github.com/nikunjmavani/core-be/issues/19)) ([236a036](https://github.com/nikunjmavani/core-be/commit/236a036ee4626229128c6be82b85fe7e866a3667))
- **upload:** hardening — filename extension, PENDING sweeper, per-user quota, S3 adapter contract test ([#28](https://github.com/nikunjmavani/core-be/issues/28)) ([bddb789](https://github.com/nikunjmavani/core-be/commit/bddb78904e286d3fcab00692e921d635b0676bac))

### Fixed

- add keyset pagination for large lists ([#36](https://github.com/nikunjmavani/core-be/issues/36)) ([35ca54d](https://github.com/nikunjmavani/core-be/commit/35ca54dbfe05e6ddf7cf2259273475f72db58f72))
- align worker connection budget with registered queues ([#30](https://github.com/nikunjmavani/core-be/issues/30)) ([86e927d](https://github.com/nikunjmavani/core-be/commit/86e927d2c8d6d65a857e430a7abc0dc2dc02d21e))
- **ci:** correct post-merge-ci branch context handling ([#53](https://github.com/nikunjmavani/core-be/issues/53)) ([82a359f](https://github.com/nikunjmavani/core-be/commit/82a359f55994f5ce9daf612c2c97c94533290007))
- **ci:** remove invalid secrets inherit from cd workflow_call ([#48](https://github.com/nikunjmavani/core-be/issues/48)) ([685aa75](https://github.com/nikunjmavani/core-be/commit/685aa75fc66b31d9affb0ffc7adecb7b0b6eccc5))
- **ci:** replace invalid env context in post-merge workflow calls ([#50](https://github.com/nikunjmavani/core-be/issues/50)) ([802b772](https://github.com/nikunjmavani/core-be/commit/802b772eca33178319fa33d0857aadd18f1358be))
- **ci:** run post-merge only on protected branches ([#52](https://github.com/nikunjmavani/core-be/issues/52)) ([3cf2215](https://github.com/nikunjmavani/core-be/commit/3cf2215935c26a3cd48921693f4fb40ed4cb2c90))
- **ci:** stabilize post-merge flow and pre-push gating ([#54](https://github.com/nikunjmavani/core-be/issues/54)) ([40dc82e](https://github.com/nikunjmavani/core-be/commit/40dc82eca77460e71d7dcbbdabd7a5ef6a2285ff))
- document CAPTCHA production guard ([#27](https://github.com/nikunjmavani/core-be/issues/27)) ([d426f1d](https://github.com/nikunjmavani/core-be/commit/d426f1d7235033fa3e5fcde6e56c1178d5ed5544))
- enforce RS256-only JWT policy ([#32](https://github.com/nikunjmavani/core-be/issues/32)) ([293efc1](https://github.com/nikunjmavani/core-be/commit/293efc11157bf1b7cb0c633976b7c5165b8dd0d8))
- gate post-response side effects after commit ([#25](https://github.com/nikunjmavani/core-be/issues/25)) ([1d020f2](https://github.com/nikunjmavani/core-be/commit/1d020f23e42617a6212f1089b738a93ef439d2f7))
- harden observability secret redaction ([#31](https://github.com/nikunjmavani/core-be/issues/31)) ([b293c5c](https://github.com/nikunjmavani/core-be/commit/b293c5c09341224539534f756de4d8bc7179255b))
- include svg sanitizer in runtime dependencies ([1f47aed](https://github.com/nikunjmavani/core-be/commit/1f47aed1b8d84ead3de873531a8199a590f8b33e))
- require measured DR restore RTO ([#29](https://github.com/nikunjmavani/core-be/issues/29)) ([91c01ec](https://github.com/nikunjmavani/core-be/commit/91c01ec32b018af02141b44e53cfd3de63c563c9))
- resolve major production-hardening issues (13 of 16 + partial [#2](https://github.com/nikunjmavani/core-be/issues/2)) ([#17](https://github.com/nikunjmavani/core-be/issues/17)) ([c0c6620](https://github.com/nikunjmavani/core-be/commit/c0c6620098af677bb6e49418d8aef485238beaf3))
- support scoped RLS contexts ([#26](https://github.com/nikunjmavani/core-be/issues/26)) ([5ecd60c](https://github.com/nikunjmavani/core-be/commit/5ecd60c4f81d38fd6523200ad84d02ea68ce7ed0))
- use keyset pagination for large lists ([#35](https://github.com/nikunjmavani/core-be/issues/35)) ([f874a89](https://github.com/nikunjmavani/core-be/commit/f874a89415fe2a2fbbb29d4c09459af781f34f62))

### Changed

- **ci:** align post-merge sequence with release-first flow ([#51](https://github.com/nikunjmavani/core-be/issues/51)) ([4bb98b4](https://github.com/nikunjmavani/core-be/commit/4bb98b42ea4a2c5f9a1ca89d0c5e887eac4ddc1b))
- **ci:** rename cd workflow, restrict post-merge to merged PRs, optimize flow ([#49](https://github.com/nikunjmavani/core-be/issues/49)) ([26e49d2](https://github.com/nikunjmavani/core-be/commit/26e49d2d49f52ecddaf14c99df6033bb7e753f8e))
- **setup:** redesign setup infra workflow ([#23](https://github.com/nikunjmavani/core-be/issues/23)) ([bb7273f](https://github.com/nikunjmavani/core-be/commit/bb7273f2d9c335b5e201dc7a24cbc4b2238cfaba))

### Documentation

- **audit:** expand AuditService.record JSDoc comment ([#12](https://github.com/nikunjmavani/core-be/issues/12)) ([d01dcf0](https://github.com/nikunjmavani/core-be/commit/d01dcf0157140ae03953e4b4660f465b450ec770))
