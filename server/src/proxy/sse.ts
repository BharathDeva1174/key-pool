import type { FastifyReply } from 'fastify';
import { readUsage as readUsageObject, type Usage } from '../core/usage.js';
import { classifyErrorEnvelope, isOpenAIErrorShape, statusForErrorKind, type UpstreamErrorKind } from '../core/errors.js';

export interface StreamOutcome {
  ttfbMs: number | null;
  latencyMs: number;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  /** Input tokens the upstream served from its prompt cache, when reported. */
  cachedTokens: number | null;
  /** Reasoning tokens broken out by the provider, when reported. */
  reasoningTokens: number | null;
  /**
   * Characters of output text the stream carried, whether or not the upstream
   * ever reported usage. The raw material for the token estimate taken when
   * usage is missing - the pipe itself never guesses a token count, it only
   * reports what went through it.
   */
  outputTextChars: number;
  /** True when the upstream died after we had already started writing. */
  errored: boolean;
  errorMessage: string | null;
  sawDone: boolean;
  /**
   * What actually happened to this attempt.
   *
   * This was a boolean once, and the boolean was the bug: `false` had to mean
   * both "the upstream sent nothing" and "we discarded what it sent", so a
   * translator that dropped an unrecognised field reported a self-inflicted
   * loss in the same vocabulary as a network fault. The caller then failed
   * over, burned a billed generation per key, and answered 502 for a request
   * the upstream had in fact completed. Three states, because the two causes
   * call for opposite responses.
   */
  delivery: StreamDelivery;
  /**
   * Set when the upstream refused the request inside a 200 rather than by
   * dropping the stream.
   *
   * `delivered_nothing` alone says "the upstream produced nothing", which is what
   * the caller used to conclude and mark the key against the breaker for. That is
   * wrong for a refusal: the upstream spoke, it said no, and the credential has
   * been vindicated. Carrying the real kind lets the caller fail over on the
   * upstream's terms and record what it actually said.
   */
  upstreamError?: RecoveredUpstreamError;
}

/**
 * - `delivered_to_client` - content reached the client, or none was needed.
 * - `delivered_nothing` - the upstream genuinely produced nothing. A sibling
 *   key may well serve this request, so the attempt is abandonable.
 * - `dropped_in_translation` - the upstream *did* send frames, and this
 *   translator could not map them onto the client's protocol. Retrying cannot
 *   help: the next key is the same gateway with the same frames. The client is
 *   committed and told what happened, rather than the pool being spent on a
 *   request that was never going to succeed.
 */
export type StreamDelivery = 'delivered_to_client' | 'delivered_nothing' | 'dropped_in_translation';

/** An SSE frame that never terminates is dropped rather than buffered forever. */
const FRAME_BUFFER_CAP = 256 * 1024;

/**
 * How much of the raw body is kept while an attempt has produced nothing.
 *
 * The capture exists only to recognise a *complete* answer that arrived in the
 * wrong shape, so it is abandoned the moment real content is seen: a healthy
 * stream holds nothing, and the only case that pays for it is one where the
 * whole body is at most a single message.
 */
export const COMPLETE_CAPTURE_CAP = 4 * 1024 * 1024;

/**
 * How long an upstream stream may go without producing a byte.
 *
 * The header deadline is cleared the moment headers arrive, which is right - a
 * generation legitimately outlives any total budget - but it left the *body*
 * unbounded, and nothing else covered it. An upstream that accepted the request,
 * sent headers, and then went quiet held the connection, the request, and a
 * worker for as long as the client cared to wait, with no log entry, no failover
 * and no way to tell that apart from a very slow model.
 *
 * This measures the gap between bytes, not the whole turn, so it costs a healthy
 * stream nothing however long the answer takes: a reasoning model that thinks for
 * four minutes sends nothing for four minutes and is re-armed on the first token.
 * What it catches is an upstream that has stopped.
 */
export const DEFAULT_STREAM_STALL_TIMEOUT_MS = 300_000;

/** A non-streaming chat completion, in the fields the proxy reads. */
export interface OpenAICompletion {
  choices?: Array<{
    message?: {
      content?: string | null;
      reasoning_content?: string | null;
      reasoning?: string | null;
      thinking?: string | null;
      tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
}

/**
 * Recognises a completion that arrived whole when a stream was requested.
 *
 * A gateway that buffers, or a backend reached through one that does not
 * stream, answers `stream: true` with an ordinary `application/json`
 * completion: one complete message and not a single `data:` line. An SSE reader
 * finds nothing there, and reading "nothing" as "the upstream produced nothing"
 * is how a pool discards answers the model really produced, spends every key,
 * and answers 502 for a request that succeeded.
 *
 * Returns the parsed completion, or null when the text is not one - including
 * when it parses but carries no content, because an empty answer is a real
 * failure and must stay abandonable. Both pipes need this, and a shared
 * implementation is what stops the two dialects from drifting on which upstream
 * shapes they can rescue.
 */
export function parseWholeCompletion(raw: string): OpenAICompletion | null {
  const text = raw.trim();
  if (!text.startsWith('{')) return null;

  let completion: OpenAICompletion;
  try {
    completion = JSON.parse(text) as OpenAICompletion;
  } catch {
    return null;
  }

  const message = completion.choices?.[0]?.message;
  if (!message) return null;
  const hasContent =
    (typeof message.content === 'string' && message.content.length > 0) ||
    [message.reasoning_content, message.reasoning, message.thinking].some(
      (value) => typeof value === 'string' && value.length > 0,
    ) ||
    (Array.isArray(message.tool_calls) && message.tool_calls.length > 0);
  return hasContent ? completion : null;
}

/**
 * Relays an upstream SSE body to the client byte-for-byte.
 *
 * Frames are never re-serialised, so token-level compatibility with whatever
 * client and upstream are in play is preserved. Usage is extracted purely for
 * our own stats; if the upstream does not send it, the columns stay null rather
 * than being guessed - though the output size is still counted, so the caller
 * can take a token estimate if it wants one.
 */
export async function pipeSseToReply(
  response: Response,
  reply: FastifyReply,
  startedAt: number,
  stallTimeoutMs: number = DEFAULT_STREAM_STALL_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<StreamOutcome> {
  const raw = reply.raw;

  /*
   * Nothing is written, and the reply is not hijacked, until the upstream has
   * produced something worth keeping.
   *
   * The Anthropic pipe buffers for the same reason (`anthropic/stream.ts`), and
   * this path had no equivalent: it hijacked the socket and wrote the head
   * before reading a single byte, then reported `delivered_to_client`
   * unconditionally. So a stream the upstream opened and abandoned - a preamble
   * and nothing else, or an empty body - was relayed to the client as a clean
   * 200 carrying no answer. That is the worst outcome available: the client
   * cannot tell it from a real answer, and because the attempt looks delivered,
   * the pool is never asked for another key.
   *
   * Buffering is bytes, not re-serialisation: the frames are relayed exactly as
   * they arrived, just deferred until there is at least one to relay.
   */
  const pending: Buffer[] = [];
  let committed = false;

  const commit = (): void => {
    if (committed) return;
    committed = true;
    reply.hijack();
    raw.writeHead(response.status, {
      'content-type': response.headers.get('content-type') ?? 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Tells any intermediate proxy not to buffer the stream.
      'x-accel-buffering': 'no',
    });
    for (const chunk of pending) raw.write(chunk);
    pending.length = 0;
  };

  const body = response.body;
  if (!body) {
    // Headers and nothing else: nothing to deliver, and the attempt is
    // abandonable, exactly as a stream that died before its first token is.
    return {
      ttfbMs: null,
      latencyMs: Date.now() - startedAt,
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
      cachedTokens: null,
      reasoningTokens: null,
      outputTextChars: 0,
      errored: true,
      errorMessage: 'Upstream returned no response body.',
      sawDone: false,
      delivery: 'delivered_nothing',
    };
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let ttfbMs: number | null = null;
  let errorMessage: string | null = null;
  let sawDone = false;
  let sawFinishReason = false;
  let frameBuffer = '';
  let usage: Usage | null = null;
  let outputChars = 0;
  /**
   * Set when a delta carried something a client would call output.
   *
   * Separate from `outputChars` because size and substance are not the same
   * question. What the committer below needs to know is "did this turn produce
   * anything at all", and there are two ways a turn that plainly did produce
   * something still counts zero characters:
   *
   *   - a tool call that takes no arguments. Its whole payload is a name; the
   *     arguments are the empty string, so the character count stays at zero
   *     even though the call itself is complete and delivered. The
   *     non-streaming reassembler has always counted a call as content on the
   *     strength of the call existing (`toolCalls.length > 0`), so the two
   *     readers disagreed about identical bytes.
   *   - an empty-string content delta, which is a frame from the preamble of a
   *     real answer rather than a malformed one.
   *
   * Treating substance as `outputChars > 0` meant an attempt that delivered a
   * complete turn could still be read as having delivered nothing: the client
   * was never committed, every key in the pool was spent re-sending it, and the
   * request ended at a 502 naming a network fault that never happened.
   */
  let sawOutput = false;
  /** The raw body, kept only while this attempt has produced nothing. */
  let captured = '';
  let capturing = true;
  /** Set when the answer arrived whole rather than as frames. */
  let recovered = false;
  /** Set when the upstream refused the request inside a 200. */
  let recoveredError: RecoveredUpstreamError | null = null;

  /**
   * Reads one complete SSE frame.
   *
   * Each frame is parsed exactly once. The previous scan kept a rolling window
   * and re-parsed every frame in it on each chunk until usage turned up, which
   * spent quadratic effort on long streams; counting output size needs every
   * frame anyway, so the scan is incremental instead. Returns the usage the
   * frame carried, if any - the caller keeps the last one seen.
   */
  const scanFrame = (frame: string): Usage | null => {
    let found: Usage | null = null;
    for (const line of frame.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      if (payload === '[DONE]') {
        sawDone = true;
        continue;
      }
      let parsed: {
        usage?: unknown;
        choices?: Array<{ delta?: Record<string, unknown>; finish_reason?: string | null }>;
      };
      try {
        parsed = JSON.parse(payload);
      } catch {
        // A frame split across chunk boundaries cannot happen here - only
        // complete frames reach this point - so a parse failure is a
        // malformed frame, not a half-read one.
        continue;
      }
      if (parsed.usage && typeof parsed.usage === 'object') {
        // Last usage frame wins: a provider that sends an initial partial
        // usage and a final corrected one should have the final one counted.
        found = readUsageObject(parsed.usage);
      }
      for (const choice of parsed.choices ?? []) {
        // A turn that finished with no text is a real, complete answer - an
        // empty one - so it commits the client the same way content does.
        if (choice?.finish_reason) sawFinishReason = true;
        const delta = choice?.delta;
        if (!delta) continue;
        if (typeof delta.content === 'string') {
          outputChars += delta.content.length;
          if (delta.content.length > 0) sawOutput = true;
        }
        /*
         * All three names, from one list.
         *
         * `reasoning_content`, `reasoning` and `thinking` are the same thing
         * under three names a gateway might pick, and every other reader in the
         * codebase accepts all three - `collectCompletionFromSse` and
         * `charsOfCompletion` below, `parseWholeCompletion` above, and the
         * Anthropic writer's `firstNonEmptyString`. This scan read the first two
         * and silently dropped the third.
         *
         * On a stream that ends with a finish reason that is invisible, because
         * the finish reason commits the client regardless. A stream that closes
         * without one is a different matter: the turn's whole output counted as
         * zero characters, so the attempt looked like it had produced nothing,
         * and the pool spent every key re-sending a request the upstream had
         * already answered - ending at a 502 that named a network fault.
         *
         * Spelled as a loop over the three names rather than three separate
         * branches precisely so the next reader cannot add a fourth name to one
         * place and miss another.
         */
        for (const value of [delta.reasoning_content, delta.reasoning, delta.thinking]) {
          if (typeof value === 'string' && value.length > 0) {
            outputChars += value.length;
            sawOutput = true;
          }
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const call of delta.tool_calls as Array<Record<string, unknown> | null>) {
            // The call existing is the content; its arguments are only a size.
            if (call) sawOutput = true;
            const fn = call?.function as { arguments?: unknown } | undefined;
            if (typeof fn?.arguments === 'string') outputChars += fn.arguments.length;
          }
        }
      }
    }
    return found;
  };

  /*
   * The stall watchdog.
   *
   * `reader.read()` blocks indefinitely once the upstream goes quiet, so the
   * loop cannot check a clock - it has to be interrupted. A timer that rejects is
   * raced against the read, and re-armed on every byte that actually arrives, so
   * what it measures is the gap between bytes rather than the length of the turn.
   *
   * It rejects rather than resolving, so the failure lands in the same `catch` as
   * every other read error and gets the same treatment: an uncommitted attempt
   * stays abandonable and a sibling key is tried, a committed one is ended
   * honestly. Resolving instead would have needed a flag checked after the loop,
   * which is one more path to keep in step with this one.
   *
   * The timer is always cleared in the `finally`, including when it loses the
   * race - a leaked interval would keep the process alive after the request that
   * armed it had long since finished.
   */
  let stallTimer: NodeJS.Timeout | undefined;
  let rejectStall: ((err: Error) => void) | undefined;
  // Resolves never; rejects when the upstream goes quiet for `stallTimeoutMs`.
  // One promise for the whole loop rather than one per read, because a fresh
  // promise per iteration would leave every losing timer armed to fire after the
  // read it lost the race to.
  const stall = new Promise<never>((_resolve, reject) => {
    rejectStall = reject;
  });
  const armStall = (): void => {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      rejectStall?.(new Error(`Upstream stream stalled: no data for ${stallTimeoutMs}ms`));
    }, stallTimeoutMs);
  };
  armStall();

  /*
   * Client disconnect, raced against every read below. Without this the pipe
   * consumes the upstream to completion after the client has left: billed
   * tokens nobody receives, a pool slot held for nothing, and a success row
   * for a request nobody read. The caller owns what the abort *means* (never
   * fail over, never charge the key); this pipe only stops reading and
   * releases the upstream socket.
   */
  let rejectAbort: ((err: Error) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  // A promise rejection with no consumer is an unhandled rejection, so the
  // loop below always races this - and `finally` clears nothing here because
  // there is no timer, only a listener removed after the loop.
  const onAbort = (): void => {
    rejectAbort?.(new Error('Client disconnected'));
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();

  // Refreshed where the loop can exit without an exception (a backpressure
  // wait resolved by a socket close); the `catch` covers the abort rejection.
  let disconnected = false;

  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), stall, aborted]);
      // Re-armed on arrival, so what the timer measures is the gap between bytes.
      armStall();
      if (done) break;
      if (ttfbMs === null) ttfbMs = Date.now() - startedAt;

      const chunk = Buffer.from(value);
      const text = decoder.decode(value, { stream: true });
      if (capturing) {
        captured += text;
        if (captured.length > COMPLETE_CAPTURE_CAP) capturing = false;
      }

      if (committed) {
        if (!raw.write(chunk)) {
          /*
           * A slow client applies backpressure, and `drain` is the only honest
           * wait - but a client that disconnected instead will never drain.
           * Waiting on `drain` alone held the pool slot, the upstream socket
           * and the recorder row forever after the other end was gone.
           */
          const drained = await new Promise<boolean>((resolve) => {
            const onDrain = (): void => {
              cleanup();
              resolve(true);
            };
            const onClose = (): void => {
              cleanup();
              resolve(false);
            };
            const cleanup = (): void => {
              raw.off('drain', onDrain);
              raw.off('close', onClose);
            };
            raw.once('drain', onDrain);
            raw.once('close', onClose);
          });
          if (!drained) break;
        }
      } else {
        pending.push(chunk);
      }

      frameBuffer += text;
      if (frameBuffer.length > FRAME_BUFFER_CAP) {
        // An upstream that never sends a blank line is malformed; the bytes
        // have already been relayed, so dropping the buffer loses only the
        // estimate, never a byte the client sees.
        frameBuffer = frameBuffer.slice(-FRAME_BUFFER_CAP);
      }
      for (;;) {
        const split = frameBuffer.search(/\r?\n\r?\n/);
        if (split === -1) break;
        const frame = frameBuffer.slice(0, split);
        frameBuffer = frameBuffer.slice(split + (frameBuffer[split] === '\r' ? 4 : 2));
        const found = scanFrame(frame);
        if (found) usage = found;
        // The first real token, or a completed-but-empty turn, is the point
        // the client is committed to this attempt.
        if (!committed && (sawOutput || sawFinishReason)) {
          capturing = false;
          commit();
        }
      }
    }
    // A disconnect ends the attempt here: no tail recovery, no completion
    // reassembly, no refusal parsing for a client that has left. The caller
    // records the disconnect and, crucially, does not fail over onto a sibling
    // key to serve nobody. Refreshed here because a backpressure wait can
    // resolve via socket close without ever throwing into the `catch` below.
    if (signal?.aborted) disconnected = true;
    /*
     * Whatever the loop above could not split into frames.
     *
     * Two cases land here, and both used to be counted without ever committing
     * the client: a body whose frames are separated by a single newline rather
     * than a blank line, so the whole body is one unsplittable buffer, and a
     * final frame that never got its terminating blank line. Content found in
     * either place raised `outputChars` and left `committed` false, so the
     * attempt came back as `delivered_nothing` - read by the caller as "the
     * upstream produced nothing". It marked the key against the breaker and
     * spent every key in the pool to answer a request the upstream had just
     * answered correctly.
     *
     * So the commit check runs here exactly as it does in the drain loop. The
     * scan is per line, which is what a client that has stopped being strict
     * about framing does too, and it is why the Anthropic pipe was never
     * affected: its tail flush is per line and its commit runs afterwards.
     */
    // Skipped after a disconnect: every branch below can commit the client,
    // and there is no client left to commit to.
    if (!disconnected && frameBuffer.trim()) {
      for (const line of frameBuffer.split(/\r?\n/)) {
        if (!line.trim()) continue;
        const found = scanFrame(line);
        if (found) usage = found;
      }
      if (!committed && (sawOutput || sawFinishReason)) {
        capturing = false;
        commit();
      }
    }

    /*
     * A whole answer where frames were expected. The bytes are already buffered
     * verbatim, so the client gets exactly what the upstream sent - the same
     * bytes the relay would have produced, minus the fiction that they were
     * ever frames. Usage is read off the completion rather than left null, so
     * the request is not logged as free.
     */
    const completion = !committed && !disconnected ? parseWholeCompletion(captured) : null;
    if (completion) {
      recovered = true;
      usage = readUsageObject(completion.usage);
      commit();
    }
    /*
     * A refusal rather than an answer, delivered with a 200. The attempt is still
     * abandonable - a sibling key is worth trying - but the reason is the
     * upstream's own, and the key is not at fault for it.
     */
    if (!committed && !disconnected) {
      recoveredError = parseUpstreamErrorEnvelope(captured) ?? parseSseErrorFrame(captured);
    }
  } catch (err) {
    errorMessage = (err as Error)?.message ?? String(err);
    disconnected = signal?.aborted ?? false;
    if (disconnected) {
      // The upstream socket is released now, not when the gateway finishes a
      // generation nobody will read. Cancelling a consumed reader is safe; a
      // missing body was already returned above, so `body` exists here.
      try {
        await reader.cancel();
      } catch {
        /* already closed */
      }
    }
  } finally {
    // Always cleared, including when the read won the race - a live timer would
    // reject a settled promise and hold the process open after the request ended.
    if (stallTimer) clearTimeout(stallTimer);
    signal?.removeEventListener('abort', onAbort);
    try {
      // Only a committed attempt owns the socket. Ending an uncommitted one
      // would answer the client with an empty 200 the failover then cannot undo.
      if (committed) raw.end();
    } catch {
      /* client already gone */
    }
    reader.releaseLock?.();
  }

  /*
   * Nothing reached the client and nothing had been sent to it, so the reply was
   * never hijacked and the attempt is genuinely abandonable - the caller can try
   * the next key, which is the whole point of a pool. Deliberately not a
   * `delivered_to_client`: that would hand back a clean 200 with no answer in
   * it, and a client cannot tell that from a real one.
   */
  if (!committed) {
    return {
      ttfbMs,
      latencyMs: Date.now() - startedAt,
      promptTokens: usage?.promptTokens ?? null,
      completionTokens: usage?.completionTokens ?? null,
      totalTokens: usage?.totalTokens ?? null,
      cachedTokens: usage?.cachedTokens ?? null,
      reasoningTokens: usage?.reasoningTokens ?? null,
      outputTextChars: outputChars,
      errored: true,
      // A disconnect is named as one, not as a network fault: the network was
      // fine, the reader left. The caller must not fail over on this.
      errorMessage: disconnected
        ? 'Client disconnected'
        : (recoveredError?.message ?? errorMessage ?? 'Upstream closed the stream before sending any content.'),
      sawDone,
      delivery: 'delivered_nothing',
      ...(recoveredError && !disconnected ? { upstreamError: recoveredError } : {}),
    };
  }

  return {
    ttfbMs,
    latencyMs: Date.now() - startedAt,
    promptTokens: usage?.promptTokens ?? null,
    completionTokens: usage?.completionTokens ?? null,
    totalTokens: usage?.totalTokens ?? null,
    cachedTokens: usage?.cachedTokens ?? null,
    reasoningTokens: usage?.reasoningTokens ?? null,
    // Counted from the completion too, so the token estimate taken when the
    // upstream reported no usage has a real size to work from.
    outputTextChars: outputChars > 0 ? outputChars : recovered ? charsOfCompletion(captured) : 0,
    errored: errorMessage !== null,
    errorMessage,
    sawDone: sawDone || recovered,
    delivery: 'delivered_to_client',
  };
}

/** Output characters of a completion read whole, for the token estimate. */
function charsOfCompletion(raw: string): number {
  const completion = parseWholeCompletion(raw);
  const message = completion?.choices?.[0]?.message;
  if (!message) return 0;
  let chars = typeof message.content === 'string' ? message.content.length : 0;
  for (const value of [message.reasoning_content, message.reasoning, message.thinking]) {
    if (typeof value === 'string') chars += value.length;
  }
  for (const call of message.tool_calls ?? []) {
    if (typeof call?.function?.arguments === 'string') chars += call.function.arguments.length;
  }
  return chars;
}

/** One tool call reassembled from the frames that carried it. */
interface ReassembledToolCall {
  id?: string;
  type?: string;
  function: { name?: string; arguments: string };
}

/** The completion a set of SSE frames adds up to. */
interface ReassembledCompletion {
  id?: string;
  object: string;
  created?: number;
  model?: string;
  choices: Array<{
    index: number;
    message: { role: string; content: string | null; reasoning_content?: string; tool_calls?: ReassembledToolCall[] };
    finish_reason: string | null;
  }>;
  usage?: Record<string, number> | null;
}

/**
 * The mirror of `parseWholeCompletion`: reassembles an SSE body into the single
 * completion a client that did *not* ask to stream expects.
 *
 * Both directions of the same mismatch exist, and only one was handled. A gateway
 * that answers `stream: true` with a whole JSON body is caught by
 * `parseWholeCompletion`; a gateway that answers `stream: false` with frames was
 * forwarded verbatim, so the client got a 200 it could not parse while the log
 * recorded a success. The two must not be handled in one place only, because the
 * symptom differs - one loses the answer, the other loses the agreement between
 * the client and the log - and only one of them is a 502.
 *
 * Returns null unless the body really is a frame stream that produced content,
 * so an ordinary JSON reply is never rewritten. Frames that split a payload
 * across several `data:` lines are joined, and a stream that ended without a
 * trailing blank line still contributes its last frame.
 *
 * Reasoning and tool calls are carried over because a reasoning model's whole
 * turn can be its reasoning: dropping it here would hand back an empty
 * completion, which is the failure this function exists to prevent.
 */
export function collectCompletionFromSse(raw: string): ReassembledCompletion | null {
  const text = raw.trim();
  if (!text.startsWith('data:')) return null;

  let content = '';
  let reasoning = '';
  let finishReason: string | null = null;
  let usage: Record<string, number> | null = null;
  let model: string | undefined;
  let id: string | undefined;
  const tools = new Map<number, ReassembledToolCall>();

  for (const frame of text.split(/\r?\n\r?\n/)) {
    // A frame is one or more `data:` lines; joining them is what a client that
    // has stopped being strict about framing also does.
    const payload = frameDataOf(frame);
    if (payload === null) continue;
    if (payload === '[DONE]') break;

    let chunk: {
      id?: string;
      model?: string;
      usage?: Record<string, number> | null;
      choices?: Array<{
        index?: number;
        delta?: {
          content?: string | null;
          reasoning_content?: string | null;
          reasoning?: string | null;
          thinking?: string | null;
          tool_calls?: Array<{ index?: number; id?: string; type?: string; function?: { name?: string; arguments?: string } }>;
        };
        finish_reason?: string | null;
      }>;
    };
    try {
      chunk = JSON.parse(payload);
    } catch {
      // A frame that is not JSON is not part of a completion. Skipping it is
      // what keeps a comment, a retry notice or a heartbeat from failing the
      // whole body.
      continue;
    }

    if (typeof chunk.model === 'string') model = chunk.model;
    if (typeof chunk.id === 'string') id = chunk.id;
    // Last usage frame wins, matching the streaming readers: a provider that
    // sends a partial then a corrected count should have the corrected one.
    if (chunk.usage && typeof chunk.usage === 'object') usage = chunk.usage;

    for (const choice of chunk.choices ?? []) {
      if (choice.finish_reason) finishReason = choice.finish_reason;
      const delta = choice.delta;
      if (!delta) continue;
      if (typeof delta.content === 'string') content += delta.content;
      for (const value of [delta.reasoning_content, delta.reasoning, delta.thinking]) {
        if (typeof value === 'string') reasoning += value;
      }
      for (const call of delta.tool_calls ?? []) {
        const toolIndex = typeof call.index === 'number' ? call.index : 0;
        const existing = tools.get(toolIndex);
        if (existing) {
          if (call.id) existing.id = call.id;
          if (call.function?.name) existing.function.name = call.function.name;
          if (typeof call.function?.arguments === 'string') existing.function.arguments += call.function.arguments;
        } else {
          tools.set(toolIndex, {
            id: call.id,
            type: call.type ?? 'function',
            function: { name: call.function?.name, arguments: call.function?.arguments ?? '' },
          });
        }
      }
    }
  }

  const toolCalls = [...tools.entries()].sort((a, b) => a[0] - b[0]).map(([, call]) => call);
  // Nothing came out of the frames, so there is no completion to hand back and
  // the body is left exactly as it arrived.
  if (content.length === 0 && reasoning.length === 0 && toolCalls.length === 0) return null;

  return {
    ...(id !== undefined ? { id } : {}),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    ...(model !== undefined ? { model } : {}),
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: content.length > 0 ? content : null,
          ...(reasoning.length > 0 ? { reasoning_content: reasoning } : {}),
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: finishReason,
      },
    ],
    usage: usage ?? null,
  };
}

/** The `data:` payload of one frame, or null when the frame carries none. */
function frameDataOf(frame: string): string | null {
  const parts: string[] = [];
  for (const line of frame.split(/\r?\n/)) {
    if (line.startsWith('data:')) parts.push(line.slice(5).trimStart());
  }
  return parts.length ? parts.join('\n') : null;
}

/** What the upstream said when it refused the request behind a 200. */
export interface RecoveredUpstreamError {
  message: string;
  kind: UpstreamErrorKind;
  status: number;
}

/**
 * Recognises an error envelope the upstream sent inside a `200 OK`.
 *
 * The mirror image of `parseWholeCompletion`, and the same shape of problem: the
 * upstream answered, but not with an answer. A gateway in front of several
 * providers reports a rejection in more than one way, and when it reports it in
 * the body the status code stays 200.
 *
 * Three separate readers used to disagree about what that meant. The SSE pipes
 * found no frames and no completion, so the attempt was reported as a dropped
 * connection - `delivered_nothing` - and the pool spent every key on a request
 * the upstream had already refused, ending at a 502 that named the network. The
 * non-streaming path forwarded the bytes verbatim and recorded `success: true`,
 * so the log and the client disagreed about whether the request worked, and on
 * the Anthropic side the envelope was reshaped into an empty assistant message:
 * a refusal reported to the client as a completed turn with no words in it.
 *
 * One reader, both dialects. It looks at the whole body only, because a body that
 * is *mostly* an error envelope is an answer with a comment attached and must not
 * be reinterpreted.
 */
export function parseUpstreamErrorEnvelope(raw: string): RecoveredUpstreamError | null {
  const text = raw.trim();
  if (!text.startsWith('{')) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isOpenAIErrorShape(parsed)) return null;

  const kind = classifyErrorEnvelope(parsed);
  return {
    message: parsed.error.message,
    kind,
    status: statusForErrorKind(kind),
  };
}

/**
 * The same envelope, delivered as a `data:` frame inside a stream.
 *
 * A gateway has two habits for reporting a refusal. Some return the envelope as
 * the whole body; others have already committed to `text/event-stream` and can
 * only put the error *inside* it, as a frame that is not a completion chunk.
 * Readers that scan for completion chunks never look at such a frame, so the
 * stream is found to carry no content and the request is reported as a dropped
 * connection - the same fiction the whole-body case produced, one layer down.
 *
 * Observed for real here: a request carrying a tool definition in the wrong
 * schema was refused by the upstream with an empty stream, and the refusal
 * surfaced to the operator as "Upstream closed the stream before sending any
 * content" after every key in the pool had been spent on it.
 *
 * Only frames that are *purely* an envelope count. An error-shaped key inside a
 * completion chunk is part of a real answer and must not be reinterpreted, and a
 * stream that carried any content at all is handled as content by the caller
 * before this is consulted.
 */
export function parseSseErrorFrame(raw: string): RecoveredUpstreamError | null {
  if (!raw.includes('data:')) return null;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      continue;
    }
    if (!isOpenAIErrorShape(parsed)) continue;
    const kind = classifyErrorEnvelope(parsed);
    return { message: parsed.error.message, kind, status: statusForErrorKind(kind) };
  }
  return null;
}
