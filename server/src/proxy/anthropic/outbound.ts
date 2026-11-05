/**
 * OpenAI chat-completions -> Anthropic message.
 *
 * The mirror of `inbound.ts`. The one decision worth stating is which model id
 * goes back: the **requested** one, never the upstream one. A client addresses
 * models by name, and a request that came in for a spoofed name has to come
 * back under that same name or the next turn in the conversation will not
 * resolve.
 */

export interface AnthropicContentBlock {
  type: 'text' | 'tool_use' | 'thinking';
  text?: string;
  /** Reasoning text, on a `thinking` block. */
  thinking?: string;
  /**
   * Always present on a `thinking` block, and empty here: it is the upstream's
   * own attestation of its thinking, which this proxy cannot forge. Sent empty
   * rather than omitted so the block keeps the shape a client parses.
   */
  signature?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

export interface AnthropicMessage {
  id: string;
  type: 'message';
  role: 'assistant';
  model: string;
  content: AnthropicContentBlock[];
  stop_reason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | null;
  stop_sequence: string | null;
  usage: { input_tokens: number; output_tokens: number };
}

export interface OpenAIResponse {
  id?: string;
  model?: string;
  choices?: Array<{
    message?: {
      content?: string | null;
      /** Reasoning, under whichever of the three names the gateway uses. */
      reasoning_content?: string | null;
      reasoning?: string | null;
      thinking?: string | null;
      tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
}

const FINISH_REASONS: Record<string, AnthropicMessage['stop_reason']> = {
  stop: 'end_turn',
  length: 'max_tokens',
  tool_calls: 'tool_use',
  function_call: 'tool_use',
  content_filter: 'end_turn',
};

/** `msg_` + hex, matching the shape an Anthropic client expects to parse. */
export function newMessageId(): string {
  return `msg_${Math.random().toString(16).slice(2, 10)}${Date.now().toString(16)}`;
}

/** A tool id is only ever generated when the upstream did not supply one. */
export function toolUseId(seed?: string): string {
  if (typeof seed === 'string' && seed.trim()) return seed;
  return `toolu_${Math.random().toString(16).slice(2, 10)}${Date.now().toString(16)}`;
}

export function stopReasonOf(finishReason: string | null | undefined): AnthropicMessage['stop_reason'] {
  if (!finishReason) return 'end_turn';
  return FINISH_REASONS[finishReason] ?? 'end_turn';
}

export function toAnthropicMessage(upstream: OpenAIResponse, requestedModel: string): AnthropicMessage {
  const choice = upstream.choices?.[0];
  const content: AnthropicContentBlock[] = [];

  /*
   * Reasoning becomes a leading `thinking` block, mirroring the streaming path.
   * The same three field names are read because the same gateways send them, and
   * the same thing happens when none is read: a reasoning model's whole answer
   * is reasoning, and it arrives here as a message with no content in it.
   */
  const message = choice?.message;
  const reasoning = [message?.reasoning_content, message?.reasoning, message?.thinking].find(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
  if (reasoning !== undefined) {
    content.push({ type: 'thinking', thinking: reasoning, signature: '' });
  }

  const text = choice?.message?.content;
  if (typeof text === 'string' && text.length > 0) {
    content.push({ type: 'text', text });
  }

  /*
   * Tool calls become `tool_use` blocks in the same message as the text, which
   * is what lets a turn say "let me check that" and then call a tool - the
   * shape every Anthropic tool loop is written against.
   */
  for (const call of choice?.message?.tool_calls ?? []) {
    const name = call.function?.name;
    if (typeof name !== 'string' || !name) continue;
    let input: unknown = {};
    try {
      input = call.function?.arguments ? JSON.parse(call.function.arguments) : {};
    } catch {
      /*
       * Arguments that will not parse are passed through as a marker rather
       * than dropped. A tool call with no input is still a tool call the client
       * has to answer, and a silently missing block would end the turn without
       * it ever running.
       */
      input = { __unparsed_arguments: call.function?.arguments ?? '' };
    }
    content.push({ type: 'tool_use', id: toolUseId(call.id), name, input });
  }

  return {
    id: typeof upstream.id === 'string' && upstream.id ? upstream.id : newMessageId(),
    type: 'message',
    role: 'assistant',
    // The requested name, so a spoofed or aliased model keeps addressing the
    // same thing on the next turn.
    model: requestedModel,
    content,
    stop_reason: stopReasonOf(choice?.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: upstream.usage?.prompt_tokens ?? 0,
      output_tokens: upstream.usage?.completion_tokens ?? 0,
    },
  };
}

/** The error envelope an Anthropic client parses. */
export function anthropicError(type: string, message: string): Record<string, unknown> {
  return { type: 'error', error: { type, message } };
}

/** OpenAI status -> Anthropic error type, for the failures this proxy raises. */
export function anthropicErrorType(status: number): string {
  if (status === 400) return 'invalid_request_error';
  if (status === 401) return 'authentication_error';
  if (status === 403) return 'permission_error';
  if (status === 404) return 'not_found_error';
  if (status === 413) return 'request_too_large';
  if (status === 429) return 'rate_limit_error';
  if (status >= 500) return 'api_error';
  return 'invalid_request_error';
}
