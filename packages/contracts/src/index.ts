/**
 * @forex-agent/contracts — the API's shape, validated in both directions.
 *
 * Shared by the server that builds a response and the client that renders it, so a
 * change to one is a compile error in the other rather than a runtime surprise.
 * Depends only on `packages/core`: client components may import from `contracts` and
 * `core` and nothing else (ARCHITECTURE §4.1).
 */

export * from './analysis.js';
export * from './presentation.js';
export * from './panels.js';
