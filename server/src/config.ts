/** Environment configuration, read once and validated at boot. */

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`missing required environment variable ${name}`);
  return value;
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
  /**
   * Supabase's JWT secret, used to verify tokens it issued. Found under
   * Project Settings -> API. Projects on asymmetric signing keys verify
   * against the JWKS endpoint instead — see src/auth/session.ts.
   */
  supabaseJwtSecret: required('SUPABASE_JWT_SECRET'),
  supabaseUrl: process.env.SUPABASE_URL ?? '',
  /** AES key for employee_identifier and bank account columns. */
  fieldEncryptionKey: required('FIELD_ENCRYPTION_KEY'),
  corsOrigins: (process.env.CORS_ORIGINS ?? '').split(',').filter(Boolean),
} as const;
