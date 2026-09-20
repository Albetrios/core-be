/**
 * MCP (Model Context Protocol) server that exposes this project's APIs as tools and resources.
 * When the backend is running, frontends (or AI agents) can connect to the MCP endpoint
 * to discover and call APIs without separate API documentation.
 *
 * Resource URIs are `{PROJECT_SLUG}://…`, built from the generated project identity:
 * - Resource {@link MCP_OPENAPI_RESOURCE_URI}: OpenAPI 3.0 spec (paths, schemas, request/response)
 * - Resource {@link MCP_ROUTES_RESOURCE_URI}: route catalog (method, path, access)
 * - Tool `call_api`: call any API endpoint (method, path, optional body/headers); forwards auth via headers
 *
 * The @modelcontextprotocol/sdk package is an optional dependency; load it via loadMcpSdk() only when MCP is enabled.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { GLOBAL_ROLES } from '@/shared/constants/index.js';
import {
  MCP_CLIENT_GUIDE_RESOURCE_URI,
  MCP_OPENAPI_RESOURCE_URI,
  MCP_RESOURCES,
  MCP_ROUTES_RESOURCE_URI,
  MCP_TOOLS,
  callApiInputSchema,
  evaluateCallApiPolicy,
} from '@/infrastructure/mcp/mcp-capabilities.js';
import { MCP_CLIENT_GUIDE } from '@/infrastructure/mcp/mcp-client-guide.js';
import { requireRole } from '@/shared/utils/auth/authorization.util.js';
import { STRICT_AUTHED_RATE_LIMIT } from '@/shared/middlewares/rate-limit/rate-limit-presets.constants.js';
import { getEnv } from '@/shared/config/env.config.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';

const ROUTES_CATALOG_PATH = join(process.cwd(), 'docs', 'routes.txt');
const OPENAPI_SPEC_PATH = join(process.cwd(), 'docs', 'openapi', 'openapi.json');

type McpSdk = {
  McpServer: typeof McpServer;
  StreamableHTTPServerTransport: typeof StreamableHTTPServerTransport;
};

let cachedMcpSdk: McpSdk | null = null;

/** Loads the optional MCP SDK (cached after first successful load). */
export async function loadMcpSdk(): Promise<McpSdk> {
  if (cachedMcpSdk !== null) {
    return cachedMcpSdk;
  }
  const [mcpModule, streamableHttpModule] = await Promise.all([
    import('@modelcontextprotocol/sdk/server/mcp.js'),
    import('@modelcontextprotocol/sdk/server/streamableHttp.js'),
  ]);
  cachedMcpSdk = {
    McpServer: mcpModule.McpServer,
    StreamableHTTPServerTransport: streamableHttpModule.StreamableHTTPServerTransport,
  };
  return cachedMcpSdk;
}

function loadRoutesCatalog(): string {
  try {
    return readFileSync(ROUTES_CATALOG_PATH, 'utf-8');
  } catch {
    return 'Route catalog not available. Run pnpm routes:catalog to generate docs/routes.txt.';
  }
}

function loadOpenApiSpec(): string {
  try {
    return readFileSync(OPENAPI_SPEC_PATH, 'utf-8');
  } catch {
    return JSON.stringify({
      error:
        'OpenAPI spec not available. Run pnpm docs:generate to produce docs/openapi/openapi.json.',
    });
  }
}

/**
 * Construction parameters for {@link createMcpServer}. `inject` is the in-process HTTP
 * back-channel (Fastify `app.inject`) the `call_api` tool uses to invoke real route
 * handlers without an external network hop.
 */
export type CreateMcpServerOptions = {
  name: string;
  version: string;
  inject: (options: {
    method: string;
    url: string;
    payload?: unknown;
    headers?: Record<string, string>;
  }) => Promise<{ statusCode: number; payload: unknown; headers: Record<string, string> }>;
};

/** Concrete instance type of the lazily-loaded `@modelcontextprotocol/sdk` `McpServer`. */
export type McpServerInstance = InstanceType<McpSdk['McpServer']>;
/** Concrete instance type of the lazily-loaded `StreamableHTTPServerTransport`. */
export type McpTransportInstance = InstanceType<McpSdk['StreamableHTTPServerTransport']>;

/**
 * Creates and configures the MCP server with a routes resource and call_api tool.
 * Does not connect to a transport; caller must call server.connect(transport).
 */
export function createMcpServer(options: CreateMcpServerOptions, sdk: McpSdk): McpServerInstance {
  const { name, version, inject } = options;
  const { McpServer } = sdk;
  const routesCatalog = loadRoutesCatalog();
  const openApiSpec = loadOpenApiSpec();

  const server = new McpServer(
    { name, version },
    {
      capabilities: {
        tools: { listChanged: false },
        resources: { listChanged: false },
      },
    },
  );

  const openApiResource = MCP_RESOURCES.find(
    (resource) => resource.uri === MCP_OPENAPI_RESOURCE_URI,
  );
  const routesResource = MCP_RESOURCES.find((resource) => resource.uri === MCP_ROUTES_RESOURCE_URI);
  const clientGuideResource = MCP_RESOURCES.find(
    (resource) => resource.uri === MCP_CLIENT_GUIDE_RESOURCE_URI,
  );
  const callApiTool = MCP_TOOLS.find((tool) => tool.name === 'call_api');
  if (!(openApiResource && routesResource && clientGuideResource && callApiTool)) {
    throw new Error('MCP resource/tool catalog is incomplete');
  }

  server.registerResource(
    openApiResource.name,
    MCP_OPENAPI_RESOURCE_URI,
    {
      title: openApiResource.title,
      description: openApiResource.description,
      mimeType: openApiResource.mimeType,
    },
    async () => ({
      contents: [
        {
          uri: MCP_OPENAPI_RESOURCE_URI,
          mimeType: 'application/json',
          text: openApiSpec,
        },
      ],
    }),
  );

  server.registerResource(
    routesResource.name,
    MCP_ROUTES_RESOURCE_URI,
    {
      title: routesResource.title,
      description: routesResource.description,
      mimeType: routesResource.mimeType,
    },
    async () => ({
      contents: [
        {
          uri: MCP_ROUTES_RESOURCE_URI,
          mimeType: 'text/plain',
          text: routesCatalog,
        },
      ],
    }),
  );

  server.registerResource(
    clientGuideResource.name,
    MCP_CLIENT_GUIDE_RESOURCE_URI,
    {
      title: clientGuideResource.title,
      description: clientGuideResource.description,
      mimeType: clientGuideResource.mimeType,
    },
    async () => ({
      contents: [
        {
          uri: MCP_CLIENT_GUIDE_RESOURCE_URI,
          mimeType: 'text/markdown',
          text: MCP_CLIENT_GUIDE,
        },
      ],
    }),
  );

  server.registerTool(
    callApiTool.name,
    {
      title: callApiTool.title,
      description: callApiTool.description,
      inputSchema: callApiInputSchema,
    },
    async (args) => {
      const parsed = callApiInputSchema.safeParse(args);
      if (!parsed.success) {
        return {
          content: [{ type: 'text', text: `Invalid arguments: ${parsed.error.message}` }],
          isError: true,
        };
      }
      const data = parsed.data;
      const environment = getEnv();
      // R14: call_api is an admin-authority in-process API proxy. Every gate (path, read-only-by-
      // default method, optional operator allowlist) is consolidated in evaluateCallApiPolicy so it
      // is pure and unit-testable. Mutating methods require explicit MCP_CALL_API_ALLOW_MUTATIONS.
      const policy = evaluateCallApiPolicy({
        method: data.method,
        path: data.path,
        allowMutations: environment.MCP_CALL_API_ALLOW_MUTATIONS,
        allowedPathPrefixes: environment.MCP_CALL_API_ALLOWED_PATH_PREFIXES,
      });
      if (!policy.allowed) {
        return { content: [{ type: 'text', text: policy.message }], isError: true };
      }
      try {
        // Strip headers that could override authentication, session identity, or tenant context.
        // The MCP endpoint itself is admin-authenticated; the injected sub-request must not be
        // able to impersonate a different principal or pivot tenant context via caller-supplied
        // header overrides. route-#8 hardening kept even though the API no longer reads x-organization-id, so a
        // caller must not be able to set it on the proxied sub-request; the sub-request derives
        // its organization the same way every other request does.
        const BLOCKED_HEADERS = new Set([
          'authorization',
          'cookie',
          'set-cookie',
          'x-csrf-token',
          'x-forwarded-for',
          'x-real-ip',
          'x-organization-id',
        ]);
        const safeHeaders: Record<string, string> = {};
        for (const [key, value] of Object.entries(data.headers ?? {})) {
          if (!BLOCKED_HEADERS.has(key.toLowerCase())) {
            // eslint-disable-next-line security/detect-object-injection -- key filtered via BLOCKED_HEADERS allowlist above.
            safeHeaders[key] = value;
          }
        }
        const result = await inject({
          method: data.method,
          url: data.path,
          payload: data.body,
          headers: safeHeaders,
        });
        const responseBody =
          typeof result.payload === 'object' && result.payload !== null
            ? JSON.stringify(result.payload)
            : String(result.payload);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                statusCode: result.statusCode,
                headers: result.headers,
                body: responseBody,
              }),
            },
          ],
        };
      } catch (error) {
        // R14: MCP responses bypass the global error-handler masker (reply.hijack), so do NOT
        // reflect the raw error to the client — log the detail server-side, return a generic message.
        logger.warn({ error, method: data.method, path: data.path }, 'mcp.call_api.failed');
        return {
          content: [{ type: 'text', text: 'API call failed (see server logs for details).' }],
          isError: true,
        };
      }
    },
  );

  return server;
}

/**
 * Pair of MCP server + transport that must be created together: stateless mode requires
 * a fresh transport per request, so callers cannot reuse them across requests.
 */
export type McpTransportAndServer = {
  transport: McpTransportInstance;
  server: McpServerInstance;
};

/**
 * Creates the MCP server and Streamable HTTP transport (stateless, JSON response).
 * Caller must register the transport's handleRequest with Fastify and then connect the server to the transport.
 */
export function createMcpTransportAndServer(
  options: CreateMcpServerOptions,
  sdk: McpSdk,
): McpTransportAndServer {
  const server = createMcpServer(options, sdk);
  const transport = new sdk.StreamableHTTPServerTransport({
    enableJsonResponse: true,
  });
  return { transport, server };
}

type McpRouteOptions = {
  name: string;
  version: string;
};

/**
 * Registers MCP HTTP handlers on the given Fastify scope.
 * When ENABLE_MCP_SERVER is true, GET and POST /api/v1/mcp handle MCP requests:
 * - POST: JSON-RPC (initialize, tools/list, call_api, etc.).
 * - GET: SSE stream for client connection flow (returns an event-stream; may stay idle in JSON response mode).
 *
 * Stateless mode (sessionIdGenerator: undefined) requires a new transport per request;
 * the SDK rejects reuse. So we create a new transport and server per request.
 */
export async function registerMcpRouteHandlers(
  app: FastifyInstance,
  options: McpRouteOptions,
): Promise<void> {
  const sdk = await loadMcpSdk();

  const inject = async (opts: {
    method: string;
    url: string;
    payload?: unknown;
    headers?: Record<string, string>;
  }) => {
    const injectOptions: InjectOptions = {
      method: opts.method as 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
      url: opts.url,
      headers: opts.headers ?? {},
    };
    if (opts.payload !== undefined) {
      injectOptions.payload = opts.payload as NonNullable<InjectOptions['payload']>;
    }
    const response = await app.inject(injectOptions);
    let payload: unknown;
    try {
      payload = response.json();
    } catch {
      payload = response.body;
    }
    const headersRecord: Record<string, string> = {};
    for (const [key, value] of Object.entries(response.headers)) {
      if (typeof value === 'string') {
        // eslint-disable-next-line security/detect-object-injection -- key from Object.entries iteration over server-built headers.
        headersRecord[key] = value;
      } else if (Array.isArray(value) && value[0]) {
        // eslint-disable-next-line security/detect-object-injection -- key from Object.entries iteration over server-built headers.
        headersRecord[key] = String(value[0]);
      }
    }
    return {
      statusCode: response.statusCode,
      payload,
      headers: headersRecord,
    };
  };

  async function handleMcpRequest(
    nodeRequest: IncomingMessage,
    nodeResponse: ServerResponse,
    parsedBody: unknown,
    callerToken: string | undefined,
  ): Promise<void> {
    // Forward the verified MCP caller's JWT into every sub-request so that
    // downstream route handlers authenticate as the MCP principal — without
    // this the sub-request would arrive unauthenticated (the outer BLOCKED_HEADERS
    // guard strips any caller-supplied `authorization` header, but we must still
    // inject the already-verified one that app.authenticate accepted on the MCP route).
    const requestInject: typeof inject = (opts) =>
      inject({
        ...opts,
        headers: {
          ...(callerToken ? { authorization: callerToken } : {}),
          ...opts.headers,
        },
      });

    const { transport, server } = createMcpTransportAndServer(
      {
        ...options,
        inject: requestInject,
      },
      sdk,
    );
    await server.connect(transport as Parameters<McpServerInstance['connect']>[0]);
    await transport.handleRequest(nodeRequest, nodeResponse, parsedBody);
  }

  app.get(
    '/api/v1/mcp',
    {
      ...STRICT_AUTHED_RATE_LIMIT,
      schema: {
        summary: 'MCP streamable HTTP (GET)',
        description: `Model Context Protocol endpoint when \`ENABLE_MCP_SERVER=true\`. Exposes resources \`${MCP_OPENAPI_RESOURCE_URI}\` and \`${MCP_ROUTES_RESOURCE_URI}\`, plus the \`call_api\` tool for in-process API invocation. Requires JWT with global \`admin\` or \`super_admin\` role. See docs/integrations/cursor-backend-mcp.md.`,
        tags: ['MCP'],
      },
    },
    async (request, reply) => {
      reply.hijack();
      await handleMcpRequest(request.raw, reply.raw, undefined, request.headers.authorization);
    },
  );

  app.post(
    '/api/v1/mcp',
    {
      ...STRICT_AUTHED_RATE_LIMIT,
      schema: {
        summary: 'MCP streamable HTTP (POST)',
        description:
          'Primary MCP transport for Cursor and other MCP clients. Same auth and capabilities as GET. Request and response bodies follow the MCP streamable HTTP specification.',
        tags: ['MCP'],
      },
    },
    async (request, reply) => {
      reply.hijack();
      await handleMcpRequest(request.raw, reply.raw, request.body, request.headers.authorization);
    },
  );
}

/**
 * Registers the MCP endpoint with JWT authentication and admin role required.
 * MCP can proxy arbitrary API calls — must not be exposed without authentication.
 */
export async function registerMcpRoute(
  app: FastifyInstance,
  options: { name: string; version: string },
): Promise<void> {
  if (!app.authenticate) {
    throw new Error('MCP routes require Fastify authenticate decorator');
  }

  const adminPreHandlers = [app.authenticate, requireRole(GLOBAL_ROLES.SUPER_ADMIN)] as const;

  await app.register(
    async (scope) => {
      scope.addHook('preHandler', async (request, reply) => {
        for (const handler of adminPreHandlers) {
          await handler.call(scope, request, reply);
        }
      });
      await registerMcpRouteHandlers(scope, options);
    },
    { prefix: '' },
  );
}
