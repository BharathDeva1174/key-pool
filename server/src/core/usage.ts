/**
 * Reading token usage out of an upstream response, kept pure.
 *
 * Every provider reports this differently and several report it in more than one
 * place, so each field is read from the places it can legitimately appear. A
 * field that is absent everywhere stays null rather than becoming 0, because 0
 * is a claim about the request and null is a claim about our knowledge of it.
 */

/** The three token counts the log records. */
export interface Usage {
  promptTokens: number | null;
  completionTokens: number | null;
  /**
   * The provider's own `total_tokens`, kept rather than recomputed as
   * prompt + completion. They are normally equal, but a provider that counts
   * reasoning outside the completion figure will report a larger total, and
   * replacing its number with our arithmetic would be a silent disagreement
   * between the log and the upstream's own invoice.
   */
  totalTokens: number | null;
  /** Input tokens the provider served from its prompt cache. */
  cachedTokens: number | null;
  /** Reasoning/thinking tokens, when the provider breaks them out. */
  reasoningTokens: number | null;
  /**
   * True when `completionTokens` already contains `reasoningTokens`.
   *
   * It usually does. OpenAI nests them under `completion_tokens_details`, where
   * the detail is a *breakdown* of the total rather than an addition to it, and
   * Anthropic folds thinking into `output_tokens`.
   */
  completionIncludesReasoning: boolean;
}

/**
 * Normalises the usage object from any of the three response shapes.
 */
export function readUsage(raw: unknown): Usage {
  const u = (raw ?? {}) as Record<string, unknown>;
  const num = (...keys: string[]): number | null => {
    for (const k of keys) {
      const v = u[k];
      if (typeof v === 'number' && Number.isFinite(v)) return v;
    }
    return null;
  };

  const details = (u.completion_tokens_details ?? u.output_tokens_details) as Record<string, unknown> | undefined;
  const promptDetails = (u.prompt_tokens_details ?? u.input_tokens_details) as Record<string, unknown> | undefined;

  const reasoning =
    num('reasoning_tokens') ??
    (details && typeof details.reasoning_tokens === 'number' ? details.reasoning_tokens : null) ??
    (details && typeof details.thoughts_tokens === 'number' ? details.thoughts_tokens : null);

  // Anthropic reports cache reads at the top level; OpenAI-compatible gateways
  // put them under prompt_tokens_details. Read both, and both spellings of the
  // nested key, because a gateway that renames one field usually renames only
  // that one.
  const cached =
    num('cached_tokens', 'cache_read_input_tokens', 'prompt_cache_hit_tokens', 'cache_read_tokens') ??
    (promptDetails && typeof promptDetails.cached_tokens === 'number' ? promptDetails.cached_tokens : null) ??
    (promptDetails && typeof promptDetails.cache_read_tokens === 'number' ? promptDetails.cache_read_tokens : null);

  const nested = !!(details && typeof details.reasoning_tokens === 'number');

  return {
    promptTokens: num('prompt_tokens', 'input_tokens'),
    completionTokens: num('completion_tokens', 'output_tokens'),
    totalTokens: num('total_tokens'),
    cachedTokens: cached,
    reasoningTokens: reasoning,
    completionIncludesReasoning: nested || u.output_tokens !== undefined,
  };
}

// ----------------------------------------------------------------- estimating

/**
 * A rough token count for text a provider never counted for us.
 *
 * This is the fallback for a stream whose upstream ignored
 * `stream_options.include_usage` and sent no usage frame at all. English prose
 * runs near four characters per token, which is the same approximation the
 * Anthropic `count_tokens` answer uses, and it is honest about being one: the
 * estimate exists so a request is not silently free, not to rival the
 * provider's own invoice. A floor of one keeps a non-empty answer from
 * rounding away entirely; an empty one is genuinely zero tokens.
 */
export function estimateTokensFromChars(chars: number): number {
  if (!Number.isFinite(chars) || chars <= 0) return 0;
  return Math.max(1, Math.round(chars / 4));
}

/**
 * Estimates the prompt size of an OpenAI-shaped request body.
 *
 * Reads only the text the provider actually bills for - message content,
 * tool-call arguments and tool definitions - because counting the JSON
 * scaffolding (`"role": "assistant"` and friends) would inflate the estimate on
 * every request. Parts arrays are walked rather than stringified whole so a
 * base64 image part does not masquerade as half a million characters of prose.
 */
export function estimatePromptTokens(body: unknown): number {
  let chars = 0;

  const textOf = (value: unknown): void => {
    if (typeof value === 'string') {
      chars += value.length;
    } else if (Array.isArray(value)) {
      for (const part of value) {
        if (part && typeof part === 'object') {
          const record = part as Record<string, unknown>;
          if (typeof record.text === 'string') chars += record.text.length;
          // A tool result carries its payload under `content`.
          textOf(record.content);
        }
      }
    }
  };

  const b = (body ?? {}) as Record<string, unknown>;
  if (Array.isArray(b.messages)) {
    for (const message of b.messages as unknown[]) {
      if (!message || typeof message !== 'object') continue;
      const m = message as Record<string, unknown>;
      textOf(m.content);
      if (typeof m.name === 'string') chars += m.name.length;
      if (typeof m.tool_call_id === 'string') chars += 8;
      if (Array.isArray(m.tool_calls)) {
        for (const call of m.tool_calls as unknown[]) {
          if (!call || typeof call !== 'object') continue;
          const fn = (call as Record<string, unknown>).function as Record<string, unknown> | undefined;
          if (typeof fn?.arguments === 'string') chars += fn.arguments.length;
          if (typeof fn?.name === 'string') chars += fn.name.length;
        }
      }
    }
  }
  if (Array.isArray(b.tools)) {
    try {
      chars += JSON.stringify(b.tools).length;
    } catch {
      /* circular tools are not a real request; skip them */
    }
  }
  if (typeof b.prompt === 'string') chars += b.prompt.length;

  return estimateTokensFromChars(chars);
}