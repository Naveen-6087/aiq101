// Hard-wrap helper kept apart from data.ts so it can be tested on its own.

/** Hard-wrap `s` to `width` columns, at most `maxLines` lines; the last line ends in "..." if cut. */
export function wrapLines(s: string, width: number, maxLines: number): string[] {
  const flat = s.replace(/\s+/g, ' ').trim();
  const w = Math.max(4, width);
  const lines: string[] = [];
  for (let i = 0; i < flat.length && lines.length < maxLines; i += w) lines.push(flat.slice(i, i + w));
  if (flat.length > w * maxLines && lines.length) lines[lines.length - 1] = `${(lines[lines.length - 1] as string).slice(0, w - 3)}...`;
  return lines.length ? lines : [''];
}
