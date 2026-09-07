/**
 * The app's logger.
 *
 * A module rather than bare `console` so that server-side output is structured and
 * levelled the same way the worker's is. The tick endpoint is the reason this exists: it
 * deliberately returns nothing useful to its caller, so the log is the only place a
 * preflight failure or a composition error is ever visible.
 *
 * **Nothing here touches the environment at import time.** Next evaluates route modules
 * during `next build` to collect page data, and there is no environment then — reading
 * configuration at module scope turns a missing variable into a build failure on a
 * machine that was never going to run the code. Configuration is read on first use, at
 * which point a missing variable is a real fault in a real request.
 */

import { createLogger, getEnv, type Logger } from '@forex-agent/config';

let instance: Logger | null = null;

function get(): Logger {
  if (instance === null) {
    const env = getEnv();
    instance = createLogger({
      level: env.LOG_LEVEL,
      // Pretty output belongs to a terminal; the hosting platform collects JSON.
      pretty: env.NODE_ENV === 'development',
    });
  }
  return instance;
}

/**
 * A thin façade over the lazily-built logger.
 *
 * Callers write `logger.error(...)` and never see the laziness, which is the point: a
 * call site that had to remember to initialise first would eventually forget, on the
 * path that only runs when something has already gone wrong.
 */
export const logger = {
  error: (...args: Parameters<Logger['error']>): void => {
    get().error(...args);
  },
  warn: (...args: Parameters<Logger['warn']>): void => {
    get().warn(...args);
  },
  info: (...args: Parameters<Logger['info']>): void => {
    get().info(...args);
  },
};
