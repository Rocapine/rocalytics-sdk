/**
 * UTF-8 length of `s` in bytes, without `TextEncoder` or `Buffer` (neither is
 * guaranteed on every JavaScript runtime an app ships on). A lone surrogate
 * counts as the 3-byte replacement character, as an encoder would write it.
 */
export function utf8ByteLength(s: string): number {
  let bytes = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i++;
      } else {
        bytes += 3;
      }
    } else bytes += 3;
  }
  return bytes;
}

/** Length in code points: what JSON Schema's `minLength` / `maxLength` count. */
export function codePointLength(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) i++;
    }
    n++;
  }
  return n;
}

/**
 * True when `s` holds a U+0000 or a lone surrogate: text the Rocalytics ingest
 * rejects (`string_encoding`), as jsonb cannot store NUL and a lone surrogate is
 * not valid UTF-8. A loop rather than the ingest's lookbehind regex, which not
 * every JavaScript engine an app ships on supports.
 */
export function hasBadText(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0) return true;
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (next < 0xdc00 || next > 0xdfff) return true;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) return true;
  }
  return false;
}
