/**
 * A correct-enough CSV reader, with no dependencies of any kind.
 *
 * In its own file precisely because it has none: it was inside `import.ts`,
 * which reaches the database config through two hops, so a pure string
 * function could not be tested without a live `DATABASE_URL`. A function this
 * fiddly is exactly the one worth being able to test in isolation.
 *
 * Handles quoted fields, embedded commas, embedded newlines and doubled quotes
 * — the whole of RFC 4180 that anybody actually produces. Hand-written rather
 * than pulled in, because a dependency that parses untrusted uploads is a
 * larger decision than forty lines of state machine.
 *
 * **Not a spreadsheet reader.** An .xlsx is a zip of XML and needs a real
 * library; handing one to this produces gibberish rows rather than an error,
 * which is why the caller refuses anything that does not look like text.
 */
export function parseDelimited(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === ',') { row.push(field); field = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }

  /* Trailing blank lines are not rows; a file usually ends with a newline. */
  return rows.filter((r) => r.some((c) => c.trim().length));
}
