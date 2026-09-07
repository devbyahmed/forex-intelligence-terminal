/**
 * @forex-agent/providers — the egress boundary.
 *
 * The only package permitted to fetch from a third party. Everything it returns is a
 * `ProviderResult`, so there is exactly one place that decides what happens when data
 * cannot be obtained — and no branch in it produces a substitute value.
 */

export * from './types.js';
export * from './http.js';
export * from './resilience.js';
export * from './registry.js';
export * from './economicCalendar/forexFactory.js';
export * from './economicCalendar/fred.js';
export * from './news/rss.js';
export * from './macro/fred.js';
export * from './marketData/twelveData.js';
export * from './marketData/yahoo.js';
export * from './email/index.js';
