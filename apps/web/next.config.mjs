/**
 * Next configuration.
 *
 * `transpilePackages` covers the workspace packages: they ship TypeScript source
 * compiled to ESM, and Next needs to process them rather than treating them as
 * prebuilt node_modules.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  transpilePackages: ['@forex-agent/contracts', '@forex-agent/core'],
  /**
   * Kept out of the bundle and required at runtime instead.
   *
   * `@node-rs/argon2` is a native `.node` addon — webpack cannot parse it, and
   * bundling it would in any case defeat the point of a platform-specific binary.
   * `pg` and `drizzle-orm` are server-only and large; leaving them external keeps the
   * server build honest about what it actually loads.
   */
  serverExternalPackages: [
    '@node-rs/argon2',
    'pg',
    'drizzle-orm',
    // The workspace packages that reach them. Without these, webpack follows the
    // symlink into the native addon regardless of the entries above.
    '@forex-agent/auth',
    '@forex-agent/db',
    '@forex-agent/worker',
  ],
  eslint: { ignoreDuringBuilds: true },

  /**
   * ── Getting the native addon into the deployed function ──────────────────
   *
   * `serverExternalPackages` keeps `@node-rs/argon2` out of the bundle, which is
   * correct — but external means "require it at runtime", and that only works if the
   * file is actually there. It was not: every server route on Vercel failed with
   * `Cannot find module @node-rs/argon2` while the local build was fine, because the
   * addon is reached through a pnpm symlink from @forex-agent/auth and the tracer
   * does not follow it out of the app directory.
   *
   * `outputFileTracingRoot` tells the tracer the deployable unit is the whole
   * workspace rather than `apps/web`, which is what makes the addon reachable.
   *
   * An `outputFileTracingIncludes` entry naming the binaries explicitly was tried
   * as belt and braces and had to be removed: those globs resolve through
   * `.pnpm/<pkg>/node_modules/@node-rs/argon2`, which is itself a symlink, and
   * Vercel rejects the whole deployment with "the framework produced an invalid
   * deployment package" when a function contains symlinked directories. The build
   * succeeds and the deploy fails, which is a slower way to learn it.
   */
  outputFileTracingRoot: repoRoot,

  /**
   * Leave native addons to Node's own resolver.
   *
   * `serverExternalPackages` alone is not enough here: the workspace packages are
   * pnpm symlinks, so webpack traverses into them and reaches
   * `@node-rs/argon2`'s platform binary — a `.node` file it has no loader for and
   * should not be trying to parse. Marking the module external on the server build
   * makes it a plain `require` at runtime, which is what a native addon needs.
   *
   * Scoped to `isServer`: none of this may ever reach a client bundle, and if it
   * somehow did, failing loudly at build time is the outcome we want.
   */
  webpack: (config, { isServer }) => {
    if (isServer) {
      config.externals = [
        ...(Array.isArray(config.externals) ? config.externals : [config.externals]).filter(
          Boolean,
        ),
        ({ request }, callback) =>
          typeof request === 'string' && /^@node-rs\/argon2/.test(request)
            ? callback(null, `commonjs ${request}`)
            : callback(),
      ];
    }
    return config;
  },
};

export default config;
