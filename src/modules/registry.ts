import type { ComponentType } from 'react';
import type { AppRole, Employee } from '../types/employee';

/** The slice of session state that titles and badges are allowed to depend on. */
export interface ModuleCtx {
  role: AppRole;
  meId: string;
  me: Employee;
}

/**
 * One entry per route. `subtitle` and `badge` run against live data on every
 * render, which is how the topbar and sidebar counts stay current.
 */
export interface ModuleDef {
  key: string;
  title: string;
  subtitle?: (ctx: ModuleCtx) => string;
  /** Count shown as a pill in the sidebar; 0 or undefined hides it. */
  badge?: (ctx: ModuleCtx) => number;
  Component: ComponentType;
}

const registry = new Map<string, ModuleDef>();

export function registerModule(def: ModuleDef): ModuleDef {
  registry.set(def.key, def);
  return def;
}

export const getModule = (key: string): ModuleDef | undefined => registry.get(key);

export const hasModule = (key: string): boolean => registry.has(key);
