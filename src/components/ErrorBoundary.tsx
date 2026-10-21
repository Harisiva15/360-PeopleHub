/**
 * A page that throws says so, instead of painting nothing.
 *
 * ## Why this exists
 *
 * React unmounts the whole tree when a render throws and nothing catches it.
 * With the boundary at the root that means the shell goes too, and the person
 * is left on a white rectangle with no navigation, no message, and nothing to
 * report beyond "it went blank". The Payroll page did exactly that: one
 * payslip with an empty earnings array, `p.earn[0].a` on a row, and the entire
 * application disappeared — including the way back to any other page.
 *
 * So the boundary sits around the page body and **inside** the shell. A crash
 * loses the page and keeps the rail, the top bar and every other route, which
 * turns "the app is broken" into "this page is broken, I'll use another one".
 *
 * ## Why it remounts on navigation
 *
 * A boundary that has caught an error stays in its error state until it is
 * re-created. Keyed by route, moving to another page builds a new boundary, so
 * one bad page does not poison the rest of the session. Coming back to the
 * same route also re-creates it, which is the retry — if the cause was a
 * transient fetch, it simply works.
 *
 * ## What it shows
 *
 * The message, because somebody has to be able to repeat it, and this product
 * is used by people who will tell us in words what they saw. Not a stack: a
 * stack in front of an HR administrator is noise, and the console already has
 * it for anybody who can read it.
 */

import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

interface Props {
  children: ReactNode;
  /** Named in the message, so a report says which page. */
  where?: string;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    /*
     * Left in the console deliberately. There is no error-reporting service in
     * this product, so the console is the only record, and a crash that is
     * caught and silent is harder to diagnose than one that takes the page
     * down loudly.
     */
    console.error('[page crashed]', this.props.where ?? '', error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="stack" style={{ padding: 24, maxWidth: 680 }} role="alert">
        <h2 style={{ margin: 0, fontSize: 18 }}>This page could not be displayed</h2>
        <p className="muted" style={{ margin: 0 }}>
          Something on
          {this.props.where ? ` the ${this.props.where} page` : ' this page'}
          {' '}
          went wrong while it was being drawn. The rest of the application is
          unaffected — use the navigation to go elsewhere, or reload to try again.
        </p>
        {/*
          * The message verbatim. It is the one thing that makes a report
          * actionable, and paraphrasing it would lose the detail.
          */}
        <pre
          className="mono"
          style={{
            margin: 0, padding: 12, fontSize: 12, whiteSpace: 'pre-wrap',
            background: 'var(--surface-2)', borderRadius: 8, overflowX: 'auto',
          }}
        >
          {error.message || String(error)}
        </pre>
        <div className="row" style={{ gap: 8 }}>
          <button className="btn primary" onClick={() => window.location.reload()}>
            Reload the page
          </button>
        </div>
      </div>
    );
  }
}
