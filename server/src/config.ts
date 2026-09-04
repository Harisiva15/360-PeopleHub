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
   * a different URL with the owning role; if these are ever the same, the
   * policies stop meaning anything.
   */
  databaseUrl: required('DATABASE_URL'),
  /**
   * Server-side pepper for session-token hashes. Rotating it invalidates every
   * live session, which is the intended emergency lever.
   */
  tokenPepper: required('TOKEN_PEPPER'),
  sessionTtlDays: Number(process.env.SESSION_TTL_DAYS ?? 30),
  /** AES key for employee_identifier and bank account columns. */
  fieldEncryptionKey: required('FIELD_ENCRYPTION_KEY'),
  corsOrigins: (process.env.CORS_ORIGINS ?? '').split(',').filter(Boolean),
} as const;
