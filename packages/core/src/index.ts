/**
 * @forex-agent/core — pure domain vocabulary and value types.
 *
 * Zero runtime dependencies by design. Everything here is deterministic and has no
 * I/O, so it can be imported safely by engines, providers, the database layer, the
 * server and the browser alike.
 */

export * from './vocab.js';
export * from './ids.js';
export * from './freshness.js';
export * from './factTiming.js';
export * from './timeZone.js';
export * from './stats.js';
export * from './joinCoverage.js';
export * from './observation.js';
export * from './result.js';
export * from './scores.js';
export * from './errors.js';
