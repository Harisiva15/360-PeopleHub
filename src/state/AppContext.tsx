import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { ACCOUNTS, can, SCOPE, visibleEmps, visibleIds } from './rbac';
import { EMAP } from '../data/employees';
import type { AppRole, Employee } from '../types/employee';

export type Theme = 'light' | 'dark';

export interface Toast {
  id: number;
  msg: string;
  kind?: 'ok' | 'err';
}

interface AppState {
  role: AppRole;
  meId: string;
  me: Employee;
  theme: Theme;
  /** Bumped by `bump()` to re-render views after the mutable dataset changes. */
  revision: number;

  signInAs: (role: AppRole) => void;
  toggleTheme: () => void;
  /** Call after mutating the dataset so dependent views recompute. */
  bump: () => void;

  can: (route: string) => boolean;
  scope: (typeof SCOPE)[AppRole];
  visibleIds: () => string[];
  visibleEmps: () => Employee[];
  isMyReport: (id: string) => boolean;

  toasts: Toast[];
  toast: (msg: string, kind?: 'ok' | 'err') => void;
  dismissToast: (id: number) => void;
}

const Ctx = createContext<AppState | null>(null);

const THEME_KEY = '360people.theme';

function readStoredTheme(): Theme {
  try {
    return localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

let toastSeq = 0;

export function AppProvider({ children, initialRole = 'admin' }: { children: ReactNode; initialRole?: AppRole }) {
  const start = ACCOUNTS().find((a) => a.role === initialRole)!;
  const [role, setRole] = useState<AppRole>(start.role);
  const [meId, setMeId] = useState<string>(start.empId);
  const [theme, setTheme] = useState<Theme>(readStoredTheme);
  const [revision, setRevision] = useState(0);
  const [toasts, setToasts] = useState<Toast[]>([]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* private mode — the theme just will not persist */
    }
  }, [theme]);

  const bump = useCallback(() => setRevision((r) => r + 1), []);

  const signInAs = useCallback((next: AppRole) => {
    const acc = ACCOUNTS().find((a) => a.role === next);
    if (!acc) return;
    setRole(acc.role);
    setMeId(acc.empId);
  }, []);

  const toggleTheme = useCallback(() => setTheme((t) => (t === 'light' ? 'dark' : 'light')), []);

  const dismissToast = useCallback((id: number) => setToasts((ts) => ts.filter((t) => t.id !== id)), []);

  const toast = useCallback(
    (msg: string, kind?: 'ok' | 'err') => {
      const id = ++toastSeq;
      setToasts((ts) => [...ts, { id, msg, kind }]);
      setTimeout(() => dismissToast(id), 2800);
    },
    [dismissToast],
  );

  const value = useMemo<AppState>(
    () => ({
      role,
      meId,
      me: EMAP[meId],
      theme,
      revision,
      signInAs,
      toggleTheme,
      bump,
      can: (route: string) => can(role, route),
      scope: SCOPE[role],
      visibleIds: () => visibleIds(role, meId),
      visibleEmps: () => visibleEmps(role, meId),
      isMyReport: (id: string) => role !== 'employee' && visibleIds(role, meId).includes(id) && id !== meId,
      toasts,
      toast,
      dismissToast,
    }),
    [role, meId, theme, revision, signInAs, toggleTheme, bump, toasts, toast, dismissToast],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp must be used inside <AppProvider>');
  return v;
}
