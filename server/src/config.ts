/** Environment configuration, read once and validated at boot. */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

const required = (name: string): string => {
  const value = process.env[name];
  if (value) return value;

  /*
   * Say where we looked, because the usual cause is not a missing variable.
   *
   * The dev and start scripts pass `--env-file-if-exists=.env`, and that flag
   * is silent when the file is not there — by design, so a deployment supplying
   * its environment another way does not need a dummy file. The cost is that
   * running from the wrong directory produces this error and no clue: there is
   * no .env at the repository root, the flag finds nothing, says nothing, and
   * the first thing you learn is that a variable you can plainly see in the
   * file is "missing".
   *
   * One line of context turns twenty minutes into ten seconds.
   */
  const where = process.cwd();
  const hasEnvFile = existsSync(join(where, '.env'));
  throw new Error([
    `missing required environment variable ${name}`,
    `  working directory: ${where}`,
    `  .env found there:  ${hasEnvFile ? 'yes' : 'NO'}`,
    hasEnvFile
      ? `  The file exists but does not define ${name}.`
      : '  Run this from the server directory: cd server && npm run dev',
  ].join('\n'));
};

export const config = {
  port: Number(process.env.PORT ?? 8080),
  nodeEnv: process.env.NODE_ENV ?? 'development',
  /**
   * Connects as app_rw, which cannot bypass row-level security. Migrations use
   * MIGRATE_DATABASE_URL with the owning role; if these are ever the same
   * role, the policies stop meaning anything. Never point this at Supabase's
   * service_role — that exists to skip every policy.
   */
  databaseUrl: required('DATABASE_URL'),
  supabaseUrl: required('SUPABASE_URL'),
  /**
   * Where Supabase publishes the public keys it signs tokens with. This
   * server holds no signing secret at all — it can verify a token and cannot
   * mint one, which is the point of asymmetric signing.
   */
  jwksUrl: process.env.SUPABASE_JWKS_URL
    ?? `${process.env.SUPABASE_URL ?? ''}/auth/v1/.well-known/jwks.json`,
  /** Path to Supabase's CA certificate. Required in production. */
  sslRootCert: process.env.PGSSLROOTCERT ?? '',
  corsOrigins: (process.env.CORS_ORIGINS ?? '').split(',').filter(Boolean),

  /**
   * The key that can create auth users, and the one credential this server
   * holds that Supabase treats as itself.
   *
   * Everything else here is either public (the project URL, the JWKS endpoint)
   * or scoped by row-level security (`app_rw`). This is neither: it bypasses
   * RLS and can mint accounts. It exists for exactly one caller —
   * `auth/adminApi.ts`, which sends invitations — and it must never be read
   * anywhere a response, a log line or a bundle could carry it.
   *
   * Optional on purpose. A deployment that does not send invitations should
   * boot without it rather than be forced to hold a credential it has no use
   * for; the invite path refuses clearly when it is absent.
   */
  supabaseServiceKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',

  /**
   * Where an invited person lands, and the only redirect this server will ask
   * Supabase for.
   *
   * Supabase refuses a redirect that is not on its own allow-list, so this has
   * to match an entry under Authentication -> URL Configuration. It is
   * configured rather than derived because the API and the app are different
   * hosts in production, and the Origin of the admin's request is the wrong
   * answer — an invitation must not point wherever the caller happened to be.
   */
  appBaseUrl: (process.env.APP_BASE_URL ?? '').replace(/\/+$/, ''),
} as const;
