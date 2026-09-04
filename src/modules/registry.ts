import type { ComponentType } from 'react';
import type { AppRole, Employee } from '../types/employee';

/** The slice of session state that titles and badges are allowed to depend on. */
export interface ModuleCtx {
  role: AppRole;
  meId: string;
  me: Employee;
}

/**
 * One entry per route.
 *
 * `subtitle` is synchronous, so it may depend only on the session and on
 * static configuration — never on records. Sidebar pills used to be a
 * `badge` callback here, which could not await a service; they now come from
 * `approvals.navBadges` and are rendered by the shell.
 */
export interface ModuleDef {
  key: string;
  title: string;
  subtitle?: (ctx: ModuleCtx) => string;
  Component: ComponentType;
}

const registry = new Map<string, ModuleDef>();

export function registerModule(def: ModuleDef): ModuleDef {
  registry.set(def.key, def);
  return def;
}

export const getModule = (key: string): ModuleDef | undefined => registry.get(key);

export const hasModule = (key: string): boolean => registry.has(key);
