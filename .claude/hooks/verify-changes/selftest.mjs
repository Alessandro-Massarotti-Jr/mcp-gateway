#!/usr/bin/env node

// Suite for the verify-changes hook. It runs against a disposable fixture project in
// os.tmpdir(), never against the real repo - the fixture's "commands" are millisecond-long
// `node -e` calls, so the suite exercises the state machine without paying for a real
// lint/build/test.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./verify-changes.mjs', import.meta.url));

const OK_SCRIPT = 'node -e "0"';
const FAIL_SCRIPT = 'node -e "console.error(\'boom on rule X\');process.exit(1)"';

let counter = 0;

function makeFixture(scripts) {
  counter += 1;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `verify-changes-${counter}-`));
  fs.mkdirSync(path.join(root, 'src', 'nested'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(root, 'src', 'nested', 'b.ts'), 'export const b = 2;\n');
  fs.writeFileSync(path.join(root, 'other.ts'), 'export const c = 3;\n');
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'fixture', version: '1.0.0', scripts }, null, 2),
  );
  return { root, stateDir: path.join(root, '.state'), sessionId: `s-${counter}` };
}

function touch(fixture, relFile, content) {
  const file = path.join(fixture.root, relFile);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function run(fixture, event, env = {}, payloadOverride = null) {
  // why: a payload in Claude Code's format - `session_id`/`hook_event_name`, `reason` on
  // SessionStart and `last_assistant_message` on Stop. `--event=` is still passed as a second
  // source, which is the manual run path of the script.
  const payload = payloadOverride ?? {
    session_id: fixture.sessionId,
    transcript_path: 'x',
    cwd: fixture.root,
    permission_mode: 'default',
    ...(event === 'sessionStart'
      ? { hook_event_name: 'SessionStart', reason: 'startup' }
      : {
          hook_event_name: 'Stop',
          stop_hook_active: false,
          last_assistant_message: 'done',
        }),
  };
  const proc = spawnSync(process.execPath, [SCRIPT, `--event=${event}`], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
    env: {
      ...process.env,
      VERIFY_CHANGES_STATE_DIR: fixture.stateDir,
      VERIFY_CHANGES_PATHS: 'src',
      VERIFY_CHANGES_FORMAT: '',
      ...env,
    },
  });
  if (proc.error) throw proc.error;
  const stdout = proc.stdout.trim();
  return {
    status: proc.status,
    stdout,
    stderr: proc.stderr,
    json: stdout === '' ? null : JSON.parse(stdout),
  };
}

const stop = (fixture, env) => run(fixture, 'agentStop', env);
const start = (fixture, env) => run(fixture, 'sessionStart', env);

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

function assertBlock(out) {
  assert(out.json !== null, `did not block: empty stdout (exit ${out.status})`);
  assert(out.json.decision === 'block', `decision ${out.json.decision}`);
  const reason = out.json.reason ?? '';
  assert(reason.includes('[verify-changes]'), 'reason without the hook prefix');
  // hazard: with exit 2 Stop also blocks, but the message then comes from stderr and the turn is
  // marked as a hook error. With exit 0 the `reason` reaches the agent clean.
  assert(out.status === 0, `exit ${out.status} - a block only counts with exit 0`);
  // hazard: the reason must NOT be mirrored on stderr, which with exit 0 only goes to the debug
  // log - duplicating it there is just noise and hides which channel the agent read from.
  assert(
    !out.stderr.includes('[verify-changes]'),
    `stderr must not carry the reason, it came with: ${out.stderr}`,
  );
  return reason;
}

// hazard: `{ decision: 'allow' }` does NOT exist in the Stop schema - the object fails validation
// and the turn picks up a "hook error" warning for nothing. Allowing on Stop is sending no
// `decision` at all.
//
// why: even when allowing, the hook answers with JSON carrying a `systemMessage`. Total silence
// does not tell a live hook from a dead one, and `systemMessage` on Stop only goes to the debug
// log.
function assertAllow(out) {
  assert(out.status === 0, `exit ${out.status} (expected 0)`);
  assert(out.json !== null, 'decided nothing: empty stdout');
  assert(out.json.decision === undefined, `allowed with decision: ${out.json.decision}`);
  assert(
    out.json.reason === undefined,
    'allow must not carry a `reason` - it continues the conversation',
  );
  assert(
    out.json.hookSpecificOutput?.additionalContext === undefined,
    'allow must not carry `additionalContext` - it continues the conversation too',
  );
}

// --- trigger: only runs when something changed in the watched paths ------------------------

check('with no change in src no command runs', () => {
  const fixture = makeFixture({ lint: OK_SCRIPT });
  const env = { VERIFY_CHANGES_COMMANDS: 'lint', VERIFY_CHANGES_NOTIFY: 'on-run' };
  start(fixture, env);
  assertAllow(stop(fixture, env));
});

check('a change in src triggers the verification', () => {
  const fixture = makeFixture({ lint: OK_SCRIPT });
  start(fixture);
  touch(fixture, 'src/a.ts', 'export const a = 99;\n');
  const reason = assertBlock(stop(fixture, { VERIFY_CHANGES_COMMANDS: 'lint' }));
  assert(reason.includes('npm run lint'), 'the report does not quote the command that ran');
  assert(reason.includes('OK'), 'the report does not mark the command as OK');
});

check('a new file in src triggers the verification', () => {
  const fixture = makeFixture({ lint: OK_SCRIPT });
  start(fixture);
  touch(fixture, 'src/nested/c.ts', 'export const c = 1;\n');
  assertBlock(stop(fixture, { VERIFY_CHANGES_COMMANDS: 'lint' }));
});

check('a change OUTSIDE src triggers nothing', () => {
  const fixture = makeFixture({ lint: OK_SCRIPT });
  const env = { VERIFY_CHANGES_COMMANDS: 'lint', VERIFY_CHANGES_NOTIFY: 'on-run' };
  start(fixture, env);
  touch(fixture, 'other.ts', 'export const c = 999;\n');
  touch(fixture, 'README.md', '# doc\n');
  assertAllow(stop(fixture, env));
});

check('a rewrite with the same content does not count as a change', () => {
  const fixture = makeFixture({ lint: OK_SCRIPT });
  const env = { VERIFY_CHANGES_COMMANDS: 'lint', VERIFY_CHANGES_NOTIFY: 'on-run' };
  start(fixture, env);
  // hazard: this is what `format` does - it touches the mtime without changing anything. If the
  // trigger were the mtime, the hook would fire itself in a loop after every formatting run.
  touch(fixture, 'src/a.ts', 'export const a = 1;\n');
  assertAllow(stop(fixture, env));
});

check('a path configured as /src is normalized', () => {
  const fixture = makeFixture({ lint: OK_SCRIPT });
  const env = { VERIFY_CHANGES_PATHS: '/src', VERIFY_CHANGES_COMMANDS: 'lint' };
  start(fixture, env);
  touch(fixture, 'src/a.ts', 'export const a = 42;\n');
  assertBlock(stop(fixture, env));
});

check('configurable path: watching another folder leaves src free', () => {
  const fixture = makeFixture({ lint: OK_SCRIPT });
  const env = {
    VERIFY_CHANGES_PATHS: 'app',
    VERIFY_CHANGES_COMMANDS: 'lint',
    VERIFY_CHANGES_NOTIFY: 'on-run',
  };
  start(fixture, env);
  touch(fixture, 'src/a.ts', 'export const a = 7;\n');
  assertAllow(stop(fixture, env));
  touch(fixture, 'app/x.ts', 'export const x = 1;\n');
  assertBlock(stop(fixture, env));
});

// --- execution: runs all of them, reports each one -----------------------------------------

check('runs ALL commands even with a failure in the middle', () => {
  const fixture = makeFixture({ lint: FAIL_SCRIPT, build: OK_SCRIPT });
  start(fixture);
  touch(fixture, 'src/a.ts', 'export const a = 2;\n');
  const reason = assertBlock(stop(fixture, { VERIFY_CHANGES_COMMANDS: 'lint,build' }));
  assert(/npm run lint\s+->\s+FAILED/.test(reason), 'lint does not show up as FAILED');
  assert(/npm run build\s+->\s+OK/.test(reason), 'build did not run after the lint failure');
});

check('the failure comes with an exit code and an excerpt of the output', () => {
  const fixture = makeFixture({ lint: FAIL_SCRIPT });
  start(fixture);
  touch(fixture, 'src/a.ts', 'export const a = 3;\n');
  const reason = assertBlock(stop(fixture, { VERIFY_CHANGES_COMMANDS: 'lint' }));
  assert(reason.includes('exit 1'), 'the reason does not carry the exit code');
  assert(reason.includes('boom on rule X'), 'the reason does not carry the failing command output');
});

check('format runs before the other commands', () => {
  const fixture = makeFixture({ format: OK_SCRIPT, lint: OK_SCRIPT });
  start(fixture);
  touch(fixture, 'src/a.ts', 'export const a = 4;\n');
  const reason = assertBlock(
    stop(fixture, { VERIFY_CHANGES_FORMAT: 'format', VERIFY_CHANGES_COMMANDS: 'lint' }),
  );
  assert(
    reason.indexOf('npm run format') < reason.indexOf('npm run lint'),
    'format does not appear before lint in the report',
  );
});

// --- a missing script: reports, but does not block ------------------------------------------

check('a script missing from package.json does not block the agent, it only reports', () => {
  const fixture = makeFixture({ lint: OK_SCRIPT });
  start(fixture);
  touch(fixture, 'src/a.ts', 'export const a = 5;\n');
  const reason = assertBlock(stop(fixture, { VERIFY_CHANGES_COMMANDS: 'lint,test' }));
  assert(
    reason.includes('does not exist in package.json'),
    'the reason does not explain the missing script',
  );
  assert(reason.includes('"test"'), 'the reason does not name the missing script');
  assert(reason.includes('NO failures'), 'a missing script was treated as a failure');
  assert(!reason.includes('attempt'), 'a missing script entered the fix cycle');
});

check('only missing scripts: the report goes out and the cycle ends', () => {
  const fixture = makeFixture({});
  start(fixture);
  touch(fixture, 'src/a.ts', 'export const a = 6;\n');
  const reason = assertBlock(stop(fixture, { VERIFY_CHANGES_COMMANDS: 'lint,build,test' }));
  assert(reason.includes('NO failures'), 'it should end with no failures');
  assertAllow(stop(fixture, { VERIFY_CHANGES_COMMANDS: 'lint,build,test' }));
});

// --- the mandatory final report ---------------------------------------------------------------

check('success blocks ONCE so the agent reports, and allows right after', () => {
  const fixture = makeFixture({ lint: OK_SCRIPT });
  start(fixture);
  touch(fixture, 'src/a.ts', 'export const a = 8;\n');
  const reason = assertBlock(stop(fixture, { VERIFY_CHANGES_COMMANDS: 'lint' }));
  assert(
    reason.includes('final answer to the user'),
    'it does not require the report in the final answer',
  );
  assertAllow(stop(fixture, { VERIFY_CHANGES_COMMANDS: 'lint' }));
});

// --- a notice at every end of turn (NOTIFY) ---------------------------------------------------

check('with no change the hook reports that nothing ran and why', () => {
  const fixture = makeFixture({ lint: OK_SCRIPT, build: OK_SCRIPT });
  const env = { VERIFY_CHANGES_COMMANDS: 'lint,build' };
  start(fixture, env);
  const reason = assertBlock(stop(fixture, env));
  assert(reason.includes('NO command was run'), 'it does not say nothing ran');
  assert(reason.includes('nothing changed in src'), 'it does not explain the reason');
  assert(reason.includes('npm run lint, npm run build'), 'it does not list what would run');
  assert(reason.includes('do not redo anything'), 'it does not stop the agent from redoing work');
});

check('the "did not run" notice does not feed itself', () => {
  const fixture = makeFixture({ lint: OK_SCRIPT });
  const env = { VERIFY_CHANGES_COMMANDS: 'lint' };
  start(fixture, env);
  // hazard: the turn that DELIVERS the notice also ends in agentStop with no change at all.
  // Without the justReported guard that becomes notice -> turn -> notice until MAX_BLOCKS.
  assertBlock(stop(fixture, env));
  assertAllow(stop(fixture, env));
  assertBlock(stop(fixture, env));
  assertAllow(stop(fixture, env));
});

check('NOTIFY=on-run silences the notice when nothing ran, but keeps the success one', () => {
  const fixture = makeFixture({ lint: OK_SCRIPT });
  const env = { VERIFY_CHANGES_COMMANDS: 'lint', VERIFY_CHANGES_NOTIFY: 'on-run' };
  start(fixture, env);
  assertAllow(stop(fixture, env));
  touch(fixture, 'src/a.ts', 'export const a = 20;\n');
  assert(assertBlock(stop(fixture, env)).includes('NO failures'), 'lost the success report');
});

check('NOTIFY=on-error only speaks when some verification fails', () => {
  const fixture = makeFixture({ lint: OK_SCRIPT });
  const env = { VERIFY_CHANGES_COMMANDS: 'lint', VERIFY_CHANGES_NOTIFY: 'on-error' };
  start(fixture, env);
  assertAllow(stop(fixture, env));
  touch(fixture, 'src/a.ts', 'export const a = 21;\n');
  assertAllow(stop(fixture, env));

  const failing = makeFixture({ lint: FAIL_SCRIPT });
  const failEnv = { VERIFY_CHANGES_COMMANDS: 'lint', VERIFY_CHANGES_NOTIFY: 'on-error' };
  start(failing, failEnv);
  touch(failing, 'src/a.ts', 'export const a = 22;\n');
  assert(
    assertBlock(stop(failing, failEnv)).includes('WITH FAILURES'),
    'it did not report the failure',
  );
});

check('every report states explicitly whether the verification ran', () => {
  const fixture = makeFixture({ lint: FAIL_SCRIPT });
  const env = { VERIFY_CHANGES_COMMANDS: 'lint' };
  start(fixture, env);
  assert(
    assertBlock(stop(fixture, env)).includes('Verification status'),
    'notice without a status',
  );
  touch(fixture, 'src/a.ts', 'export const a = 23;\n');
  assert(
    assertBlock(stop(fixture, env)).includes('Verification status'),
    'failure without a status',
  );
});

// --- the stop criteria -------------------------------------------------------------------------

check('a persistent failure stops after MAX_ATTEMPTS and asks for a report', () => {
  const fixture = makeFixture({ lint: FAIL_SCRIPT });
  const env = { VERIFY_CHANGES_COMMANDS: 'lint', VERIFY_CHANGES_MAX_ATTEMPTS: '3' };
  start(fixture);
  touch(fixture, 'src/a.ts', 'export const a = 9;\n');

  const first = assertBlock(stop(fixture, env));
  assert(first.includes('attempt 1 of 3'), `attempt 1 not announced: ${first.slice(0, 120)}`);

  // why: the agent ends the turn WITHOUT fixing anything - the gate has to stay up regardless.
  const second = assertBlock(stop(fixture, env));
  assert(second.includes('attempt 2 of 3'), 'attempt 2 not announced');

  const third = assertBlock(stop(fixture, env));
  assert(third.includes('STOP trying to fix it'), 'it did not end the cycle on the last attempt');
  assert(third.includes('will not block again'), 'it does not say the gate stopped');
  assert(third.includes('FAILED'), 'the final report has no command results');

  // the loop is over: with the failure still standing, the agent can deliver the answer
  assertAllow(stop(fixture, env));
});

check('MAX_ATTEMPTS=1 ends the cycle on the very first block', () => {
  const fixture = makeFixture({ lint: FAIL_SCRIPT });
  const env = { VERIFY_CHANGES_COMMANDS: 'lint', VERIFY_CHANGES_MAX_ATTEMPTS: '1' };
  start(fixture);
  touch(fixture, 'src/a.ts', 'export const a = 10;\n');
  assert(
    assertBlock(stop(fixture, env)).includes('STOP trying to fix it'),
    'it did not end the cycle',
  );
  assertAllow(stop(fixture, env));
});

check('an exhausted time budget ends the cycle', () => {
  const fixture = makeFixture({ lint: FAIL_SCRIPT });
  const env = {
    VERIFY_CHANGES_COMMANDS: 'lint',
    VERIFY_CHANGES_MAX_ATTEMPTS: '9',
    VERIFY_CHANGES_BUDGET_SEC: '0.001',
  };
  start(fixture);
  touch(fixture, 'src/a.ts', 'export const a = 11;\n');
  const reason = assertBlock(stop(fixture, env));
  assert(reason.includes('time budget exhausted'), 'it does not mention the time overrun');
  assertAllow(stop(fixture, env));
});

check('the absolute block cap disarms the hook', () => {
  const fixture = makeFixture({ lint: FAIL_SCRIPT });
  const env = {
    VERIFY_CHANGES_COMMANDS: 'lint',
    VERIFY_CHANGES_MAX_ATTEMPTS: '99',
    VERIFY_CHANGES_MAX_BLOCKS: '2',
  };
  start(fixture);
  touch(fixture, 'src/a.ts', 'export const a = 12;\n');
  assertBlock(stop(fixture, env));
  assertBlock(stop(fixture, env));

  // why: disarming quietly would leave the session looking verified when it no longer is - the
  // notice costs one block beyond the cap (3 here), still below the runtime's 8.
  const reason = assertBlock(stop(fixture, env));
  assert(reason.includes('DISARMED ITSELF'), 'it did not warn that the gate disarmed');
  assert(reason.includes('run the commands by hand'), 'it does not say what the user loses');

  assertAllow(stop(fixture, env));
  assertAllow(stop(fixture, env));
});

check('a broken hook warns the user once and then stays quiet', () => {
  const fixture = makeFixture({ lint: OK_SCRIPT });
  const env = { VERIFY_CHANGES_COMMANDS: 'lint' };
  // hazard: a non-string cwd makes path.resolve throw deep inside - it is the way to exercise
  // the internal failure path without putting a test hook in the production code.
  const broken = { sessionId: 'broken', cwd: 12345, stopReason: 'end_turn' };

  const reason = assertBlock(run(fixture, 'agentStop', env, broken));
  assert(reason.includes('BROKE'), 'it did not warn that the hook failed');
  assert(reason.includes('were NOT run'), 'it does not make clear nothing ran');

  // why: the fault is the hook's own - insisting on the notice at every end of turn would loop.
  assertAllow(run(fixture, 'agentStop', env, broken));
  assertAllow(run(fixture, 'agentStop', env, broken));
});

check('a varying sessionId does not fragment the state (the key is the cwd)', () => {
  const fixture = makeFixture({ lint: FAIL_SCRIPT });
  const env = { VERIFY_CHANGES_COMMANDS: 'lint', VERIFY_CHANGES_MAX_ATTEMPTS: '3' };
  start(fixture, env);
  touch(fixture, 'src/a.ts', 'export const a = 40;\n');

  // hazard: the id arriving on each event may diverge. With the sessionId in the state key,
  // every end of turn opened a new file and the counter stayed stuck at "1 of 3".
  const at = (sessionId) =>
    run(fixture, 'agentStop', env, { sessionId, cwd: fixture.root, stopReason: 'end_turn' });

  assert(assertBlock(at('real-session')).includes('attempt 1 of 3'), 'first attempt not announced');
  assert(
    assertBlock(at('call_S2a2584krvQiQjfrF3TS7dnA')).includes('attempt 2 of 3'),
    'a tool call id opened a new counter instead of continuing the session one',
  );
  assert(
    assertBlock(at('call_9EzH1Aog62qdiaMKVoNJPmWx')).includes('STOP trying to fix it'),
    'the cycle did not reach its end with different sessionIds',
  );
});

check('stop_hook_active without state of its own limits the hook to one last block', () => {
  const fixture = makeFixture({ lint: FAIL_SCRIPT });
  const env = { VERIFY_CHANGES_COMMANDS: 'lint', VERIFY_CHANGES_MAX_ATTEMPTS: '9' };
  touch(fixture, 'src/a.ts', 'export const a = 30;\n');
  // hazard: with no sessionStart there is no state - and the runtime is saying the turn was
  // ALREADY forced to continue. Counting from zero here would stack our blocks on top of the
  // ones it already granted.
  const forced = {
    sessionId: fixture.sessionId,
    cwd: fixture.root,
    stopReason: 'end_turn',
    stop_hook_active: true,
  };
  assertBlock(run(fixture, 'agentStop', env, forced));
  // why: the next end of turn already hits the cap - and the disarm announces itself before
  // going quiet.
  assert(
    assertBlock(run(fixture, 'agentStop', env, forced)).includes('DISARMED ITSELF'),
    'it disarmed without warning',
  );
  assertAllow(run(fixture, 'agentStop', env, forced));
});

check('without stop_hook_active the block counter starts from zero', () => {
  const fixture = makeFixture({ lint: FAIL_SCRIPT });
  const env = { VERIFY_CHANGES_COMMANDS: 'lint', VERIFY_CHANGES_MAX_ATTEMPTS: '9' };
  touch(fixture, 'src/a.ts', 'export const a = 31;\n');
  assertBlock(stop(fixture, env));
  assertBlock(stop(fixture, env));
  assertBlock(stop(fixture, env));
});

// --- fail-open and edge cases ------------------------------------------------------------------

check('empty stdin decides nothing', () => {
  const fixture = makeFixture({ lint: OK_SCRIPT });
  const proc = spawnSync(process.execPath, [SCRIPT, '--event=agentStop'], {
    input: '',
    encoding: 'utf8',
    env: { ...process.env, VERIFY_CHANGES_STATE_DIR: fixture.stateDir },
  });
  assert(proc.status === 0, `exit ${proc.status}`);
  assert(proc.stdout.trim() === '', 'answered something without a payload');
});

check('an unreadable payload is fail-open (it does not block the end of turn)', () => {
  const fixture = makeFixture({ lint: OK_SCRIPT });
  const out = run(fixture, 'agentStop', { VERIFY_CHANGES_COMMANDS: 'lint' }, 'not-json');
  assertAllow(out);
});

check('without package.json the hook verifies nothing, but reports', () => {
  const fixture = makeFixture({ lint: OK_SCRIPT });
  start(fixture);
  touch(fixture, 'src/a.ts', 'export const a = 13;\n');
  fs.rmSync(path.join(fixture.root, 'package.json'));
  const reason = assertBlock(stop(fixture, { VERIFY_CHANGES_COMMANDS: 'lint' }));
  assert(reason.includes('NO command was run'), 'it does not report that nothing ran');
  assert(reason.includes('package.json'), 'it does not explain the reason');
});

check('without package.json and with NOTIFY=on-run the hook stays inert', () => {
  const fixture = makeFixture({ lint: OK_SCRIPT });
  const env = { VERIFY_CHANGES_COMMANDS: 'lint', VERIFY_CHANGES_NOTIFY: 'on-run' };
  start(fixture, env);
  touch(fixture, 'src/a.ts', 'export const a = 13;\n');
  fs.rmSync(path.join(fixture.root, 'package.json'));
  assertAllow(stop(fixture, env));
});

check('an empty command list turns the gate off', () => {
  const fixture = makeFixture({ lint: OK_SCRIPT });
  const env = { VERIFY_CHANGES_COMMANDS: '', VERIFY_CHANGES_FORMAT: '' };
  start(fixture, env);
  touch(fixture, 'src/a.ts', 'export const a = 14;\n');
  assertAllow(stop(fixture, env));
});

check('with no baseline (resumed session) it falls back to git and does not blow up', () => {
  const fixture = makeFixture({ lint: OK_SCRIPT });
  // why: no sessionStart ran - this is the case of a hook installed mid-session.
  touch(fixture, 'src/a.ts', 'export const a = 15;\n');
  const out = stop(fixture, { VERIFY_CHANGES_COMMANDS: 'lint' });
  assert(out.status === 0 || out.status === 2, `unexpected exit ${out.status}`);
  if (out.json !== null) assert(out.json.decision === 'block', 'unexpected decision');
});

// --- sessionStart -------------------------------------------------------------------------------

check('sessionStart tells the agent about the gate', () => {
  const fixture = makeFixture({ lint: OK_SCRIPT });
  const out = start(fixture, { VERIFY_CHANGES_COMMANDS: 'lint,build' });
  assert(out.status === 0, `exit ${out.status}`);
  assert(out.json !== null, 'sessionStart injected no context');
  // hazard: in Claude Code the SessionStart `additionalContext` lives INSIDE
  // `hookSpecificOutput`. At the top of the object it fails schema validation and the notice
  // never reaches the agent - the session starts without knowing a gate exists at the end.
  assert(
    out.json.additionalContext === undefined,
    'context at the top of the object fails the schema',
  );
  const context = out.json.hookSpecificOutput?.additionalContext ?? '';
  assert(context.includes('npm run lint'), 'the context does not list the commands');
  assert(context.includes('src'), 'the context does not name the watched path');
});

check('sessionStart resets the attempts of a previous session', () => {
  const fixture = makeFixture({ lint: FAIL_SCRIPT });
  const env = { VERIFY_CHANGES_COMMANDS: 'lint', VERIFY_CHANGES_MAX_ATTEMPTS: '1' };
  start(fixture, env);
  touch(fixture, 'src/a.ts', 'export const a = 16;\n');
  assertBlock(stop(fixture, env));
  assertAllow(stop(fixture, env));

  start(fixture, env);
  touch(fixture, 'src/a.ts', 'export const a = 17;\n');
  assertBlock(stop(fixture, env));
});

// --- the SessionStart contract in Claude Code -------------------------------------------------

check('sessionStart: the notice goes out in hookSpecificOutput.additionalContext', () => {
  const fixture = makeFixture({ lint: OK_SCRIPT });
  const out = start(fixture, { VERIFY_CHANGES_COMMANDS: 'lint' });
  assert(out.status === 0, `exit ${out.status}`);
  const hso = out.json?.hookSpecificOutput ?? {};
  assert(hso.hookEventName === 'SessionStart', `hookEventName ${hso.hookEventName}`);
  assert(
    out.json.additionalContext === undefined,
    'a notice at the top of the object fails schema validation',
  );
  const note = hso.additionalContext ?? '';
  assert(note.includes('[verify-changes]'), 'notice without the hook prefix');
  assert(note.includes('npm run lint'), 'the notice does not say what will run');
});

check('sessionStart is recognized by hook_event_name, with no --event=', () => {
  const fixture = makeFixture({ lint: OK_SCRIPT });
  const proc = spawnSync(process.execPath, [SCRIPT], {
    input: JSON.stringify({
      hook_event_name: 'SessionStart',
      reason: 'startup',
      session_id: fixture.sessionId,
      cwd: fixture.root,
    }),
    encoding: 'utf8',
    env: {
      ...process.env,
      VERIFY_CHANGES_STATE_DIR: fixture.stateDir,
      VERIFY_CHANGES_PATHS: 'src',
      VERIFY_CHANGES_FORMAT: '',
      VERIFY_CHANGES_COMMANDS: 'lint',
    },
  });
  const json = JSON.parse(proc.stdout.trim());
  assert(
    json.hookSpecificOutput?.hookEventName === 'SessionStart',
    'it did not recognize the event by hook_event_name',
  );
});

check('Stop is recognized by hook_event_name, with no --event=', () => {
  const fixture = makeFixture({ lint: FAIL_SCRIPT });
  start(fixture, { VERIFY_CHANGES_COMMANDS: 'lint' });
  touch(fixture, 'src/a.ts', 'export const a = 99;\n');
  const proc = spawnSync(process.execPath, [SCRIPT], {
    input: JSON.stringify({
      hook_event_name: 'Stop',
      stop_hook_active: false,
      session_id: fixture.sessionId,
      cwd: fixture.root,
    }),
    encoding: 'utf8',
    env: {
      ...process.env,
      VERIFY_CHANGES_STATE_DIR: fixture.stateDir,
      VERIFY_CHANGES_PATHS: 'src',
      VERIFY_CHANGES_FORMAT: '',
      VERIFY_CHANGES_COMMANDS: 'lint',
    },
  });
  const json = JSON.parse(proc.stdout.trim());
  assert(json.decision === 'block', `it did not block: ${proc.stdout}`);
  assert((json.reason ?? '').includes('WITH FAILURES'), 'it did not report the failure');
});

// --- configuration through command line arguments (the settings.json path) --------------------

check('--commands= and --paths= through arguments replace the defaults', () => {
  const fixture = makeFixture({ lint: FAIL_SCRIPT, other: OK_SCRIPT });
  const base = [`--state-dir=${fixture.stateDir}`, '--paths=src', '--format='];
  const call = (event, extra) =>
    spawnSync(process.execPath, [SCRIPT, `--event=${event}`, ...base, ...extra], {
      input: JSON.stringify({ session_id: fixture.sessionId, cwd: fixture.root }),
      encoding: 'utf8',
      // hazard: a clean env on purpose - if the argument does not work, the test has to fail,
      // and not fall back to the env var and pass by accident.
      env: { ...process.env, VERIFY_CHANGES_STATE_DIR: '', VERIFY_CHANGES_COMMANDS: '' },
    });

  call('sessionStart', ['--commands=other']);
  touch(fixture, 'src/a.ts', 'export const a = 42;\n');
  const out = call('agentStop', ['--commands=other']);
  const json = JSON.parse(out.stdout.trim());
  assert(json.decision === 'block', `it did not block: ${out.stdout}`);
  assert(
    (json.reason ?? '').includes('npm run other'),
    'it did not run the script from the argument',
  );
  assert(!(json.reason ?? '').includes('npm run lint'), 'it ran a script that was not asked for');
});

const failed = results.filter((result) => !result.ok);
for (const result of results) {
  process.stdout.write(`${result.ok ? 'ok  ' : 'FAIL'} ${result.name}\n`);
  if (!result.ok) process.stdout.write(`     ${result.message}\n`);
}
process.stdout.write(`\n${results.length - failed.length}/${results.length} passed\n`);
process.exitCode = failed.length === 0 ? 0 : 1;
