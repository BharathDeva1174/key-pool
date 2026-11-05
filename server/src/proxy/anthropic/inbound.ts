/**
 * Anthropic Messages API -> OpenAI chat-completions.
 *
 * Translation is one-way and lives entirely at the edge: every upstream KeyPool
 * speaks the OpenAI dialect, so nothing downstream of this file changes. The
 * failover, health and stats machinery is shared by both dialects.
 *
 * The awkward parts of this mapping are documented where they happen, because
 * each one is a place a plausible-looking translation silently corrupts a tool
 * call rather than failing loudly.
 */

export interface AnthropicBlock {
  type: string;
  text?: string;
  thinking?: string;
  source?: { type: string; media_type?: string; data?: string; url?: string };
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: string | AnthropicBlock[];
  is_error?: boolean;
}

export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicBlock[];
}

export interface AnthropicMessagesRequest {
  model?: unknown;
  max_tokens?: unknown;
  system?: unknown;
  messages?: unknown;
  tools?: unknown;
  tool_choice?: unknown;
  stop_sequences?: unknown;
  temperature?: unknown;
  top_p?: unknown;
  top_k?: unknown;
  stream?: unknown;
}

export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | Array<Record<string, unknown>> | null;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

export interface OpenAITool {
  type: 'function';
  function: { name: string; description?: string; parameters?: unknown };
}

export interface OpenAIRequest {
  model: string;
  messages: OpenAIMessage[];
  max_tokens?: number;
  stream?: boolean;
  stream_options?: { include_usage: true };
  tools?: OpenAITool[];
  tool_choice?: unknown;
  stop?: string[];
  temperature?: number;
  top_p?: number;
}

/** A translation that could not be made, with a reason an operator can act on. */
export class InboundError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

const isBlock = (v: unknown): v is AnthropicBlock => typeof v === 'object' && v !== null && typeof (v as { type?: unknown }).type === 'string';

/**
 * The plain text of an Anthropic content value.
 *
 * A string is returned as-is; a block array is flattened to its text blocks.
 * Anything else flattens to empty rather than throwing, because a message the
 * model would have seen as empty is not worth failing the whole turn over.
 */
function textOf(content: string | AnthropicBlock[] | undefined): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(isBlock)
    .map((b) => (typeof b.text === 'string' ? b.text : ''))
    .join('');
}

/** A `tool_result` payload is text on the wire; the OpenAI side takes a string. */
function toolResultText(block: AnthropicBlock): string {
  const text = textOf(block.content as string | AnthropicBlock[] | undefined);
  // OpenAI has no error flag for a tool result, so a failed call is marked in
  // the text the model reads rather than being flattened into a success.
  return block.is_error ? `Error: ${text}` : text;
}

function blocksOf(message: AnthropicMessage): AnthropicBlock[] {
  if (typeof message.content === 'string') {
    return message.content.length ? [{ type: 'text', text: message.content }] : [];
  }
  return Array.isArray(message.content) ? message.content.filter(isBlock) : [];
}

/** An image becomes an `image_url` part; a base64 source becomes a data URL. */
function imagePart(block: AnthropicBlock): Record<string, unknown> | null {
  const src = block.source;
  if (!src || typeof src !== 'object') return null;
  const url = src.type === 'base64' && typeof src.data === 'string'
    ? `data:${src.media_type ?? 'image/png'};base64,${src.data}`
    : typeof src.url === 'string'
      ? src.url
      : null;
  if (!url) return null;
  return { type: 'image_url', image_url: { url } };
}

/** Splits one user turn into plain content and the tool results it carries. */
interface Turn {
  content: Array<Record<string, unknown>> | string;
  toolResults: Array<{ id: string; text: string }>;
}

function userTurn(blocks: AnthropicBlock[]): Turn {
  const parts: Array<Record<string, unknown>> = [];
  const toolResults: Array<{ id: string; text: string }> = [];

  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push({ type: 'text', text: block.text });
    } else if (block.type === 'image') {
      const part = imagePart(block);
      if (part) parts.push(part);
    } else if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
      toolResults.push({ id: block.tool_use_id, text: toolResultText(block) });
    }
    // `thinking` and anything unrecognised are dropped rather than
    // half-translated: a field the upstream does not understand is worse than
    // one that is absent, because it is silently ignored anyway.
  }

  if (parts.length === 0) return { content: '', toolResults };
  // A single text part is sent as a bare string, which is what every
  // OpenAI-compatible upstream is happiest with.
  if (parts.length === 1 && parts[0]!.type === 'text') return { content: parts[0]!.text as string, toolResults };
  return { content: parts, toolResults };
}

/** An assistant turn carries its text and any tool calls it is asking for. */
function assistantTurn(blocks: AnthropicBlock[]): OpenAIMessage {
  const parts: Array<Record<string, unknown>> = [];
  const toolCalls: OpenAIMessage['tool_calls'] = [];

  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push({ type: 'text', text: block.text });
    } else if (block.type === 'tool_use' && typeof block.name === 'string') {
      toolCalls.push({
        id: block.id ?? `call_${toolCalls.length}`,
        type: 'function',
        // The id is carried through untouched, so the `tool_use_id` the client
        // sends back on the next turn still resolves to this call. A tool loop
        // that loses that association returns every result to the wrong call.
        function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
      });
    }
  }

  const content = parts.length === 0 ? null : parts.length === 1 && parts[0]!.type === 'text' ? (parts[0]!.text as string) : parts;
  return toolCalls.length ? { role: 'assistant', content, tool_calls: toolCalls } : { role: 'assistant', content };
}

/**
 * Anthropic custom tools become OpenAI function tools. Anything else a client
 * sends - server-side tools such as `web_search`, which carry a `type` but no
 * usable `name` - has no OpenAI equivalent and is reported rather than
 * silently dropped: a search the model never receives is a search that
 * "fails" with no error anywhere.
 */
interface TranslatedTools {
  tools?: OpenAITool[];
  /** `type` values of server-side tools that could not be translated. */
  droppedServerTypes: string[];
}

function translateTools(raw: unknown): TranslatedTools {
  const tools: OpenAITool[] = [];
  const droppedServerTypes: string[] = [];
  if (!Array.isArray(raw)) return { droppedServerTypes };
  for (const t of raw) {
    if (!t || typeof t !== 'object') continue;
    const tool = t as { name?: unknown; description?: unknown; input_schema?: unknown; type?: unknown };
    if (typeof tool.name !== 'string') {
      if (typeof tool.type === 'string') droppedServerTypes.push(tool.type);
      continue;
    }
    tools.push({
      type: 'function',
      function: {
        name: tool.name,
        ...(typeof tool.description === 'string' ? { description: tool.description } : {}),
        parameters: tool.input_schema ?? { type: 'object', properties: {} },
      },
    });
  }
  return { tools: tools.length ? tools : undefined, droppedServerTypes };
}

function translateToolChoice(raw: unknown): unknown {
  if (typeof raw === 'string') {
    if (raw === 'any') return 'required';
    if (raw === 'auto' || raw === 'none') return raw;
    return undefined;
  }
  if (raw && typeof raw === 'object') {
    const choice = raw as { type?: unknown; name?: unknown };
    if (choice.type === 'tool' && typeof choice.name === 'string') {
      return { type: 'function', function: { name: choice.name } };
    }
  }
  return undefined;
}

/**
 * Translates an Anthropic Messages request into an OpenAI chat-completions body.
 *
 * `model` is passed through untouched - KeyPool resolves it exactly as it does
 * for an OpenAI client, so aliases, spoofs and plain model ids all work here
 * with no special handling.
 */
export function toOpenAIRequest(body: AnthropicMessagesRequest): OpenAIRequest {
  const model = typeof body.model === 'string' ? body.model.trim() : '';
  if (!model) {
    throw new InboundError("Missing or invalid 'model'. Expected a JSON body with a model string.");
  }

  const messages: OpenAIMessage[] = [];

  // The Anthropic system prompt is a top-level field; OpenAI carries it as the
  // first message. It goes first so it is part of the cached prefix, which is
  // where every OpenAI-compatible upstream expects an instruction to sit.
  const system = textOf(body.system as string | AnthropicBlock[] | undefined);
  if (system) messages.push({ role: 'system', content: system });

  if (!Array.isArray(body.messages)) {
    throw new InboundError("Missing or invalid 'messages'. Expected an array of { role, content }.");
  }

  for (const raw of body.messages as AnthropicMessage[]) {
    if (!raw || typeof raw !== 'object') continue;
    const blocks = blocksOf(raw);

    if (raw.role === 'assistant') {
      messages.push(assistantTurn(blocks));
      continue;
    }

    const turn = userTurn(blocks);
    if (turn.content !== '') messages.push({ role: 'user', content: turn.content });

    /*
     * Each tool result becomes its own `role: 'tool'` message.
     *
     * Anthropic packs any number of results into a single user turn, but OpenAI
     * takes exactly one per message and matches it by `tool_call_id`. Folding
     * them into one content string would leave every result pointing at
     * whichever call happened to come first, so a multi-tool turn would feed
     * the model one tool's output for another's arguments.
     */
    for (const result of turn.toolResults) {
      messages.push({ role: 'tool', tool_call_id: result.id, content: result.text });
    }
  }

  if (messages.length === 0) {
    throw new InboundError('A request needs at least one message with content.');
  }

  const request: OpenAIRequest = { model, messages };
  if (typeof body.max_tokens === 'number') request.max_tokens = body.max_tokens;
  if (typeof body.temperature === 'number') request.temperature = body.temperature;
  if (typeof body.top_p === 'number') request.top_p = body.top_p;
  // `top_k` has no OpenAI equivalent and is dropped rather than approximated.
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) {
    request.stop = body.stop_sequences.filter((s): s is string => typeof s === 'string');
  }

  const { tools, droppedServerTypes } = translateTools(body.tools);
  if (!tools && droppedServerTypes.length > 0) {
    const kinds = [...new Set(droppedServerTypes)].join(', ');
    throw new InboundError(
      `Anthropic server-side tool(s) (${kinds}) cannot run on this proxy's OpenAI-compatible upstreams and were not sent. ` +
        `Use a client-side tool with an input_schema, or serve this model directly from an Anthropic endpoint.`,
    );
  }
  if (tools) {
    request.tools = tools;
    const choice = translateToolChoice(body.tool_choice);
    if (choice !== undefined) {
      // A forced choice naming a tool that was not sent would reach the
      // upstream pointing at nothing - the exact silent corruption above, one
      // step later. Fail here, naming the tool.
      const forced = (choice as { type?: unknown; function?: { name?: unknown } })?.function?.name;
      if (typeof forced === 'string' && !tools.some((t) => t.function.name === forced)) {
        throw new InboundError(
          `tool_choice names "${forced}", which was not sent upstream (Anthropic server-side tools cannot run on OpenAI-compatible upstreams). ` +
            `Force one of the translated tools instead, or serve this model directly from an Anthropic endpoint.`,
        );
      }
      request.tool_choice = choice;
    }
  }

  if (body.stream === true) {
    request.stream = true;
    /*
     * Without this an OpenAI-compatible upstream sends no token counts on a
     * stream at all, and both the client's usage fields and KeyPool's own token
     * columns would be zero for every streaming request. It is the one OpenAI
     * extension requested here, and it is requested deliberately.
     */
    request.stream_options = { include_usage: true };
  }

  return request;
}

/** Characters per token across the mix of prose and code a coding agent sends. */
const CHARS_PER_TOKEN = 3.7;

/**
 * An estimate of the input tokens an Anthropic request would cost.
 *
 * There is no tokenizer here, and an exact one is not available: the count
 * belongs to whichever upstream ends up serving the request, and that is not
 * known at this point. A character heuristic is what this figure is for — a
 * client uses it to decide whether to compact a context or trim a file, and for
 * that a number within roughly ten percent is as good as an exact one. Spending
 * a round trip to every upstream to answer a question the client only asks
 * approximately would cost more than the answer is worth.
 *
 * Counted over the parts that are actually sent: the system prompt, the
 * conversation, and the tool definitions, which are usually the largest single
 * block an agent sends.
 */
export function estimateInputTokens(body: AnthropicMessagesRequest): number {
  let chars = 0;

  const system = textOf(body.system as string | AnthropicBlock[] | undefined);
  chars += system.length;

  if (Array.isArray(body.messages)) {
    for (const message of body.messages as AnthropicMessage[]) {
      if (!message || typeof message !== 'object') continue;
      for (const block of blocksOf(message)) {
        if (typeof block.text === 'string') chars += block.text.length;
        if (typeof block.name === 'string') chars += block.name.length;
        if (block.input !== undefined) {
          try {
            chars += JSON.stringify(block.input).length;
          } catch {
            chars += 64;
          }
        }
        if (block.source) {
          // A base64 image is a fixed, known cost rather than text, but its
          // media type is the only part that can be read here.
          chars += typeof block.source.media_type === 'string' ? block.source.media_type.length : 0;
        }
        const result = block.content;
        if (typeof result === 'string') chars += result.length;
        else if (Array.isArray(result)) chars += textOf(result).length;
      }
    }
  }

  if (Array.isArray(body.tools)) {
    for (const tool of body.tools) {
      if (!tool || typeof tool !== 'object') continue;
      const t = tool as { name?: unknown; description?: unknown; input_schema?: unknown };
      chars += typeof t.name === 'string' ? t.name.length : 0;
      chars += typeof t.description === 'string' ? t.description.length : 0;
      try {
        chars += t.input_schema === undefined ? 0 : JSON.stringify(t.input_schema).length;
      } catch {
        chars += 64;
      }
    }
  }

  // Never zero: a client reading 0 will assume the request was free.
  return Math.max(1, Math.ceil(chars / CHARS_PER_TOKEN));
}
