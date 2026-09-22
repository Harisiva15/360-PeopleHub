/**
 * The integration screens' data access.
 *
 * Every call carries the caller and the service checks it. The hooks decide
 * nothing — a hook that filtered by role would be a second, quieter copy of
 * the rules, and the two would drift.
 */

import { useMutation, useQuery } from '../../services/react';
import { useCaller } from '../../services/people';
import type { ApiKeyDraft, WebhookDraft } from '../../services';

export { useCaller, usePeople, useVisiblePeople } from '../../services/people';
export type { Directory } from '../../services/people';

export function useIntegrations() {
  const c = useCaller();
  return useQuery((s) => s.integrations.list(c), [c.role, c.meId]);
}

export function useIntegrationStats() {
  const c = useCaller();
  return useQuery((s) => s.integrations.stats(c), [c.role, c.meId]);
}

export function useWebhooks() {
  const c = useCaller();
  return useQuery((s) => s.integrations.webhooks(c), [c.role, c.meId]);
}

export function useApiKeys() {
  const c = useCaller();
  return useQuery((s) => s.integrations.apiKeys(c), [c.role, c.meId]);
}

export function useApiScopes() {
  const c = useCaller();
  return useQuery((s) => s.integrations.scopes(c), [c.role, c.meId]);
}

export const useCreateWebhook = () => {
  const c = useCaller();
  return useMutation((s, draft: WebhookDraft) => s.integrations.createWebhook(c, draft));
};

export const useSetWebhookActive = () => {
  const c = useCaller();
  return useMutation((s, id: string, active: boolean) =>
    s.integrations.setWebhookActive(c, id, active));
};

export const useRemoveWebhook = () => {
  const c = useCaller();
  return useMutation((s, id: string) => s.integrations.removeWebhook(c, id));
};

export const useCreateApiKey = () => {
  const c = useCaller();
  return useMutation((s, draft: ApiKeyDraft) => s.integrations.createApiKey(c, draft));
};

export const useRevokeApiKey = () => {
  const c = useCaller();
  return useMutation((s, id: string) => s.integrations.revokeApiKey(c, id));
};
