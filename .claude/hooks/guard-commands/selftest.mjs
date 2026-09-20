#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./guard-commands.mjs', import.meta.url));

// why: the checks below are written in the short form (`toolName`/`toolArgs`), which is shorter
// to read. This translation rewrites them into Claude Code's real format before they reach the
// hook, so the whole suite exercises the production path without any check having to repeat the
// payload envelope. The checks that send `toolCalls` are left untouched on purpose: they cover
// the batch payload support.
function toClaudePayload(payload) {
  if (typeof payload === 'string' || payload === null || typeof payload !== 'object')
    return payload;
  if (payload.toolCalls !== undefined || payload.tool_calls !== undefined) return payload;
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

function bash(command, env) {
  return run({ toolName: 'bash', toolArgs: { command } }, env);
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

function assertDeny(out, expectedRule) {
  assert(out.status === 2, `exit ${out.status} (expected 2 = deny on PreToolUse)`);
  assert(out.json !== null, 'did not deny: empty stdout');
  assert(out.stderr.includes('[guard-commands]'), 'reason missing from stderr');
  // hazard: in Claude Code the decision MUST be inside `hookSpecificOutput`. At the top of the
  // object it fails schema validation and becomes a non-blocking error - the command goes through.
  const hso = out.json.hookSpecificOutput ?? {};
  assert(hso.hookEventName === 'PreToolUse', `hookEventName ${hso.hookEventName}`);
  assert(
    out.json.permissionDecision === undefined,
    'a decision at the top of the object fails the schema',
  );
  assert(hso.permissionDecision === 'deny', `decision ${hso.permissionDecision}`);
  const reason = hso.permissionDecisionReason ?? '';
  assert(reason.includes('[guard-commands]'), 'reason without the hook prefix');
  if (expectedRule)
    assert(reason.includes(expectedRule), `reason does not quote the rule ${expectedRule}`);
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

// --- blocking the default destructive commands ---------------------------------------------

check('git push is denied', () => {
  assertDeny(bash('git push'), 'git push');
});

check('git push --force is denied', () => {
  assertDeny(bash('git push --force origin main'), 'git push');
});

check('git push -f is denied', () => {
  assertDeny(bash('git push -f'));
});

check('git push --force-with-lease is denied', () => {
  assertDeny(bash('git push --force-with-lease origin HEAD'));
});

check('git reset --hard is denied', () => {
  assertDeny(bash('git reset --hard HEAD~1'), 'git reset --hard');
});

check('git clean -fd is denied (joined flags)', () => {
  assertDeny(bash('git clean -fd'), 'git clean -f');
});

check('rm -rf is denied', () => {
  assertDeny(bash('rm -rf /workspace/dist'), 'rm -rf');
});

check('rm -r -f separated is denied too', () => {
  assertDeny(bash('rm -r -f dist'));
});

check('npm publish is denied', () => {
  assertDeny(bash('npm publish --access public'), 'npm publish');
});

check('powershell Remove-Item -Recurse -Force is denied', () => {
  assertDeny(
    run({ toolName: 'powershell', toolArgs: { command: 'Remove-Item -Recurse -Force .\\dist' } }),
  );
});

check('git branch -D is denied', () => {
  assertDeny(bash('git branch -D feature/x'), 'git branch -D');
});

check('git branch -d (safe) passes', () => {
  assertAllow(bash('git branch -d feature/x'));
});

// --- workarounds -----------------------------------------------------------------------------

check('git push after && is denied', () => {
  assertDeny(bash('npm test && git push'));
});

check('git push after ; is denied', () => {
  assertDeny(bash('npm run build ; git push origin main'));
});

check('git push inside bash -c is denied', () => {
  assertDeny(bash('bash -c "git push --force"'));
});

check('git push with sudo/wrapper is denied', () => {
  assertDeny(bash('sudo git push'));
});

check('git push with -c before the subcommand is denied', () => {
  assertDeny(bash('git -c user.name=bot push origin main'));
});

check('git push inside a subshell is denied', () => {
  assertDeny(bash('cd repo && (git push)'));
});

check('echo piped into a shell is denied', () => {
  assertDeny(bash('echo "git push" | bash'));
});

check('git push inside an inline npm script is denied', () => {
  assertDeny(
    run({ toolName: 'bash', toolArgs: { command: 'npm run deploy', script: 'git push --tags' } }),
  );
});

check('exec + args is reassembled before deciding', () => {
  assertDeny(run({ toolName: 'bash', toolArgs: { exec: 'git', args: ['push', '--force'] } }));
});

// --- what must keep passing -------------------------------------------------------------------

check('git status passes', () => {
  assertAllow(bash('git status --short'));
});

check('git commit passes', () => {
  assertAllow(bash('git commit -m "feat: new route"'));
});

check('git commit -m containing the word push passes', () => {
  assertAllow(bash('git commit -m "prepare manual push"'));
});

check('git pull passes', () => {
  assertAllow(bash('git pull --rebase'));
});

check('npm test passes', () => {
  assertAllow(bash('npm test'));
});

check('plain rm (without -rf) passes', () => {
  assertAllow(bash('rm dist/index.js'));
});

check('echo mentioning git push passes', () => {
  assertAllow(bash('echo "the human has to run git push afterwards"'));
});

check('git push --dry-run passes (default allow)', () => {
  assertAllow(bash('git push --dry-run origin main'));
});

check('a write tool is not analyzed by this hook', () => {
  assertAllow(
    run({
      toolName: 'create',
      toolArgs: { path: 'docs/deploy.md', file_text: 'Run `git push --force` manually.' },
    }),
  );
});

check('a read tool passes', () => {
  assertAllow(run({ toolName: 'view', toolArgs: { path: 'README.md' } }));
});

// --- batch payload: toolCalls[] with args as a JSON string ------------------------------------
// why: a runtime may deliver several calls in a single invocation, with `args` packed as a JSON
// string. Reading only `tool_name`/`tool_input` would make the hook allow that batch in silence.

function batched(name, args, extraArgs = []) {
  return runArgs(
    {
      sessionId: '1016eb14-5a5d-46b4-a8bd-d9daa6194b11',
      cwd: 'c:\\repo',
      toolCalls: [{ id: 'call_lm0kC49RbaBwqE20Dh99lC1m', name, args: JSON.stringify(args) }],
    },
    extraArgs,
  );
}

check('the toolCalls[] format with args as a JSON string is denied', () => {
  assertDeny(
    // hazard: `npm install` is on no rule by default - the rule comes in through the argument.
    // What this check proves is not the rule, but that `args` arriving as a JSON STRING is
    // unpacked before the analysis; without that the command would slip through.
    batched(
      'powershell',
      {
        command: 'npm install',
        description: 'Installs the project dependencies',
        mode: 'sync',
        initial_wait: 120,
      },
      ['--deny=npm install'],
    ),
    'npm install',
  );
});

check('the toolCalls[] format allows an ordinary command', () => {
  assertAllow(batched('powershell', { command: 'npm test', description: 'Runs the tests' }));
});

check('the toolCalls[] format ignores a read tool', () => {
  assertAllow(batched('rg', { pattern: 'git push', paths: ['docs/deploy.md'] }));
});

check('batch of toolCalls: one blocked command is enough', () => {
  assertDeny(
    run({
      sessionId: 'batch',
      toolCalls: [
        { id: 'a', name: 'powershell', args: JSON.stringify({ command: 'git status' }) },
        { id: 'b', name: 'powershell', args: JSON.stringify({ command: 'git push --force' }) },
      ],
    }),
  );
});

check('args already as an object works too', () => {
  assertDeny(run({ toolCalls: [{ name: 'bash', args: { command: 'git reset --hard' } }] }));
});

check('a snake_case payload (VS Code) is denied too', () => {
  assertDeny(
    run({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'git push --force', description: 'Send commits' },
    }),
  );
});

check('a description alone does not trigger a block', () => {
  assertAllow(
    run({
      toolName: 'Bash',
      toolArgs: { command: 'git log --oneline -5', description: 'Check before the git push' },
    }),
  );
});

// --- configuration through env -----------------------------------------------------------------

check('a custom GUARD_COMMANDS_DENY blocks another command', () => {
  assertDeny(bash('docker compose down -v', { GUARD_COMMANDS_DENY: 'docker compose down' }));
});

check('a custom GUARD_COMMANDS_DENY frees the defaults', () => {
  assertAllow(bash('git push --force', { GUARD_COMMANDS_DENY: 'docker compose down' }));
});

check('GUARD_COMMANDS_ALLOW opens an exception', () => {
  assertAllow(
    bash('git push origin refs/notes/*', { GUARD_COMMANDS_ALLOW: 'git push origin refs/*' }),
  );
});

check('an empty GUARD_COMMANDS_ALLOW closes even the dry-run', () => {
  assertDeny(bash('git push --dry-run', { GUARD_COMMANDS_ALLOW: '' }));
});

check('a wildcard in the rule works', () => {
  assertDeny(bash('terraform destroy -auto-approve', { GUARD_COMMANDS_DENY: 'terraform destr*' }));
});

// --- output contract ---------------------------------------------------------------------------

check('the reason says the command is destructive and did not run', () => {
  const reason = reasonOf(bash('git push'));
  assert(reason.includes('destructive'), 'the reason does not classify the command as destructive');
  assert(reason.includes('nothing changed'), 'the reason does not make clear nothing was executed');
});

check('the reason tells the agent to report command and reason to the human', () => {
  const reason = reasonOf(bash('git push'));
  assert(reason.includes('human'), 'the reason does not tell the agent to involve the human');
  assert(reason.includes('exact command'), 'the reason does not ask for the exact command tried');
  assert(reason.includes('why'), 'the reason does not ask for the reason behind the attempt');
  assert(reason.includes('manually'), 'the reason does not say the human runs it manually');
});

check('the reason quotes the attempted command', () => {
  const reason = reasonOf(bash('git push --force origin main'));
  assert(
    reason.includes('git push --force origin main'),
    'the reason does not quote the attempted command',
  );
});

check('the output is a single JSON object, all inside hookSpecificOutput', () => {
  const out = bash('git push');
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

check('--deny= replaces the default list', () => {
  const out = runArgs({ toolName: 'bash', toolArgs: { command: 'docker compose down -v' } }, [
    '--deny=docker compose down -v',
  ]);
  assertDeny(out, 'docker compose down -v');
});

check('--deny= through an argument turns the default rules off', () => {
  assertAllow(
    runArgs({ toolName: 'bash', toolArgs: { command: 'git push' } }, ['--deny=npm publish']),
  );
});

check('--allow= beats the deny list', () => {
  assertAllow(
    runArgs({ toolName: 'bash', toolArgs: { command: 'git push --dry-run origin main' } }, [
      '--allow=git push --dry-run',
    ]),
  );
});

check('an empty --allow= means no exception, not the default', () => {
  assertDeny(
    runArgs({ toolName: 'bash', toolArgs: { command: 'git push --dry-run' } }, ['--allow=']),
    'git push',
  );
});

check('the argument takes priority over the env var', () => {
  const out = runArgs(
    { toolName: 'bash', toolArgs: { command: 'npm publish' } },
    ['--deny=npm publish'],
    { GUARD_COMMANDS_DENY: 'git push' },
  );
  assertDeny(out, 'npm publish');
});

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  process.stdout.write(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : ` -> ${r.message}`}\n`);
}
process.stdout.write(`\n${results.length - failed.length}/${results.length} passed\n`);
process.exitCode = failed.length === 0 ? 0 : 1;
