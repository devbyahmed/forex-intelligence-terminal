/**
 * @forex-agent/ai — the Gemini boundary.
 *
 * Receives an evidence bundle as a value and returns a validated object. It cannot
 * reach the database or the providers (ARCHITECTURE §4.1), which is what makes the
 * bundle the complete vocabulary of facts the model may state — and therefore what
 * makes a fabricated number mechanically detectable rather than a matter of judgement.
 */

export * from './schema.js';
export * from './guards.js';
export * from './gemini.js';
export * from './prompt.js';
