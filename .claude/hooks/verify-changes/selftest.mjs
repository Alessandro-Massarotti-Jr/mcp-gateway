#!/usr/bin/env node

// Suite do hook verify-changes. Roda contra um projeto-fixture descartavel em os.tmpdir(),
// nunca contra o repo real - os "comandos" da fixture sao `node -e` de milissegundos, entao a
// suite exercita a maquina de estados sem pagar lint/build/teste de verdade.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./verify-changes.mjs', import.meta.url));

const OK_SCRIPT = 'node -e "0"';
const FAIL_SCRIPT = 'node -e "console.error(\'boom na regra X\');process.exit(1)"';

let counter = 0;

function makeFixture(scripts) {
  counter += 1;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `verify-changes-${counter}-`));
  fs.mkdirSync(path.join(root, 'src', 'nested'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(root, 'src', 'nested', 'b.ts'), 'export const b = 2;\n');
  fs.writeFileSync(path.join(root, 'outro.ts'), 'export const c = 3;\n');
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
  // why: payload no formato do Claude Code - `session_id`/`hook_event_name`, `reason` no
  // SessionStart e `last_assistant_message` no Stop. O `--event=` continua sendo passado como
  // segunda fonte, que e o caminho de execucao manual do script.
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
          last_assistant_message: 'pronto',
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
  assert(out.json !== null, `nao bloqueou: stdout vazio (exit ${out.status})`);
  assert(out.json.decision === 'block', `decisao ${out.json.decision}`);
  const reason = out.json.reason ?? '';
  assert(reason.includes('[verify-changes]'), 'motivo sem prefixo do hook');
  // hazard: com exit 2 o Stop tambem bloqueia, mas a mensagem passa a vir do stderr e o turno e
  // marcado como erro de hook. Com exit 0 o `reason` chega limpo ao agente.
  assert(out.status === 0, `exit ${out.status} - bloqueio so vale com exit 0`);
  // hazard: o motivo NAO pode ser espelhado no stderr, que com exit 0 vai apenas para o log de
  // debug - duplicar ali so gera ruido e esconde de qual canal veio o texto que o agente leu.
  assert(
    !out.stderr.includes('[verify-changes]'),
    `stderr nao pode carregar o motivo, veio: ${out.stderr}`,
  );
  return reason;
}

// hazard: `{ decision: 'allow' }` NAO existe no schema de Stop - o objeto reprova a validacao
// e o turno ganha um aviso de "hook error" a toa. Liberar em Stop e nao mandar `decision`
// nenhum.
//
// why: mesmo liberando, o hook responde um JSON com `systemMessage`. Silencio total nao
// distingue hook vivo de hook morto, e `systemMessage` em Stop so vai para o log de debug.
function assertAllow(out) {
  assert(out.status === 0, `exit ${out.status} (esperado 0)`);
  assert(out.json !== null, 'nao decidiu nada: stdout vazio');
  assert(out.json.decision === undefined, `liberou com decision: ${out.json.decision}`);
  assert(
    out.json.reason === undefined,
    'allow nao pode carregar `reason` - ele continua a conversa',
  );
  assert(
    out.json.hookSpecificOutput?.additionalContext === undefined,
    'allow nao pode carregar `additionalContext` - ele tambem continua a conversa',
  );
}

// --- gatilho: so roda quando algo mudou nos caminhos observados ---------------------------

check('sem alteracao em src nenhum comando roda', () => {
  const fixture = makeFixture({ lint: OK_SCRIPT });
  const env = { VERIFY_CHANGES_COMMANDS: 'lint', VERIFY_CHANGES_NOTIFY: 'on-run' };
  start(fixture, env);
  assertAllow(stop(fixture, env));
});

check('alteracao em src dispara a verificacao', () => {
  const fixture = makeFixture({ lint: OK_SCRIPT });
  start(fixture);
  touch(fixture, 'src/a.ts', 'export const a = 99;\n');
  const reason = assertBlock(stop(fixture, { VERIFY_CHANGES_COMMANDS: 'lint' }));
  assert(reason.includes('npm run lint'), 'relatorio nao cita o comando executado');
  assert(reason.includes('OK'), 'relatorio nao marca o comando como OK');
});

check('arquivo novo em src dispara a verificacao', () => {
  const fixture = makeFixture({ lint: OK_SCRIPT });
  start(fixture);
  touch(fixture, 'src/nested/c.ts', 'export const c = 1;\n');
  assertBlock(stop(fixture, { VERIFY_CHANGES_COMMANDS: 'lint' }));
});

check('alteracao FORA de src nao dispara nada', () => {
  const fixture = makeFixture({ lint: OK_SCRIPT });
  const env = { VERIFY_CHANGES_COMMANDS: 'lint', VERIFY_CHANGES_NOTIFY: 'on-run' };
  start(fixture, env);
  touch(fixture, 'outro.ts', 'export const c = 999;\n');
  touch(fixture, 'README.md', '# doc\n');
  assertAllow(stop(fixture, env));
});

check('reescrita com o mesmo conteudo nao conta como alteracao', () => {
  const fixture = makeFixture({ lint: OK_SCRIPT });
  const env = { VERIFY_CHANGES_COMMANDS: 'lint', VERIFY_CHANGES_NOTIFY: 'on-run' };
  start(fixture, env);
  // hazard: e o que o `format` faz - mexe no mtime sem mudar nada. Se o gatilho fosse mtime,
  // o hook se auto-dispararia em loop depois de cada prettier.
  touch(fixture, 'src/a.ts', 'export const a = 1;\n');
  assertAllow(stop(fixture, env));
});

check('caminho configurado como /src e normalizado', () => {
  const fixture = makeFixture({ lint: OK_SCRIPT });
  const env = { VERIFY_CHANGES_PATHS: '/src', VERIFY_CHANGES_COMMANDS: 'lint' };
  start(fixture, env);
  touch(fixture, 'src/a.ts', 'export const a = 42;\n');
  assertBlock(stop(fixture, env));
});

check('caminho configuravel: observando outra pasta, src fica livre', () => {
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

// --- execucao: roda todos, reporta cada um -------------------------------------------------

check('roda TODOS os comandos mesmo com falha no meio', () => {
  const fixture = makeFixture({ lint: FAIL_SCRIPT, build: OK_SCRIPT });
  start(fixture);
  touch(fixture, 'src/a.ts', 'export const a = 2;\n');
  const reason = assertBlock(stop(fixture, { VERIFY_CHANGES_COMMANDS: 'lint,build' }));
  assert(/npm run lint\s+->\s+FALHOU/.test(reason), 'lint nao aparece como FALHOU');
  assert(/npm run build\s+->\s+OK/.test(reason), 'build nao rodou depois da falha do lint');
});

check('a falha vem com exit code e trecho da saida', () => {
  const fixture = makeFixture({ lint: FAIL_SCRIPT });
  start(fixture);
  touch(fixture, 'src/a.ts', 'export const a = 3;\n');
  const reason = assertBlock(stop(fixture, { VERIFY_CHANGES_COMMANDS: 'lint' }));
  assert(reason.includes('exit 1'), 'motivo nao traz o exit code');
  assert(reason.includes('boom na regra X'), 'motivo nao traz a saida do comando que falhou');
});

check('o format roda antes dos demais comandos', () => {
  const fixture = makeFixture({ format: OK_SCRIPT, lint: OK_SCRIPT });
  start(fixture);
  touch(fixture, 'src/a.ts', 'export const a = 4;\n');
  const reason = assertBlock(
    stop(fixture, { VERIFY_CHANGES_FORMAT: 'format', VERIFY_CHANGES_COMMANDS: 'lint' }),
  );
  assert(
    reason.indexOf('npm run format') < reason.indexOf('npm run lint'),
    'format nao aparece antes do lint no relatorio',
  );
});

// --- script inexistente: avisa, mas nao trava ----------------------------------------------

check('script ausente no package.json nao trava o agente, so avisa', () => {
  const fixture = makeFixture({ lint: OK_SCRIPT });
  start(fixture);
  touch(fixture, 'src/a.ts', 'export const a = 5;\n');
  const reason = assertBlock(stop(fixture, { VERIFY_CHANGES_COMMANDS: 'lint,test' }));
  assert(reason.includes('nao existe no package.json'), 'motivo nao explica o script ausente');
  assert(reason.includes('"test"'), 'motivo nao nomeia o script ausente');
  assert(reason.includes('SEM falhas'), 'script ausente foi tratado como falha');
  assert(!reason.includes('tentativa'), 'script ausente entrou no ciclo de correcao');
});

check('so scripts ausentes: relatorio sai e o ciclo encerra', () => {
  const fixture = makeFixture({});
  start(fixture);
  touch(fixture, 'src/a.ts', 'export const a = 6;\n');
  const reason = assertBlock(stop(fixture, { VERIFY_CHANGES_COMMANDS: 'lint,build,test' }));
  assert(reason.includes('SEM falhas'), 'deveria encerrar sem falhas');
  assertAllow(stop(fixture, { VERIFY_CHANGES_COMMANDS: 'lint,build,test' }));
});

// --- relatorio final obrigatorio -------------------------------------------------------------

check('sucesso bloqueia UMA vez para o agente relatar, e libera na sequencia', () => {
  const fixture = makeFixture({ lint: OK_SCRIPT });
  start(fixture);
  touch(fixture, 'src/a.ts', 'export const a = 8;\n');
  const reason = assertBlock(stop(fixture, { VERIFY_CHANGES_COMMANDS: 'lint' }));
  assert(reason.includes('resposta final ao usuario'), 'nao exige o relatorio na resposta final');
  assertAllow(stop(fixture, { VERIFY_CHANGES_COMMANDS: 'lint' }));
});

// --- aviso em todo encerramento (NOTIFY) -----------------------------------------------------

check('sem alteracao o hook avisa que nao rodou nada e o porque', () => {
  const fixture = makeFixture({ lint: OK_SCRIPT, build: OK_SCRIPT });
  const env = { VERIFY_CHANGES_COMMANDS: 'lint,build' };
  start(fixture, env);
  const reason = assertBlock(stop(fixture, env));
  assert(reason.includes('NENHUM comando executado'), 'nao diz que nada rodou');
  assert(reason.includes('nada mudou em src'), 'nao explica o motivo');
  assert(reason.includes('npm run lint, npm run build'), 'nao lista o que rodaria');
  assert(reason.includes('nao refaca nada'), 'nao impede o agente de refazer o trabalho');
});

check('o aviso de "nao rodou" nao se auto-alimenta', () => {
  const fixture = makeFixture({ lint: OK_SCRIPT });
  const env = { VERIFY_CHANGES_COMMANDS: 'lint' };
  start(fixture, env);
  // hazard: o turno que ENTREGA o aviso tambem termina em agentStop sem alteracao nenhuma. Sem
  // o guard de justReported isso vira aviso -> turno -> aviso ate estourar MAX_BLOCKS.
  assertBlock(stop(fixture, env));
  assertAllow(stop(fixture, env));
  assertBlock(stop(fixture, env));
  assertAllow(stop(fixture, env));
});

check('NOTIFY=on-run cala o aviso quando nada rodou, mas mantem o de sucesso', () => {
  const fixture = makeFixture({ lint: OK_SCRIPT });
  const env = { VERIFY_CHANGES_COMMANDS: 'lint', VERIFY_CHANGES_NOTIFY: 'on-run' };
  start(fixture, env);
  assertAllow(stop(fixture, env));
  touch(fixture, 'src/a.ts', 'export const a = 20;\n');
  assert(assertBlock(stop(fixture, env)).includes('SEM falhas'), 'perdeu o relatorio de sucesso');
});

check('NOTIFY=on-error so fala quando alguma verificacao falha', () => {
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
  assert(assertBlock(stop(failing, failEnv)).includes('COM FALHAS'), 'nao reportou a falha');
});

check('todo relatorio diz explicitamente se a verificacao rodou', () => {
  const fixture = makeFixture({ lint: FAIL_SCRIPT });
  const env = { VERIFY_CHANGES_COMMANDS: 'lint' };
  start(fixture, env);
  assert(assertBlock(stop(fixture, env)).includes('Status da verificacao'), 'aviso sem status');
  touch(fixture, 'src/a.ts', 'export const a = 23;\n');
  assert(assertBlock(stop(fixture, env)).includes('Status da verificacao'), 'falha sem status');
});

// --- criterio de parada -----------------------------------------------------------------------

check('falha persistente para depois de MAX_ATTEMPTS e manda relatar', () => {
  const fixture = makeFixture({ lint: FAIL_SCRIPT });
  const env = { VERIFY_CHANGES_COMMANDS: 'lint', VERIFY_CHANGES_MAX_ATTEMPTS: '3' };
  start(fixture);
  touch(fixture, 'src/a.ts', 'export const a = 9;\n');

  const first = assertBlock(stop(fixture, env));
  assert(first.includes('tentativa 1 de 3'), `tentativa 1 nao anunciada: ${first.slice(0, 120)}`);

  // why: o agente encerra SEM corrigir nada - o gate tem de continuar de pe mesmo assim.
  const second = assertBlock(stop(fixture, env));
  assert(second.includes('tentativa 2 de 3'), 'tentativa 2 nao anunciada');

  const third = assertBlock(stop(fixture, env));
  assert(third.includes('PARE de tentar corrigir'), 'nao encerrou o ciclo na ultima tentativa');
  assert(third.includes('nao vai bloquear de novo'), 'nao avisa que o gate parou');
  assert(third.includes('FALHOU'), 'relatorio final sem o resultado dos comandos');

  // o loop acabou: com a falha ainda de pe, o agente consegue entregar a resposta
  assertAllow(stop(fixture, env));
});

check('MAX_ATTEMPTS=1 encerra o ciclo ja no primeiro bloqueio', () => {
  const fixture = makeFixture({ lint: FAIL_SCRIPT });
  const env = { VERIFY_CHANGES_COMMANDS: 'lint', VERIFY_CHANGES_MAX_ATTEMPTS: '1' };
  start(fixture);
  touch(fixture, 'src/a.ts', 'export const a = 10;\n');
  assert(assertBlock(stop(fixture, env)).includes('PARE de tentar corrigir'), 'nao encerrou');
  assertAllow(stop(fixture, env));
});

check('orcamento de tempo esgotado encerra o ciclo', () => {
  const fixture = makeFixture({ lint: FAIL_SCRIPT });
  const env = {
    VERIFY_CHANGES_COMMANDS: 'lint',
    VERIFY_CHANGES_MAX_ATTEMPTS: '9',
    VERIFY_CHANGES_BUDGET_SEC: '0.001',
  };
  start(fixture);
  touch(fixture, 'src/a.ts', 'export const a = 11;\n');
  const reason = assertBlock(stop(fixture, env));
  assert(reason.includes('orcamento de tempo esgotado'), 'nao cita o estouro de tempo');
  assertAllow(stop(fixture, env));
});

check('teto absoluto de bloqueios desarma o hook', () => {
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

  // why: desarmar calado deixaria a sessao parecendo verificada quando nao esta mais - o aviso
  // custa um bloqueio alem do teto (3 aqui), ainda abaixo dos 8 do runtime.
  const reason = assertBlock(stop(fixture, env));
  assert(reason.includes('SE DESARMOU'), 'nao avisou que o gate se desarmou');
  assert(reason.includes('rodar os comandos na mao'), 'nao diz o que o usuario perde');

  assertAllow(stop(fixture, env));
  assertAllow(stop(fixture, env));
});

check('hook quebrado avisa o usuario uma vez e depois se cala', () => {
  const fixture = makeFixture({ lint: OK_SCRIPT });
  const env = { VERIFY_CHANGES_COMMANDS: 'lint' };
  // hazard: cwd nao-string faz path.resolve lancar la dentro - e o jeito de exercitar o caminho
  // de falha interna sem por gancho de teste no codigo de producao.
  const broken = { sessionId: 'quebrado', cwd: 12345, stopReason: 'end_turn' };

  const reason = assertBlock(run(fixture, 'agentStop', env, broken));
  assert(reason.includes('QUEBROU'), 'nao avisou que o hook falhou');
  assert(reason.includes('NAO foram executados'), 'nao deixa claro que nada rodou');

  // why: o defeito e do proprio hook - insistir no aviso a cada encerramento viraria loop.
  assertAllow(run(fixture, 'agentStop', env, broken));
  assertAllow(run(fixture, 'agentStop', env, broken));
});

check('sessionId variavel nao fragmenta o estado (chave e o cwd)', () => {
  const fixture = makeFixture({ lint: FAIL_SCRIPT });
  const env = { VERIFY_CHANGES_COMMANDS: 'lint', VERIFY_CHANGES_MAX_ATTEMPTS: '3' };
  start(fixture, env);
  touch(fixture, 'src/a.ts', 'export const a = 40;\n');

  // hazard: o id que chega em cada evento pode divergir. Com o sessionId na chave
  // do estado, cada encerramento abria um arquivo novo e o contador ficava preso em "1 de 3".
  const at = (sessionId) =>
    run(fixture, 'agentStop', env, { sessionId, cwd: fixture.root, stopReason: 'end_turn' });

  assert(
    assertBlock(at('sessao-real')).includes('tentativa 1 de 3'),
    'primeira tentativa nao anunciada',
  );
  assert(
    assertBlock(at('call_S2a2584krvQiQjfrF3TS7dnA')).includes('tentativa 2 de 3'),
    'id de tool call abriu um contador novo em vez de continuar o da sessao',
  );
  assert(
    assertBlock(at('call_9EzH1Aog62qdiaMKVoNJPmWx')).includes('PARE de tentar corrigir'),
    'o ciclo nao chegou ao fim com sessionIds diferentes',
  );
});

check('stop_hook_active sem estado proprio limita o hook a um ultimo bloqueio', () => {
  const fixture = makeFixture({ lint: FAIL_SCRIPT });
  const env = { VERIFY_CHANGES_COMMANDS: 'lint', VERIFY_CHANGES_MAX_ATTEMPTS: '9' };
  touch(fixture, 'src/a.ts', 'export const a = 30;\n');
  // hazard: sem sessionStart nao ha estado - e o runtime dizendo que o turno JA foi forcado a
  // continuar. Contar do zero aqui somaria bloqueios nossos aos que ele ja concedeu.
  const forced = {
    sessionId: fixture.sessionId,
    cwd: fixture.root,
    stopReason: 'end_turn',
    stop_hook_active: true,
  };
  assertBlock(run(fixture, 'agentStop', env, forced));
  // why: o encerramento seguinte ja bate no teto - e o desarme se anuncia antes de calar.
  assert(
    assertBlock(run(fixture, 'agentStop', env, forced)).includes('SE DESARMOU'),
    'desarmou sem avisar',
  );
  assertAllow(run(fixture, 'agentStop', env, forced));
});

check('sem stop_hook_active o contador de bloqueios comeca do zero', () => {
  const fixture = makeFixture({ lint: FAIL_SCRIPT });
  const env = { VERIFY_CHANGES_COMMANDS: 'lint', VERIFY_CHANGES_MAX_ATTEMPTS: '9' };
  touch(fixture, 'src/a.ts', 'export const a = 31;\n');
  assertBlock(stop(fixture, env));
  assertBlock(stop(fixture, env));
  assertBlock(stop(fixture, env));
});

// --- fail-open e bordas ------------------------------------------------------------------------

check('stdin vazio nao decide nada', () => {
  const fixture = makeFixture({ lint: OK_SCRIPT });
  const proc = spawnSync(process.execPath, [SCRIPT, '--event=agentStop'], {
    input: '',
    encoding: 'utf8',
    env: { ...process.env, VERIFY_CHANGES_STATE_DIR: fixture.stateDir },
  });
  assert(proc.status === 0, `exit ${proc.status}`);
  assert(proc.stdout.trim() === '', 'respondeu algo sem payload');
});

check('payload ilegivel e fail-open (nao bloqueia o encerramento)', () => {
  const fixture = makeFixture({ lint: OK_SCRIPT });
  const out = run(fixture, 'agentStop', { VERIFY_CHANGES_COMMANDS: 'lint' }, 'nao-e-json');
  assertAllow(out);
});

check('sem package.json o hook nao verifica nada, mas avisa', () => {
  const fixture = makeFixture({ lint: OK_SCRIPT });
  start(fixture);
  touch(fixture, 'src/a.ts', 'export const a = 13;\n');
  fs.rmSync(path.join(fixture.root, 'package.json'));
  const reason = assertBlock(stop(fixture, { VERIFY_CHANGES_COMMANDS: 'lint' }));
  assert(reason.includes('NENHUM comando executado'), 'nao avisa que nada rodou');
  assert(reason.includes('package.json'), 'nao explica o motivo');
});

check('sem package.json e com NOTIFY=on-run o hook fica inerte', () => {
  const fixture = makeFixture({ lint: OK_SCRIPT });
  const env = { VERIFY_CHANGES_COMMANDS: 'lint', VERIFY_CHANGES_NOTIFY: 'on-run' };
  start(fixture, env);
  touch(fixture, 'src/a.ts', 'export const a = 13;\n');
  fs.rmSync(path.join(fixture.root, 'package.json'));
  assertAllow(stop(fixture, env));
});

check('lista de comandos vazia desliga o gate', () => {
  const fixture = makeFixture({ lint: OK_SCRIPT });
  const env = { VERIFY_CHANGES_COMMANDS: '', VERIFY_CHANGES_FORMAT: '' };
  start(fixture, env);
  touch(fixture, 'src/a.ts', 'export const a = 14;\n');
  assertAllow(stop(fixture, env));
});

check('sem baseline (sessao retomada) cai no git e nao explode', () => {
  const fixture = makeFixture({ lint: OK_SCRIPT });
  // why: nenhum sessionStart rodou - e o caso de hook instalado no meio da sessao.
  touch(fixture, 'src/a.ts', 'export const a = 15;\n');
  const out = stop(fixture, { VERIFY_CHANGES_COMMANDS: 'lint' });
  assert(out.status === 0 || out.status === 2, `exit inesperado ${out.status}`);
  if (out.json !== null) assert(out.json.decision === 'block', 'decisao inesperada');
});

// --- sessionStart -------------------------------------------------------------------------------

check('sessionStart avisa o agente sobre o gate', () => {
  const fixture = makeFixture({ lint: OK_SCRIPT });
  const out = start(fixture, { VERIFY_CHANGES_COMMANDS: 'lint,build' });
  assert(out.status === 0, `exit ${out.status}`);
  assert(out.json !== null, 'sessionStart nao injetou contexto');
  // hazard: no Claude Code o `additionalContext` de SessionStart vive DENTRO de
  // `hookSpecificOutput`. No topo do objeto ele reprova a validacao de schema e o aviso nao
  // chega ao agente - a sessao comeca sem saber que existe um gate no encerramento.
  assert(out.json.additionalContext === undefined, 'contexto no topo do objeto reprova o schema');
  const context = out.json.hookSpecificOutput?.additionalContext ?? '';
  assert(context.includes('npm run lint'), 'contexto nao lista os comandos');
  assert(context.includes('src'), 'contexto nao cita o caminho observado');
});

check('sessionStart zera as tentativas de uma sessao anterior', () => {
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

// --- resultado ------------------------------------------------------------------------------------

// --- contrato do SessionStart no Claude Code -------------------------------------------------

check('sessionStart: o aviso sai em hookSpecificOutput.additionalContext', () => {
  const fixture = makeFixture({ lint: OK_SCRIPT });
  const out = start(fixture, { VERIFY_CHANGES_COMMANDS: 'lint' });
  assert(out.status === 0, `exit ${out.status}`);
  const hso = out.json?.hookSpecificOutput ?? {};
  assert(hso.hookEventName === 'SessionStart', `hookEventName ${hso.hookEventName}`);
  assert(
    out.json.additionalContext === undefined,
    'aviso no topo do objeto reprova a validacao de schema',
  );
  const note = hso.additionalContext ?? '';
  assert(note.includes('[verify-changes]'), 'aviso sem prefixo do hook');
  assert(note.includes('npm run lint'), 'aviso nao diz o que vai rodar');
});

check('sessionStart e reconhecido pelo hook_event_name, sem --event=', () => {
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
    'nao reconheceu o evento pelo hook_event_name',
  );
});

check('Stop e reconhecido pelo hook_event_name, sem --event=', () => {
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
  assert(json.decision === 'block', `nao bloqueou: ${proc.stdout}`);
  assert((json.reason ?? '').includes('COM FALHAS'), 'nao reportou a falha');
});

// --- configuracao por argumento de linha de comando (o caminho do settings.json) ------------

check('--commands= e --paths= por argumento substituem os defaults', () => {
  const fixture = makeFixture({ lint: FAIL_SCRIPT, outro: OK_SCRIPT });
  const base = [`--state-dir=${fixture.stateDir}`, '--paths=src', '--format='];
  const call = (event, extra) =>
    spawnSync(process.execPath, [SCRIPT, `--event=${event}`, ...base, ...extra], {
      input: JSON.stringify({ session_id: fixture.sessionId, cwd: fixture.root }),
      encoding: 'utf8',
      // hazard: env limpa de proposito - se o argumento nao funcionar, o teste tem de falhar,
      // e nao cair na env var e passar por acidente.
      env: { ...process.env, VERIFY_CHANGES_STATE_DIR: '', VERIFY_CHANGES_COMMANDS: '' },
    });

  call('sessionStart', ['--commands=outro']);
  touch(fixture, 'src/a.ts', 'export const a = 42;\n');
  const out = call('agentStop', ['--commands=outro']);
  const json = JSON.parse(out.stdout.trim());
  assert(json.decision === 'block', `nao bloqueou: ${out.stdout}`);
  assert((json.reason ?? '').includes('npm run outro'), 'nao rodou o script do argumento');
  assert(!(json.reason ?? '').includes('npm run lint'), 'rodou um script que nao foi pedido');
});

const failed = results.filter((result) => !result.ok);
for (const result of results) {
  process.stdout.write(`${result.ok ? 'ok  ' : 'FAIL'} ${result.name}\n`);
  if (!result.ok) process.stdout.write(`     ${result.message}\n`);
}
process.stdout.write(`\n${results.length - failed.length}/${results.length} passaram\n`);
process.exitCode = failed.length === 0 ? 0 : 1;
