#!/usr/bin/env node

// why: o agente precisa LER esses arquivos para entender as regras do projeto - o que ele nao
// pode e alterar. Por isso o bloqueio e por intencao de escrita, nao por mencao ao arquivo.
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
  // why: case-insensitive porque o CLI roda no Windows e o cloud agent no Linux - o mesmo
  // padrao precisa pegar `Jest.Config.js` nos dois, e sobrar protecao e o lado seguro.
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

// why: o caminho chega em formatos diferentes conforme a tool (`jest.config.js`,
// `./jest.config.js`, `/workspace/jest.config.js`, `C:\repo\jest.config.js`). Comparar cada
// sufixo resolve todos sem precisar saber qual e a raiz do repo.
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

// why: um comando de shell nao chega separado em argumentos - `sed -i s/a/b/ jest.config.js`
// e uma string so, entao o caminho precisa ser recortado dela.
function shellTokens(value) {
  return value.split(/[\s=<>|&;,()"'`]+/).filter(Boolean);
}

const WRITE_MARKERS = [
  // redirecionamento: `> arq`, `>> arq`. `=>`, `->` e `>&` ficam de fora.
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
  // apply_patch e diffs unificados: o caminho vive dentro do corpo do patch.
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

// why: nomes de tool variam por runtime e por formato (`view` vs `Read`), entao a comparacao
// ignora caixa e separadores em vez de listar cada grafia.
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
  // nomes proprios do Claude Code
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
  'O que fazer agora: NAO tente outro caminho (shell, redirecionamento, patch, renomear, ' +
  'script, subagente) - o mesmo hook bloqueia todos. Siga com o restante da tarefa que nao ' +
  'depende dessa alteracao e, ao final, entregue ao humano um pedido de alteracao explicito ' +
  'com (1) o arquivo e o trecho exato, (2) o diff proposto, (3) o motivo e o que quebra sem ' +
  'ele, (4) como validar depois de aplicado.';

function denyReason(path, how) {
  return [
    `[protect-files] ${path} e um arquivo protegido deste repositorio: o agente pode ler, mas nao pode alterar.`,
    `A chamada foi bloqueada ${how} e nada foi gravado.`,
    GUIDANCE,
    EXTRA_MESSAGE,
  ]
    .filter(Boolean)
    .join(' ');
}

// hazard: o `permissionDecision` vive DENTRO de `hookSpecificOutput`. Um JSON com o campo no
// topo do objeto nao e apenas ignorado: ele reprova a validacao de schema e vira erro
// NAO-bloqueante - ou seja, a escrita passaria.
//
// hazard: exit 2 junto. Em PreToolUse o exit 2 bloqueia mesmo se o stdout for descartado, e o
// runtime prefere o `permissionDecisionReason` do JSON como mensagem; o stderr so aparece
// quando esse campo nao existe.
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
    // why: campo de caminho e o alvo declarado da tool - se casa com a lista, e escrita.
    // Texto livre (conteudo, comando, patch) so bloqueia com marcador de escrita junto,
    // senao um README que apenas cita `jest.config.js` seria barrado.
    const isPathField = !shell && key !== '' && PATH_KEY_RE.test(key);

    if (isPathField) {
      const hit = protectedPath(field.value);
      if (hit !== null) return denyReason(hit, `(tool \`${rawToolName}\`)`);
      continue;
    }

    if (!hasWriteIntent(field.value)) continue;

    for (const token of [field.value, ...shellTokens(field.value)]) {
      const hit = protectedPath(token);
      if (hit !== null) return denyReason(hit, 'porque o comando/patch tenta grava-lo');
    }
  }

  return null;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

// hazard: process.exit() pode truncar o stdout no Windows - o script nunca chama, so define
// exitCode e deixa o Node dar flush no JSON da decisao.
try {
  const raw = (await readStdin()).trim();

  if (raw === '') {
    // why: stdin vazio e execucao manual/fora do runtime, nao uma tool call - nao ha o que negar.
  } else {
    let payload = null;
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = null;
    }

    if (payload === null || typeof payload !== 'object') {
      // hazard: preToolUse e fail-closed. Sem payload legivel nao da para saber o alvo da tool,
      // e deixar passar aqui anula o hook - entao nega com motivo explicito.
      emitDeny(
        '[protect-files] payload de PreToolUse ilegivel; a chamada foi negada por seguranca (fail-closed). ' +
          'Avise o humano: se isto se repetir em toda tool call, o hook precisa de ajuste em .claude/settings.json.',
      );
    } else {
      const reason = decide(payload);
      // why: silencio = decisao padrao do runtime. Emitir "allow" pre-aprovaria chamadas que
      // deveriam passar pelo fluxo normal de permissao.
      if (reason !== null) emitDeny(reason);
    }
  }
} catch (error) {
  emitDeny(
    `[protect-files] falha interna do hook (${error?.name ?? 'Error'}); a chamada foi negada por seguranca (fail-closed). ` +
      'Avise o humano para revisar .claude/hooks/protect-files/protect-files.mjs.',
  );
}

// hazard: `??=` e nao `=` - o emitDeny() ja pode ter definido 2, e sobrescrever aqui
// liberaria exatamente a escrita que acabou de ser negada.
process.exitCode ??= 0;
