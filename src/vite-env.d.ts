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
  /**
   * The browser-side key, `sb_publishable_...`.
   *
   * `VITE_SUPABASE_ANON_KEY` used to be declared beside this one, for projects
   * still issuing a legacy anon JWT. This project's legacy JWT-based API keys
   * are disabled, so the name is gone from the type as well as from the code —
   * a declared variable that can only ever hold a dead key is an invitation.
   */
  readonly VITE_SUPABASE_PUBLISHABLE_KEY?: string;
  /**
   * Base URL of the API, e.g. http://localhost:8080. Unset means every screen
   * reads the in-memory dataset — which is what the public demo is.
   */
  readonly VITE_API_URL?: string;
  /** Comma-separated: google, azure, github. */
  readonly VITE_SSO_PROVIDERS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
