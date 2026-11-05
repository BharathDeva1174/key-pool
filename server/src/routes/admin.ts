import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { parseBulkKeys, type BulkFormat } from '../core/bulkKeys.js';
import { COMPAT_PROFILES } from '../core/compat.js';
import { pingEntries, pingEntry } from '../upstream/probe.js';
import { STRATEGY_DESCRIPTIONS, STRATEGY_NAMES, type StrategyName } from '../routing/strategies.js';
import { RESTART_REQUIRED_KEYS, type Settings } from '../settings.js';
import { normalizeBaseUrl } from '../core/url.js';
import { computeStreak, earnedTiers, heatLevel, heatmapRange, localDayKey, nextTier } from '../stats/streak.js';
import type { Endpoint } from '../upstream/store.js';

/** The `count` local days ending with the one containing `now`, oldest first. */
function lastDayKeys(now: number, count: number): string[] {
  const keys: string[] = [];
  for (let i = count - 1; i >= 0; i--) keys.push(localDayKey(now - i * 86_400_000));
  return keys;
}

function body<T = Record<string, unknown>>(request: FastifyRequest): T {
  const raw = request.body;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as T;
    } catch {
      return {} as T;
    }
  }
  return (raw ?? {}) as T;
}

const BulkPayload = z.object({
  /**
   * The pasted text, or an array of keys for scripted/CLI callers.
   *
   * Required and non-empty: an import with nothing in it should be rejected,
   * not silently reported back as a successful import of zero keys.
   */
  payload: z
    .union([z.string(), z.array(z.string())])
    .transform((v) => (Array.isArray(v) ? v.join('\n') : v))
    .pipe(z.string().min(1, 'A non-empty payload is required.')),
  format: z.enum(['auto', 'text', 'json', 'csv']).optional(),
  modelIds: z.array(z.string()).optional(),
  autoPing: z.boolean().optional(),
  priority: z.number().int().optional(),
  weight: z.number().int().optional(),
});

const QuickAdd = z.object({
  baseUrl: z.string().min(1),
  apiKey: z.string().min(1),
  modelId: z.string().min(1),
  name: z.string().optional(),
  autoPing: z.boolean().optional(),
  authType: z.enum(['bearer', 'none', 'header', 'query']).optional(),
  authHeader: z.string().nullable().optional(),
  authPrefix: z.string().nullable().optional(),
  extraHeaders: z.record(z.string(), z.string()).optional(),
});

const EndpointCreate = z.object({
  name: z.string().optional(),
  baseUrl: z.string().min(1),
  authType: z.enum(['bearer', 'none', 'header', 'query']).optional(),
  authHeader: z.string().nullable().optional(),
  authPrefix: z.string().nullable().optional(),
  extraHeaders: z.record(z.string(), z.string()).optional(),
  compatProfile: z.enum(COMPAT_PROFILES).nullable().optional(),
});

const BulkPreview = z.object({
  payload: z.string(),
  format: z.enum(['auto', 'text', 'json', 'csv']).optional(),
});

const ImportKeys = BulkPayload.extend({
  baseUrl: z.string().min(1),
  name: z.string().optional(),
});

/**
 * Turns a provider name into something safe to write to a filesystem.
 *
 * The name is operator-supplied and ends up as a download filename, so it has
 * to survive Windows, macOS and Linux: no path separators, no reserved
 * characters, no control characters, no leading dots, and short enough to
 * write. Two providers that sanitise to the same name would collide, so the
 * endpoint id is appended to keep backups distinguishable.
 */
function exportFileName(name: string, endpointId: string): string {
  const cleaned = name
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"|?*\\/]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '')
    // A name made only of separators sanitises to a run of dashes: legal on
    // disk, but useless as a filename. Collapsing that to nothing is what lets
    // the fallback below actually fire.
    .replace(/^[\s-]+|[\s-]+$/g, '')
    .trim()
    .slice(0, 80);
  return `${cleaned || 'provider'}-${endpointId}.txt`;
}

/**
 * Reads an alias strategy out of a request body.
 *
 * Three outcomes, and the difference matters:
 * - `undefined` - the field was not sent, so a PATCH leaves the stored strategy
 *   alone rather than silently resetting it.
 * - `null` - the operator sent nothing usable, meaning "inherit whatever is set
 *   in Settings". A name that is not a real strategy is treated the same way
 *   rather than stored, because `orderCandidates` has no case for it and would
 *   quietly fall through to pool order.
 * - a `StrategyName` - use this one for the alias.
 */
function readAliasStrategy(raw: unknown): StrategyName | null | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const value = raw.trim();
  return STRATEGY_NAMES.includes(value as StrategyName) ? (value as StrategyName) : null;
}

/** Registers the dashboard-facing REST API. */
export async function registerAdminRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { store, settings, poolState, recorder, queries } = ctx;

  // ----------------------------------------------------------------- overview

  app.get('/api/admin/pool', async () => {
    const entries = store.listEntriesWithContext();
    const credentials = store.listCredentialsWithContext();
    const now = Date.now();
    return {
      endpoints: store.listEndpoints(),
      entries,
      credentials,
      aliases: store.listAliases(),
      summary: {
        endpoints: store.listEndpoints().length,
        credentials: credentials.length,
        entries: entries.length,
        healthy: entries.filter((e) => e.entry.status === 'ok' && !e.disabled && e.keyStatus === 'ok').length,
        cooling: entries.filter((e) => e.cooldownUntil !== null && now < e.cooldownUntil).length,
        authErrors: credentials.filter((c) => c.credential.status === 'auth_error').length,
        breakerOpen: credentials.filter((c) => c.credential.breakerState === 'open').length,
      },
    };
  });

  app.get('/api/admin/strategies', async () => ({
    strategies: STRATEGY_NAMES.map((name) => ({ name, description: STRATEGY_DESCRIPTIONS[name] })),
  }));

  // ---------------------------------------------------------------- endpoints

  app.get('/api/admin/endpoints', async () => store.listEndpoints());

  app.post('/api/admin/endpoints', async (request, reply) => {
    const parsed = EndpointCreate.safeParse(body(request));
    if (!parsed.success) {
      return reply.code(400).send({ error: 'A valid baseUrl is required.', issues: parsed.error.issues });
    }
    try {
      const endpoint = store.createEndpoint(parsed.data);
      return reply.code(201).send(endpoint);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.patch('/api/admin/endpoints/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const patch = body<Record<string, unknown>>(request);
    try {
      const updated = store.updateEndpoint(id, {
        name: typeof patch.name === 'string' ? patch.name : undefined,
        baseUrl: typeof patch.baseUrl === 'string' ? patch.baseUrl : undefined,
        apiStyle: patch.apiStyle === 'v1' || patch.apiStyle === 'root' || patch.apiStyle === 'auto' ? patch.apiStyle : undefined,
        authType: patch.authType === 'bearer' || patch.authType === 'none' || patch.authType === 'header' || patch.authType === 'query' ? patch.authType : undefined,
        authHeader: typeof patch.authHeader === 'string' ? patch.authHeader : patch.authHeader === null ? null : undefined,
        authPrefix: typeof patch.authPrefix === 'string' ? patch.authPrefix : patch.authPrefix === null ? null : undefined,
        extraHeaders:
          patch.extraHeaders && typeof patch.extraHeaders === 'object' ? (patch.extraHeaders as Record<string, string>) : undefined,
        compatProfile:
          patch.compatProfile === 'opencode-zen' ? 'opencode-zen' : patch.compatProfile === null ? null : undefined,
        enabled: typeof patch.enabled === 'boolean' ? patch.enabled : undefined,
      });
      if (!updated) return reply.code(404).send({ error: 'Endpoint not found.' });
      return updated;
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.delete('/api/admin/endpoints/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const credentials = store.listCredentials(id);
    const entryIds = credentials.flatMap((c) => store.listModelEntries().filter((e) => e.credentialId === c.id).map((e) => e.id));
    const ok = store.deleteEndpoint(id);
    poolState.forget(entryIds);
    return reply.code(ok ? 200 : 404).send({ deleted: ok });
  });

  // ------------------------------------------------------------------- export

  /**
   * `GET /api/admin/endpoints/:id/export-keys` - every key on one provider, in
   * plaintext, one per line.
   *
   * This is the one route that deliberately hands back secrets, so it lives
   * inside the admin scope and inherits its `onRequest` guard: it only works
   * once the operator has turned on "Require the key on the dashboard API too".
   * A GET that returns secrets must never be cached or left in a log line, so
   * the response is explicitly marked no-store.
   *
   * The output is one key per line, which is exactly the shape the bulk importer
   * accepts, so a file exported here can be imported straight back.
   */
  app.get('/api/admin/endpoints/:id/export-keys', async (request, reply) => {
    const { id } = request.params as { id: string };
    const endpoint = store.getEndpoint(id);
    if (!endpoint) return reply.code(404).send({ error: 'Endpoint not found.' });

    const lines: string[] = [];
    const skipped: string[] = [];
    for (const credential of store.listCredentials(id)) {
      try {
        lines.push(store.getCredentialSecret(credential.id));
      } catch {
        // A key sealed under a different master.key cannot be recovered. Say so
        // rather than silently writing a short file that looks complete.
        skipped.push(credential.keyHint);
      }
    }

    const body = lines.length ? `${lines.join('\n')}\n` : '';
    return reply
      .header('content-type', 'text/plain; charset=utf-8')
      .header('cache-control', 'no-store')
      // The dashboard reads this to name the download, so the sanitising rule
      // lives in exactly one place.
      .header('x-export-filename', exportFileName(endpoint.name, endpoint.id))
      .header('x-export-skipped', String(skipped.length))
      .send(body);
  });

  // -------------------------------------------------------------- credentials

  /** The single form the operator actually uses: base URL + key + model. */
  app.post('/api/admin/quick-add', async (request, reply) => {
    const parsed = QuickAdd.safeParse(body(request));
    if (!parsed.success) {
      return reply.code(400).send({ error: 'baseUrl, apiKey and modelId are all required.', issues: parsed.error.issues });
    }
    const input = parsed.data;
    try {
      const normalized = normalizeBaseUrl(input.baseUrl);
      let endpoint = store.findEndpointByBaseUrl(normalized);
      if (!endpoint) {
        endpoint = store.createEndpoint({
          name: input.name ?? '',
          baseUrl: normalized,
          authType: input.authType ?? 'bearer',
          authHeader: input.authHeader ?? null,
          authPrefix: input.authPrefix ?? null,
          extraHeaders: input.extraHeaders ?? {},
        });
      }
      const { credential, created: keyCreated } = store.addCredential({
        endpointId: endpoint.id,
        apiKey: input.apiKey,
        label: null,
      });
      const { entry, created: entryCreated } = store.createModelEntry({
        credentialId: credential.id,
        modelId: input.modelId.trim(),
      });

      let ping = null;
      if (input.autoPing ?? settings.get('autoPingOnAdd')) {
        ping = await pingEntry(store, entry.id, settings.all);
      }

      return reply.code(201).send({ endpoint, credential, entry, keyCreated, entryCreated, ping });
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.get('/api/admin/credentials', async (request) => {
    const { endpointId } = request.query as { endpointId?: string };
    return store.listCredentialsWithContext().filter((c) => (endpointId ? c.credential.endpointId === endpointId : true));
  });

  app.patch('/api/admin/credentials/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const patch = body<Record<string, unknown>>(request);
    const updated = store.updateCredential(id, {
      label: typeof patch.label === 'string' ? patch.label : patch.label === null ? null : undefined,
      disabled: typeof patch.disabled === 'boolean' ? patch.disabled : undefined,
    });
    if (!updated) return reply.code(404).send({ error: 'Credential not found.' });
    return updated;
  });

  app.delete('/api/admin/credentials/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const entryIds = store.listModelEntries().filter((e) => e.credentialId === id).map((e) => e.id);
    const ok = store.deleteCredential(id);
    poolState.forget(entryIds);
    return reply.code(ok ? 200 : 404).send({ deleted: ok });
  });

  /**
   * Imports keys against a base URL, creating the endpoint if it is new.
   *
   * This is what the "Bulk import" mode in the add-upstream dialog calls, so a
   * single paste can stand up an entire upstream in one step.
   */
  app.post('/api/admin/import-keys', async (request, reply) => {
    const parsed = ImportKeys.safeParse(body(request));
    if (!parsed.success) {
      return reply.code(400).send({ error: 'A baseUrl and payload are required.', issues: parsed.error.issues });
    }
    const { baseUrl, name, payload: text, format, modelIds, autoPing } = parsed.data;

    let endpoint;
    try {
      const normalized = normalizeBaseUrl(baseUrl);
      endpoint = store.findEndpointByBaseUrl(normalized) ?? store.createEndpoint({ name: name ?? '', baseUrl: normalized });
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
    return importKeysInto(reply, endpoint, { payload: text, format, modelIds, autoPing });
  });

  /** Bulk key import against one endpoint, with an optional auto-ping. */
  app.post('/api/admin/endpoints/:id/keys', async (request, reply) => {
    const { id } = request.params as { id: string };
    const endpoint = store.getEndpoint(id);
    if (!endpoint) return reply.code(404).send({ error: 'Endpoint not found.' });

    const parsed = BulkPayload.safeParse(body(request));
    if (!parsed.success) {
      return reply.code(400).send({ error: 'A payload string is required.', issues: parsed.error.issues });
    }
    return importKeysInto(reply, endpoint, parsed.data);
  });

  /** Shared bulk-import implementation for both entry points above. */
  async function importKeysInto(
    reply: FastifyReply,
    endpoint: Endpoint,
    input: { payload: string; format?: BulkFormat; modelIds?: string[]; autoPing?: boolean; priority?: number; weight?: number },
  ): Promise<unknown> {
    const { payload: text, format, modelIds, autoPing, priority, weight } = input;

    let report;
    try {
      report = parseBulkKeys(text, {
        format: format as BulkFormat | undefined,
        targetBaseUrl: endpoint.baseUrl,
      });
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }

    const modelList = (modelIds ?? []).map((m) => m.trim()).filter(Boolean);
    const createdEntries: string[] = [];
    const errors: Array<{ index: number; reason: string }> = [];
    let added = 0;
    let duplicatesOnServer = 0;

    for (const row of report.rows) {
      if (row.status !== 'ok') continue;
      try {
        const { credential, created } = store.addCredential({
          endpointId: endpoint.id,
          apiKey: row.key,
          label: row.label,
        });
        if (created) added += 1;
        else duplicatesOnServer += 1;

        // A row may name its own model; otherwise bind every requested model.
        const models = row.modelId ? [row.modelId] : modelList;
        for (const modelId of models) {
          const { entry, created: entryCreated } = store.createModelEntry({
            credentialId: credential.id,
            modelId,
            priority,
            weight,
          });
          if (entryCreated) createdEntries.push(entry.id);
        }
      } catch (err) {
        errors.push({ index: row.index, reason: (err as Error).message });
      }
    }

    const shouldPing = (autoPing ?? settings.get('autoPingOnAdd')) && createdEntries.length > 0;
    const pings = shouldPing
      ? await pingEntries(store, createdEntries, settings.get('bulkPingConcurrency'), settings.all)
      : [];

    return reply.code(201).send({
      endpointId: endpoint.id,
      endpointName: endpoint.name,
      format: report.format,
      parsed: report.summary,
      added,
      duplicatesOnServer,
      errors,
      entriesCreated: createdEntries.length,
      pings,
    });
  }

  /** Preview-only parse so the UI can show what it recognised before commit. */
  app.post('/api/admin/parse-bulk', async (request, reply) => {
    const parsed = BulkPreview.safeParse(body(request));
    if (!parsed.success) return reply.code(400).send({ error: 'A payload string is required.' });
    try {
      return parseBulkKeys(parsed.data.payload, { format: parsed.data.format as BulkFormat | undefined });
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  // ------------------------------------------------------------- model entries

  app.get('/api/admin/model-entries', async () => store.listEntriesWithContext());

  app.post('/api/admin/model-entries', async (request, reply) => {
    const patch = body<{ credentialId?: string; modelId?: string; weight?: number; priority?: number }>(request);
    if (!patch.credentialId || !patch.modelId) {
      return reply.code(400).send({ error: 'credentialId and modelId are required.' });
    }
    try {
      const result = store.createModelEntry({
        credentialId: patch.credentialId,
        modelId: patch.modelId,
        weight: patch.weight,
        priority: patch.priority,
      });
      let ping = null;
      if (settings.get('autoPingOnAdd')) {
        ping = await pingEntry(store, result.entry.id, settings.all);
      }
      return reply.code(201).send({ ...result, ping });
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.patch('/api/admin/model-entries/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const patch = body<Record<string, unknown>>(request);
    const updated = store.updateModelEntry(id, {
      modelId: typeof patch.modelId === 'string' ? patch.modelId : undefined,
      enabled: typeof patch.enabled === 'boolean' ? patch.enabled : undefined,
      weight: typeof patch.weight === 'number' ? patch.weight : undefined,
      priority: typeof patch.priority === 'number' ? patch.priority : undefined,
      status: typeof patch.status === 'string' ? (patch.status as never) : undefined,
    });
    if (!updated) return reply.code(404).send({ error: 'Entry not found.' });
    return updated;
  });

  app.delete('/api/admin/model-entries/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const ok = store.deleteModelEntry(id);
    poolState.forget([id]);
    return reply.code(ok ? 200 : 404).send({ deleted: ok });
  });

  app.post('/api/admin/model-entries/:id/ping', async (request, reply) => {
    const { id } = request.params as { id: string };
    return pingEntry(store, id, settings.all);
  });

  app.post('/api/admin/model-entries/ping-all', async (request) => {
    const { endpointId } = body<{ endpointId?: string }>(request);
    let entries = store.listModelEntries().filter((e) => e.enabled);
    if (endpointId) {
      const allowed = new Set(store.listCredentials(endpointId).map((c) => c.id));
      entries = entries.filter((e) => allowed.has(e.credentialId));
    }
    const results = await pingEntries(store, entries.map((e) => e.id), settings.get('bulkPingConcurrency'), settings.all);
    return { pinged: results.length, results };
  });

  // ------------------------------------------------------------------ aliases

  app.get('/api/admin/aliases', async () => store.listAliases());

  app.post('/api/admin/aliases', async (request, reply) => {
    const patch = body<{ name?: string; strategy?: string | null; targets?: string[] }>(request);
    if (!patch.name?.trim()) return reply.code(400).send({ error: 'Alias name is required.' });
    if (store.getAliasByName(patch.name.trim())) {
      return reply.code(409).send({ error: `An alias named "${patch.name.trim()}" already exists.` });
    }
    // No strategy in the body means "inherit the global default", not
    // "round-robin" - otherwise a strategy chosen in Settings would never
    // apply to a freshly created alias.
    const strategy = readAliasStrategy(patch.strategy) ?? null;
    try {
      const { id } = store.createAlias(patch.name, strategy, patch.targets ?? []);
      return reply.code(201).send(store.getAlias(id));
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.patch('/api/admin/aliases/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const patch = body<{ name?: string; strategy?: string | null; targets?: string[] }>(request);
    let ok: boolean;
    try {
      ok = store.updateAlias(id, {
        name: patch.name,
        strategy: readAliasStrategy(patch.strategy),
        targets: Array.isArray(patch.targets) ? patch.targets : undefined,
      });
    } catch (err) {
      // A rejected target id is a bad request, not a server fault - same answer
      // the create route gives.
      return reply.code(400).send({ error: (err as Error).message });
    }
    if (!ok) return reply.code(404).send({ error: 'Alias not found.' });
    return store.getAlias(id);
  });

  app.delete('/api/admin/aliases/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const ok = store.deleteAlias(id);
    return reply.code(ok ? 200 : 404).send({ deleted: ok });
  });

  // ----------------------------------------------------------- model spoofing

  /**
   * A spoof name may not collide with anything already resolvable.
   *
   * This is load-bearing rather than tidiness. `resolveRequestedModel` checks
   * aliases first, so a spoof sharing an alias's name would be silently dead -
   * it would appear in the dashboard and in `/v1/models` and then never fire.
   * A spoof sharing a real model's id would be worse: it would quietly divert
   * every request for that model. Rejecting at write time is the only point
   * where the collision is still visible.
   */
  const spoofNameTaken = (name: string, exceptId?: string) => {
    const spoof = store.getSpoofByName(name);
    if (spoof && spoof.id !== exceptId) return `A spoof named "${name}" already exists.`;
    if (store.getAliasByName(name)) return `"${name}" is already an alias.`;
    if (store.hasModel(name)) return `"${name}" is already a real model id.`;
    return null;
  };

  app.get('/api/admin/model-spoofs', async () => store.listSpoofs());

  app.post('/api/admin/model-spoofs', async (request, reply) => {
    const patch = body<{ name?: string; targetModel?: string }>(request);
    if (!patch.name?.trim()) return reply.code(400).send({ error: 'Spoof model id is required.' });
    if (!patch.targetModel?.trim()) return reply.code(400).send({ error: 'Target model id is required.' });

    const taken = spoofNameTaken(patch.name.trim());
    if (taken) return reply.code(409).send({ error: taken });

    try {
      const { id } = store.createSpoof(patch.name, patch.targetModel);
      return reply.code(201).send(store.getSpoof(id));
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.patch('/api/admin/model-spoofs/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const patch = body<{ name?: string; targetModel?: string }>(request);
    if (!store.getSpoof(id)) return reply.code(404).send({ error: 'Spoof not found.' });

    if (patch.name?.trim()) {
      const taken = spoofNameTaken(patch.name.trim(), id);
      if (taken) return reply.code(409).send({ error: taken });
    }
    if (patch.targetModel?.trim() && store.getSpoofByName(patch.targetModel.trim())) {
      return reply
        .code(409)
        .send({ error: `"${patch.targetModel.trim()}" is itself a spoof. Point a spoof at a real model id.` });
    }

    store.updateSpoof(id, { name: patch.name, targetModel: patch.targetModel });
    return store.getSpoof(id);
  });

  app.delete('/api/admin/model-spoofs/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const ok = store.deleteSpoof(id);
    return reply.code(ok ? 200 : 404).send({ deleted: ok });
  });

  // ----------------------------------------------------------------- settings

  app.get('/api/admin/settings', async () => {
    const all = settings.all;
    const { unifiedKeyHash: _omitted, ...visible } = all;
    return {
      settings: visible,
      hasUnifiedKey: Boolean(all.unifiedKeyHash),
      // Only populated on the very first boot, so the operator can copy it.
      bootstrapUnifiedKey: ctx.bootstrapUnifiedKey,
      restartRequired: RESTART_REQUIRED_KEYS,
      strategies: STRATEGY_NAMES.map((name) => ({ name, description: STRATEGY_DESCRIPTIONS[name] })),
    };
  });

  app.put('/api/admin/settings', async (request, reply) => {
    const patch = body<Partial<Settings>>(request);
    const { settings: updated, changed } = settings.update(patch);
    const { unifiedKeyHash: _omitted, ...visible } = updated;
    return {
      settings: visible,
      changed,
      restartRequired: RESTART_REQUIRED_KEYS.filter((k) => changed.includes(k)),
    };
  });

  app.post('/api/admin/settings/rotate-unified-key', async () => {
    const key = settings.rotateUnifiedKey();
    ctx.bootstrapUnifiedKey = key;
    return { key, note: 'Existing clients using the old key will start failing with 401.' };
  });

  /**
   * `GET /api/admin/settings/unified-key` - the current unified key, in
   * plaintext, so the dashboard can put it on screen.
   *
   * Its own route rather than a field on `GET /api/admin/settings`, because
   * that response is refetched on every save and on every visit to the page,
   * and a secret should not ride along on all of them. `no-store` for the same
   * reason `export-keys` sets it: this is a secret, and a secret must never sit
   * in a cache or a log line.
   *
   * `key` is null rather than a 404 when the key file is absent, which is the
   * state of every install that predates the file. The dashboard tells that
   * apart from "nothing to show" and offers to rotate.
   */
  app.get('/api/admin/settings/unified-key', async (_request, reply) =>
    reply.header('cache-control', 'no-store').send({ key: settings.revealUnifiedKey() || null }),
  );

  app.post('/api/admin/settings/reset-entry-health', async (request, reply) => {
    const { entryId } = body<{ entryId?: string }>(request);
    const entries = entryId ? [entryId] : store.listModelEntries().map((e) => e.id);
    for (const id of entries) {
      const routable = store.getRoutableEntry(id);
      if (!routable) continue;
      store.persistHealth(routable.credentialId, {
        status: 'unknown',
        failStreak: 0,
        breakerState: 'closed',
        openedAt: null,
        cooldownMs: settings.get('breakerCooldownMs'),
        cooldownUntil: null,
        cooldownAttempts: 0,
        lastError: null,
      });
      store.updateModelEntry(id, { status: 'unknown', lastError: null });
    }
    return { reset: entries.length };
  });

  // -------------------------------------------------------------------- stats

  app.get('/api/admin/stats/overview', async (request) => {
    const { range } = request.query as { range?: string };
    return queries.overview(rangeStart(range));
  });

  app.get('/api/admin/stats/timeseries', async (request) => {
    const { range } = request.query as { range?: string };
    const since = rangeStart(range);
    return { since, bucketMs: bucketFor(since), points: queries.timeseries(since, bucketFor(since)) };
  });

  app.get('/api/admin/stats/by-model', async (request) => queries.byModel(rangeStart((request.query as { range?: string }).range)));
  app.get('/api/admin/stats/by-upstream', async (request) => queries.byUpstream(rangeStart((request.query as { range?: string }).range)));
  app.get('/api/admin/stats/by-credential', async (request) => queries.byCredential(rangeStart((request.query as { range?: string }).range)));
  app.get('/api/admin/stats/errors', async (request) => queries.byError(rangeStart((request.query as { range?: string }).range)));

  /*
   * The streak figure behind the sidebar element.
   *
   * Computed from the log rather than from a counter, so it cannot disagree with
   * the request log every other figure aggregates. The one exception is `best`,
   * a high-water mark persisted in its own single-row table, because pruning
   * would otherwise delete the very days that produced it.
   *
   * The window is the retention window rather than a fixed span: a streak can
   * only be as long as the log still reaches, and reading that bound off the
   * same setting the pruner uses is what keeps `truncated` truthful.
   */
  app.get('/api/admin/stats/streak', async () => {
    const now = Date.now();
    const retentionDays = settings.get('logRetentionDays');
    const days = queries.activityByDay(now - retentionDays * 86_400_000);
    const streak = computeStreak(days, now);
    const best = queries.recordBestStreak(streak.current);
    const today = localDayKey(now);
    const byDay = new Map(days.map((d) => [d.day, d]));

    return {
      ...streak,
      best,
      retentionDays,
      tier: nextTier(streak.current),
      earned: earnedTiers(best),
      // Two weeks for the strip beside the figure, twelve weeks of cells for
      // the heatmap below it.
      days: lastDayKeys(now, 14).map((day) => ({
        day,
        requests: byDay.get(day)?.requests ?? 0,
        active: (byDay.get(day)?.successes ?? 0) > 0,
        isToday: day === today,
      })),
      heatmap: heatmapRange(now).map((day) => {
        const row = byDay.get(day);
        return {
          day,
          requests: row?.requests ?? 0,
          successes: row?.successes ?? 0,
          level: heatLevel(row?.requests ?? 0),
        };
      }),
    };
  });

  app.get('/api/admin/logs', async (request) => {
    const q = request.query as { model?: string; success?: string; errorKind?: string; limit?: string; offset?: string; range?: string };
    return queries.logs({
      sinceMs: rangeStart(q.range),
      model: q.model,
      success: q.success === undefined ? undefined : q.success === 'true',
      errorKind: q.errorKind,
      limit: q.limit ? Number(q.limit) : undefined,
      offset: q.offset ? Number(q.offset) : undefined,
    });
  });

  app.post('/api/admin/logs/flush', async () => {
    recorder.flush();
    return { flushed: true };
  });

  /*
   * Delete the rows the log read would show for the same filters. The buffer is
   * drained first: rows still in memory would land after the DELETE and read
   * back as entries the console had just removed.
   */
  app.delete('/api/admin/logs', async (request) => {
    const q = request.query as { model?: string; success?: string; errorKind?: string; range?: string };
    recorder.flush();
    return {
      deleted: queries.deleteLogs({
        sinceMs: rangeStart(q.range),
        model: q.model,
        success: q.success === undefined ? undefined : q.success === 'true',
        errorKind: q.errorKind,
      }),
    };
  });
}

const RANGES: Record<string, number> = {
  '1h': 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
  // `all` is a zero span, not "the last N years": any fixed lookback would
  // quietly hide rows from a long-lived log, and lifetime token totals are
  // exactly what people select this range for.
  all: 0,
};

export function rangeStart(range?: string): number {
  const span = RANGES[range ?? '24h'] ?? RANGES['24h'] as number;
  // Epoch is the only lower bound no retained row can fall before of.
  return span === 0 ? 0 : Date.now() - span;
}

function bucketFor(sinceMs: number): number {
  const span = Date.now() - sinceMs;
  const MIN = 60 * 1000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;
  if (span <= 6 * HOUR) return 5 * MIN;
  if (span <= 3 * DAY) return HOUR;
  if (span <= 90 * DAY) return 6 * HOUR;
  if (span <= 2 * 365 * DAY) return DAY;
  return 7 * DAY;
}
