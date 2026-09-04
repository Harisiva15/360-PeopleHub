import type { ComponentType } from 'react';

/**
 * One entry per route. `subtitle` and `badge` run against live data on every
 * render, which is how the topbar and sidebar counts stay current.
 */
export interface ModuleDef {
  key: string;
  title: string;
  subtitle?: () => string;
  /** Count shown as a pill in the sidebar; 0 or undefined hides it. */
  badge?: () => number;
  Component: ComponentType;
}

const registry = new Map<string, ModuleDef>();

export function registerModule(def: ModuleDef): ModuleDef {
  registry.set(def.key, def);
  return def;
}

export const getModule = (key: string): ModuleDef | undefined => registry.get(key);

export const hasModule = (key: string): boolean => registry.has(key);
