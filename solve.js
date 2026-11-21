// Fast drop-in for csv-reader 1.0.0, v2: returns exactly its answer for
// every input {text, header} -> {columns, rows, errors}, but reads the
// text as one monolithic indexOf-driven state machine built around two
// monotonic pointers, so no span of text is ever scanned twice for the
// same character:
//
//   - nextCR: the first CR at or after the last point checked;
//   - lineEnd: the LF that ends the line the reader is on (or -1: no LF
//     left in the text). v1 searched for '\n' again inside every
//     unquoted field, rescanning the rest of the line each time; v2
//     finds a line's end once and every field on that line reuses it.
//
// The field being read is kept in three locals (fVal, fEnd, fAdded)
// instead of a fresh {value, ended, added} object per field, the
// unquoted scan is inlined into the record loop, and a quoted field's
// value is built from one slice of its raw content plus, only when the
// content really holds them, two native regex passes: CRLF / lone CR ->
// LF, and doubled quotes -> one quote (v1 walked the content segment by
// segment with three indexOf scans per segment). A record with no quote
// and no CR but its line ending takes the plainest path: one slice of
// the whole line, split on commas in native code.
//
// The reading policy is csv-reader's own, matched case for case:
//   - a U+FEFF at the very start is dropped;
//   - a record ends at LF or CRLF, and a line left with no characters is
//     no record;
//   - outside quotes a CR not followed by LF is dropped (stray_cr);
//   - a field opening with a quote runs to the next quote that is not
//     doubled, "" inside it is one quote, and each CRLF or lone CR inside
//     it is read as LF; junk after the closing quote is appended as it
//     stands (quote_junk, when the field ends); a quote that never closes
//     is a literal character and the rest is re-read unquoted
//     (unterminated_quote);
//   - a quote inside an unquoted field is literal; fields are never
//     trimmed or converted;
//   - columns is the first record when header is true, else null; rows are
//     padded (short_row, with fields) or cut (long_row, with extra) to the
//     first record's width;
//   - errors are {code, line, row} in the order met, line the record's
//     starting line (counting every LF, CRLF and lone CR inside quotes),
//     row its index in rows, null for the header.

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

const CR_RUN = /\r\n|\r/g;
const DQ_RUN = /""/g;

export function run(input) {
  const text = typeof input.text === 'string' ? input.text : String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0;
  let line = 1;
  if (n > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  // Monotonic pointers (see the header comment). lineEnd starts unset;
  // -1 is a settled value (no LF remains), never a stale one.
  let nextCR = text.indexOf('\r', pos);
  let lineEnd = -2;

  // The record being read: where its errors are addressed.
  let recordLine = 1;
  let recordRow = null;

  // The field being read, kept in locals instead of a returned object.
  let fVal = '';
  let fEnd = END;
  let fAdded = 0;

  // Unquoted scan on top of `prefix` ('' normally, '"' after an
  // unterminated quote, or a quoted value before its junk), used for the
  // junk and unterminated paths; the plain unquoted field is inlined in
  // the record loop below. Sets fVal (prefix included), fEnd, and fAdded
  // (characters kept from the text itself, prefix not counted). Stray
  // CRs are dropped, each with its error, in order.
  function unquotedTail(prefix) {
    let parts = null;
    let seg = pos;
    fAdded = 0;
    if (lineEnd === -2 || (lineEnd >= 0 && lineEnd < seg)) lineEnd = text.indexOf('\n', seg);
    for (;;) {
      const iComma = text.indexOf(',', seg);
      let end = n;
      let delim = END;
      if (lineEnd !== -1) { end = lineEnd; delim = LINE_BREAK; }
      if (iComma !== -1 && iComma < end) { end = iComma; delim = COMMA; }
      if (nextCR !== -1 && nextCR < seg) nextCR = text.indexOf('\r', seg);
      if (nextCR !== -1 && nextCR < end) {
        if (delim === LINE_BREAK && nextCR === end - 1) {
          const s = text.slice(seg, nextCR);
          fAdded += s.length;
          fVal = parts ? (parts.push(s), parts.join('')) : prefix + s;
          pos = end + 1;
          line += 1;
          fEnd = LINE_BREAK;
          return;
        }
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        if (parts === null) parts = prefix ? [prefix] : [];
        const s = text.slice(seg, nextCR);
        if (s) parts.push(s);
        fAdded += s.length;
        pos = nextCR + 1;
        seg = pos;
        continue;
      }
      const s = text.slice(seg, end);
      fAdded += s.length;
      fVal = parts ? (s && parts.push(s), parts.join('')) : prefix + s;
      if (delim === COMMA) pos = end + 1;
      else if (delim === LINE_BREAK) { pos = end + 1; line += 1; }
      else pos = n;
      fEnd = delim;
      return;
    }
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && pos + 1 < n && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    if (nextCR !== -1 && nextCR < pos) nextCR = text.indexOf('\r', pos);
    if (lineEnd === -2 || (lineEnd >= 0 && lineEnd < pos)) lineEnd = text.indexOf('\n', pos);

    // Plain record path: the line up to its break holds no quote, and no
    // CR but a CRLF's at its very end. Such a record can hold no error:
    // its fields are the line split on commas, exactly as the unquoted
    // reader would read them one by one.
    let fields = null;
    {
      const contentEnd = lineEnd === -1 ? n : lineEnd;
      const iQ = text.indexOf('"', pos);
      let sliceEnd = -1;
      if (iQ === -1 || iQ >= contentEnd) {
        if (nextCR === -1 || nextCR > contentEnd) sliceEnd = contentEnd;
        else if (lineEnd !== -1 && nextCR === contentEnd - 1) sliceEnd = contentEnd - 1;
      }
      if (sliceEnd !== -1) {
        const lineText = text.slice(pos, sliceEnd);
        pos = lineEnd === -1 ? n : lineEnd + 1;
        if (lineEnd !== -1) line += 1;
        if (lineText !== '') fields = lineText.split(',');
      }
    }

    if (fields === null) {
      fields = [];
      let lastQuoted = false;
      for (;;) {
        if (pos < n && text.charCodeAt(pos) === 34) {
          lastQuoted = true;
          const open = pos;
          const openLine = line;
          // Find the closing quote: a quote followed by another quote is
          // a doubled quote inside the field, never the closing one.
          let q = text.indexOf('"', open + 1);
          let doubled = false;
          while (q !== -1 && q + 1 < n && text.charCodeAt(q + 1) === 34) {
            doubled = true;
            q = text.indexOf('"', q + 2);
          }
          if (q === -1) {
            // The quote never closes: it is a literal character, and the
            // text after it is read again as unquoted, on the line the
            // field began.
            pos = open + 1;
            line = openLine;
            errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
            unquotedTail('"');
          } else {
            if (nextCR !== -1 && nextCR < open + 1) nextCR = text.indexOf('\r', open + 1);
            const hasCR = nextCR !== -1 && nextCR < q;
            // Every quote inside the content is one of a doubled pair
            // (a lone one would have been the closing quote), so the
            // value is the raw content with CRs read as LF and doubled
            // quotes collapsed — two native passes, each skipped when
            // its characters are absent. The line advances by the
            // number of line breaks in the finished value.
            let value = text.slice(open + 1, q);
            if (hasCR) value = value.replace(CR_RUN, '\n');
            if (doubled) value = value.replace(DQ_RUN, '"');
            if (value.indexOf('\n') !== -1) {
              let breaks = 0;
              let bi = -1;
              while ((bi = value.indexOf('\n', bi + 1)) !== -1) breaks += 1;
              line += breaks;
            }
            pos = q + 1;
            // What follows the closing quote: a comma, a line break,
            // the end of the text, or junk appended as it stands.
            if (pos >= n) {
              fVal = value;
              fEnd = END;
            } else {
              const c = text.charCodeAt(pos);
              if (c === 44) {
                pos += 1;
                fVal = value;
                fEnd = COMMA;
              } else if (c === 10) {
                pos += 1;
                line += 1;
                fVal = value;
                fEnd = LINE_BREAK;
              } else if (c === 13 && pos + 1 < n && text.charCodeAt(pos + 1) === 10) {
                pos += 2;
                line += 1;
                fVal = value;
                fEnd = LINE_BREAK;
              } else {
                unquotedTail(value);
                if (fAdded > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
              }
            }
          }
        } else {
          lastQuoted = false;
          // Unquoted field, inlined: the next comma (one short indexOf
          // scan) against the line end already known, one slice for the
          // field, stray CRs dropped in place.
          if (lineEnd === -2 || (lineEnd >= 0 && lineEnd < pos)) lineEnd = text.indexOf('\n', pos);
          let parts = null;
          let seg = pos;
          const start = pos;
          for (;;) {
            const iComma = text.indexOf(',', seg);
            let end = n;
            let delim = END;
            if (lineEnd !== -1) { end = lineEnd; delim = LINE_BREAK; }
            if (iComma !== -1 && iComma < end) { end = iComma; delim = COMMA; }
            if (nextCR !== -1 && nextCR < seg) nextCR = text.indexOf('\r', seg);
            if (nextCR !== -1 && nextCR < end) {
              if (delim === LINE_BREAK && nextCR === end - 1) {
                const s = text.slice(seg, nextCR);
                fVal = parts ? (parts.push(s), parts.join('')) : s;
                pos = end + 1;
                line += 1;
                fEnd = LINE_BREAK;
                break;
              }
              errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
              if (parts === null) parts = [];
              const s = text.slice(seg, nextCR);
              if (s) parts.push(s);
              pos = nextCR + 1;
              seg = pos;
              continue;
            }
            fVal = parts
              ? (parts.push(text.slice(seg, end)), parts.join(''))
              : text.slice(start, end);
            if (delim === COMMA) pos = end + 1;
            else if (delim === LINE_BREAK) { pos = end + 1; line += 1; }
            else pos = n;
            fEnd = delim;
            break;
          }
        }
        fields.push(fVal);
        if (fEnd !== COMMA) break;
      }

      // A line that held only stray CRs is left with no characters: no
      // record (its stray_cr errors stay).
      if (fields.length === 1 && fields[0] === '' && !lastQuoted) continue;
    }

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
