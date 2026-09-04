/** Client-side CSV export. BOM-prefixed so Excel reads UTF-8 correctly. */
export function downloadCSV(name: string, rows: (string | number | null | undefined)[][]): void {
  const csv = rows
    .map((r) =>
      r
        .map((c) => {
          const s = c == null ? '' : String(c);
          return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
        })
        .join(','),
    )
    .join('\n');
  const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}
