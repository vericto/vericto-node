// SPDX-FileCopyrightText: 2026 Vericto S.A.S.
// SPDX-License-Identifier: Apache-2.0

/**
 * Runs the TypeScript examples of the README and the framework guides against the
 * local Runtime API stub (scripts/docs-stub.mjs), so a published example cannot drift
 * from the package. Every ```ts block is type-checked (tsc, strict) and executed with
 * Node's type stripping, with VERICTO_* pointing at the stub. Markers, as HTML comments
 * on the lines just before a block:
 *
 *   <!-- docs-check: skip <reason> -->      not run (the reason is required)
 *   <!-- docs-check: env KEY=VALUE ... -->  extra environment; {stub} is the stub's URL
 *   <!-- docs-check: output -->             before the ```text block that follows the code
 *                                           (prose may come between): the expected stdout
 *
 *   node scripts/check-docs-examples.mjs core        # README.md + docs/frameworks/langchain.md
 *   node scripts/check-docs-examples.mjs frameworks  # the other guides, in docs/frameworks/
 *
 * Needs `npm run build` first (the examples import `@vericto/sdk`, resolved to dist/).
 * The frameworks suite also needs `npm ci` in docs/frameworks/ and the databases its
 * guides name (DATABASE_URL, MYSQL_URL; CI starts PostgreSQL and MySQL services).
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startStub } from './docs-stub.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GUIDES = path.join(ROOT, 'docs', 'frameworks');
// Guides whose frameworks are the package's own devDependencies run in the core suite.
const CORE_GUIDES = new Set(['langchain.md']);

const suite = process.argv[2] ?? 'core';
if (suite !== 'core' && suite !== 'frameworks') {
  console.error('usage: check-docs-examples.mjs core|frameworks');
  process.exit(2);
}
const guides = readdirSync(GUIDES).filter((f) => f.endsWith('.md') && f !== 'README.md');
const files =
  suite === 'core'
    ? [path.join(ROOT, 'README.md'), ...guides.filter((f) => CORE_GUIDES.has(f)).map((f) => path.join(GUIDES, f))]
    : guides.filter((f) => !CORE_GUIDES.has(f)).map((f) => path.join(GUIDES, f));
// Where the extracted files live decides how `@vericto/sdk` and the frameworks resolve:
// the package itself (self-reference) for core, docs/frameworks/node_modules otherwise.
const project = suite === 'core' ? ROOT : GUIDES;
const work = path.join(project, '.docs-check');

/** The ```ts blocks of a Markdown file, with their markers and expected output. */
export function extractBlocks(markdown) {
  const lines = markdown.split('\n');
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const open = /^```(ts|typescript)\s*$/.exec(lines[i]);
    if (!open) continue;
    const start = i;
    const body = [];
    for (i++; i < lines.length && !/^```\s*$/.test(lines[i]); i++) body.push(lines[i]);
    const markers = [];
    for (let j = start - 1; j >= 0 && (lines[j].trim() === '' || /^<!-- docs-check:/.test(lines[j])); j--) {
      const m = /^<!-- docs-check: (.*?) -->$/.exec(lines[j].trim());
      if (m) markers.push(m[1]);
    }
    const block = { line: start + 1, code: body.join('\n') + '\n', skip: undefined, env: {}, output: undefined };
    for (const m of markers) {
      if (m.startsWith('skip')) {
        block.skip = m.slice(4).trim();
        if (!block.skip) throw new Error(`line ${start + 1}: docs-check: skip needs a reason`);
      } else if (m.startsWith('env ')) {
        for (const pair of m.slice(4).trim().split(/\s+/)) {
          const eq = pair.indexOf('=');
          block.env[pair.slice(0, eq)] = pair.slice(eq + 1);
        }
      } else {
        throw new Error(`line ${start + 1}: unknown docs-check marker "${m}"`);
      }
    }
    // An expected output: <!-- docs-check: output --> then a ```text block, before the
    // next code block (prose may sit in between).
    let k = i + 1;
    while (k < lines.length && !/^```/.test(lines[k]) && lines[k].trim() !== '<!-- docs-check: output -->') k++;
    if (lines[k]?.trim() === '<!-- docs-check: output -->') {
      k++;
      while (k < lines.length && lines[k].trim() === '') k++;
      if (!/^```text\s*$/.test(lines[k] ?? '')) throw new Error(`line ${k + 1}: docs-check: output must precede a \`\`\`text block`);
      const out = [];
      for (k++; k < lines.length && !/^```\s*$/.test(lines[k]); k++) out.push(lines[k]);
      block.output = out.join('\n').trim();
    }
    blocks.push(block);
  }
  return blocks;
}

rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
// A suite may need generated code first (docs/frameworks: the Prisma client).
const scripts = JSON.parse(readFileSync(path.join(project, 'package.json'), 'utf8')).scripts ?? {};
if (scripts['docs-check:setup']) {
  const setup = spawnSync('npm', ['run', '--silent', 'docs-check:setup'], { cwd: project, stdio: 'inherit' });
  if (setup.status !== 0) process.exit(1);
}
const jobs = [];
let skipped = 0;
for (const file of files) {
  const rel = path.relative(ROOT, file);
  for (const block of extractBlocks(readFileSync(file, 'utf8'))) {
    if (block.skip !== undefined) {
      skipped++;
      console.log(`skip  ${rel}:${block.line} (${block.skip})`);
      continue;
    }
    const name = `${path.basename(file, '.md').toLowerCase()}-${block.line}.ts`;
    writeFileSync(path.join(work, name), block.code);
    jobs.push({ ...block, rel, name });
  }
}
writeFileSync(
  path.join(work, 'tsconfig.json'),
  JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      lib: ['ES2022', 'DOM'],
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      types: ['node'],
      // Each example is its own module: names may repeat across blocks.
      moduleDetection: 'force',
      // Node runs the files with type stripping, so relative imports name the .ts file.
      allowImportingTsExtensions: true,
      // ...and only syntax type stripping can erase (no enums, parameter properties).
      erasableSyntaxOnly: true,
    },
    include: ['*.ts', 'generated/**/*.ts'],
  }),
);

let failed = 0;
const tsc = path.join(project, 'node_modules', 'typescript', 'bin', 'tsc');
const typecheck = spawnSync(process.execPath, [tsc, '-p', path.join(work, 'tsconfig.json')], { encoding: 'utf8' });
if (typecheck.status !== 0) {
  failed++;
  console.error(`FAIL  type-check\n${typecheck.stdout}${typecheck.stderr}`);
} else {
  console.log(`ok    type-check (${jobs.length} examples)`);
}

const stub = await startStub();
try {
  for (const job of jobs) {
    const env = {
      ...process.env,
      VERICTO_API_KEY: 'vtro_docs_check_not_a_real_key',
      VERICTO_DATABASE_ID: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
      VERICTO_API_URL: stub.url,
      VERICTO_FAIL_MODE: '',
      VERICTO_TIMEOUT: '',
      NODE_NO_WARNINGS: '1',
    };
    for (const [k, v] of Object.entries(job.env)) env[k] = v.replaceAll('{stub}', stub.url);
    // Asynchronous: the stub answers from this process's event loop.
    const run = await runNode(path.join(work, job.name), { cwd: work, env });
    const where = `${job.rel}:${job.line}`;
    if (run.status !== 0) {
      failed++;
      console.error(`FAIL  ${where} (exit ${run.status ?? run.signal})\n${run.stdout}${run.stderr}`);
    } else if (job.output !== undefined && run.stdout.trim() !== job.output) {
      failed++;
      console.error(`FAIL  ${where}: output differs\n--- expected\n${job.output}\n--- actual\n${run.stdout.trim()}`);
    } else {
      console.log(`ok    ${where}${job.output !== undefined ? ' (output matches)' : ''}`);
    }
  }
} finally {
  await stub.close();
}
/** Run one example; resolves its exit status and output (killed after 60 s). */
function runNode(file, options) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--experimental-strip-types', file], { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d) => { stdout += d; });
    child.stderr.setEncoding('utf8').on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, 60_000);
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, stdout, stderr });
    });
  });
}

console.log(`${jobs.length} run, ${skipped} skipped, ${failed} failed`);
if (!failed) rmSync(work, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
