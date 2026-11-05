/**
 * Curated intelligence priors, by model-family name.
 *
 * KeyPool does not run benchmarks - it routes traffic. "Intelligence" here is
 * therefore a prior, not a measurement: an ordered rule table over the model
 * id, encoding where each family roughly sits on publicly known capability
 * (reasoning depth, coding ability, instruction following). Reliability and
 * efficiency are measured locally and are not invented here.
 *
 * The table is deliberately ordered and first-match-wins, so the more
 * specific a family name, the earlier it has to appear ('gpt-4.1' before
 * 'gpt-4', 'claude-opus' before 'claude'). Unknown ids fall back to a neutral
 * 55 - labelled "unrated" rather than guessed high, because a wrong high
 * score would pull traffic onto a model nobody has assessed.
 */

export interface IntelPrior {
  /** 0-100, curated. */
  intelligence: number;
  /** Human-readable family, used by the advice copy. */
  family: string;
}

interface Rule {
  test: RegExp;
  intelligence: number;
  family: string;
}

const RULES: Rule[] = [
  // Anthropic
  { test: /claude[-_. ]?(opus|4[-_. ]?opus|3[-_. ]?opus)/i, intelligence: 98, family: 'Claude Opus' },
  { test: /claude[-_. ]?sonnet/i, intelligence: 92, family: 'Claude Sonnet' },
  { test: /claude[-_. ]?haiku/i, intelligence: 78, family: 'Claude Haiku' },
  { test: /claude/i, intelligence: 88, family: 'Claude' },

  // OpenAI
  { test: /\bgpt[-_.]?5/i, intelligence: 97, family: 'GPT-5' },
  { test: /\bo[45](?:[-_.]|$)/i, intelligence: 95, family: 'OpenAI o-series' },
  { test: /\bo3(?:[-_.]|$)/i, intelligence: 92, family: 'OpenAI o3' },
  { test: /\bo1(?:[-_.]|$)/i, intelligence: 88, family: 'OpenAI o1' },
  { test: /\bgpt[-_.]?4\.1/i, intelligence: 90, family: 'GPT-4.1' },
  { test: /\bgpt[-_.]?4o/i, intelligence: 86, family: 'GPT-4o' },
  { test: /\bgpt[-_.]?4/i, intelligence: 82, family: 'GPT-4' },
  { test: /\bgpt[-_.]?3\.5/i, intelligence: 60, family: 'GPT-3.5' },

  // Google
  { test: /gemini[-_.]?2\.5[-_.]?pro/i, intelligence: 93, family: 'Gemini 2.5 Pro' },
  { test: /gemini[-_.]?2\.5[-_.]?flash/i, intelligence: 84, family: 'Gemini 2.5 Flash' },
  { test: /gemini[-_.]?(2|1\.5)[-_.]?pro/i, intelligence: 88, family: 'Gemini Pro' },
  { test: /gemini/i, intelligence: 81, family: 'Gemini' },

  // DeepSeek
  { test: /deepseek[-_.]?r1/i, intelligence: 90, family: 'DeepSeek R1' },
  { test: /deepseek[-_.]?(v3|chat)/i, intelligence: 86, family: 'DeepSeek V3' },
  { test: /deepseek/i, intelligence: 80, family: 'DeepSeek' },

  // xAI
  { test: /grok[-_.]?4/i, intelligence: 94, family: 'Grok 4' },
  { test: /grok[-_.]?3/i, intelligence: 86, family: 'Grok 3' },
  { test: /grok/i, intelligence: 82, family: 'Grok' },

  // Meta
  { test: /llama[-_.]?4/i, intelligence: 84, family: 'Llama 4' },
  { test: /llama[-_.]?3(\.\d)?/i, intelligence: 76, family: 'Llama 3' },
  { test: /llama/i, intelligence: 72, family: 'Llama' },

  // Alibaba
  { test: /qwen[-_.]?3/i, intelligence: 85, family: 'Qwen 3' },
  { test: /qwen[-_.]?2\.5/i, intelligence: 80, family: 'Qwen 2.5' },
  { test: /qwen/i, intelligence: 78, family: 'Qwen' },

  // Moonshot
  { test: /kimi[-_.]?k2/i, intelligence: 86, family: 'Kimi K2' },
  { test: /kimi/i, intelligence: 78, family: 'Kimi' },

  // Zhipu
  { test: /\bglm[-_.]?4(\.\d)?/i, intelligence: 79, family: 'GLM-4' },
  { test: /\bglm/i, intelligence: 72, family: 'GLM' },

  // MiniMax
  { test: /minimax|minimax[-_.]?m/i, intelligence: 74, family: 'MiniMax' },

  // Mistral
  { test: /mistral[-_.]?large|mistral[-_.]?medium/i, intelligence: 80, family: 'Mistral' },
  { test: /codestral|devstral/i, intelligence: 76, family: 'Mistral Code' },
  { test: /magistral/i, intelligence: 78, family: 'Mistral Reasoning' },
  { test: /mistral|mixtral/i, intelligence: 70, family: 'Mistral' },

  // Nvidia / Cohere / Microsoft
  { test: /nemotron/i, intelligence: 77, family: 'Nemotron' },
  { test: /command[-_.]?r\+/i, intelligence: 76, family: 'Command R+' },
  { test: /command[-_.]?r/i, intelligence: 70, family: 'Command R' },
  { test: /phi[-_.]?4/i, intelligence: 70, family: 'Phi-4' },
  { test: /phi[-_.]?3/i, intelligence: 62, family: 'Phi-3' },

  // Google open
  { test: /gemma[-_.]?3/i, intelligence: 70, family: 'Gemma 3' },
  { test: /gemma[-_.]?2/i, intelligence: 62, family: 'Gemma 2' },

  // Coding-specialised providers
  { test: /poolside|laguna/i, intelligence: 78, family: 'Poolside' },
  { test: /code[-_.]?llama|stable[-_.]?code/i, intelligence: 70, family: 'Code-specialised' },

  // Chinese labs, broad sweep
  { test: /ernie|doubao|hunyuan|internlm|yi[-_.]|step[-_.]|seed[-_.]|sensetime|baichuan/i, intelligence: 72, family: 'Regional' },
];

const SIZE_HEAVY = /(\d{1,3})\s?b\b/i;
const HEAVY = /\b(pro|max|ultra|large|plus|70b|72b|120b|235b|405b)\b/i;
const LIGHT = /\b(mini|nano|tiny|lite|flash|small|haiku)\b/i;
const REASON = /\b(reason|reasoning|thinking|r1|o[1-9])\b/i;

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/**
 * The prior for one model id: family from the table, adjusted by size and
 * qualifier hints, clamped to a sane band.
 */
export function describeModel(modelId: string): IntelPrior {
  const id = modelId.toLowerCase();
  const rule = RULES.find((r) => r.test.test(modelId));
  let intelligence = rule?.intelligence ?? 55;
  const family = rule?.family ?? 'Unrated';

  if (!rule) {
    // Unknown families still get useful signal from size and naming, but only
    // a little - the band stays conservative.
    const size = SIZE_HEAVY.exec(id);
    if (size) {
      const billions = Number(size[1]);
      if (billions >= 70) intelligence += 6;
      else if (billions >= 30) intelligence += 3;
      else if (billions >= 7) intelligence -= 2;
      else intelligence -= 6;
    }
    if (HEAVY.test(id)) intelligence += 3;
    if (LIGHT.test(id)) intelligence -= 5;
    if (REASON.test(id)) intelligence += 3;
  }

  return { intelligence: clamp(Math.round(intelligence), 40, 99), family };
}
