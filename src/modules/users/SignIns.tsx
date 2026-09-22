/**
 * Sign-in history.
 *
 * One table, drawn the same way in three places: a person's own under My
 * Profile, one account's inside the user drawer, and everybody's on the Users
 * page. The columns are the same in all three because the question is the same
 * — was that me, and if not, when and from where.
 *
 * **Why the address is a column and not a badge.** The row people are looking
 * for is the one from somewhere they have never been, and it is found by
 * scanning a column of addresses for the odd one out. Hiding it behind a
 * hover, or summarising it as "unrecognised device", takes away the only thing
 * on the screen a person can actually check against their own memory.
 *
 * **What is not here.** Wrong passwords. Supabase Auth checks the password, so
 * this application never sees a failed one — and an endpoint the login page
 * could report failures to would let anybody write rows against any address
 * they can guess. An empty column is honest; a number sourced from the client
 * is not. See `server/src/modules/users/loginHistory.ts`.
 */

import { Badge, EmptyState, Table, TableWrap } from '../../components/ui';
import type { BadgeKind } from '../../components/ui';
import { Icon } from '../../components/icons';
import type { LoginEvent } from '../../services';
import { whenOf } from './shared';
import type { Directory } from './data';

/* ---------------- how each outcome reads ---------------- */

/**
 * Plain words, not the database's.
 *
 * `locked_out` and `refused` are the two rows that matter and the two a person
 * will not recognise by their stored name. Both are somebody holding a token
 * that no longer works — which is the evidence the deactivation took effect,
 * and worth being able to see.
 */
const OUTCOME_LABEL: Record<string, string> = {
  success: 'Signed in',
  signed_out: 'Signed out',
  refused: 'Refused',
  locked_out: 'Locked out',
  failed: 'Failed',
};

const OUTCOME_TONE: Record<string, BadgeKind> = {
  success: 'good',
  signed_out: 'mute',
  refused: 'warn',
  locked_out: 'crit',
  failed: 'crit',
};

const METHOD_LABEL: Record<string, string> = {
  password: 'Password',
  mfa: 'Authenticator',
  recovery_code: 'Recovery code',
  sso: 'Single sign-on',
  magic_link: 'Email link',
};

/**
 * "Chrome on Windows" out of a user-agent string.
 *
 * Deliberately rough. The full string is useless to the person reading it and
 * a precise parse of it is a library nobody should take on for a label — what
 * matters is only whether this row looks like the machine they were using. The
 * raw string stays in the title attribute for whoever needs it.
 */
function clientOf(ua: string): string {
  if (!ua) return '—';
  const browser = /Edg\//.test(ua) ? 'Edge'
    : /Chrome\//.test(ua) ? 'Chrome'
      : /Firefox\//.test(ua) ? 'Firefox'
        : /Safari\//.test(ua) ? 'Safari'
          : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows'
    : /iPhone|iPad/.test(ua) ? 'iOS'
      : /Android/.test(ua) ? 'Android'
        : /Mac OS X/.test(ua) ? 'macOS'
          : /Linux/.test(ua) ? 'Linux'
            : '';
  return os ? `${browser} on ${os}` : browser;
}

/* ---------------- the table ---------------- */

export function SignInTable({
  rows, dir, showWho = false, emptyMsg = 'No sign-ins recorded yet',
}: {
  rows: LoginEvent[];
  /** Only needed when the person is a column. */
  dir?: Directory;
  showWho?: boolean;
  emptyMsg?: string;
}) {
  if (!rows.length) {
    return <EmptyState msg={emptyMsg} icon={<Icon n="security" size="lg" />} />;
  }

  return (
    <TableWrap>
      <Table>
        <thead>
          <tr>
            <th>When</th>
            {showWho && <th>Who</th>}
            <th>What happened</th>
            <th>How</th>
            <th>From</th>
            <th>Device</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((e) => (
            <tr key={e.id}>
              <td style={{ whiteSpace: 'nowrap' }}>{whenOf(e.at)}</td>
              {showWho && (
                <td>{e.employeeId && dir ? dir.name(e.employeeId) : '—'}</td>
              )}
              <td>
                <Badge kind={OUTCOME_TONE[e.outcome] ?? 'mute'}>
                  {OUTCOME_LABEL[e.outcome] ?? e.outcome}
                </Badge>
                {/*
                  * The reason sits under the badge rather than in its own
                  * column: it is only present on the rows that are not a
                  * plain success, and an empty column on every good row
                  * teaches people to stop reading it.
                  */}
                {e.reason && (
                  <div className="muted" style={{ fontSize: 11.5, marginTop: 3 }}>
                    {e.reason}
                  </div>
                )}
              </td>
              <td>{METHOD_LABEL[e.method] ?? e.method}</td>
              <td style={{ whiteSpace: 'nowrap' }}>{e.ip || '—'}</td>
              <td title={e.userAgent || undefined}>{clientOf(e.userAgent)}</td>
            </tr>
          ))}
        </tbody>
      </Table>
    </TableWrap>
  );
}

/**
 * What to do about a row you do not recognise.
 *
 * A history with no next step is a list of facts somebody worries about and
 * cannot act on. Shown above the table rather than below it, because the
 * person who needs it is alarmed and will not scroll.
 */
export function SignInAdvice() {
  return (
    <div className="hint">
      If you see a sign-in you do not recognise, change your password and tell
      your administrator. Signing in from a new device or a different network
      is normal and will show a different address.
    </div>
  );
}
