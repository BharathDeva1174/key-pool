import Fastify, { LogController, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyCors from '@fastify/cors';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppContext } from './context.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerCostRoutes } from './routes/costs.js';
import { registerIntelligenceRoutes } from './routes/intelligence.js';
import { handleChatCompletions } from './proxy/chatCompletions.js';
import { listPooledModels, findPooledModel } from './proxy/models.js';
import { anthropicError, anthropicErrorType } from './proxy/anthropic/outbound.js';
import { estimateInputTokens, type AnthropicMessagesRequest } from './proxy/anthropic/inbound.js';
import { verifyUnifiedKey } from './auth/keyGuard.js';
import { detectClientCategory } from './core/clientIdentity.js';
import { openAIError } from './core/errors.js';

const HERE = dirname(fileURLToPath(import.meta.url));
// dist/ -> server/ -> repo root
const REPO_ROOT = resolve(HERE, '..', '..');
const WEB_DIST = join(REPO_ROOT, 'web', 'dist');

/** Best-effort model extraction for logging, which must never throw. */
function readRequestedModel(body: unknown): string {
  try {
    const parsed: unknown = typeof body === 'string' ? JSON.parse(body) : body;
    if (parsed && typeof parsed === 'object' && typeof (parsed as { model?: unknown }).model === 'string') {
      return (parsed as { model: string }).model;
    }
  } catch {
    /* unparseable body */
  }
  return '(unknown)';
}

export interface BuildAppOptions {
  logLevel?: string;
  /** Enables permissive CORS for the Vite dev server. Off in production. */
  devCors?: boolean;
  /** Serve the built SPA. Disabled in tests, which only exercise the API. */
  serveDashboard?: boolean;
}

export async function buildApp(ctx: AppContext, options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: options.logLevel ?? 'info' },
    /*
     * Pino's automatic per-request pair - "incoming request" and "request
     * completed" - is the single largest source of terminal output here, and
     * the least useful: this process is a proxy sitting in front of a wall
     * display, so a client retrying is normal traffic, not an event. The
     * dashboard's request log is the record of what happened; stdout is for
     * what the process itself has to say.
     *
     * `KEYPOOL_LOG_LEVEL=debug` puts them back when diagnosing something.
     *
     * Spelled through `logController` rather than the top-level
     * `disableRequestLogging`, which is deprecated in Fastify 5 and prints a
     * warning of its own - noise in a change made to remove noise.
     */
    logController: new LogController({ disableRequestLogging: true }),
    // A proxied chat body can be large; keep the default limit but raise it.
    bodyLimit: 32 * 1024 * 1024,
  });

  // Bodies are captured as raw strings so the proxy can forward JSON with
  // minimal re-serialisation and the admin API can validate before parsing.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'string' }, (_req, payload, done) => {
    done(null, payload);
  });

  if (options.devCors) {
    await app.register(fastifyCors, { origin: true, credentials: true });
  }

  // ----------------------------------------------------------------- /v1 API

  // Auth runs at preHandler rather than onRequest so the body is already
  // parsed: that lets a rejected request still be recorded in the log with the
  // model it asked for, instead of vanishing from the dashboard.
  app.addHook('preHandler', async (request, reply) => {
    /*
     * A liveness probe sent by clients that check a base URL is reachable
     * before doing anything else. It carries no key, so guarding it would
     * report the proxy as broken when it is working - the one answer a
     * reachability check cannot use.
     */
    if (request.url.startsWith('/v1/api/hello')) return;
    // The Anthropic surface is the same pool behind the same guard, so it is
    // authenticated identically. `x-api-key` is already one of the headers
    // verifyUnifiedKey reads, which is what an Anthropic SDK sends.
    if (!request.url.startsWith('/v1') && !request.url.startsWith('/anthropic/v1')) return;
    const result = verifyUnifiedKey(ctx.settings.all, request.headers as Record<string, unknown>);
    if (result.authorized) return;

    const message =
      result.reason === 'disabled'
        ? 'Unauthorized.'
        : result.reason === 'missing'
          ? 'Missing API key. Send it as "Authorization: Bearer <key>".'
          : result.reason === 'unconfigured'
            ? 'No unified API key has been generated yet.'
            : 'Incorrect API key.';

    const startedAt = Date.now();
    const requestedModel = readRequestedModel(request.body);
    if (ctx.settings.get('logRequests')) {
      ctx.recorder.record({
        ts: startedAt,
        requestedModel,
        aliasId: null,
        entryId: null,
        endpointName: null,
        credentialLabel: null,
        upstreamModel: null,
        success: false,
        statusCode: 401,
        errorKind: 'authentication_error',
        errorMessage: message,
        attempts: 0,
        strategy: null,
        streaming: false,
        latencyMs: Date.now() - startedAt,
        ttfbMs: null,
        promptTokens: null,
        completionTokens: null,
        totalTokens: null,
        // A rejected request still says who tried: a wave of 401s on the
        // console with no client named is half a diagnosis.
        clientCategory: detectClientCategory(request.headers as Record<string, unknown>),
      });
    }

    // A client that speaks Anthropic parses its own error envelope, and would
    // otherwise report an authentication failure as an unparseable body.
    if (request.url.startsWith('/anthropic/v1')) {
      return reply.code(401).send(anthropicError('authentication_error', message));
    }
    return reply.code(401).send(openAIError(message, 'authentication_error', `invalid_${result.reason}`));
  });

  app.post('/v1/chat/completions', async (request, reply) => {
    await handleChatCompletions(request, reply, {
      db: ctx.db,
      store: ctx.store,
      settings: ctx.settings,
      poolState: ctx.poolState,
      recorder: ctx.recorder,
    });
  });

  app.get('/v1/models', async () => listPooledModels(ctx.store));

  // Answers the reachability probe described on the preHandler hook above.
  app.all('/v1/api/hello', async () => ({ ok: true }));

  /*
   * Per-model lookup, addressed by a wildcard rather than `:id`.
   *
   * A model id in this pool routinely contains a slash - `stealth/space-bunny-alpha`,
   * `minimax/minimax-m3:free` - and a single-segment `:id` cannot match one. A
   * client that resolves a model with `GET /v1/models/{id}` before dispatching
   * therefore got a bare route 404 for every such id and reported the pool as not
   * knowing the model, while the same name sat in `GET /v1/models` all along.
   * `*` matches across slashes.
   *
   * find-my-way decodes the captured remainder, so `stealth%2Fspace-bunny-alpha`
   * resolves to the same entry as the raw form rather than becoming a second,
   * differently-spelled model that only one spelling can find.
   *
   * Shared by both dialects, the way `handleChatCompletions` is: the lookup and
   * the list are one catalogue, and only the error envelope differs.
   */
  const modelLookup = (dialect: 'openai' | 'anthropic') => async (request: FastifyRequest, reply: FastifyReply) => {
    const id = (request.params as { '*': string })['*'];
    // `/v1/models/` is the list under a trailing slash, not a lookup of ''.
    if (id === '') return listPooledModels(ctx.store);
    const model = findPooledModel(ctx.store, id);
    if (!model) {
      const message = `Model "${id}" is not available in this pool.`;
      return reply
        .code(404)
        .send(dialect === 'anthropic'
          ? anthropicError(anthropicErrorType(404), message)
          : openAIError(message, 'not_found_error', 'model_not_found'));
    }
    return model;
  };

  app.get('/v1/models/*', modelLookup('openai'));

  /*
   * The Anthropic dialect.
   *
   * A separate path rather than content-type sniffing on `/v1`: sniffing risks
   * an existing OpenAI client being routed into a translation it never asked
   * for. Pointing an agent's `ANTHROPIC_BASE_URL` at `.../anthropic` is enough
   * to have it address this surface and nothing else.
   *
   * The same endpoints are also served on `/v1`. A client handed the OpenAI base
   * URL appends `/v1/messages` to it and lands on `/v1/v1/messages`, which is a
   * natural thing for an operator to configure and an unhelpful thing to debug.
   * The dialect still follows the path, never the content type.
   */
  const anthropicMessages = async (request: FastifyRequest, reply: FastifyReply) => {
    await handleChatCompletions(
      request,
      reply,
      { db: ctx.db, store: ctx.store, settings: ctx.settings, poolState: ctx.poolState, recorder: ctx.recorder },
      { dialect: 'anthropic' },
    );
  };

  app.post('/anthropic/v1/messages', anthropicMessages);
  app.post('/v1/messages', anthropicMessages);

  /*
   * `count_tokens` is not optional for an agent — Claude Code calls it before
   * every turn to size its context — and a 404 here reads as a broken proxy.
   *
   * Answered locally and approximately. The real count belongs to whichever
   * upstream serves the request, which is not knowable before routing, and
   * asking one would cost a round trip per turn to return a figure the client
   * only uses comparatively.
   */
  const countTokens = async (request: FastifyRequest, reply: FastifyReply) => {
    let parsed: unknown = null;
    try {
      parsed = typeof request.body === 'string' ? JSON.parse(request.body) : request.body;
    } catch {
      return reply.code(400).send(anthropicError('invalid_request_error', 'Body is not valid JSON.'));
    }
    const inputTokens = estimateInputTokens((parsed ?? {}) as AnthropicMessagesRequest);
    return reply.send({ input_tokens: inputTokens });
  };

  app.post('/anthropic/v1/messages/count_tokens', countTokens);
  app.post('/v1/messages/count_tokens', countTokens);

  // The same synthesised list the OpenAI surface serves, so a client that
  // enumerates models finds the same names in either dialect.
  app.get('/anthropic/v1/models', async () => listPooledModels(ctx.store));

  // ...and the same per-model lookup, so an Anthropic-dialect client that
  // fetches one model is answered identically rather than 404-ing on a route
  // that was never registered here.
  app.get('/anthropic/v1/models/*', modelLookup('anthropic'));

  // ------------------------------------------------------------- admin API

  await app.register(async (scope) => {
    scope.addHook('onRequest', async (request, reply) => {
      if (!ctx.settings.get('requireApiKeyForAdmin')) return;
      const result = verifyUnifiedKey(ctx.settings.all, request.headers as Record<string, unknown>);
      if (result.authorized) return;
      return reply.code(401).send({ error: 'Admin API is locked. Send the unified API key.' });
    });
    await registerAdminRoutes(scope, ctx);
    // Same guarded scope, different failure posture - see the header of
    // routes/costs.ts for why it is not inside admin.ts. No-op when the
    // context carries no cost store.
    await registerCostRoutes(scope, ctx);
    await registerIntelligenceRoutes(scope, ctx);
  });

  app.get('/api/health', async () => {
    const entries = ctx.store.listModelEntries();
    return {
      status: 'ok',
      uptimeSeconds: Math.round(process.uptime()),
      entries: entries.length,
      enabledEntries: entries.filter((e) => e.enabled).length,
      version: 1,
    };
  });

  // ------------------------------------------------------------- dashboard

  const hasDashboard = (options.serveDashboard ?? true) && existsSync(join(WEB_DIST, 'index.html'));
  if (hasDashboard) {
    await app.register(fastifyStatic, { root: WEB_DIST, index: ['index.html'] });
  }

  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith('/api/') || request.url.startsWith('/v1/') || request.url.startsWith('/anthropic/')) {
      return reply.code(404).send(openAIError(`No route for ${request.method} ${request.url}.`, 'invalid_request_error', 'not_found'));
    }
    if (hasDashboard) {
      return reply.type('text/html').sendFile('index.html');
    }
    return reply.code(404).type('text/plain').send(
      'KeyPool server is running, but the dashboard has not been built.\n' +
        'Run `pnpm build` (or start via run.bat) and reload.\n',
    );
  });

  app.setErrorHandler((error: Error & { statusCode?: number }, request, reply) => {
    request.log.error({ err: error }, 'unhandled error');
    if (reply.sent) return;
    const status = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
    if (request.url.startsWith('/v1/')) {
      return reply.code(status).send(openAIError(error.message || 'Internal error.', 'api_error', 'internal'));
    }
    return reply.code(status).send({ error: error.message || 'Internal error.' });
  });

  return app;
}
