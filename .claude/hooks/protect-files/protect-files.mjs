#!/usr/bin/env node

// why: the agent needs to READ these files to understand the project rules - what it must not
// do is change them. That is why the block is by write intent, not by mentioning the file.
const DEFAULT_PATHS = [
  '.eslintrc*',
  'eslint.config.*',
  '.eslintignore',
  'jest.config.*',
  'jest.setup.*',
  '.prettierrc*',
  'prettier.config.*',
  '.prettierignore',
].join(',');

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

const RAW_PATTERNS = parseList(setting('paths', 'PROTECT_FILES_PATHS', DEFAULT_PATHS));
const RAW_EXCEPTIONS = parseList(setting('allow', 'PROTECT_FILES_ALLOW', ''));
const EXTRA_MESSAGE = setting('message', 'PROTECT_FILES_MESSAGE', '').trim();

function globToRegExp(pattern) {
  let source = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        source += '.*';
        i += 1;
      } else {
        source += '[^/]*';
      }
    } else if (ch === '?') {
      source += '[^/]';
    } else {
      source += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  // why: case-insensitive because the CLI runs on Windows and the cloud agent on Linux - the
  // same pattern has to catch both spellings, and over-protecting is the safe side.
  return new RegExp(`^${source}$`, 'i');
}

function compile(patterns) {
  return patterns.map((pattern) => ({
    source: pattern,
    hasSlash: pattern.includes('/'),
    re: globToRegExp(pattern.replace(/\\/g, '/').replace(/^\.\//, '')),
  }));
}

const PATTERNS = compile(RAW_PATTERNS);
const EXCEPTIONS = compile(RAW_EXCEPTIONS);

function normalizePath(value) {
  if (typeof value !== 'string') return null;
  const cleaned = value.trim().replace(/^['"`]+|['"`]+$/g, '');
  if (cleaned === '') return null;
  const normalized = cleaned
    .replace(/\\/g, '/')
    .replace(/^[A-Za-z]:/, '')
    .replace(/\/+$/, '')
    .replace(/^(\.\/)+/, '');
  return normalized === '' || normalized === '.' ? null : normalized;
}

// why: the path arrives in different shapes depending on the tool (a bare file name, a
// `./`-prefixed one, an absolute POSIX path, a Windows path). Comparing every suffix solves
// them all without having to know where the repo root is.
function suffixesOf(path) {
  const parts = path.split('/').filter(Boolean);
  const out = [];
  for (let i = Math.max(0, parts.length - 8); i < parts.length; i += 1) {
    out.push(parts.slice(i).join('/'));
  }
  return out;
}

function matches(entries, path) {
  const base = path.split('/').pop();
  const candidates = suffixesOf(path);
  for (const entry of entries) {
    if (!entry.hasSlash) {
      if (entry.re.test(base)) return entry.source;
      continue;
    }
    for (const candidate of candidates) {
      if (entry.re.test(candidate)) return entry.source;
    }
  }
  return null;
}

function protectedPath(value) {
  const path = normalizePath(value);
  if (path === null) return null;
  if (matches(EXCEPTIONS, path) !== null) return null;
  return matches(PATTERNS, path) === null ? null : path;
}

// why: a shell command does not arrive split into arguments - an in-place edit call is a
// single string, so the path has to be carved out of it.
function shellTokens(value) {
  return value.split(/[\s=<>|&;,()"'`]+/).filter(Boolean);
}

const WRITE_MARKERS = [
  // redirection: `> file`, `>> file`. `=>`, `->` and `>&` are left out.
  /(^|[^-=<>&])>>?\s*[^|&\s>]/,
  /\b(rm|mv|cp|tee|truncate|dd|touch|chmod|chown|ln|shred|unlink|install|patch)\b/i,
  /\b(sed|perl|ruby)\b[^\n]*\s-[a-z]*i\b/i,
  /\bgit\s+(checkout|restore|apply|rm|mv|reset|clean|stash|revert)\b/i,
  /\bprettier\b[^\n]*(--write|\s-w\b)/i,
  /\beslint\b[^\n]*--fix\b/i,
  /\bnpm\s+pkg\s+set\b/i,
  /\b(Set|Add|Clear)-Content\b|\bOut-File\b/i,
  /\b(Remove|Move|Copy|New|Rename)-Item\b|\bSet-ItemProperty\b/i,
  /\[IO\.File\]::(Write|Append|Delete|Move|Copy)/i,
  /\bopen\s*\([^)]*['"][wa]/i,
  /\b(writeFile|writeFileSync|appendFile|appendFileSync|renameSync|rmSync|unlinkSync|copyFileSync)\b/,
  // apply_patch and unified diffs: the path lives inside the patch body.
  /\*\*\*\s*(Update|Add|Delete|Move)\s+File/i,
  /(^|\n)(---|\+\+\+)\s/,
  /(^|\n)diff --git /,
  /(^|\n)Index:\s/,
];

function hasWriteIntent(text) {
  return WRITE_MARKERS.some((re) => re.test(text));
}

function normalizeKey(key) {
  return String(key ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase();
}

const PATH_KEY_RE =
  /(^|_)(path|paths|file|files|filename|filepath|dir|directory|dest|destination|target|source)s?$/;

function collectFields(node, key, out, depth = 0) {
  if (depth > 6 || out.length > 500) return out;
  if (typeof node === 'string') out.push({ key, value: node });
  else if (Array.isArray(node)) for (const item of node) collectFields(item, key, out, depth + 1);
  else if (node && typeof node === 'object') {
    for (const [childKey, value] of Object.entries(node)) {
      collectFields(value, childKey, out, depth + 1);
    }
  }
  return out;
}

// why: tool names vary by runtime and by format (`view` vs `Read`), so the comparison ignores
// case and separators instead of listing every spelling.
function normalizeToolName(name) {
  return String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z]/g, '');
}

const READ_ONLY_TOOLS = new Set([
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
  'task',
  'agent',
  // Claude Code's own tool names
  'toolsearch',
  'skill',
  'exitplanmode',
  'enterplanmode',
  'askuserquestion',
  'artifact',
]);

function isShellTool(tool) {
  return (
    tool.includes('bash') ||
    tool.includes('powershell') ||
    tool.includes('shell') ||
    tool === 'command' ||
    tool === 'terminal' ||
    tool === 'pwsh' ||
    tool === 'cmd'
  );
}

const GUIDANCE =
  'What to do now: do NOT try another route (shell, redirection, patch, rename, script, ' +
  'subagent) - the same hook blocks them all. Carry on with the rest of the task that does not ' +
  'depend on this change and, at the end, hand the human an explicit change request with ' +
  '(1) the file and the exact excerpt, (2) the proposed diff, (3) the reason and what breaks ' +
  'without it, (4) how to validate it once applied.';

function denyReason(path, how) {
  return [
    `[protect-files] ${path} is a protected file of this repository: the agent may read it, but may not change it.`,
    `The call was blocked ${how} and nothing was written.`,
    GUIDANCE,
    EXTRA_MESSAGE,
  ]
    .filter(Boolean)
    .join(' ');
}

// hazard: `permissionDecision` lives INSIDE `hookSpecificOutput`. JSON with the field at the
// top of the object is not merely ignored: it fails schema validation and becomes a
// NON-blocking error - which means the write would go through.
//
// hazard: exit 2 goes along with it. On PreToolUse, exit 2 blocks even if stdout is discarded,
// and the runtime prefers the JSON's `permissionDecisionReason` as the message; stderr only
// shows up when that field does not exist.
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
  const rawToolName = payload.tool_name ?? payload.toolName;
  const tool = normalizeToolName(rawToolName);
  if (READ_ONLY_TOOLS.has(tool)) return null;

  const args = payload.tool_input ?? payload.toolArgs ?? {};
  const shell = isShellTool(tool);

  for (const field of collectFields(args, null, [])) {
    const key = normalizeKey(field.key);
    // why: a path field is the tool's declared target - if it matches the list, it is a write.
    // Free text (content, command, patch) only blocks when a write marker comes with it,
    // otherwise a README that merely cites a protected file would be stopped.
    const isPathField = !shell && key !== '' && PATH_KEY_RE.test(key);

    if (isPathField) {
      const hit = protectedPath(field.value);
      if (hit !== null) return denyReason(hit, `(tool \`${rawToolName}\`)`);
      continue;
    }

    if (!hasWriteIntent(field.value)) continue;

    for (const token of [field.value, ...shellTokens(field.value)]) {
      const hit = protectedPath(token);
      if (hit !== null) return denyReason(hit, 'because the command/patch tries to write to it');
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
      // hazard: preToolUse is fail-closed. With no readable payload there is no way to know the
      // tool's target, and letting it through here defeats the hook - so it denies with an
      // explicit reason.
      emitDeny(
        '[protect-files] unreadable PreToolUse payload; the call was denied for safety (fail-closed). ' +
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
    `[protect-files] internal hook failure (${error?.name ?? 'Error'}); the call was denied for safety (fail-closed). ` +
      'Tell the human to review .claude/hooks/protect-files/protect-files.mjs.',
  );
}

// hazard: `??=` and not `=` - emitDeny() may already have set 2, and overwriting it here would
// allow exactly the write that was just denied.
process.exitCode ??= 0;
