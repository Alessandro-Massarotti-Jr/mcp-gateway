#!/usr/bin/env node

// why: o agente pode (e deve) rodar leitura, build e teste a vontade - o que ele nao pode e
// disparar acao destrutiva ou irreversivel (publicar, reescrever historico, apagar). Por isso
// o bloqueio e por COMANDO, e a mensagem manda ele devolver a decisao ao humano em vez de
// procurar outro caminho.
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

// why: um padrao e uma sequencia de palavras (`git push`) mais um conjunto de flags
// (`--hard`, `-f`). Separar os dois deixa a ordem das flags livre: `git push --force origin` e
// `git push origin --force` casam com a mesma regra.
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

// why: cada pedaco separado por `|`, `&&`, `;`, `$(`... e um comando proprio. Sem isso,
// `npm test && git push` escaparia por nao comecar com `git`.
const SEGMENT_SPLIT = /\|\||&&|\||;|&|\n|\r|\$\(|`|\(|\)|\{|\}/;

// why: `echo "rode git push"` nao executa nada - so imprime. Mas se a saida for canalizada
// para um interpretador, volta a ser execucao e o segmento deixa de ser texto inofensivo.
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
    // hazard: case-sensitive de proposito - `git branch -d` (seguro, so apaga o que ja foi
    // mergeado) nao pode casar com a regra `git branch -D`.
    if (/^-[A-Za-z]+$/.test(token)) for (const letter of token.slice(1)) letters.add(letter);
  }
  return letters;
}

function flagMatches(flag, tokens, letters) {
  // why: `-rf` chega colado, separado (`-r -f`) ou invertido (`-fr`). Comparar letra a letra
  // pega os tres; flags longas (`--hard`, `-Recurse`) continuam na comparacao literal.
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
    // why: entre duas palavras do padrao so podem existir flags (e o valor delas) - assim
    // `git -c core.x=1 push` ainda casa com `git push`, mas `git commit -m push` nao casa.
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
  // hazard: se a saida vai para um interpretador, o texto volta a ser comando - nesse caso o
  // comando inteiro tambem e avaliado como um segmento so.
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

// why: `command` e o alvo real da tool. Restringir a esses campos evita barrar um `description`
// ou um texto que apenas MENCIONA o comando; se nenhum campo desses existir, cai para tudo.
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
  // why: `exec: "git"` + `args: ["push"]` chega quebrado - a juncao devolve o comando inteiro.
  if (values.length > 1) values.push(values.join(' '));
  return values;
}

function normalizeToolName(name) {
  return String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z]/g, '');
}

function parseArgs(value) {
  // hazard: no formato em lote, `args` chega como STRING JSON, nao como objeto.
  if (typeof value !== 'string') return value ?? {};
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

// why: o Claude Code entrega sempre UMA chamada por invocacao, em `tool_name` + `tool_input`.
// As outras formas (`toolName`/`toolArgs`, `toolCalls: [...]`) ficaram no codigo de proposito:
// nao custam nada e cobrem uma tool de MCP que resolva empacotar chamadas.
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

// why: este hook so olha EXECUCAO. Leitura e escrita de arquivo tem dono proprio
// (`protect-files`); analisar o conteudo delas aqui so geraria falso positivo em texto.
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
  // nomes proprios do Claude Code
  'toolsearch',
  'skill',
  'exitplanmode',
  'enterplanmode',
  'artifact',
]);

const GUIDANCE =
  'O que fazer agora: NAO tente outro caminho (outra flag, alias, script, subagente, outra ' +
  'shell, git plumbing) - o mesmo hook bloqueia todos. Siga com o restante da tarefa que nao ' +
  'depende desse comando e, ao final, informe ao humano em texto claro: (1) o comando exato ' +
  'que voce tentou executar, (2) por que voce queria executa-lo agora, (3) o que fica pendente ' +
  'enquanto ele nao roda. Quem decide e executa esse comando e o humano, manualmente.';

function shorten(value) {
  const clean = value.replace(/\s+/g, ' ').trim();
  return clean.length > 200 ? `${clean.slice(0, 197)}...` : clean;
}

function denyReason(command, rule) {
  return [
    `[guard-commands] comando bloqueado: \`${shorten(command)}\`.`,
    `Ele casa com a regra \`${rule}\` de comandos destrutivos/irreversiveis deste repositorio, ` +
      'nao foi executado e nada mudou.',
    GUIDANCE,
  ]
    .filter(Boolean)
    .join(' ');
}

// hazard: o `permissionDecision` vive DENTRO de `hookSpecificOutput`. Um JSON com o campo no
// topo do objeto nao e apenas ignorado: ele reprova a validacao de schema e vira erro
// NAO-bloqueante - ou seja, o comando passaria.
//
// why: a recusa ainda sai pelos tres canais. Em PreToolUse o exit 2 bloqueia sozinho mesmo que
// o stdout seja descartado, e o runtime usa o `permissionDecisionReason` do JSON como mensagem
// quando ele existe, caindo no stderr so quando nao existe.
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
      // hazard: preToolUse e fail-closed. Sem payload legivel nao da para saber qual comando
      // seria executado, e deixar passar aqui anula o hook - entao nega com motivo explicito.
      emitDeny(
        '[guard-commands] payload de PreToolUse ilegivel; a chamada foi negada por seguranca (fail-closed). ' +
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
    `[guard-commands] falha interna do hook (${error?.name ?? 'Error'}); a chamada foi negada por seguranca (fail-closed). ` +
      'Avise o humano para revisar .claude/hooks/guard-commands/guard-commands.mjs.',
  );
}

// hazard: `??=` e nao `=` - emitDeny() ja pode ter definido 2, e sobrescrever aqui liberaria
// exatamente a chamada que acabou de ser negada.
process.exitCode ??= 0;
