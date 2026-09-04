/**
 * The Supabase client, and the decision about whether there is one at all.
 *
 * Two modes, chosen by whether the build was given a Supabase project:
 *
 *   configured   — real sign-in. Nobody sees a page without a session.
 *   demo         — no project, so no auth. The role switcher stands in, and
 *                  every screen reads the in-memory dataset.
 *
 * That split is deliberate rather than a convenience. The public demo at
 * harisiva15.github.io has no backend and must keep working; a real deployment
 * must not be reachable without signing in. One build, and the environment
 * decides which it is — with the fallback being the harmless one.
 */

import { createClient } from '@supabase/supabase-js';
import type { SupabaseClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL ?? '';
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY ?? '';

/** True when this build has a project to authenticate against. */
export const authConfigured = Boolean(url && anonKey);

/**
 * Null in demo mode. Every caller checks `authConfigured` first, so the null
 * is never dereferenced — and making it null rather than a stub means a
 * mistake fails loudly at the call site instead of silently doing nothing.
 */
export const supabase: SupabaseClient | null = authConfigured
  ? createClient(url, anonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        // The OAuth redirect comes back with the token in the URL fragment.
        // This app uses HashRouter, so the fragment is also the route — let
        // the client consume the token and clean up before routing reads it.
        detectSessionInUrl: true,
      },
    })
  : null;

/**
 * Which single-sign-on providers this deployment offers.
 *
 * Set VITE_SSO_PROVIDERS=google,azure. Each still has to be enabled and
 * configured in the Supabase dashboard — listing one here only decides whether
 * the button is drawn.
 */
export type SsoProvider = 'google' | 'azure' | 'github';

const PROVIDER_LABELS: Record<SsoProvider, string> = {
  google: 'Google Workspace',
  azure: 'Microsoft',
  github: 'GitHub',
};

export const ssoProviders: SsoProvider[] = (import.meta.env.VITE_SSO_PROVIDERS ?? '')
  .split(',')
  .map((p: string) => p.trim().toLowerCase())
  .filter((p: string): p is SsoProvider => p === 'google' || p === 'azure' || p === 'github');

export const providerLabel = (p: SsoProvider): string => PROVIDER_LABELS[p];

/**
 * Where the identity provider sends the browser back to.
 *
 * Must be the page itself, and must be listed in Supabase under
 * Authentication -> URL Configuration. Built from `location` rather than
 * hard-coded so the same build works on localhost and on the deployed path.
 */
export const redirectTo = (): string =>
  `${window.location.origin}${window.location.pathname}`;
