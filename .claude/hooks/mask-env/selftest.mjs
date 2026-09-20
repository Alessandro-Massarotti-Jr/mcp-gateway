#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./mask-env.mjs', import.meta.url));

const ENV_FILE = [
  '# local credentials',
  'DATABASE_URL=postgres://admin:sup3rs3cret@db.internal:5432/app',
  'SENTRY_DSN="https://abc123@o1.ingest.sentry.io/42"',
  'export FIREBASE_API_KEY=AIzaSyD-super-secret',
  'EMPTY_VAR=',
  '',
  '# OLD_DATABASE_URL=postgres://admin:oldp4ss@old.internal:5432/legacy',
  '## LEGACY_TOKEN = ghp_oldTokenNobodyRemoved',
  'USERS_API_URL=https://users.internal',
].join('\n');

const MULTILINE = [
  'JWT_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----',
  'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQ',
  '-----END PRIVATE KEY-----"',
  'PORT=3333',
].join('\n');

// why: the checks below are written in the short form (`toolName`/`toolArgs`/`toolResult`),
// which is shorter to read. This translation rewrites them into Claude Code's real format
// before they reach the hook, so the whole suite exercises the production path without any
// check having to repeat the payload envelope.
//
// hazard: `toolResult` becomes `tool_response` AND KEEPS ITS OBJECT SHAPE. That is exactly what
// the checks need to prove: the hook returns `updatedToolOutput` with the same shape it
// received, because a value of a different shape is discarded by the runtime and the raw text
// reaches the model.
function toClaudePayload(payload) {
  if (typeof payload === 'string' || payload === null || typeof payload !== 'object')
    return payload;
  const { toolName, toolArgs, toolResult, sessionId, ...rest } = payload;
  return {
    hook_event_name: 'PostToolUse',
    session_id: sessionId ?? 'selftest',
    ...rest,
    ...(toolName === undefined ? {} : { tool_name: toolName }),
    ...(toolArgs === undefined ? {} : { tool_input: toolArgs }),
    ...(toolResult === undefined ? {} : { tool_response: toolResult }),
  };
}

function run(payload, env = {}) {
  const translated = toClaudePayload(payload);
  const input = typeof translated === 'string' ? translated : JSON.stringify(translated);
  const proc = spawnSync(process.execPath, [SCRIPT], {
    input,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  if (proc.error) throw proc.error;
  const stdout = proc.stdout.trim();
  return {
    status: proc.status,
    stderr: proc.stderr,
    stdout,
    json: stdout === '' ? null : JSON.parse(stdout),
  };
}

// why: the masked output is no longer a loose piece of text - it is the `updatedToolOutput`,
// with the shape of the tool's original output. The checks still ask "what text is left?", so
// this function gathers the strings from wherever they sit inside that shape.
function textLeaves(node, out = [], depth = 0) {
  if (depth > 8) return out;
  if (typeof node === 'string') out.push(node);
  else if (Array.isArray(node)) for (const item of node) textLeaves(item, out, depth + 1);
  else if (node !== null && typeof node === 'object') {
    for (const value of Object.values(node)) textLeaves(value, out, depth + 1);
  }
  return out;
}

function maskedTextOf(result) {
  const updated = result.json?.hookSpecificOutput?.updatedToolOutput;
  if (updated === undefined) return '';
  if (typeof updated === 'string') return updated;
  return (
    updated.textResultForLlm ??
    updated.stdout ??
    updated.file?.content ??
    updated.content ??
    textLeaves(updated).join('\n')
  );
}

// hazard: the runtime DISCARDS an `updatedToolOutput` whose shape does not match the tool's
// output, and then the raw content reaches the model. This assert is what prevents that
// regression.
function assertSameShape(original, updated, trail = 'root') {
  const kind = (value) => (value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value);
  assert(
    kind(original) === kind(updated),
    `shape changed at ${trail}: ${kind(original)} -> ${kind(updated)}`,
  );
  if (Array.isArray(original)) {
    assert(original.length === updated.length, `array length changed at ${trail}`);
    original.forEach((item, i) => assertSameShape(item, updated[i], `${trail}[${i}]`));
    return;
  }
  if (original !== null && typeof original === 'object') {
    const a = Object.keys(original).sort().join(',');
    const b = Object.keys(updated).sort().join(',');
    assert(a === b, `keys changed at ${trail}: ${a} -> ${b}`);
    for (const key of Object.keys(original)) {
      assertSameShape(original[key], updated[key], `${trail}.${key}`);
    }
  }
}

const results = [];

function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, message: error.message });
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

check('view .env: masks values and preserves names', () => {
  const out = run({
    sessionId: 's1',
    timestamp: Date.now(),
    cwd: '.',
    toolName: 'view',
    toolArgs: { path: '.env' },
    toolResult: { resultType: 'success', textResultForLlm: ENV_FILE },
  });
  assert(out.status === 0, `exit ${out.status}`);
  const text = maskedTextOf(out);
  assert(text.includes('DATABASE_URL=<redacted>'), 'DATABASE_URL not masked');
  assert(text.includes('SENTRY_DSN=<redacted>'), 'SENTRY_DSN not masked');
  assert(text.includes('export FIREBASE_API_KEY=<redacted>'), 'export not preserved');
  assert(!text.includes('sup3rs3cret'), 'password leaked');
  assert(!text.includes('AIzaSyD-super-secret'), 'api key leaked');
  assert(!text.includes('sentry.io/42'), 'dsn leaked');
});

check('view .env: preserves comments, blank lines and an empty value', () => {
  const out = run({
    toolName: 'view',
    toolArgs: { path: '.env' },
    toolResult: { resultType: 'success', textResultForLlm: ENV_FILE },
  });
  const text = maskedTextOf(out);
  assert(text.includes('# local credentials'), 'comment removed');
  assert(text.includes('EMPTY_VAR='), 'empty variable changed');
  assert(!text.includes('EMPTY_VAR=<redacted>'), 'empty variable masked for nothing');
  assert(text.split('\n').length === ENV_FILE.split('\n').length, 'line count changed');
});

check('a credential on a commented line is masked too', () => {
  const out = run({
    toolName: 'view',
    toolArgs: { path: '.env' },
    toolResult: { resultType: 'success', textResultForLlm: ENV_FILE },
  });
  const text = maskedTextOf(out);
  assert(!text.includes('oldp4ss'), 'password in a comment leaked');
  assert(!text.includes('ghp_oldTokenNobodyRemoved'), 'token in a comment leaked');
  assert(text.includes('# OLD_DATABASE_URL=<redacted>'), 'single comment lost the key');
  assert(text.includes('## LEGACY_TOKEN = <redacted>'), 'double comment lost the key');
});

check('rg output with a path prefix is masked', () => {
  const hit =
    'C:\\Users\\dev\\projects\\example-api\\.env:PG_SQL_CONN_URL=postgresql://user:p4ss@host:35432/db';
  const out = run({
    toolName: 'rg',
    toolArgs: {
      pattern: '^PG_SQL_CONN_URL=.*$',
      paths: 'C:\\Users\\dev\\projects\\example-api\\.env',
      output_mode: 'content',
    },
    toolResult: { resultType: 'success', textResultForLlm: hit },
  });
  const text = maskedTextOf(out);
  assert(!text.includes('p4ss'), 'password leaked in the rg output');
  assert(!text.includes('35432/db'), 'host and port leaked in the rg output');
  assert(text.includes('PG_SQL_CONN_URL=<redacted>'), 'key lost in the rg output');
  assert(text.includes('.env:'), 'the path prefix was destroyed');
});

check('grep output on .env with path and line number is masked', () => {
  const hit = '.env:18:MONGO_INVITATIONS_COLLECTION=invitations-prod';
  const out = run({
    toolName: 'grep',
    toolArgs: { pattern: 'MONGO_INVITATIONS_COLLECTION', paths: '.env' },
    toolResult: { resultType: 'success', textResultForLlm: hit },
  });
  const text = maskedTextOf(out);
  assert(!text.includes('invitations-prod'), 'value leaked with the path:lineno: prefix');
  assert(text.includes('MONGO_INVITATIONS_COLLECTION=<redacted>'), 'key lost');
  assert(text.includes('.env:18:'), 'the path:lineno: prefix was destroyed');
});

check('view with view_range: the "168. " numbering does not fool the masker', () => {
  const ranged = [
    '168.',
    '169. ENTERPRISE_ACCESS_REQUEST_REJECTED_MAIL_TEMPLATE="AccessRequestRejectedTemplate"',
    '170. REVIEW_ENTERPRISE_ACCESS_REQUEST_MAIL_TEMPLATE="AdminReviewEnterpriseAccessRequest"',
    '171.',
    "172. ENTERPRISE_MIN_CREATED_DATE_ALLOWED='2026-07-28'",
    "173. IGNORE_CUSTOMER_OWNER_NO='13030'",
    '177. AVOCADO=tasty',
  ].join('\n');
  const out = run({
    toolName: 'view',
    toolArgs: { path: 'C:\\proj\\example-api\\.env', view_range: [168, 177] },
    toolResult: { resultType: 'success', textResultForLlm: ranged },
  });
  const text = maskedTextOf(out);
  assert(!text.includes('AccessRequestRejectedTemplate'), 'value leaked with "168. " numbering');
  assert(!text.includes('2026-07-28'), 'date leaked');
  assert(!text.includes('13030'), 'number leaked');
  assert(!text.includes('tasty'), 'AVOCADO leaked');
  assert(
    text.includes('169. ENTERPRISE_ACCESS_REQUEST_REJECTED_MAIL_TEMPLATE=<redacted>'),
    'key or numbering lost',
  );
  assert(text.includes('177. AVOCADO=<redacted>'), 'last line not masked');
  assert(text.split('\n')[0] === '168.', 'empty numbered line was changed');
});

check('numbering in other formats is covered too', () => {
  for (const line of [
    '  12| SECRET=abc',
    '12→SECRET=abc',
    '12: SECRET=abc',
    '  12\tSECRET=abc',
    '12) SECRET=abc',
  ]) {
    const out = run({
      toolName: 'view',
      toolArgs: { path: '.env' },
      toolResult: { resultType: 'success', textResultForLlm: line },
    });
    assert(
      !maskedTextOf(out).includes('abc'),
      `value leaked in the format: ${JSON.stringify(line)}`,
    );
  }
});

check('.env.sample is readable: view passes untouched', () => {
  const out = run({
    toolName: 'view',
    toolArgs: { path: 'C:\\proj\\example-api\\.env.sample' },
    toolResult: { resultType: 'success', textResultForLlm: ENV_FILE },
  });
  assert(out.status === 0, `exit ${out.status}`);
  assert(out.stdout === '', `the hook masked .env.sample: ${out.stdout}`);
});

check('.env.example / .env.template / .env.dist are readable too', () => {
  for (const name of ['.env.example', 'infra/.env.template', '.env.dist']) {
    const out = run({
      toolName: 'view',
      toolArgs: { path: name },
      toolResult: { resultType: 'success', textResultForLlm: ENV_FILE },
    });
    assert(out.stdout === '', `the hook masked ${name}`);
  }
});

check('rg on .env.sample passes untouched', () => {
  const hit = '.env.sample:PG_SQL_CONN_URL=postgresql://user:pass@host:5432/db';
  const out = run({
    toolName: 'rg',
    toolArgs: { pattern: '^PG_SQL_CONN_URL=.*$', paths: '.env.sample' },
    toolResult: { resultType: 'success', textResultForLlm: hit },
  });
  assert(out.stdout === '', 'the hook masked a search in .env.sample');
});

check('a search across both files: masks only the .env lines', () => {
  const hits = [
    '.env.sample:PG_SQL_CONN_URL=postgresql://user:pass@host:5432/db',
    '.env:PG_SQL_CONN_URL=postgresql://admin:realP4ss@prod.rds.amazonaws.com:35432/app',
  ].join('\n');
  const out = run({
    toolName: 'rg',
    toolArgs: { pattern: '^PG_SQL_CONN_URL=.*$', paths: ['.env.sample', '.env'] },
    toolResult: { resultType: 'success', textResultForLlm: hits },
  });
  const text = maskedTextOf(out);
  assert(!text.includes('realP4ss'), 'the real password leaked');
  assert(
    text.includes('.env.sample:PG_SQL_CONN_URL=postgresql://user:pass@host:5432/db'),
    'the sample line was masked',
  );
  assert(text.includes('.env:PG_SQL_CONN_URL=<redacted>'), 'the .env line was not masked');
});

check('an empty MASK_ENV_ALLOW goes back to masking the sample', () => {
  const out = run(
    {
      toolName: 'view',
      toolArgs: { path: '.env.sample' },
      toolResult: { resultType: 'success', textResultForLlm: ENV_FILE },
    },
    { MASK_ENV_ALLOW: '' },
  );
  assert(!maskedTextOf(out).includes('sup3rs3cret'), 'an empty allowlist did not mask again');
});

check('a bare URL is not mistaken for an assignment', () => {
  const out = run({
    toolName: 'view',
    toolArgs: { path: '.env' },
    toolResult: {
      resultType: 'success',
      textResultForLlm: 'https://user:pw@host/path?a=b\nPORT=3333',
    },
  });
  const text = maskedTextOf(out);
  assert(text.includes('https://user:pw@host/path?a=b'), 'a URL with no assignment was changed');
  assert(text.includes('PORT=<redacted>'), 'the following assignment was not masked');
});

check('powershell reading .env is masked', () => {
  const out = run({
    toolName: 'powershell',
    toolArgs: {
      command:
        "$line = Get-Content '.env' | Where-Object { $_ -match '^\\s*PG_SQL_CONN_URL\\s*=' }; $line",
    },
    toolResult: {
      resultType: 'success',
      textResultForLlm:
        'PG_SQL_CONN_URL=postgresql://user:p4ss@host:35432/db\n<shellId: 4 completed with exit code 0>',
    },
  });
  const text = maskedTextOf(out);
  assert(!text.includes('p4ss'), 'password leaked through powershell');
  assert(text.includes('PG_SQL_CONN_URL=<redacted>'), 'key lost through powershell');
});

check('bash cat .env: masks based on the command', () => {
  const out = run({
    toolName: 'bash',
    toolArgs: { command: 'cat ./.env | head -20' },
    toolResult: { resultType: 'success', textResultForLlm: ENV_FILE },
  });
  assert(!maskedTextOf(out).includes('sup3rs3cret'), 'password leaked through bash');
});

check('bash printenv: masks an environment dump', () => {
  const out = run({
    toolName: 'bash',
    toolArgs: { command: 'printenv' },
    toolResult: { resultType: 'success', textResultForLlm: ENV_FILE },
  });
  assert(!maskedTextOf(out).includes('sup3rs3cret'), 'password leaked through printenv');
});

check('.env.production: file variants are covered', () => {
  const out = run({
    toolName: 'view',
    toolArgs: { path: 'infra/.env.production' },
    toolResult: { resultType: 'success', textResultForLlm: ENV_FILE },
  });
  assert(!maskedTextOf(out).includes('sup3rs3cret'), 'password leaked in .env.production');
});

check('a snake_case payload (VS Code) is accepted', () => {
  const out = run({
    hook_event_name: 'PostToolUse',
    session_id: 's2',
    tool_name: 'view',
    tool_input: { path: '.env' },
    tool_result: { result_type: 'success', text_result_for_llm: ENV_FILE },
  });
  assert(!maskedTextOf(out).includes('sup3rs3cret'), 'password leaked in the snake_case format');
  assert(maskedTextOf(out).includes('DATABASE_URL=<redacted>'), 'key lost in snake_case');
});

check('output with line numbers is masked', () => {
  const numbered = ENV_FILE.split('\n')
    .map((line, index) => `${String(index + 1).padStart(4)}\t${line}`)
    .join('\n');
  const out = run({
    toolName: 'view',
    toolArgs: { path: '.env' },
    toolResult: { resultType: 'success', textResultForLlm: numbered },
  });
  const text = maskedTextOf(out);
  assert(!text.includes('sup3rs3cret'), 'password leaked with line numbering');
  assert(text.includes('DATABASE_URL=<redacted>'), 'key lost with numbering');
});

check('a quoted multi-line value does not leak its continuation', () => {
  const out = run({
    toolName: 'view',
    toolArgs: { path: '.env' },
    toolResult: { resultType: 'success', textResultForLlm: MULTILINE },
  });
  const text = maskedTextOf(out);
  assert(!text.includes('MIIEvQ'), 'the private key body leaked');
  assert(!text.includes('BEGIN PRIVATE KEY'), 'the key header leaked');
  assert(text.includes('PORT=<redacted>'), 'the line after the block was not processed');
});

check('a file unrelated to env passes untouched', () => {
  const out = run({
    toolName: 'view',
    toolArgs: { path: 'src/routes.ts' },
    toolResult: { resultType: 'success', textResultForLlm: 'const port = 3333;\nAPI=1\n' },
  });
  assert(out.status === 0, `exit ${out.status}`);
  assert(out.stdout === '', `the hook had an opinion about an ordinary file: ${out.stdout}`);
});

check('invalid stdin produces neither output nor an error', () => {
  const out = run('this is not json');
  assert(out.status === 0, `exit ${out.status}`);
  assert(out.stdout === '', 'produced output with invalid stdin');
});

check('an empty result produces no output', () => {
  const out = run({
    toolName: 'view',
    toolArgs: { path: '.env' },
    toolResult: { resultType: 'success', textResultForLlm: '' },
  });
  assert(out.stdout === '', 'produced output for an empty result');
});

check('the output is a single JSON object, all inside hookSpecificOutput', () => {
  const out = run({
    toolName: 'view',
    toolArgs: { path: '.env' },
    toolResult: { resultType: 'success', textResultForLlm: ENV_FILE },
  });
  assert(out.stdout.split('\n').length === 1, 'emitted more than one line');
  // hazard: the runtime validates the whole object. A loose decision field at the top fails
  // validation and the RAW result reaches the model - the exact leak this hook exists to
  // prevent.
  assert(Object.keys(out.json).join(',') === 'hookSpecificOutput', 'unexpected fields at the top');
  const hso = out.json.hookSpecificOutput;
  assert(hso.hookEventName === 'PostToolUse', `hookEventName ${hso.hookEventName}`);
  assert(typeof hso.additionalContext === 'string', 'additionalContext missing');
  // why: the shape of the original output is preserved - `resultType` is still there, intact.
  assert(hso.updatedToolOutput.resultType === 'success', 'lost the shape of the original output');
});

// --- the updatedToolOutput contract in Claude Code -------------------------------------------

check(
  'Bash output: masks stdout and preserves the {stdout,stderr,interrupted,isImage} shape',
  () => {
    const original = { stdout: ENV_FILE, stderr: '', interrupted: false, isImage: false };
    const out = run({
      toolName: 'Bash',
      toolArgs: { command: 'cat .env' },
      toolResult: original,
    });
    const updated = out.json?.hookSpecificOutput?.updatedToolOutput;
    assert(updated !== undefined, 'did not return updatedToolOutput');
    assertSameShape(original, updated);
    assert(!updated.stdout.includes('sup3rs3cret'), 'password leaked in stdout');
    assert(updated.stdout.includes('DATABASE_URL='), 'lost the variable name');
    assert(updated.interrupted === false, 'a boolean turned into something else');
  },
);

check('Read output: masks file.content and preserves the nested shape', () => {
  const original = {
    type: 'text',
    file: {
      filePath: '/repo/.env',
      content: ENV_FILE,
      numLines: 9,
      startLine: 1,
      totalLines: 9,
    },
  };
  const out = run({
    toolName: 'Read',
    toolArgs: { file_path: '/repo/.env' },
    toolResult: original,
  });
  const updated = out.json?.hookSpecificOutput?.updatedToolOutput;
  assert(updated !== undefined, 'did not return updatedToolOutput');
  assertSameShape(original, updated);
  assert(!updated.file.content.includes('sup3rs3cret'), 'password leaked in content');
  assert(updated.file.numLines === 9, 'a number turned into something else');
  assert(updated.file.filePath === '/repo/.env', 'the path should not have been touched');
});

check('the decision never goes at the top of the object (it would fail the schema)', () => {
  const out = run({
    toolName: 'Bash',
    toolArgs: { command: 'cat .env' },
    toolResult: { stdout: ENV_FILE, stderr: '', interrupted: false, isImage: false },
  });
  assert(out.json.modifiedResult === undefined, 'output in the old loose-text format');
  assert(out.json.updatedToolOutput === undefined, 'updatedToolOutput outside hookSpecificOutput');
  assert(
    out.json.hookSpecificOutput?.hookEventName === 'PostToolUse',
    'hookEventName missing or wrong',
  );
});

check('the notice goes in additionalContext, inside hookSpecificOutput', () => {
  const out = run({
    toolName: 'Bash',
    toolArgs: { command: 'cat .env' },
    toolResult: { stdout: ENV_FILE, stderr: '', interrupted: false, isImage: false },
  });
  const note = out.json?.hookSpecificOutput?.additionalContext ?? '';
  assert(note.includes('mask-env'), 'notice missing');
  assert(
    out.json.additionalContext === undefined,
    'a notice at the top of the object fails the schema',
  );
});

check('--placeholder= through an argument changes the masking text', () => {
  const proc = spawnSync(process.execPath, [SCRIPT, '--placeholder=[REDACTED]'], {
    input: JSON.stringify(
      toClaudePayload({
        toolName: 'Bash',
        toolArgs: { command: 'cat .env' },
        toolResult: { stdout: ENV_FILE, stderr: '', interrupted: false, isImage: false },
      }),
    ),
    encoding: 'utf8',
    env: { ...process.env },
  });
  const json = JSON.parse(proc.stdout.trim());
  assert(
    json.hookSpecificOutput.updatedToolOutput.stdout.includes('[REDACTED]'),
    'the placeholder from the argument was not used',
  );
});

check('--allow= through an argument frees the example file', () => {
  const proc = spawnSync(process.execPath, [SCRIPT, '--allow=.env.demo'], {
    input: JSON.stringify(
      toClaudePayload({
        toolName: 'Read',
        toolArgs: { file_path: '/repo/.env.demo' },
        toolResult: { stdout: ENV_FILE, stderr: '', interrupted: false, isImage: false },
      }),
    ),
    encoding: 'utf8',
    env: { ...process.env },
  });
  assert(proc.stdout.trim() === '', `should have stayed quiet, answered: ${proc.stdout}`);
});

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  process.stdout.write(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : ` -> ${r.message}`}\n`);
}
process.stdout.write(`\n${results.length - failed.length}/${results.length} passed\n`);
process.exitCode = failed.length === 0 ? 0 : 1;
