/**
 * UTF-8 length of a string without encoding it. Allocates nothing.
 *
 * @param s The string.
 * @returns Its byte length as UTF-8.
 */
export function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      n += 4;
      i += 1;
    } else n += 3;
  }
  return n;
}
