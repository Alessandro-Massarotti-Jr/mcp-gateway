#!/usr/bin/env node

// why: nao existe campo `env` por hook no settings.json do Claude Code. A configuracao chega
// entao por argumento de linha de comando (`args`, forma exec, sem shell no meio), e a env var
// continua valendo como segunda opcao - e o que os selftests usam.
function flagValue(name) {
  const prefix = `--${name}=`;
  const hit = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return hit === undefined ? undefined : hit.slice(prefix.length);
}

// hazard: `??` em toda a cadeia, nunca `||` - um valor vazio (`--allow=`) precisa significar
// "nenhuma excecao", e nao "cai no default".
function setting(flag, envName, fallback) {
  return flagValue(flag) ?? process.env[envName] ?? fallback;
}

const PLACEHOLDER = setting('placeholder', 'MASK_ENV_PLACEHOLDER', '') || '<censurado>';

const ENV_DUMP_RE = /(^|[\s;&|(])(printenv|env)($|[\s;&|)])/;
const KEY_CHAR_RE = /[A-Za-z0-9_.-]/;
const KEY_SHAPE_RE = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const QUERY_SEPARATORS = new Set(['?', '&']);

// hazard: every host decorates these lines differently - `grep` prepends `path:` and
// `path:lineno:`, `view` with a range prepends `168. `, plain reads prepend nothing. Two
// leaks already came from regexes that assumed one shape, so this walks left from the first
// `=` and keeps whatever decoration it finds instead of trying to enumerate the formats.
function parseAssignment(body) {
  const eq = body.indexOf('=');
  if (eq <= 0) return null;

  let keyEnd = eq;
  while (keyEnd > 0 && /\s/.test(body[keyEnd - 1])) keyEnd -= 1;

  let keyStart = keyEnd;
  while (keyStart > 0 && KEY_CHAR_RE.test(body[keyStart - 1])) keyStart -= 1;

  const key = body.slice(keyStart, keyEnd);
  // why: a one-character key before `=` is a query parameter far more often than an env var,
  // and `?`/`&` before it settles the remaining cases like `host/path?a=b`.
  if (key.length < 2 || !KEY_SHAPE_RE.test(key)) return null;
  if (keyStart > 0 && QUERY_SEPARATORS.has(body[keyStart - 1])) return null;

  let valueStart = eq + 1;
  while (valueStart < body.length && body[valueStart] === ' ') valueStart += 1;

  return {
    prefix: body.slice(0, keyStart),
    key,
    separator: body.slice(keyEnd, valueStart),
    value: body.slice(valueStart),
  };
}

const NOTICE =
  `Os valores de variaveis de ambiente foram mascarados pelo hook mask-env. ` +
  `Os nomes das variaveis sao reais; os valores foram substituidos por ${PLACEHOLDER}. ` +
  `Trate os valores como indisponiveis e nao tente obte-los por outro caminho.`;

// why: sample/example files carry placeholders, not secrets, and the agent needs them to know
// which variables exist - masking them removed the only readable source of that shape.
const DEFAULT_ALLOW = '.env.sample,.env.example,.env.template,.env.dist';
const ALLOW = setting('allow', 'MASK_ENV_ALLOW', DEFAULT_ALLOW)
  .split(',')
  .map((name) => name.trim().toLowerCase())
  .filter(Boolean);

function baseNameOf(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  const cleaned = value.replace(/^['"`]+|['"`]+$/g, '');
  const base = cleaned.split(/[\\/]/).pop();
  return base ? base.toLowerCase() : null;
}

function isEnvPath(value) {
  const base = baseNameOf(value);
  if (base === null) return false;
  return base === '.env' || base.startsWith('.env.') || base.endsWith('.env');
}

function isAllowedEnvPath(value) {
  const base = baseNameOf(value);
  return base !== null && ALLOW.includes(base);
}

function pathFromPrefix(prefix) {
  const trimmed = prefix
    .replace(/\s*\d+[\t :|]+$/, '')
    .replace(/:\s*$/, '')
    .trim();
  return trimmed === '' ? null : trimmed;
}

function shellTokens(value) {
  return value.split(/[\s=><|&;,()"'`]+/).filter(Boolean);
}

function collectStrings(node, out = [], depth = 0) {
  if (depth > 6 || out.length > 500) return out;
  if (typeof node === 'string') out.push(node);
  else if (Array.isArray(node)) for (const item of node) collectStrings(item, out, depth + 1);
  else if (node && typeof node === 'object') {
    for (const item of Object.values(node)) collectStrings(item, out, depth + 1);
  }
  return out;
}

function inspectArgs(args) {
  let hasAllowed = false;
  let hasDisallowed = false;
  let isDump = false;

  for (const value of collectStrings(args)) {
    if (ENV_DUMP_RE.test(value)) isDump = true;
    for (const candidate of [value, ...shellTokens(value)]) {
      if (!isEnvPath(candidate)) continue;
      if (isAllowedEnvPath(candidate)) hasAllowed = true;
      else hasDisallowed = true;
    }
  }

  return { hasAllowed, hasDisallowed, isDump };
}

function looksLikeEnvDump(text) {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
  if (lines.length < 3) return false;
  const assigns = lines.filter((line) => parseAssignment(line) !== null).length;
  return assigns / lines.length >= 0.8;
}

function maskText(text) {
  let masked = 0;
  // invariant: openQuote is non-null only while a quoted value keeps running across lines,
  // and every line consumed in that state is emitted empty.
  let openQuote = null;

  const out = text.split('\n').map((line) => {
    const cr = line.endsWith('\r') ? '\r' : '';
    const body = cr ? line.slice(0, -1) : line;

    if (openQuote !== null) {
      masked += 1;
      if (body.includes(openQuote)) openQuote = null;
      return cr;
    }

    if (body.trim() === '') return line;

    // hazard: a commented-out assignment is still a live credential - `# DB_URL=postgres://user:pw@host`
    // is exactly how rotated-but-kept secrets sit in a .env, so comments are masked too.
    const parsed = parseAssignment(body);
    if (parsed === null) return line;

    const { prefix, key, separator, value } = parsed;
    if (value.trim() === '') return line;

    // why: grep output mixes files in one result, and each hit carries its own path prefix -
    // that prefix is what tells a `.env` line apart from a `.env.sample` line here.
    const pathHint = pathFromPrefix(prefix);
    if (pathHint !== null && isAllowedEnvPath(pathHint)) return line;

    const quote = value[0];
    if ((quote === '"' || quote === "'") && !value.slice(1).includes(quote)) openQuote = quote;

    masked += 1;
    return `${prefix}${key}${separator}${PLACEHOLDER}${cr}`;
  });

  return { text: out.join('\n'), masked };
}

// hazard: a substituicao sai em `hookSpecificOutput.updatedToolOutput`, e o runtime exige que
// o valor tenha A MESMA FORMA da saida original da tool - um objeto para `Bash` (`{stdout,
// stderr, interrupted, isImage}`), outro para `Read`, e assim por diante. Valor com forma
// errada e DESCARTADO em silencio e o original chega ao modelo, que e exatamente o vazamento
// que este hook existe para evitar.
//
// why: por isso nada aqui monta um objeto novo. `maskValue` clona a saida original e troca
// apenas o conteudo das strings, entao a forma sai preservada seja qual for a tool.
// why: percorre a saida da tool trocando so o conteudo das strings. Um clone raso por nivel
// preserva arrays, objetos, numeros e booleanos exatamente como vieram, que e o que a
// validacao de schema do `updatedToolOutput` cobra.
function maskValue(node, counter, depth = 0) {
  if (depth > 8) return node;
  if (typeof node === 'string') {
    const { text, masked } = maskText(node);
    counter.masked += masked;
    return text;
  }
  if (Array.isArray(node)) return node.map((item) => maskValue(item, counter, depth + 1));
  if (node !== null && typeof node === 'object') {
    const out = {};
    for (const [key, value] of Object.entries(node))
      out[key] = maskValue(value, counter, depth + 1);
    return out;
  }
  return node;
}

function emit(updatedToolOutput) {
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        updatedToolOutput,
        additionalContext: NOTICE,
      },
    })}\n`,
  );
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

let involved = false;

// hazard: process.exit() can truncate a piped stdout on Windows, so this script never
// calls it - it returns and lets Node flush the decision JSON before the process ends.
try {
  const raw = await readStdin();

  let payload = null;
  try {
    payload = JSON.parse(raw);
  } catch {
    // why: without a parseable payload there is no result to replace, so staying silent
    // is the only honest outcome - redacting an unknown tool result would corrupt it.
    payload = null;
  }

  if (payload !== null) {
    // hazard: no Claude Code o resultado da tool chega em `tool_response`, nao em `toolResult`.
    // Ler so o nome antigo faz o hook nao ver texto nenhum e liberar tudo em silencio.
    const toolArgs = payload.tool_input ?? payload.toolArgs ?? {};
    const result = payload.tool_response ?? payload.toolResult ?? payload.tool_result ?? null;

    if (result !== null && result !== undefined) {
      // why: a heuristica de "isto parece um dump de .env" precisa do texto inteiro, e a saida
      // pode estar espalhada por varios campos (`stdout` + `stderr`, `file.content`...).
      const text = collectStrings(result).join('\n');
      const scan = inspectArgs(toolArgs);
      involved = scan.hasDisallowed || scan.isDump || (!scan.hasAllowed && looksLikeEnvDump(text));

      if (involved) {
        const counter = { masked: 0 };
        const maskedOutput = maskValue(result, counter);
        if (counter.masked > 0) emit(maskedOutput);
      }
    }
  }
} catch (error) {
  // hazard: this hook is the last checkpoint before .env content reaches the model, and
  // postToolUse cannot fail closed by exit code - a crash would let the raw text through.
  // hazard: um `updatedToolOutput` com a forma errada e descartado, e o texto cru chega ao
  // modelo - o oposto do que este fallback quer. Entao a supressao sai por `decision: block`,
  // que o Claude Code aceita em PostToolUse com qualquer tool e coloca o aviso junto do
  // resultado, sem depender de adivinhar o schema da saida.
  if (involved) {
    process.stdout.write(
      `${JSON.stringify({
        decision: 'block',
        reason:
          `[mask-env] este resultado pode conter valores de variaveis de ambiente e o hook ` +
          `FALHOU ao mascara-lo (${error?.name ?? 'Error'}). Trate o conteudo acima como nao ` +
          'confiavel, nao repita nenhum valor dele na sua resposta e avise o humano de que o ' +
          'mascaramento nao rodou.',
      })}\n`,
    );
  }
}

process.exitCode = 0;
