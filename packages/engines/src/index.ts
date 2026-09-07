/**
 * @forex-agent/engines — pure analysis. No I/O, no database, injected clock.
 *
 * Enforced by lint: engines may not import db or providers, may not fetch, and may
 * not read the ambient clock. That is what makes scoring reproducible and testable
 * offline against fixtures.
 */

export * from './news/classify.js';
export * from './news/aggregate.js';
export * from './fundamental/factor.js';
export * from './fundamental/aggregate.js';
export * from './fundamental/confidence.js';
export * from './fundamental/normalise.js';
export * from './fundamental/inputs.js';
export * from './fundamental/factors.js';
export * from './fundamental/explain.js';
export * from './fundamental/eventRisk.js';
export * from './fundamental/engine.js';
export * from './fundamental/viability.js';
