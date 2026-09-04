import type { ComponentType } from 'react';
import type { AppRole, Employee } from '../types/employee';

/** The slice of session state that titles and badges are allowed to depend on. */
export interface ModuleCtx {
  role: AppRole;
  meId: string;
  me: Employee;
}

/**
 * One entry per route — the component and nothing else.
 *
 * Titles and subtitles live in `titles.ts` and `subtitles.ts`, and sidebar
 * pills come from `approvals.navBadges`. That is what lets a route be
 * code-split: the shell paints the header from data it already has, without
 * waiting for the route's chunk.
 */
export interface ModuleDef {
  key: string;
  title: string;
  Component: ComponentType;
}

const registry = new Map<string, ModuleDef>();

export function registerModule(def: ModuleDef): ModuleDef {
  registry.set(def.key, def);
  return def;
}

export const getModule = (key: string): ModuleDef | undefined => registry.get(key);

export const hasModule = (key: string): boolean => registry.has(key);
