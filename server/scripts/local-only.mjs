/**
 * Refuse to run a test against anything but a local database.
 *
 * ## Why this exists
 *
 * Every database-backed suite reads `MIGRATE_DATABASE_URL`, and that variable
 * pointed at production. The suites write: they create employees, send
 * invitations, provision schedules, process payroll runs. Nothing stopped one
 * from doing that to the live tenant except the person running it remembering
 * to override the variable first.
 *
 * It had not happened, and the reason is not reassuring — the production line
 * in `.env` happened to be malformed, so the suites failed on `Invalid URL`
 * rather than connecting. That is luck, not a safeguard.
 *
 * So the suites now refuse unless the host is local, and the refusal names the
 * host and nothing else: never the URL, never the user, never the password.
 *
 * ## What counts as local
 *
 * `localhost`, `127.0.0.1`, `::1`, and a Unix socket path — a connection string
 * with no host at all, or one whose host is a filesystem path, cannot reach a
 * managed database.
 */

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

/**
 * The host from a connection string, or null if there isn't one.
 *
 * Parsed by hand rather than with `new URL`, because `new URL` throws on a
 * malformed string and puts the whole string — password included — in
 * `error.input`. That has already leaked a password once in this project.
 */
export function hostOf(url) {
  if (typeof url !== 'string' || url === '') return null;

  /* A socket path, with no authority section at all. */
  if (!url.includes('//')) return url.startsWith('/') ? 'unix-socket' : null;

  const after = url.slice(url.indexOf('//') + 2);
  /* Drop any user:password@ prefix without looking at it. */
  const credentialed = after.includes('@');
  const authority = credentialed ? after.slice(after.lastIndexOf('@') + 1) : after;
  /* Then the path, query and fragment. */
  const hostPort = authority.split(/[/?#]/)[0] ?? '';
  if (hostPort === '') return 'unix-socket';

  /* A bracketed IPv6 literal keeps its brackets; anything else splits on the port. */
  if (hostPort.startsWith('[')) return hostPort.slice(0, hostPort.indexOf(']') + 1).toLowerCase();

  /* host:port — a Windows socket directory can contain a colon, so prefer a
     path-looking value over a port split. */
  if (/^[a-z]:[\\/]/i.test(hostPort)) return 'unix-socket';

  const colon = hostPort.indexOf(':');

  /*
   * `user:password` with no `@` is not `host:port`, and the difference matters:
   * both URLs in this project's .env are truncated to exactly that shape, and
   * reading them as a host printed the database username under the word "host".
   * A guard that names a credential while refusing to leak one is no guard, and
   * calling a malformed string a hostname also invites someone to read the
   * refusal as a DNS problem. So: if nothing was stripped as credentials, the
   * part after the colon has to be a port, or there is no host here to report.
   */
  if (!credentialed && colon >= 0 && !/^\d+$/.test(hostPort.slice(colon + 1))) return null;

  return (colon >= 0 ? hostPort.slice(0, colon) : hostPort).toLowerCase();
}

/** True where this connection string cannot leave the machine. */
export const isLocal = (url) => {
  const host = hostOf(url);
  return host !== null && (LOCAL_HOSTS.has(host) || host === 'unix-socket');
};

/**
 * Stop unless every named variable points somewhere local.
 *
 * Call it before connecting, in any script that writes. It exits rather than
 * throwing: a suite that caught this and carried on would defeat the point.
 */
export function assertLocalDatabase(...names) {
  const vars = names.length ? names : ['MIGRATE_DATABASE_URL', 'DATABASE_URL'];
  const offending = [];

  for (const name of vars) {
    const url = process.env[name];
    if (!url) continue;
    if (!isLocal(url)) offending.push({ name, host: hostOf(url) ?? '(unparseable)' });
  }

  if (!offending.length) return;

  console.error('');
  console.error('  REFUSED: this suite writes, and it is pointed at a database that is not local.');
  console.error('');
  for (const o of offending) console.error(`    ${o.name} -> host ${o.host}`);
  console.error('');
  console.error('  Run it against the local cluster instead, for example:');
  console.error('');
  console.error('    PGSSLMODE=disable \\');
  console.error('    MIGRATE_DATABASE_URL=postgresql://postgres:PASSWORD@127.0.0.1:55432/peoplehub \\');
  console.error('    DATABASE_URL=postgresql://postgres:PASSWORD@127.0.0.1:55432/peoplehub \\');
  console.error('    npm run check:<suite>');
  console.error('');
  process.exit(1);
}
