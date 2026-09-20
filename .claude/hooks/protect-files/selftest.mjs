#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./protect-files.mjs', import.meta.url));

const PATCH = [
  '*** Begin Patch',
  '*** Update File: jest.config.js',
  '@@',
  '-  collectCoverage: true,',
  '+  collectCoverage: false,',
  '*** End Patch',
].join('\n');

// why: the checks below are written in the short form (`toolName`/`toolArgs`), which is shorter
// to read. This translation rewrites them into Claude Code's real format before they reach the
// hook, so the whole suite exercises the production path without any check having to repeat the
// payload envelope.
function toClaudePayload(payload) {
  if (typeof payload === 'string' || payload === null || typeof payload !== 'object')
    return payload;
  const { toolName, toolArgs, ...rest } = payload;
  return {
    hook_event_name: 'PreToolUse',
    session_id: 'selftest',
    cwd: process.cwd(),
    ...rest,
    ...(toolName === undefined ? {} : { tool_name: toolName }),
    ...(toolArgs === undefined ? {} : { tool_input: toolArgs }),
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

function runArgs(payload, args, env = {}) {
  const translated = toClaudePayload(payload);
  const proc = spawnSync(process.execPath, [SCRIPT, ...args], {
    input: typeof translated === 'string' ? translated : JSON.stringify(translated),
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

function assertDeny(out, expectedPath) {
  // hazard: exit 2, not 0. In Claude Code, exit 2 blocks PreToolUse on its own, even if stdout
  // is discarded.
  assert(out.status === 2, `exit ${out.status} (expected 2 = deny on PreToolUse)`);
  assert(out.json !== null, 'did not deny: empty stdout');
  // hazard: in Claude Code the decision MUST be inside `hookSpecificOutput`. At the top of the
  // object it fails schema validation and becomes a non-blocking error - the write goes through.
  const hso = out.json.hookSpecificOutput ?? {};
  assert(hso.hookEventName === 'PreToolUse', `hookEventName ${hso.hookEventName}`);
  assert(
    out.json.permissionDecision === undefined,
    'a decision at the top of the object fails the schema',
  );
  assert(hso.permissionDecision === 'deny', `decision ${hso.permissionDecision}`);
  const reason = hso.permissionDecisionReason ?? '';
  assert(reason.includes('[protect-files]'), 'reason without the hook prefix');
  if (expectedPath) assert(reason.includes(expectedPath), `reason does not quote ${expectedPath}`);
}

function assertAllow(out) {
  assert(out.status === 0, `exit ${out.status}`);
  assert(out.stdout === '', `should have stayed silent, but answered: ${out.stdout}`);
}

// why: the reason moved during the migration (top of the object -> `hookSpecificOutput`). A
// single read point keeps the next format change from touching every check.
function reasonOf(out) {
  return out.json?.hookSpecificOutput?.permissionDecisionReason ?? '';
}

// --- direct block through a write tool ----------------------------------------------------

check('editing the Jest config is denied', () => {
  assertDeny(
    run({
      toolName: 'edit',
      toolArgs: { path: 'jest.config.js', old_str: 'a', new_str: 'b' },
    }),
    'jest.config.js',
  );
});

check('creating the Prettier config is denied', () => {
  assertDeny(run({ toolName: 'create', toolArgs: { path: '.prettierrc.json', file_text: '{}' } }));
});

check('Write (Claude format) on the ESLint config is denied', () => {
  assertDeny(
    run({ toolName: 'Write', toolArgs: { file_path: 'eslint.config.mjs', content: 'x' } }),
  );
});

check('a snake_case payload (VS Code) is denied too', () => {
  assertDeny(
    run({
      hook_event_name: 'PreToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: '.eslintrc.json', old_string: 'a', new_string: 'b' },
    }),
  );
});

check('an absolute Windows path is denied', () => {
  assertDeny(
    run({
      toolName: 'Edit',
      toolArgs: { file_path: 'C:\\Users\\dev\\repo\\jest.config.js', content: 'x' },
    }),
  );
});

check('an absolute cloud agent path is denied', () => {
  assertDeny(run({ toolName: 'create', toolArgs: { path: '/workspace/.prettierrc.json' } }));
});

check('nested edits are inspected', () => {
  assertDeny(
    run({
      toolName: 'multi_edit',
      toolArgs: { edits: [{ path: 'src/routes.ts' }, { path: '.eslintignore' }] },
    }),
  );
});

// --- reading stays allowed -----------------------------------------------------------------

check('view on the Jest config passes', () => {
  assertAllow(run({ toolName: 'view', toolArgs: { path: 'jest.config.js' } }));
});

check('grep inside the protected files passes', () => {
  assertAllow(run({ toolName: 'grep', toolArgs: { pattern: 'coverage', path: 'jest.config.js' } }));
});

check('cat of the protected file passes', () => {
  assertAllow(run({ toolName: 'bash', toolArgs: { command: 'cat .prettierrc.json' } }));
});

check('running lint/test passes', () => {
  assertAllow(run({ toolName: 'bash', toolArgs: { command: 'npx jest --config jest.config.js' } }));
});

check('editing an ordinary file passes', () => {
  assertAllow(run({ toolName: 'edit', toolArgs: { path: 'src/routes.ts', new_str: 'x' } }));
});

check('text that merely cites the protected file passes', () => {
  assertAllow(
    run({
      toolName: 'create',
      toolArgs: {
        path: 'docs/tests.md',
        file_text: 'The coverage threshold lives in jest.config.js and must not be lowered.',
      },
    }),
  );
});

// --- workarounds through the shell -----------------------------------------------------------

check('redirection onto a protected file is denied', () => {
  assertDeny(run({ toolName: 'bash', toolArgs: { command: 'echo "{}" > .prettierrc.json' } }));
});

check('append through redirection is denied', () => {
  assertDeny(run({ toolName: 'bash', toolArgs: { command: 'echo x >> .eslintignore' } }));
});

check('an in-place sed is denied', () => {
  assertDeny(
    run({ toolName: 'bash', toolArgs: { command: "sed -i 's/50/0/' jest.config.js" } }),
    'jest.config.js',
  );
});

check('rm of the protected file is denied', () => {
  assertDeny(run({ toolName: 'bash', toolArgs: { command: 'rm -f .eslintrc.json' } }));
});

check('mv of the protected file is denied', () => {
  assertDeny(
    run({ toolName: 'bash', toolArgs: { command: 'mv jest.config.js jest.config.old.js' } }),
  );
});

check('git checkout of the protected file is denied', () => {
  assertDeny(run({ toolName: 'bash', toolArgs: { command: 'git checkout -- .prettierrc.json' } }));
});

check('prettier --write on its own config is denied', () => {
  assertDeny(
    run({ toolName: 'bash', toolArgs: { command: 'npx prettier --write .prettierrc.json' } }),
  );
});

check('eslint --fix on its own config is denied', () => {
  assertDeny(
    run({ toolName: 'bash', toolArgs: { command: 'npx eslint --fix eslint.config.mjs' } }),
  );
});

check('powershell Set-Content is denied', () => {
  assertDeny(
    run({
      toolName: 'powershell',
      toolArgs: { command: "Set-Content -Path jest.config.js -Value ''" },
    }),
  );
});

check('powershell Remove-Item is denied', () => {
  assertDeny(
    run({ toolName: 'powershell', toolArgs: { command: 'Remove-Item .\\.eslintrc.json' } }),
  );
});

check('node -e with writeFileSync is denied', () => {
  assertDeny(
    run({
      toolName: 'bash',
      toolArgs: { command: "node -e \"require('fs').writeFileSync('jest.config.js','')\"" },
    }),
  );
});

check('apply_patch on the protected file is denied', () => {
  assertDeny(run({ toolName: 'apply_patch', toolArgs: { input: PATCH } }), 'jest.config.js');
});

check('2> onto a protected file is denied', () => {
  assertDeny(run({ toolName: 'bash', toolArgs: { command: 'npm test 2> jest.config.js' } }));
});

check('2>&1 on its own does not trigger a block', () => {
  assertAllow(
    run({ toolName: 'bash', toolArgs: { command: 'cat jest.config.js 2>&1 | head -5' } }),
  );
});

// --- configuration through env ----------------------------------------------------------------

check('a custom PROTECT_FILES_PATHS protects another file', () => {
  assertDeny(
    run(
      { toolName: 'edit', toolArgs: { path: 'tsconfig.json' } },
      { PROTECT_FILES_PATHS: 'tsconfig*.json' },
    ),
    'tsconfig.json',
  );
});

check('a custom PROTECT_FILES_PATHS frees the defaults', () => {
  assertAllow(
    run(
      { toolName: 'edit', toolArgs: { path: 'jest.config.js' } },
      { PROTECT_FILES_PATHS: 'tsconfig*.json' },
    ),
  );
});

check('PROTECT_FILES_ALLOW opens an exception', () => {
  assertAllow(
    run(
      { toolName: 'edit', toolArgs: { path: 'jest.config.e2e.js' } },
      { PROTECT_FILES_ALLOW: 'jest.config.e2e.js' },
    ),
  );
});

check('a pattern with a slash only catches the given path', () => {
  const env = { PROTECT_FILES_PATHS: 'config/jest.config.js' };
  assertDeny(run({ toolName: 'edit', toolArgs: { path: 'config/jest.config.js' } }, env));
  assertAllow(run({ toolName: 'edit', toolArgs: { path: 'other/jest.config.js' } }, env));
});

check('PROTECT_FILES_MESSAGE goes into the reason', () => {
  const out = run(
    { toolName: 'edit', toolArgs: { path: 'jest.config.js' } },
    { PROTECT_FILES_MESSAGE: 'Talk to the platform team.' },
  );
  assertDeny(out);
  assert(reasonOf(out).includes('Talk to the platform team.'), 'extra message missing');
});

// --- output contract ---------------------------------------------------------------------------

check('the reason tells the agent to hand the change to the human', () => {
  const reason = reasonOf(run({ toolName: 'edit', toolArgs: { path: 'jest.config.js' } }));
  assert(reason.includes('human'), 'the reason does not tell the agent to involve the human');
  assert(reason.includes('diff'), 'the reason does not ask for the proposed diff');
});

check('the output is a single JSON object, all inside hookSpecificOutput', () => {
  const out = run({ toolName: 'edit', toolArgs: { path: 'jest.config.js' } });
  assert(out.stdout.split('\n').length === 1, 'emitted more than one line');
  // hazard: Claude Code validates the whole object. An extra field at the top, or the decision
  // outside `hookSpecificOutput`, fails validation and the block becomes a NON-blocking error.
  assert(Object.keys(out.json).join(',') === 'hookSpecificOutput', 'unexpected fields at the top');
  assert(
    Object.keys(out.json.hookSpecificOutput).sort().join(',') ===
      'hookEventName,permissionDecision,permissionDecisionReason',
    'unexpected fields in the decision',
  );
});

check('empty stdin blocks nothing', () => {
  assertAllow(run(''));
});

check('unreadable stdin denies (fail-closed)', () => {
  const out = run('this is not json');
  assert(
    out.json?.hookSpecificOutput?.permissionDecision === 'deny',
    'did not deny an unreadable payload',
  );
  assert(out.status === 2, `exit ${out.status} - fail-closed needs exit 2`);
});

// --- configuration through command line arguments (the settings.json path) --------------------

check('--paths= replaces the default list', () => {
  assertDeny(
    runArgs({ toolName: 'write', toolArgs: { path: 'docker-compose.yml', content: 'x' } }, [
      '--paths=docker-compose.yml',
    ]),
    'docker-compose.yml',
  );
});

check('--paths= through an argument turns the defaults off', () => {
  assertAllow(
    runArgs({ toolName: 'write', toolArgs: { path: 'jest.config.js', content: 'x' } }, [
      '--paths=docker-compose.yml',
    ]),
  );
});

check('--allow= opens an exception inside --paths=', () => {
  assertAllow(
    runArgs({ toolName: 'write', toolArgs: { path: 'jest.config.js', content: 'x' } }, [
      '--paths=jest.config.*',
      '--allow=jest.config.js',
    ]),
  );
});

check('--message= goes into the refusal reason', () => {
  const out = runArgs({ toolName: 'write', toolArgs: { path: 'jest.config.js', content: 'x' } }, [
    '--message=Talk to the platform team.',
  ]);
  assertDeny(out, 'jest.config.js');
  assert(
    reasonOf(out).includes('Talk to the platform team.'),
    'extra message missing from the reason',
  );
});

check('the argument takes priority over the env var', () => {
  assertDeny(
    runArgs(
      { toolName: 'write', toolArgs: { path: 'docker-compose.yml', content: 'x' } },
      ['--paths=docker-compose.yml'],
      { PROTECT_FILES_PATHS: 'jest.config.*' },
    ),
    'docker-compose.yml',
  );
});

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  process.stdout.write(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : ` -> ${r.message}`}\n`);
}
process.stdout.write(`\n${results.length - failed.length}/${results.length} passed\n`);
process.exitCode = failed.length === 0 ? 0 : 1;
