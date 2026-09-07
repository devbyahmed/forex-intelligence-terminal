/**
 * The prompt.
 *
 * Versioned (`PROMPT_VERSION`) and stored with every generation, so a report from
 * three months ago can be explained by the prompt that actually produced it rather
 * than the one in the working tree.
 *
 * The constraints appear twice — here and inside the bundle — which is deliberate
 * duplication. Instructions at the top of a long prompt compete with the data below
 * them for attention; carrying them alongside the evidence means the rule and the
 * thing it governs cannot drift apart in the model's context.
 */

import type { PROMPT_VERSION } from './schema.js';

export interface PromptInput {
  readonly bundleJson: string;
  readonly asset: string;
}

export function buildPrompt(input: PromptInput): string {
  return [
    'You are summarising a deterministic fundamental analysis for a single asset.',
    'The analysis has already been computed. You are not calculating anything, ranking',
    'anything, or deciding anything — you are describing, in plain English, what the',
    'measured factors currently say.',
    '',
    '## Hard rules',
    '',
    '1. Every number you state must appear verbatim in the evidence bundle below. Do',
    '   not compute, derive, round beyond two decimals, or estimate any figure.',
    '2. Scores describe CURRENT MEASURED CONDITIONS. They are not forecasts and have no',
    '   measured predictive power. Never say what will happen, what is likely, what is',
    '   expected, or what a reader should do.',
    '3. Never give trading advice, price targets, entry or exit levels, or position',
    '   sizing.',
    '4. Factors marked `"scored": false` were NOT MEASURED. They are not neutral. Never',
    '   describe them as balanced, flat, or unchanged, and never present the picture as',
    '   complete while they are absent.',
    '5. If any factor is unscored, say so in `dataGaps` in plain language.',
    '6. Cite only factor ids that appear in the bundle, and only cite a factor as a key',
    '   driver if it actually produced a score.',
    '7. Give AT MOST FIVE key drivers — the ones that carry the most weight, not every',
    '   factor that scored.',
    '',
    '## Tone',
    '',
    'Describe, do not advise. "The real 10-year yield reads −27.7, a headwind" is right.',
    '"Gold looks weak and should fall" is forbidden twice over.',
    '',
    `## Evidence bundle for ${input.asset}`,
    '',
    '```json',
    input.bundleJson,
    '```',
    '',
    'Return JSON matching the required schema. Nothing else.',
  ].join('\n');
}

export type PromptVersion = typeof PROMPT_VERSION;
