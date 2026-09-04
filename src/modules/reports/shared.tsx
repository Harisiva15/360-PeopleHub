import type { ReactNode } from 'react';

/**
 * The header every report body opens with: name, scope line, and the two
 * actions that turn a screen into something you can circulate.
 */
export function RepHead({ title, sub, onExport }: { title: string; sub: ReactNode; onExport: () => void }) {
  return (
    <div className="toolbar">
      <div>
        <div style={{ fontSize: 16, fontWeight: 750, letterSpacing: '-.3px' }}>{title}</div>
        <div className="muted" style={{ fontSize: 12.5 }}>{sub}</div>
      </div>
      <div className="spacer" />
      <button className="btn" onClick={onExport}>⤓ Export CSV</button>
      <button className="btn" onClick={() => window.print()}>🖨 Print</button>
    </div>
  );
}

/** Shared shape for a report body: it renders itself for the caller's scope. */
export interface RepProps {
  ids: string[];
}
