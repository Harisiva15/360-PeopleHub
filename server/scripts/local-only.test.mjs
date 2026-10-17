/*
 * The guard itself, because a guard nobody tests is a comment.
 *
 * It runs no database. The hosts below are string cases, including the shapes
 * that have actually appeared in this project: a Supabase pooler host, a local
 * cluster on a non-standard port, and a malformed line that `new URL` would
 * have thrown on while quoting the password back.
 */
import { hostOf, isLocal } from './local-only.mjs';

let failed = 0;
const ok = (label, cond, detail = '') => {
  if (!cond) failed += 1;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}${cond ? '' : `   ${detail}`}`);
};

console.log('\nwhat counts as local\n');

const LOCAL = [
  'postgresql://postgres:pw@127.0.0.1:55432/peoplehub',
  'postgresql://postgres:pw@localhost:5432/postgres',
  'postgresql://u:p@[::1]:5432/db',
  'postgresql:///var/run/postgresql',
  '/var/run/postgresql',
];
for (const url of LOCAL) ok(`local: host ${hostOf(url)}`, isLocal(url), `read as ${hostOf(url)}`);

console.log('');

const REMOTE = [
  'postgresql://postgres.abc:pw@aws-0-ap-south-1.pooler.supabase.com:5432/postgres',
  'postgresql://u:p@db.example.com:5432/postgres',
  'postgresql://u:p@10.0.0.5:5432/postgres',
  'postgres://u:p@192.168.1.20/db',
];
for (const url of REMOTE) ok(`refused: host ${hostOf(url)}`, !isLocal(url), `read as ${hostOf(url)}`);

console.log('\nthe awkward ones\n');

ok('an empty string is not local', !isLocal(''));
ok('undefined is not local', !isLocal(undefined));
ok('a malformed line is not local', !isLocal('postgresql://not a url at all'),
  'it must refuse rather than throw');

/*
 * A password containing an @ must not be mistaken for the host boundary. The
 * host is taken after the LAST @, which is what the authority section means.
 */
ok('a password containing @ does not confuse the host',
  hostOf('postgresql://user:p@ss@127.0.0.1:5432/db') === '127.0.0.1',
  `read as ${hostOf('postgresql://user:p@ss@127.0.0.1:5432/db')}`);

/*
 * The shape both URLs in this project's .env are actually in: truncated after
 * the password, with no @host at all. There is no host to report, and reporting
 * the username as one printed half a credential pair under the word "host".
 */
ok('credentials with no @host have no host',
  hostOf('postgresql://postgres.exampleprojectref:0123456789abcdef0123456789abcdef') === null,
  `read as ${hostOf('postgresql://postgres.exampleprojectref:0123456789abcdef0123456789abcdef')}`);
ok('...and such a url is refused',
  !isLocal('postgresql://postgres.exampleprojectref:0123456789abcdef0123456789abcdef'));

/* But a hostname with a real port, and no credentials, still parses. */
ok('host:port without credentials still parses',
  hostOf('postgresql://127.0.0.1:55432/peoplehub') === '127.0.0.1',
  `read as ${hostOf('postgresql://127.0.0.1:55432/peoplehub')}`);
ok('...and is local', isLocal('postgres://localhost:5432/db'));
ok('a bare hostname with no port parses', hostOf('postgresql://localhost/db') === 'localhost',
  `read as ${hostOf('postgresql://localhost/db')}`);

/* And the point of the whole file: nothing it prints contains a secret. */
ok('the host of a credentialed url is just the host',
  hostOf('postgresql://postgres.exampleprojectref:s3cr3t@aws-0-ap-south-1.pooler.supabase.com:5432/postgres')
    === 'aws-0-ap-south-1.pooler.supabase.com');

console.log('');
if (failed) { console.error(`${failed} FAILED\n`); process.exit(1); }
console.log('the guard tells local from remote, and names only the host\n');
