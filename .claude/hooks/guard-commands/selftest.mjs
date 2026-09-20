#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./guard-commands.mjs', import.meta.url));

// why: os checks abaixo sao escritos na forma abreviada (`toolName`/`toolArgs`), que e mais
// curta de ler. Esta traducao os reescreve para o formato real do Claude Code antes de
// chegarem ao hook, entao a suite inteira exercita o caminho de producao sem que nenhum check
// precise repetir o envelope do payload. Os checks que mandam `toolCalls` ficam intactos de
// proposito: eles cobrem o suporte a payload em lote.
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
  assert(out.status === 2, `exit ${out.status} (esperado 2 = deny em PreToolUse)`);
  assert(out.json !== null, 'nao negou: stdout vazio');
  assert(out.stderr.includes('[guard-commands]'), 'motivo ausente no stderr');
  // hazard: no Claude Code a decisao TEM de estar dentro de `hookSpecificOutput`. No topo do
  // objeto ela reprova a validacao de schema e vira erro nao-bloqueante - o comando passa.
  const hso = out.json.hookSpecificOutput ?? {};
  assert(hso.hookEventName === 'PreToolUse', `hookEventName ${hso.hookEventName}`);
  assert(out.json.permissionDecision === undefined, 'decisao no topo do objeto reprova o schema');
  assert(hso.permissionDecision === 'deny', `decisao ${hso.permissionDecision}`);
  const reason = hso.permissionDecisionReason ?? '';
  assert(reason.includes('[guard-commands]'), 'motivo sem prefixo do hook');
  if (expectedRule)
    assert(reason.includes(expectedRule), `motivo nao cita a regra ${expectedRule}`);
}

function assertAllow(out) {
  assert(out.status === 0, `exit ${out.status}`);
  assert(out.stdout === '', `deveria ficar em silencio, mas respondeu: ${out.stdout}`);
}

// why: o motivo mudou de lugar na migracao (topo do objeto -> `hookSpecificOutput`). Um unico
// ponto de leitura evita que o proximo ajuste de formato tenha de passar por cada check.
function reasonOf(out) {
  return out.json?.hookSpecificOutput?.permissionDecisionReason ?? '';
}

// --- bloqueio dos comandos destrutivos padrao ---------------------------------------------

check('git push e negado', () => {
  assertDeny(bash('git push'), 'git push');
});

check('git push --force e negado', () => {
  assertDeny(bash('git push --force origin main'), 'git push');
});

check('git push -f e negado', () => {
  assertDeny(bash('git push -f'));
});

check('git push --force-with-lease e negado', () => {
  assertDeny(bash('git push --force-with-lease origin HEAD'));
});

check('git reset --hard e negado', () => {
  assertDeny(bash('git reset --hard HEAD~1'), 'git reset --hard');
});

check('git clean -fd e negado (flags coladas)', () => {
  assertDeny(bash('git clean -fd'), 'git clean -f');
});

check('rm -rf e negado', () => {
  assertDeny(bash('rm -rf /workspace/dist'), 'rm -rf');
});

check('rm -r -f separado tambem e negado', () => {
  assertDeny(bash('rm -r -f dist'));
});

check('npm publish e negado', () => {
  assertDeny(bash('npm publish --access public'), 'npm publish');
});

check('powershell Remove-Item -Recurse -Force e negado', () => {
  assertDeny(
    run({ toolName: 'powershell', toolArgs: { command: 'Remove-Item -Recurse -Force .\\dist' } }),
  );
});

check('git branch -D e negado', () => {
  assertDeny(bash('git branch -D feature/x'), 'git branch -D');
});

check('git branch -d (seguro) passa', () => {
  assertAllow(bash('git branch -d feature/x'));
});

// --- contornos -----------------------------------------------------------------------------

check('git push depois de && e negado', () => {
  assertDeny(bash('npm test && git push'));
});

check('git push depois de ; e negado', () => {
  assertDeny(bash('npm run build ; git push origin main'));
});

check('git push dentro de bash -c e negado', () => {
  assertDeny(bash('bash -c "git push --force"'));
});

check('git push com sudo/wrapper e negado', () => {
  assertDeny(bash('sudo git push'));
});

check('git push com -c antes do subcomando e negado', () => {
  assertDeny(bash('git -c user.name=bot push origin main'));
});

check('git push dentro de subshell e negado', () => {
  assertDeny(bash('cd repo && (git push)'));
});

check('echo canalizado para shell e negado', () => {
  assertDeny(bash('echo "git push" | bash'));
});

check('git push dentro de script npm inline e negado', () => {
  assertDeny(
    run({ toolName: 'bash', toolArgs: { command: 'npm run deploy', script: 'git push --tags' } }),
  );
});

check('exec + args e remontado antes de decidir', () => {
  assertDeny(run({ toolName: 'bash', toolArgs: { exec: 'git', args: ['push', '--force'] } }));
});

// --- o que deve continuar passando -----------------------------------------------------------

check('git status passa', () => {
  assertAllow(bash('git status --short'));
});

check('git commit passa', () => {
  assertAllow(bash('git commit -m "feat: nova rota"'));
});

check('git commit -m com a palavra push passa', () => {
  assertAllow(bash('git commit -m "prepara push manual"'));
});

check('git pull passa', () => {
  assertAllow(bash('git pull --rebase'));
});

check('npm test passa', () => {
  assertAllow(bash('npm test'));
});

check('rm simples (sem -rf) passa', () => {
  assertAllow(bash('rm dist/index.js'));
});

check('echo mencionando git push passa', () => {
  assertAllow(bash('echo "o humano precisa rodar git push depois"'));
});

check('git push --dry-run passa (allow padrao)', () => {
  assertAllow(bash('git push --dry-run origin main'));
});

check('tool de escrita nao e analisada por este hook', () => {
  assertAllow(
    run({
      toolName: 'create',
      toolArgs: { path: 'docs/deploy.md', file_text: 'Rode `git push --force` manualmente.' },
    }),
  );
});

check('tool de leitura passa', () => {
  assertAllow(run({ toolName: 'view', toolArgs: { path: 'README.md' } }));
});

// --- payload em lote: toolCalls[] com args em string JSON -------------------------------------
// why: um runtime pode entregar varias chamadas numa invocacao so, com `args` empacotado como
// string JSON. Ler apenas `tool_name`/`tool_input` faria o hook liberar esse lote em silencio.

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

check('formato toolCalls[] com args em string JSON e negado', () => {
  assertDeny(
    // hazard: `npm install` nao esta em regra nenhuma por padrao - a regra vem no argumento.
    // O que este check prova nao e a regra, e que o `args` chegando como STRING JSON e
    // desempacotado antes da analise; sem isso o comando passaria batido.
    batched(
      'powershell',
      {
        command: 'npm install',
        description: 'Instala dependencias do projeto',
        mode: 'sync',
        initial_wait: 120,
      },
      ['--deny=npm install'],
    ),
    'npm install',
  );
});

check('formato toolCalls[] libera comando comum', () => {
  assertAllow(batched('powershell', { command: 'npm test', description: 'Roda os testes' }));
});

check('formato toolCalls[] ignora tool de leitura', () => {
  assertAllow(batched('rg', { pattern: 'git push', paths: ['docs/deploy.md'] }));
});

check('lote de toolCalls: basta um comando bloqueado', () => {
  assertDeny(
    run({
      sessionId: 'lote',
      toolCalls: [
        { id: 'a', name: 'powershell', args: JSON.stringify({ command: 'git status' }) },
        { id: 'b', name: 'powershell', args: JSON.stringify({ command: 'git push --force' }) },
      ],
    }),
  );
});

check('args ja como objeto tambem funciona', () => {
  assertDeny(run({ toolCalls: [{ name: 'bash', args: { command: 'git reset --hard' } }] }));
});

check('payload snake_case (VS Code) tambem e negado', () => {
  assertDeny(
    run({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'git push --force', description: 'Enviar commits' },
    }),
  );
});

check('description nao dispara bloqueio sozinha', () => {
  assertAllow(
    run({
      toolName: 'Bash',
      toolArgs: { command: 'git log --oneline -5', description: 'Checar antes do git push' },
    }),
  );
});

// --- configuracao por env ---------------------------------------------------------------------

check('GUARD_COMMANDS_DENY customizado bloqueia outro comando', () => {
  assertDeny(bash('docker compose down -v', { GUARD_COMMANDS_DENY: 'docker compose down' }));
});

check('GUARD_COMMANDS_DENY customizado libera os defaults', () => {
  assertAllow(bash('git push --force', { GUARD_COMMANDS_DENY: 'docker compose down' }));
});

check('GUARD_COMMANDS_ALLOW abre excecao', () => {
  assertAllow(
    bash('git push origin refs/notes/*', { GUARD_COMMANDS_ALLOW: 'git push origin refs/*' }),
  );
});

check('GUARD_COMMANDS_ALLOW vazio fecha ate o dry-run', () => {
  assertDeny(bash('git push --dry-run', { GUARD_COMMANDS_ALLOW: '' }));
});

check('curinga na regra funciona', () => {
  assertDeny(bash('terraform destroy -auto-approve', { GUARD_COMMANDS_DENY: 'terraform destr*' }));
});

// --- contrato de saida -------------------------------------------------------------------------

check('motivo diz que o comando e destrutivo e nao rodou', () => {
  const reason = reasonOf(bash('git push'));
  assert(reason.includes('destrutiv'), 'motivo nao classifica o comando como destrutivo');
  assert(reason.includes('nada mudou'), 'motivo nao deixa claro que nada foi executado');
});

check('motivo manda o agente reportar comando e razao ao humano', () => {
  const reason = reasonOf(bash('git push'));
  assert(reason.includes('humano'), 'motivo nao manda envolver o humano');
  assert(reason.includes('comando exato'), 'motivo nao pede o comando exato tentado');
  assert(reason.includes('por que'), 'motivo nao pede a razao da tentativa');
  assert(reason.includes('manualmente'), 'motivo nao diz que o humano executa manualmente');
});

check('motivo cita o comando tentado', () => {
  const reason = reasonOf(bash('git push --force origin main'));
  assert(reason.includes('git push --force origin main'), 'motivo nao cita o comando tentado');
});

check('saida e um unico objeto JSON, todo dentro de hookSpecificOutput', () => {
  const out = bash('git push');
  assert(out.stdout.split('\n').length === 1, 'emitiu mais de uma linha');
  // hazard: o Claude Code valida o objeto inteiro. Campo extra no topo, ou a decisao fora de
  // `hookSpecificOutput`, reprova a validacao e o bloqueio vira erro NAO-bloqueante.
  assert(Object.keys(out.json).join(',') === 'hookSpecificOutput', 'campos inesperados no topo');
  assert(
    Object.keys(out.json.hookSpecificOutput).sort().join(',') ===
      'hookEventName,permissionDecision,permissionDecisionReason',
    'campos inesperados na decisao',
  );
});

check('stdin vazio nao bloqueia nada', () => {
  assertAllow(run(''));
});

check('stdin ilegivel nega (fail-closed)', () => {
  const out = run('isto nao e json');
  assert(out.json?.hookSpecificOutput?.permissionDecision === 'deny', 'nao negou payload ilegivel');
  assert(out.status === 2, `exit ${out.status} - fail-closed precisa do exit 2`);
});

// --- configuracao por argumento de linha de comando (o caminho do settings.json) ------------

check('--deny= substitui a lista padrao', () => {
  const out = runArgs({ toolName: 'bash', toolArgs: { command: 'docker compose down -v' } }, [
    '--deny=docker compose down -v',
  ]);
  assertDeny(out, 'docker compose down -v');
});

check('--deny= por argumento desliga as regras default', () => {
  assertAllow(
    runArgs({ toolName: 'bash', toolArgs: { command: 'git push' } }, ['--deny=npm publish']),
  );
});

check('--allow= vence a lista de deny', () => {
  assertAllow(
    runArgs({ toolName: 'bash', toolArgs: { command: 'git push --dry-run origin main' } }, [
      '--allow=git push --dry-run',
    ]),
  );
});

check('--allow= vazio significa nenhuma excecao, nao o default', () => {
  assertDeny(
    runArgs({ toolName: 'bash', toolArgs: { command: 'git push --dry-run' } }, ['--allow=']),
    'git push',
  );
});

check('argumento tem prioridade sobre a env var', () => {
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
process.stdout.write(`\n${results.length - failed.length}/${results.length} passaram\n`);
process.exitCode = failed.length === 0 ? 0 : 1;
