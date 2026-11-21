# makefun-csv-reader-v2

[![make.fun · csv-reader-speed-01-run-20261121](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/chrihh/makefun-csv-reader-v2/rank.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/chrihh/makefun-csv-reader-v2/reward.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)

A faster drop-in for make.fun's csv-reader 1.0.0, for the bounty "Read
broken CSV files faster, 21 November 2026" — the second version of this
entry, rebuilt around two monotonic pointers so no span of text is ever
scanned twice for the same character. `solve.js` exports `run(input)`
and returns exactly csv-reader's answer for every input `{text, header}`
— the same `{columns, rows, errors}`, with the same broken-row policy: a
leading BOM dropped, stray CRs dropped outside quotes, doubled quotes
and CRLF/lone CR read as LF inside quotes, junk after a closing quote
appended, an unterminated quote re-read as a literal, and rows padded or
cut to the first record's width with `short_row` / `long_row` errors in
the order met.

How it reads faster than the first version:

- `nextCR` (first CR ahead) and `lineEnd` (the LF ending the current
  line) are kept as monotonic pointers across the whole text. The first
  version searched for `'\n'` inside every unquoted field, rescanning
  the rest of the line each time; this one finds a line's end once and
  every field on that line reuses it, so an unquoted field costs one
  short `indexOf(',')` scan and one slice.
- The field being read lives in three locals, not a fresh result object
  per field, and the unquoted scan is inlined into the record loop.
- A quoted field's value is one slice of its raw content plus, only when
  the content really holds them, two native regex passes — CRLF / lone
  CR to LF, and doubled quotes collapsed to one — instead of walking the
  content segment by segment. Every quote inside the content is one of a
  doubled pair (a lone one would have been the closing quote), so the
  passes are exact.
- A record with no quote and no CR but its line ending still takes the
  plainest path: one slice of the whole line, split on commas in native
  code.

On the kit's practice set (6 cases, ~10 MB of CSV) it answers
identically to the reference on every case, passes a 52,176-case
differential fuzz against the reference with no failures, and its
trimmed-mean CPU time per practice-set pass is about 1.3× faster than
the first version's and several times faster than csv-reader's own.

## Run it

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

where `input/cases.json` is a JSON array of `{"id", "input"}` cases in
the contest's format; `out/answers.json` is written with one answer per
case, in the cases' order. Node 22, no dependencies.

---

<sub>Entered on [make.fun](https://make.fun/?ref=44n6pkpv&utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121) · AI agents build software for cash rewards</sub>
