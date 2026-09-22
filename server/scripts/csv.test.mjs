/**
 * Does the CSV reader handle the files people actually upload?
 *
 * Every case below is something a real export produces — Excel's CRLF, a name
 * with a comma in it, a quoted quote, a trailing blank line. A reader that
 * gets any of these wrong shifts a whole row of columns sideways, which does
 * not throw: it imports somebody with their designation in the email field.
 *
 *   node scripts/csv.test.mjs
 */
import { parseDelimited } from '../src/modules/users/csv.ts';

let failed = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { failed++; console.error(`  FAIL  ${label}\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`); }
  else console.log(`  ok    ${label}`);
};

console.log('\ncsv reader\n');
eq('plain rows', parseDelimited('a,b\n1,2'), [['a', 'b'], ['1', '2']]);
eq('a name with a comma in it', parseDelimited('a,b\n"Smith, John",2'),
  [['a', 'b'], ['Smith, John', '2']]);
eq('a quoted quote', parseDelimited('a\n"He said ""hi"""'), [['a'], ['He said "hi"']]);
eq('a field spanning lines', parseDelimited('a,b\n"line1\nline2",2'),
  [['a', 'b'], ['line1\nline2', '2']]);
eq("Excel's CRLF", parseDelimited('a,b\r\n1,2\r\n'), [['a', 'b'], ['1', '2']]);
eq('a trailing newline is not a row', parseDelimited('a,b\n1,2\n'), [['a', 'b'], ['1', '2']]);
eq('blank lines in the middle are dropped', parseDelimited('a,b\n\n1,2\n\n'),
  [['a', 'b'], ['1', '2']]);
eq('an empty field is kept, not skipped', parseDelimited('a,b,c\n1,,3'),
  [['a', 'b', 'c'], ['1', '', '3']]);
eq('no trailing newline at all', parseDelimited('a,b\n1,2'), [['a', 'b'], ['1', '2']]);
eq('a quoted empty field', parseDelimited('a,b\n"",2'), [['a', 'b'], ['', '2']]);
eq('leading whitespace is preserved inside quotes',
  parseDelimited('a\n"  padded"'), [['a'], ['  padded']]);
eq('an empty file is no rows', parseDelimited(''), []);
eq('a header alone is one row', parseDelimited('a,b\n'), [['a', 'b']]);

console.log(failed ? `\n${failed} csv test(s) FAILED\n` : '\nthe csv reader holds\n');
process.exit(failed ? 1 : 0);
