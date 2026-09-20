#!/usr/bin/env node

// why: the agent can (and should) run reads, builds and tests freely - what it must not do is
// fire a destructive or irreversible action (publish, rewrite history, delete). That is why the
// block is per COMMAND, and the message tells the agent to hand the decision back to the human
// instead of looking for another way around.
const DEFAULT_DENY = [
  'git push',
  'git reset --hard',
  'git checkout -f',
  'git clean -f',
  'git branch -D',
  'git filter-branch',
  'git stash drop',
  'git stash clear',
  'git update-ref -d',
  'git reflog delete',
  'rm -rf',
  'Remove-Item -Recurse -Force',
  'npm publish',
].join(',');

const DEFAULT_ALLOW = ['git push --dry-run'].join(',');

function parseList(value) {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

// why: there is no per-hook `env` field in the Claude Code settings.json. The configuration
// therefore arrives as a command line argument (`args`, exec form, with no shell in between),
// and the env var still counts as the second option - it is what the selftests use.
function flagValue(name) {
  const prefix = `--${name}=`;
  const hit = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return hit === undefined ? undefined : hit.slice(prefix.length);
}

// hazard: `??` all the way through, never `||` - an empty value (`--allow=`) has to mean
// "no exception", and not "fall back to the default".
function setting(flag, envName, fallback) {
  return flagValue(flag) ?? process.env[envName] ?? fallback;
}

const RAW_DENY = parseList(setting('deny', 'GUARD_COMMANDS_DENY', DEFAULT_DENY));
const RAW_ALLOW = parseList(setting('allow', 'GUARD_COMMANDS_ALLOW', DEFAULT_ALLOW));

function globToRegExp(pattern, flags) {
  let source = '';
  for (const ch of pattern) {
    if (ch === '*') source += '.*';
    else if (ch === '?') source += '.';
    else source += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`, flags);
}

function isFlagToken(token) {
  return token.startsWith('-') && token !== '-' && token !== '--';
}

// why: a pattern is a sequence of words (`git push`) plus a set of flags (`--hard`, `-f`).
// Separating the two leaves the flag order free: `git push --force origin` and
// `git push origin --force` match the same rule.
function compile(patterns) {
  return patterns.map((pattern) => {
    const tokens = pattern.split(/\s+/).filter(Boolean);
    return {
      source: pattern,
      words: tokens.filter((token) => !isFlagToken(token)),
      flags: tokens.filter(isFlagToken),
    };
  });
}

const DENY = compile(RAW_DENY);
const ALLOW = compile(RAW_ALLOW);

// why: each piece separated by `|`, `&&`, `;`, `$(`... is a command of its own. Without this,
// `npm test && git push` would escape by not starting with `git`.
const SEGMENT_SPLIT = /\|\||&&|\||;|&|\n|\r|\$\(|`|\(|\)|\{|\}/;

// why: `echo "run git push"` executes nothing - it only prints. But if the output is piped
// into an interpreter, it becomes execution again and the segment stops being harmless text.
const PIPES_INTO_SHELL = /\|\s*\S*\s*\b(sh|bash|zsh|ksh|dash|pwsh|powershell|node|python3?|iex)\b/i;
const TEXT_ONLY_HEADS = new Set(['echo', 'printf', ':', '#']);

function tokenize(segment) {
  return segment
    .split(/\s+/)
    .map((token) => token.replace(/^['"`]+|['"`]+$/g, '').trim())
    .filter(Boolean);
}

function shortFlagLetters(tokens) {
  const letters = new Set();
  for (const token of tokens) {
    // hazard: case-sensitive on purpose - `git branch -d` (safe, it only deletes what has been
    // merged) must not match the `git branch -D` rule.
    if (/^-[A-Za-z]+$/.test(token)) for (const letter of token.slice(1)) letters.add(letter);
  }
  return letters;
}

function flagMatches(flag, tokens, letters) {
  // why: `-rf` arrives joined, separate (`-r -f`) or reversed (`-fr`). Comparing letter by
  // letter catches all three; long flags (`--hard`, `-Recurse`) stay on the literal comparison.
  if (/^-[A-Za-z]{1,4}$/.test(flag)) {
    return [...flag.slice(1)].every((letter) => letters.has(letter));
  }
  const re = globToRegExp(flag, 'i');
  return tokens.some((token) => re.test(token));
}

function matchesWordsAt(tokens, start, words) {
  let i = start;
  for (let w = 0; w < words.length; w += 1) {
    const re = globToRegExp(words[w], 'i');
    // why: between two pattern words there may only be flags (and their values) - that way
    // `git -c core.x=1 push` still matches `git push`, but `git commit -m push` does not.
    while (w > 0 && i < tokens.length && !re.test(tokens[i])) {
      if (!isFlagToken(tokens[i])) return false;
      i += 1;
      if (i < tokens.length && !isFlagToken(tokens[i]) && !re.test(tokens[i])) i += 1;
    }
    if (i >= tokens.length || !re.test(tokens[i])) return false;
    i += 1;
  }
  return true;
}

function matchesSegment(entry, tokens, letters) {
  if (entry.words.length === 0 && entry.flags.length === 0) return false;
  if (entry.words.length > 0) {
    let found = false;
    for (let start = 0; start < tokens.length; start += 1) {
      if (matchesWordsAt(tokens, start, entry.words)) {
        found = true;
        break;
      }
    }
    if (!found) return false;
  }
  return entry.flags.every((flag) => flagMatches(flag, tokens, letters));
}

function segmentsOf(command) {
  const parts = command.split(SEGMENT_SPLIT);
  // hazard: if the output goes into an interpreter, the text becomes a command again - in that
  // case the whole command is also evaluated as a single segment.
  if (PIPES_INTO_SHELL.test(command)) parts.push(command.replace(SEGMENT_SPLIT, ' '));
  return parts;
}

function blockedRule(command) {
  const skipText = !PIPES_INTO_SHELL.test(command);
  for (const segment of segmentsOf(command)) {
    const tokens = tokenize(segment);
    if (tokens.length === 0) continue;
    if (skipText && TEXT_ONLY_HEADS.has(tokens[0].toLowerCase())) continue;

    const letters = shortFlagLetters(tokens);
    if (ALLOW.some((entry) => matchesSegment(entry, tokens, letters))) continue;

    const hit = DENY.find((entry) => matchesSegment(entry, tokens, letters));
    if (hit) return { rule: hit.source, segment: segment.trim() };
  }
  return null;
}

function normalizeKey(key) {
  return String(key ?? '')
    .toLowerCase()
    .replace(/[^a-z]/g, '');
}

// why: `command` is the tool's real target. Restricting to these fields avoids stopping a
// `description` or a text that merely MENTIONS the command; if none of these fields exists,
// it falls back to everything.
const COMMAND_KEYS = new Set([
  'command',
  'commandline',
  'cmd',
  'script',
  'shell',
  'bash',
  'powershell',
  'pwsh',
  'exec',
  'code',
  'input',
  'args',
  'argv',
  'arguments',
]);

function collectFields(node, key, out, depth = 0) {
  if (depth > 6 || out.length > 500) return out;
  if (typeof node === 'string') out.push({ key: normalizeKey(key), value: node });
  else if (Array.isArray(node)) for (const item of node) collectFields(item, key, out, depth + 1);
  else if (node && typeof node === 'object') {
    for (const [childKey, value] of Object.entries(node)) {
      collectFields(value, childKey, out, depth + 1);
    }
  }
  return out;
}

function commandCandidates(args) {
  const fields = collectFields(args, null, []);
  const preferred = fields.filter((field) => COMMAND_KEYS.has(field.key));
  const chosen = preferred.length > 0 ? preferred : fields;
  const values = chosen.map((field) => field.value);
  // why: `exec: "git"` + `args: ["push"]` arrives split - joining gives back the whole command.
  if (values.length > 1) values.push(values.join(' '));
  return values;
}

function normalizeToolName(name) {
  return String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z]/g, '');
}

function parseArgs(value) {
  // hazard: in the batch format, `args` arrives as a JSON STRING, not as an object.
  if (typeof value !== 'string') return value ?? {};
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

// why: Claude Code always delivers ONE call per invocation, in `tool_name` + `tool_input`.
// The other shapes (`toolName`/`toolArgs`, `toolCalls: [...]`) were kept on purpose: they cost
// nothing and cover an MCP tool that decides to batch calls.
function toolCallsOf(payload) {
  const calls = [];
  const batch = payload.toolCalls ?? payload.tool_calls;
  if (Array.isArray(batch)) {
    for (const call of batch) {
      if (call && typeof call === 'object') {
        calls.push({
          name: call.name ?? call.toolName ?? call.tool_name,
          args: parseArgs(call.args ?? call.arguments ?? call.toolArgs ?? call.tool_input),
        });
      }
    }
  }
  const name = payload.tool_name ?? payload.toolName;
  const args = payload.tool_input ?? payload.toolArgs;
  if (name !== undefined || args !== undefined) calls.push({ name, args: parseArgs(args) });
  return calls;
}

// why: this hook only looks at EXECUTION. Reading and writing files have their own owner
// (`protect-files`); analyzing their content here would only produce false positives on text.
const IGNORED_TOOLS = new Set([
  'view',
  'read',
  'readfile',
  'notebookread',
  'grep',
  'rg',
  'glob',
  'ls',
  'list',
  'search',
  'codebasesearch',
  'websearch',
  'webfetch',
  'fetch',
  'askuser',
  'askuserquestion',
  'updatetodo',
  'todowrite',
  'create',
  'write',
  'edit',
  'multiedit',
  'strreplaceeditor',
  'applypatch',
  'notebookedit',
  // Claude Code's own tool names
  'toolsearch',
  'skill',
  'exitplanmode',
  'enterplanmode',
  'artifact',
]);

const GUIDANCE =
  'What to do now: do NOT try another route (another flag, alias, script, subagent, another ' +
  'shell, git plumbing) - the same hook blocks them all. Carry on with the rest of the task ' +
  'that does not depend on this command and, at the end, tell the human in plain text: (1) the ' +
  'exact command you tried to run, (2) why you wanted to run it now, (3) what stays pending ' +
  'while it does not run. The human decides and runs this command, manually.';

function shorten(value) {
  const clean = value.replace(/\s+/g, ' ').trim();
  return clean.length > 200 ? `${clean.slice(0, 197)}...` : clean;
}

function denyReason(command, rule) {
  return [
    `[guard-commands] command blocked: \`${shorten(command)}\`.`,
    `It matches the \`${rule}\` rule of destructive/irreversible commands of this repository, ` +
      'it was not executed and nothing changed.',
    GUIDANCE,
  ]
    .filter(Boolean)
    .join(' ');
}

// hazard: `permissionDecision` lives INSIDE `hookSpecificOutput`. JSON with the field at the
// top of the object is not merely ignored: it fails schema validation and becomes a
// NON-blocking error - which means the command would go through.
//
// why: the refusal still goes out through all three channels. On PreToolUse, exit 2 blocks on
// its own even if stdout is discarded, and the runtime uses the JSON's
// `permissionDecisionReason` as the message when it exists, falling back to stderr only when
// it does not.
function emitDeny(reason) {
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    })}\n`,
  );
  process.stderr.write(`${reason}\n`);
  process.exitCode = 2;
}

function decide(payload) {
  for (const call of toolCallsOf(payload)) {
    if (IGNORED_TOOLS.has(normalizeToolName(call.name))) continue;
    for (const candidate of commandCandidates(call.args)) {
      const hit = blockedRule(candidate);
      if (hit !== null) return denyReason(hit.segment || candidate, hit.rule);
    }
  }
  return null;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

// hazard: process.exit() can truncate stdout on Windows - the script never calls it, it only
// sets exitCode and lets Node flush the decision JSON.
try {
  const raw = (await readStdin()).trim();

  if (raw === '') {
    // why: empty stdin is a manual run outside the runtime, not a tool call - nothing to deny.
  } else {
    let payload = null;
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = null;
    }

    if (payload === null || typeof payload !== 'object') {
      // hazard: preToolUse is fail-closed. With no readable payload there is no way to know
      // which command would run, and letting it through here defeats the hook - so it denies
      // with an explicit reason.
      emitDeny(
        '[guard-commands] unreadable PreToolUse payload; the call was denied for safety (fail-closed). ' +
          'Tell the human: if this repeats on every tool call, the hook needs adjusting in .claude/settings.json.',
      );
    } else {
      const reason = decide(payload);
      // why: silence = the runtime's default decision. Emitting "allow" would pre-approve calls
      // that should go through the normal permission flow.
      if (reason !== null) emitDeny(reason);
    }
  }
} catch (error) {
  emitDeny(
    `[guard-commands] internal hook failure (${error?.name ?? 'Error'}); the call was denied for safety (fail-closed). ` +
      'Tell the human to review .claude/hooks/guard-commands/guard-commands.mjs.',
  );
}

// hazard: `??=` and not `=` - emitDeny() may already have set 2, and overwriting it here would
// allow exactly the call that was just denied.
process.exitCode ??= 0;
