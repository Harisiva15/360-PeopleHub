/**
 * A control for something the product does not do yet.
 *
 * The alternative this replaces was worse than a missing feature. Twenty-odd
 * buttons across the app raised a success toast and did nothing: "Bank advice
 * generated", "Reminder emails sent to employees with incomplete files",
 * "Settings saved". Each read as a completed action, so somebody would press
 * it, believe the thing had happened, and not do it by the means that actually
 * work. "Settings saved" is the sharpest example — an administrator changes a
 * policy, is told it saved, and it never left the browser.
 *
 * A disabled control with a reason is honest and still says the feature is
 * intended. Removing the buttons would hide that, and the next person would
 * read the gap as an oversight rather than a decision.
 *
 * Use this only where there is genuinely nothing behind the control. Where an
 * API exists, wire it — `checks/no-fake-success.ts` will not tell the
 * difference, but a user will.
 */

import type { ReactNode } from 'react';

/**
 * Props for a button that cannot do its job yet.
 *
 * `why` completes the sentence "Not available yet — ", so write it as a
 * reason: "payslips are published when the cycle is processed", not
 * "unavailable".
 */
export function notBacked(why: string): { disabled: true; title: string; 'data-notbacked': string } {
  return { disabled: true, title: `Not available yet — ${why}`, 'data-notbacked': why };
}

/**
 * A note that a panel's controls are inert, and why.
 *
 * For a whole card, where disabling every field one at a time would say the
 * same thing repeatedly and still leave the Save button looking meaningful.
 */
export function NotBackedNote({ children }: { children: ReactNode }) {
  return (
    <div
      className="muted"
      style={{ fontSize: 12, lineHeight: 1.55, padding: '8px 11px', borderRadius: 7,
        background: 'var(--surface-2, rgba(127,127,127,.07))' }}
    >
      {children}
    </div>
  );
}
