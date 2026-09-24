/** Types for check-load-coverage.mjs — the k6 load-test route coverage audit (see that file). */

/** One route line of docs/routes.txt. */
export interface CatalogRoute {
  readonly method: string;
  readonly path: string;
  readonly auth: string;
}

/** A k6 scenario file: its name and source. */
export interface ScenarioFile {
  readonly name: string;
  readonly content: string;
}

/** One request a scenario makes, its path normalized for matching (`:param` for dynamic parts). */
export interface ScenarioRequest {
  readonly method: string;
  readonly path: string;
}

/** The coverage of the required routes by a set of scenario files. */
export interface LoadCoverage {
  readonly required: CatalogRoute[];
  readonly covered: CatalogRoute[];
  readonly uncovered: CatalogRoute[];
  readonly excluded: CatalogRoute[];
  readonly coveringFiles: Map<CatalogRoute, string[]>;
}

/** Parses the catalog table: one route per route line. */
export function parseRoutes(content: string): CatalogRoute[];
/** True for routes k6 coverage is not required for (ROLE, TOKEN, public infrastructure). */
export function isExcluded(route: Pick<CatalogRoute, 'auth' | 'path'>): boolean;
/** A scenario URL literal (quotes included) as a catalog-comparable path, or null. */
export function normalizeScenarioPath(literal: string): string | null;
/** Every request a scenario file makes. */
export function extractScenarioRequests(content: string): ScenarioRequest[];
/** Every scenario file under src/tests/load/k6/scenarios/. */
export function loadScenarioFiles(): ScenarioFile[];
/** The scenario file names a workflow's source references. */
export function nightlyScenarioNames(workflowContent: string): string[];
/** The scenario files the nightly workflow runs. */
export function loadNightlyScenarioFiles(): ScenarioFile[];
/** docs/routes.txt, parsed. */
export function loadRoutes(): CatalogRoute[];
/** Matches the scenarios' requests to the required routes. */
export function computeCoverage(input: {
  routes: CatalogRoute[];
  scenarios: ScenarioFile[];
}): LoadCoverage;
