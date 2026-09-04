/**
 * Module registration. Each ported module registers itself on import; any
 * route still awaiting a port falls back to a placeholder so the shell,
 * navigation and RBAC stay exercisable end to end.
 */
import { createElement } from 'react';
import { NAV } from '../nav';
import { hasModule, registerModule } from './registry';
import { Placeholder } from './Placeholder';
import { TITLES } from './titles';

/* ---- ported modules ---- */
import './dashboard';
import './employees';

/* ---- placeholders for the remainder ---- */
NAV.flatMap((g) => g.items).forEach((i) => {
  if (hasModule(i.k)) return;
  registerModule({
    key: i.k,
    title: TITLES[i.k] || i.n,
    Component: () => createElement(Placeholder, { name: i.n }),
  });
});
