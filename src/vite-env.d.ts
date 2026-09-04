/// <reference types="vite/client" />

/**
 * Build-time configuration.
 *
 * Every entry is optional on purpose: unset means demo mode, and a missing
 * variable must degrade to the harmless build rather than a half-configured
 * real one.
 */
interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
  /** Comma-separated: google, azure, github. */
  readonly VITE_SSO_PROVIDERS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
