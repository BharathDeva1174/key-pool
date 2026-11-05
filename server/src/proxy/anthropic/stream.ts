/**
 * OpenAI chat-completion chunks -> Anthropic message events.
 *
 * The upstream stream is *parsed and re-emitted*, unlike the OpenAI path, which
 * relays bytes untouched. That is unavoidable: an Anthropic client is waiting
 * for `message_start` / `content_block_*` / `message_delta` / `message_stop`
 * and will not read OpenAI chunks. The OpenAI path keeps its byte-for-byte
 * relay; this is a second implementation, not a change to that one.
 *
 * The part that has to be right is block indexing. Anthropic content blocks are
 * strictly sequential - open, fill, close, then the next - and they all draw
 * from **one** index space that interleaves text and tool_use. Two independent
 * counters, one for text and one for tools, produce a stream that looks
 * reasonable and that no SDK will accept.
 */

import type { FastifyReply } from 'fastify';
import {
  COMPLETE_CAPTURE_CAP,
  DEFAULT_STREAM_STALL_TIMEOUT_MS,
  parseSseErrorFrame,
  parseUpstreamErrorEnvelope,
  parseWholeCompletion,
} from '../sse.js';
import { anthropicError, newMessageId, stopReasonOf, toolUseId, type AnthropicContentBlock } from './outbound.js';

/*
 * Re-exported rather than redeclared. This file used to carry its own copy of
 * the shape, which is how a field added for one dialect silently failed to
 * exist for the other: `cachedTokens` compiled here while the proxy handler
 * could not read it. One definition, both dialects, no drift.
 */
export type { StreamOutcome } from '../sse.js';
import type { StreamDelivery, StreamOutcome, RecoveredUpstreamError } from '../sse.js';

interface ToolAccumulator {
  id: string;
  name: string;
  /** OpenAI splits arguments across chunks; they are concatenated then parsed. */
  args: string;
  /** Whether this call already emitted its `content_block_start`. */
  blockOpened: boolean;
}

class AnthropicStreamWriter {
  private nextIndex = 0;
  private openIndex: number | null = null;
  private openKind: 'text' | 'tool' | 'thinking' | null = null;
  private openTool: number | null = null;
  private readonly tools = new Map<number, ToolAccumulator>();
  private started = false;
  private stopped = false;
  private emittedContent = false;
  private stopReason: string | null = null;
  private promptTokens: number | null = null;
  private completionTokens: number | null = null;
  /** Anthropic reports cache reads separately from input; see setUsage. */
  private cachedTokens: number | null = null;
  /** Characters of output text relayed, for a token estimate when usage is absent. */
  private outputChars = 0;

  constructor(
    private readonly send: (event: string, data: unknown) => void,
    private readonly messageId: string,
    private readonly requestedModel: string,
  ) {}

  private emit(event: string, data: unknown): void {
    this.send(event, data);
  }

  /** Emitted once, before any content block, so a client learns the id early. */
  private start(): void {
    if (this.started) return;
    this.started = true;
    this.emit('message_start', {
      type: 'message_start',
      message: {
        id: this.messageId,
        type: 'message',
        role: 'assistant',
        // The requested name, so a spoofed or aliased model keeps addressing
        // the same thing on the next turn.
        model: this.requestedModel,
        content: [] as AnthropicContentBlock[],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
    // Anthropic sends pings for a client waiting on the first byte. One here
    // costs nothing and keeps an agent from timing out on a slow first token.
    this.emit('ping', { type: 'ping' });
  }

  private closeOpen(): void {
    if (this.openIndex === null) return;
    this.emit('content_block_stop', { type: 'content_block_stop', index: this.openIndex });
    this.openIndex = null;
    this.openKind = null;
    this.openTool = null;
  }

  /*
   * Emits one empty block per call that never received arguments. A header
   * never opens a block (see push), so without this a no-argument call would
   * vanish from the turn entirely and the client would never run it. In tool
   * order, after whatever is already closed, so indices stay sequential.
   */
  private flushUnopenedTools(): void {
    for (const toolIndex of [...this.tools.keys()].sort((a, b) => a - b)) {
      const tool = this.tools.get(toolIndex)!;
      if (tool.blockOpened) continue;
      this.openToolBlock(tool, toolIndex);
      tool.blockOpened = true;
      this.closeOpen();
    }
  }

  private openText(): void {
    if (this.openKind === 'text') return;
    this.closeOpen();
    this.openIndex = this.nextIndex++;
    this.openKind = 'text';
    this.emit('content_block_start', {
      type: 'content_block_start',
      index: this.openIndex,
      content_block: { type: 'text', text: '' },
    });
  }

  /*
   * Reasoning becomes a `thinking` block, which is what an Anthropic client
   * parses it as. It draws from the same index space as text and tools, so a
   * turn that thinks and then answers numbers its blocks 0 and 1.
   */
  private openThinking(): void {
    if (this.openKind === 'thinking') return;
    this.closeOpen();
    this.openIndex = this.nextIndex++;
    this.openKind = 'thinking';
    this.emit('content_block_start', {
      type: 'content_block_start',
      index: this.openIndex,
      // The signature field is part of the block's shape. This proxy cannot
      // produce a real one - it is the upstream's cryptographic attestation of
      // its own thinking, not something re-derived here - so it is sent empty
      // rather than omitted, and the thinking is delivered rather than dropped.
      content_block: { type: 'thinking', thinking: '', signature: '' },
    });
  }

  /** Tool blocks are keyed by the upstream's own tool index, so calls interleave correctly. */
  private openToolBlock(tool: ToolAccumulator, toolIndex: number): void {
    this.closeOpen();
    this.openIndex = this.nextIndex++;
    this.openKind = 'tool';
    this.openTool = toolIndex;
    this.emit('content_block_start', {
      type: 'content_block_start',
      index: this.openIndex,
      content_block: { type: 'tool_use', id: tool.id, name: tool.name, input: {} },
    });
  }

  push(delta: {
    content?: string | null;
    reasoning_content?: string | null;
    reasoning?: string | null;
    thinking?: string | null;
    tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>;
  }): void {
    this.start();

    /*
     * Reasoning first, and this is the fix for a whole class of "the model
     * returned nothing" failures.
     *
     * A reasoning model served through an OpenAI-compatible gateway reports its
     * thinking under a sibling of `content`, and the field name is not
     * standardised: `reasoning_content` is the common one, `reasoning` and
     * `thinking` both appear in the wild. None of them is `content`.
     *
     * So a turn that thinks before it answers arrives here as a run of deltas
     * this method used to discard on the way past. Two things then went wrong
     * at once, and both were invisible:
     *
     *  - the client got a well-formed message containing no content at all, so
     *    a real answer was reported as an empty one; and
     *  - `emittedContent` stayed false, which is what marks an attempt as
     *    abandonable. A stream that was cut off *after* thinking was therefore
     *    read as one that never produced anything, thrown away, and retried on
     *    the next key - burning a full generation per key and ending on a 502
     *    that named the network rather than the real cause.
     *
     * Reading it here fixes both: the thinking is delivered, and a stream that
     * carried it counts as having delivered content.
     */
    const reasoning = firstNonEmptyString(delta.reasoning_content, delta.reasoning, delta.thinking);
    if (reasoning !== null) {
      this.emittedContent = true;
      this.outputChars += reasoning.length;
      this.openThinking();
      this.emit('content_block_delta', {
        type: 'content_block_delta',
        index: this.openIndex,
        delta: { type: 'thinking_delta', thinking: reasoning },
      });
    }

    if (typeof delta.content === 'string' && delta.content.length > 0) {
      this.emittedContent = true;
      this.outputChars += delta.content.length;
      this.openText();
      this.emit('content_block_delta', {
        type: 'content_block_delta',
        index: this.openIndex,
        delta: { type: 'text_delta', text: delta.content },
      });
    }

    for (const call of delta.tool_calls ?? []) {
      // OpenAI omits `index` on a provider that only ever calls one tool; 0 is
      // then the only index there is.
      const toolIndex = typeof call.index === 'number' ? call.index : 0;
      const name = call.function?.name;
      const args = call.function?.arguments;
      const hasArgs = typeof args === 'string' && args.length > 0;

      /*
       * The accumulator is seeded *before* the block is opened, so the single
       * `content_block_start` carries the real id and name. Opening first and
       * correcting afterwards would emit two starts for one index - a stream
       * that looks plausible and that no SDK will accept.
       */
      let tool = this.tools.get(toolIndex);
      if (!tool) {
        tool = { id: toolUseId(call.id), name: name ?? '', args: '', blockOpened: false };
        this.tools.set(toolIndex, tool);
      } else {
        if (call.id && call.id !== tool.id) tool.id = call.id;
        if (name && name !== tool.name) tool.name = name;
      }

      /*
       * A header-only chunk opens nothing. Providers commonly send every
       * call's id/name first and stream the arguments afterwards, so opening
       * on the header emits an empty block per call and then a *second* start
       * for the same call when its arguments arrive after another call's
       * header - duplicate `tool_use` ids that break the client's tool loop.
       * The block opens on the first arguments instead, when there is
       * something to put in it. A call that never receives arguments is
       * emitted at finish (see flushUnopenedTools) so it is never lost.
       */
      if (!tool.blockOpened) {
        if (!hasArgs) continue;
        this.openToolBlock(tool, toolIndex);
        tool.blockOpened = true;
      } else if (this.openKind !== 'tool' || this.openTool !== toolIndex) {
        /*
         * Arguments for a call whose block already closed: the upstream
         * interleaved argument chunks across tools. Anthropic blocks are
         * strictly sequential, so no legal delta exists for this; a
         * continuation start is best effort. Real providers group each
         * call's arguments together, so this is unreachable outside
         * adversarial streams - and strictly no worse than before.
         */
        this.openToolBlock(tool, toolIndex);
      }

      if (hasArgs) {
        this.emittedContent = true;
        this.outputChars += args.length;
        tool.args += args;
        this.emit('content_block_delta', {
          type: 'content_block_delta',
          index: this.openIndex as number,
          delta: { type: 'input_json_delta', partial_json: args },
        });
      }
    }
  }

  setFinishReason(finishReason: string | null): void {
    if (finishReason) this.stopReason = finishReason;
  }

  get sawFinishReason(): boolean {
    return this.stopReason !== null;
  }

  /** True once a text or tool block has carried anything at all. */
  get hasContent(): boolean {
    return this.emittedContent;
  }

  setUsage(usage: { prompt_tokens?: number; completion_tokens?: number; cache_read_input_tokens?: number; output_tokens?: number } | null | undefined): void {
    if (typeof usage?.prompt_tokens === 'number') this.promptTokens = usage.prompt_tokens;
    // Anthropic splits input from cache reads, so the two are summed back into
    // the single prompt figure the log stores - a cached token is still a token
    // that was sent, it is just billed differently.
    if (typeof usage?.cache_read_input_tokens === 'number') this.cachedTokens = usage.cache_read_input_tokens;
    if (typeof usage?.completion_tokens === 'number') this.completionTokens = usage.completion_tokens;
    else if (typeof usage?.output_tokens === 'number') this.completionTokens = usage.output_tokens;
  }

  /** Closes any open block and writes the tail. Safe to call once. */
  finish(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.start();
    this.closeOpen();
    this.flushUnopenedTools();
    this.emit('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: stopReasonOf(this.stopReason), stop_sequence: null },
      /*
       * Anthropic reports output_tokens here. input_tokens is included too:
       * message_start is written before the upstream has sent usage, so this
       * is the only place the real input count can reach the client.
       */
      usage: {
        output_tokens: this.completionTokens ?? 0,
        input_tokens: this.promptTokens ?? 0,
      },
    });
    this.emit('message_stop', { type: 'message_stop' });
  }

  get ttfbSeen(): boolean {
    return this.started;
  }

  /*
   * Usage is read off the parsed chunks rather than scanned out of the raw
   * bytes. The byte scan exists in `pipeSseToReply` only because that path
   * relays frames without parsing them; here every chunk is already an object.
   */
  get usage(): { promptTokens: number | null; completionTokens: number | null; cachedTokens: number | null } {
    return { promptTokens: this.promptTokens, completionTokens: this.completionTokens, cachedTokens: this.cachedTokens };
  }

  /** Output size seen so far; the caller estimates tokens from it when usage is absent. */
  get outputTextChars(): number {
    return this.outputChars;
  }
}

/** Pulls the `data:` payload out of one SSE frame, or null for a non-data frame. */
function frameData(frame: string): string | null {
  const parts: string[] = [];
  for (const line of frame.split('\n')) {
    if (line.startsWith('data:')) parts.push(line.slice(5).trimStart());
  }
  return parts.length ? parts.join('\n') : null;
}

/**
 * How much of the raw body is kept while an attempt has produced nothing.
 *
 * The capture exists solely to recover a *complete* answer that arrived in the
 * wrong shape, so it stops the moment real content is relayed: a healthy stream
 * holds nothing, and only the "the upstream sent something we could not read"
 * case - where the whole body is at most one message - pays for it.
 */

/** The first argument that is a non-empty string, or null when there is none. */
function firstNonEmptyString(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

/**
 * Relays a completion that arrived whole, when a stream was requested.
 *
 * Returns false for anything that is not a completion carrying real content, so
 * a genuinely empty response stays empty and remains abandonable - the recovery
 * must never manufacture content the upstream did not produce.
 *
 * The three reasoning field names are read because the non-streaming path reads
 * the same three (`outbound.ts`), and a reasoning model's entire answer is its
 * reasoning: miss it here and the request is failed over for the same reason it
 * was before this existed.
 */
function recoverCompleteAnswer(raw: string, writer: AnthropicStreamWriter): boolean {
  // Shared with the OpenAI pipe, so the two dialects can never disagree about
  // which upstream shapes are rescuable.
  const completion = parseWholeCompletion(raw);
  if (!completion) return false;

  const choice = completion.choices?.[0];
  const message = choice?.message;
  if (!message) return false;

  const reasoning = firstNonEmptyString(message.reasoning_content, message.reasoning, message.thinking);
  const answer = typeof message.content === 'string' && message.content.length > 0 ? message.content : null;
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];

  writer.push({
    content: answer,
    reasoning_content: reasoning,
    tool_calls: toolCalls.map((call: { id?: string; function?: { name?: string; arguments?: string } }) => ({
      id: call.id,
      function: { name: call.function?.name, arguments: call.function?.arguments },
    })),
  });
  if (choice?.finish_reason) writer.setFinishReason(choice.finish_reason);
  if (completion.usage) writer.setUsage(completion.usage);
  return true;
}

/**
 * Relays an upstream OpenAI stream to the client as Anthropic message events.
 *
 * Deliberately mirrors `pipeSseToReply`'s contract - same arguments, same
 * `StreamOutcome` - so the proxy can swap one for the other and the recorder
 * below it is unchanged.
 */
export async function pipeAnthropicSse(
  response: Response,
  reply: FastifyReply,
  startedAt: number,
  requestedModel: string,
  stallTimeoutMs: number = DEFAULT_STREAM_STALL_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<StreamOutcome> {
  const raw = reply.raw;

  /*
   * Nothing is written - and the reply is not hijacked - until the upstream has
   * actually produced something.
   *
   * A gateway that fronts many providers sometimes drops a stream a second in,
   * having sent nothing usable. Writing `message_start` immediately means the
   * client is committed to a response that is already dead, and the request
   * cannot be retried on another key. Buffering until the first real token
   * keeps the attempt abandonable: if the upstream dies first, the socket is
   * untouched and the caller can fail over exactly as it does for a connection
   * that never opened.
   */
  const pending: string[] = [];
  let committed = false;

  const send = (event: string, data: unknown) => {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    if (committed) raw.write(frame);
    else pending.push(frame);
  };

  const commit = (): void => {
    if (committed) return;
    committed = true;
    reply.hijack();
    raw.writeHead(response.status, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Tells any intermediate proxy not to buffer the stream.
      'x-accel-buffering': 'no',
    });
    for (const frame of pending) raw.write(frame);
    pending.length = 0;
  };

  const writer = new AnthropicStreamWriter(send, newMessageId(), requestedModel);

  const body = response.body;
  if (!body) {
    /*
     * Headers and nothing else - no answer, and nothing to translate.
     *
     * This used to commit the socket and report `delivered_to_client`, which is
     * the worst of both worlds: the client was handed a well-formed but empty
     * Anthropic message it could not tell from a real one, *and* the attempt was
     * marked as having succeeded, so the pool was never asked for another key
     * even though a sibling key would very likely have served the request. It was
     * also the only place this pipe disagreed with `pipeSseToReply`, which has
     * always reported the identical case as `delivered_nothing`.
     *
     * So it reports what actually happened - nothing arrived - and leaves the
     * socket alone so the caller can fail over. The socket is untouched, so the
     * client is not committed and there is nothing to clean up here.
     */
    return outcome(writer, Date.now() - startedAt, null, true, 'Upstream returned no response body.', false, 'delivered_nothing');
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let errorMessage: string | null = null;
  let sawDone = false;
  let ttfbMs: number | null = null;

  /*
   * The raw body, kept only while this attempt has produced nothing.
   *
   * An upstream that answers a `stream: true` request with a plain JSON body
   * sends a complete, correct answer in a shape this parser never sees: there is
   * not one `data:` line in it. Reading only SSE frames therefore finds nothing,
   * concludes the attempt produced nothing, discards an answer the model really
   * did produce, and retries - which is how a pool turns a working upstream into
   * a wall of 502s naming a network fault that never happened.
   *
   * Capturing the bytes is what lets the two be told apart. The capture is
   * abandoned at the first real content, so a normal stream pays nothing for it.
   */
  let captured = '';
  let capturing = true;

  /*
   * Whether the upstream put something *translatable* in a delta.
   *
   * This is the signal that separates the two failures a single boolean used to
   * conflate. A frame carrying an empty `{}` delta, or the `{ role: 'assistant' }`
   * preamble every OpenAI stream opens with, is bookkeeping rather than
   * content - counting it would make a genuinely empty response look like a
   * translation gap and stop a legitimately retryable request from failing over.
   *
   * So the test is not "any populated field" but "any field that is not one of
   * the bookkeeping keys", which is what makes a genuinely unknown field
   * (`some_future_field`) register while a preamble does not.
   */
  const BOOKKEEPING_DELTA_KEYS = new Set(['role', 'content', 'reasoning_content', 'reasoning', 'thinking', 'tool_calls']);
  let sawUpstreamDelta = false;

  /*
   * Set when the commit below is reached *because* the upstream sent frames
   * this translator could not map, rather than because anything was delivered.
   * Tracked explicitly so the outcome says which of the two happened, instead
   * of a caller inferring it from the absence of content.
   */
  let droppedInTranslation = false;

  const handle = (payload: string): boolean => {
    if (payload === '[DONE]') return false;
    let chunk: {
      choices?: Array<{ delta?: Record<string, unknown>; finish_reason?: string | null }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
    };
    try {
      chunk = JSON.parse(payload);
    } catch {
      return true;
    }

    if (!ttfbMs) ttfbMs = Date.now() - startedAt;
    if (chunk.usage) writer.setUsage(chunk.usage);
    for (const choice of chunk.choices ?? []) {
      if (choice.delta) {
        const populated = Object.entries(choice.delta).filter(
          ([key, value]) => !BOOKKEEPING_DELTA_KEYS.has(key) && value !== null && value !== undefined,
        );
        if (populated.length > 0) sawUpstreamDelta = true;
        writer.push(choice.delta);
      }
      if (choice.finish_reason) writer.setFinishReason(choice.finish_reason);
    }
    return true;
  };

  const drain = (): boolean => {
    for (;;) {
      const split = buffer.search(/\r?\n\r?\n/);
      if (split === -1) break;
      const frame = buffer.slice(0, split);
      buffer = buffer.slice(split + (buffer[split] === '\r' ? 4 : 2));
      const data = frameData(frame);
      if (data === null) continue;
      if (!handle(data)) return false;
    }
    return true;
  };

  /*
   * The stall watchdog, identical to the one on the OpenAI pipe and for the same
   * reason: the header deadline is cleared once headers arrive, so nothing bounded
   * the body read, and an upstream that went quiet after its headers held the
   * request open indefinitely. Racing the read against a timer that is re-armed on
   * every byte measures the gap between chunks, not the length of the turn, so a
   * slow-but-alive stream is never cut off. The rejection lands in the `catch`
   * below, which is where a mid-stream failure already belongs.
   */
  let stallTimer: NodeJS.Timeout | undefined;
  let rejectStall: ((err: Error) => void) | undefined;
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
   * Client disconnect, raced against every read: without it this pipe keeps
   * translating a stream nobody receives, billing the upstream for a ghost.
   * The caller decides the meaning (record, never fail over); here the read
   * stops and the socket is released.
   */
  let rejectAbort: ((err: Error) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = (): void => {
    rejectAbort?.(new Error('Client disconnected'));
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();

  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), stall, aborted]);
      armStall();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      buffer += text;
      if (capturing) {
        captured += text;
        // A body that has already outgrown any single completion message is not
        // one, so there is nothing left worth holding on to.
        if (captured.length > COMPLETE_CAPTURE_CAP) capturing = false;
      }
      if (!drain()) {
        sawDone = true;
        break;
      }
      // The first real token, or a completed-but-empty turn, is the point the
      // client is committed to this attempt.
      if (!committed && (writer.hasContent || writer.sawFinishReason)) {
        // The answer is in SSE frames after all; the capture has done its job.
        capturing = false;
        commit();
      }
      if (sawDone) break;
    }

    /*
     * Flush whatever is left. An upstream that ends its stream without a
     * trailing blank line - which several OpenAI-compatible ones do - leaves
     * its final frame sitting in the buffer, and dropping it silently cut the
     * answer off short while the client was told the stream had ended
     * normally. This is the single most likely cause of a response that
     * "terminates in the middle".
     *
     * Each `data:` line is handled on its own rather than joined into one
     * payload. A tail of `data: {...}\ndata: [DONE]` with no blank line between
     * them is two frames to any client that has stopped being strict, and
     * joining them yields neither the chunk nor the terminator. Splitting a
     * JSON payload across several `data:` lines would be the case this loses -
     * and `JSON.stringify` never emits a raw newline, so an upstream built on
     * it cannot produce one.
     */
    buffer += decoder.decode();
    for (const line of buffer.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      if (!handle(line.slice(5).trim())) {
        sawDone = true;
        break;
      }
    }
    buffer = '';

    /*
     * The commit check has to run here too, not only inside the read loop.
     *
     * This is the mirror of a defect already fixed in `pipeSseToReply`, and it
     * cost a day of 502s to find: an upstream whose frames are separated by a
     * single newline, or whose last frame has no terminating blank line, leaves
     * the whole body unsplittable. `drain()` finds no `\n\n` boundary, the loop
     * never reaches its own commit check, and the frames are handled for the
     * first time right here - after the loop. So the answer was parsed
     * correctly, `writer.hasContent` was true, and `committed` was still false.
     *
     * The outcome that produced is `delivered_nothing`, which the caller reads
     * as "the upstream produced nothing": the key is marked against the
     * breaker, every key in the pool is spent, and a request the upstream
     * answered in full comes back as
     *
     *     502 "Upstream closed the stream before finishing the response."
     *
     * The two pipes now agree: whatever path the content took to get here, the
     * client is committed as soon as there is something to commit to.
     */
    if (!committed && (writer.hasContent || writer.sawFinishReason)) {
      capturing = false;
      commit();
    }
  } catch (err) {
    // The upstream died mid-stream. Whatever was already written to the client
    // is the only valid continuation, so the stream is closed cleanly and the
    // failure is reported rather than thrown into a hijacked socket.
    errorMessage = (err as Error).message;
    if (signal?.aborted) {
      try {
        await reader.cancel();
      } catch {
        /* already closed */
      }
    }
  } finally {
    // Cleared on every exit, including the early `return false` through `drain()`.
    // A live timer would reject an already-settled promise and hold the process
    // open long after the request finished.
    if (stallTimer) clearTimeout(stallTimer);
    signal?.removeEventListener('abort', onAbort);
  }

  // No recovery and no commit for a client that has left: the bytes below
  // would be translated for nobody, and committing would answer a dead socket.
  const disconnected = signal?.aborted ?? false;

  /*
   * A stream that ends without `[DONE]` *and* without a finish reason was cut
   * off somewhere we cannot see. Said out loud, because otherwise the operator
   * is told only that a stream "stopped" and has nothing to go on.
   */
  if (!sawDone && !writer.sawFinishReason && errorMessage === null) {
    errorMessage = 'Upstream closed the stream before finishing the response.';
  }

  /*
   * Nothing reached the client. What that means depends entirely on whether
   * the upstream sent anything, which is why this is two branches and not one
   * boolean.
   *
   * `sawUpstreamDelta` false: the upstream really did produce nothing. The
   * socket was never hijacked, so the attempt is genuinely abandonable and the
   * caller can try another key - the same thing it does for a connection that
   * never opened.
   *
   * `sawUpstreamDelta` true: the upstream sent frames and this translator
   * could not map them onto the client's protocol. That is our loss, not the
   * key's, and retrying is guaranteed to repeat it - the next key is the same
   * gateway emitting the same frames. So the client is committed and told, and
   * the pool is not spent. That distinction is the whole reason this is three
   * states and not two: collapsing it is what turned a translation gap into a
   * 502 and three burned keys.
   */
  /*
   * The upstream produced nothing *this pipe could read*, which is not the same
   * thing as the upstream producing nothing.
   *
   * A gateway that buffers, or a backend reached through it that does not
   * stream, answers a `stream: true` request with an ordinary
   * `application/json` completion: one complete message, not a single `data:`
   * line. The SSE scanner finds nothing there, so without this check the proxy
   * discards an answer the model really did produce, marks the key against,
   * spends the pool, and answers 502 for a request that succeeded. It arrives in
   * bursts, because the gateway's choice of backend is what decides which shape
   * a given request gets.
   *
   * So the bytes are read back before the attempt is written off. Anything that
   * parses as a completion carrying real content is relayed through the same
   * writer as a stream, so the client cannot tell the difference and the log
   * records a success.
   */
  const recovered = !disconnected && !committed && !writer.hasContent ? recoverCompleteAnswer(captured, writer) : false;

  /*
   * A refusal delivered with a 200 rather than an answer.
   *
   * Without this the two cases are indistinguishable: the body holds no frames
   * and no completion, `sawUpstreamDelta` is false, and the attempt is reported as
   * `delivered_nothing` with a message about a stream that closed. So a gateway
   * that rate-limits behind a 200 gets its refusal rewritten as a network fault,
   * every key in the pool is spent re-sending a request that was already turned
   * down, and the operator is shown a 502 describing a network that was fine.
   *
   * The upstream spoke, so the reason it gave is the reason recorded - and it
   * travels out with the outcome so the caller can hold the key responsible for
   * the call rather than for the outcome.
   */
  const upstreamError =
    !disconnected && !committed && !writer.hasContent ? parseUpstreamErrorEnvelope(captured) ?? parseSseErrorFrame(captured) : null;

  if (disconnected && !committed) {
    // Never fail over onto a sibling key to serve a client that has left.
    // The caller checks its own disconnect flag before spending the pool.
    return outcome(
      writer,
      Date.now() - startedAt,
      ttfbMs,
      true,
      'Client disconnected',
      sawDone,
      'delivered_nothing',
    );
  }

  if (recovered) {
    sawUpstreamDelta = true;
    sawDone = true;
    errorMessage = null;
  } else if (!committed && !writer.hasContent) {
    if (!sawUpstreamDelta) {
      return outcome(
        writer,
        Date.now() - startedAt,
        ttfbMs,
        true,
        upstreamError?.message ?? errorMessage ?? 'Upstream closed the stream before sending any content.',
        sawDone,
        'delivered_nothing',
        upstreamError,
      );
    }
    /*
     * Fall through to the commit below, but name the real cause on the way.
     *
     * Assigned rather than defaulted: an untranslatable response very often
     * arrives on a stream that *also* ended badly, so an existing
     * `errorMessage` would describe the truncation and hide the translation
     * gap that is the actual reason nothing reached the client. Naming only the
     * cause someone can act on is the point of this branch.
     */
    droppedInTranslation = true;
    errorMessage = 'Upstream sent a response this proxy could not translate into the Anthropic format.';
  }

  try {
    commit();
    // On an abnormal end the client is told why, in the shape it parses. A
    // stream that simply stops mid-sentence is the hardest thing to diagnose
    // from the other side; an `error` event names the failure.
    if (errorMessage !== null) {
      send('error', anthropicError('api_error', errorMessage));
    }
    writer.finish();
    raw.end();
  } catch {
    // The client disconnected mid-write. The socket is already gone, so there
    // is nothing to say to it and nothing to clean up - but throwing out of a
    // hijacked response would take the process with it.
  }

  return outcome(
    writer,
    Date.now() - startedAt,
    ttfbMs,
    errorMessage !== null,
    errorMessage,
    sawDone,
    droppedInTranslation ? 'dropped_in_translation' : 'delivered_to_client',
  );
}

function outcome(
  writer: AnthropicStreamWriter,
  latencyMs: number,
  ttfbMs: number | null,
  errored: boolean,
  errorMessage: string | null,
  sawDone: boolean,
  delivery: StreamDelivery,
  upstreamError?: RecoveredUpstreamError | null,
): StreamOutcome {
  const { promptTokens, completionTokens, cachedTokens } = writer.usage;
  // Left null rather than guessed when the upstream reported no usage, so the
  // log says "not reported" instead of a confident zero.
  const total =
    promptTokens !== null || completionTokens !== null
      ? (promptTokens ?? 0) + (completionTokens ?? 0)
      : null;
  return {
    ttfbMs,
    latencyMs,
    promptTokens,
    completionTokens,
    totalTokens: total,
    cachedTokens,
    reasoningTokens: null,
    outputTextChars: writer.outputTextChars,
    errored,
    errorMessage,
    sawDone,
    delivery,
    ...(upstreamError ? { upstreamError } : {}),
  };
}
