// Harness driver for the fast csv-reader entry: node /bot/main.ts reads
// every case from /input/cases.json (an array of {id, input}), answers
// each one alone with run() from ./solve.js, and writes the answers, in
// the cases' order, to /output/answers.json. Outside a container,
// MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in for /input and
// /output.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

// The house baseline runs with V8's incremental marking off, set before
// solve.js is imported so all of its work runs under it; this entry does
// the same, as the rules allow.
setFlagsFromString('--no-incremental-marking');

const { run } = (await import(new URL('./solve.js', import.meta.url).href)) as {
  run: (input: unknown) => unknown;
};

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8')) as {
  id: string;
  input: unknown;
}[];

const answers = new Array(cases.length);
for (let i = 0; i < cases.length; i++) answers[i] = run(cases[i]!.input);
writeFileSync(join(outputDir, 'answers.json'), JSON.stringify(answers));
