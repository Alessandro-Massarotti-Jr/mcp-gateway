#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./protect-files.mjs', import.meta.url));

const PATCH = [
  '*** Begin Patch',
  '*** Update File: jest.config.js',
  '@@',
  '-  collectCoverage: true,',
  '+  collectCoverage: false,',
  '*** End Patch',
].join('\n');

// why: os checks abaixo sao escritos na forma abreviada (`toolName`/`toolArgs`), que e mais
// curta de ler. Esta traducao os reescreve para o formato real do Claude Code antes de
// chegarem ao hook, entao a suite inteira exercita o caminho de producao sem que nenhum check
// precise repetir o envelope do payload.
function toClaudePayload(payload) {
  if (typeof payload === 'string' || payload === null || typeof payload !== 'object') return payload;
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

function assertDeny(out, expectedPath) {
  // hazard: exit 2, nao 0. No Claude Code o exit 2 bloqueia PreToolUse sozinho, mesmo se o
  // stdout for descartado.
  assert(out.status === 2, `exit ${out.status} (esperado 2 = deny em PreToolUse)`);
  assert(out.json !== null, 'nao negou: stdout vazio');
  // hazard: no Claude Code a decisao TEM de estar dentro de `hookSpecificOutput`. No topo do
  // objeto ela reprova a validacao de schema e vira erro nao-bloqueante - a escrita passa.
  const hso = out.json.hookSpecificOutput ?? {};
  assert(hso.hookEventName === 'PreToolUse', `hookEventName ${hso.hookEventName}`);
  assert(out.json.permissionDecision === undefined, 'decisao no topo do objeto reprova o schema');
  assert(hso.permissionDecision === 'deny', `decisao ${hso.permissionDecision}`);
  const reason = hso.permissionDecisionReason ?? '';
  assert(reason.includes('[protect-files]'), 'motivo sem prefixo do hook');
  if (expectedPath) assert(reason.includes(expectedPath), `motivo nao cita ${expectedPath}`);
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

// --- bloqueio direto por tool de escrita -------------------------------------------------

check('edit em jest.config.js e negado', () => {
  assertDeny(
    run({
      toolName: 'edit',
      toolArgs: { path: 'jest.config.js', old_str: 'a', new_str: 'b' },
    }),
    'jest.config.js',
  );
});

check('create em .prettierrc.json e negado', () => {
  assertDeny(run({ toolName: 'create', toolArgs: { path: '.prettierrc.json', file_text: '{}' } }));
});

check('Write (formato Claude) em eslint.config.mjs e negado', () => {
  assertDeny(
    run({ toolName: 'Write', toolArgs: { file_path: 'eslint.config.mjs', content: 'x' } }),
  );
});

check('payload snake_case (VS Code) tambem e negado', () => {
  assertDeny(
    run({
      hook_event_name: 'PreToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: '.eslintrc.json', old_string: 'a', new_string: 'b' },
    }),
  );
});

check('caminho absoluto do Windows e negado', () => {
  assertDeny(
    run({
      toolName: 'Edit',
      toolArgs: { file_path: 'C:\\Users\\dev\\repo\\jest.config.js', content: 'x' },
    }),
  );
});

check('caminho absoluto do cloud agent e negado', () => {
  assertDeny(run({ toolName: 'create', toolArgs: { path: '/workspace/.prettierrc.json' } }));
});

check('edits aninhados sao inspecionados', () => {
  assertDeny(
    run({
      toolName: 'multi_edit',
      toolArgs: { edits: [{ path: 'src/routes.ts' }, { path: '.eslintignore' }] },
    }),
  );
});

// --- leitura continua liberada ------------------------------------------------------------

check('view em jest.config.js passa', () => {
  assertAllow(run({ toolName: 'view', toolArgs: { path: 'jest.config.js' } }));
});

check('grep dentro dos arquivos protegidos passa', () => {
  assertAllow(run({ toolName: 'grep', toolArgs: { pattern: 'coverage', path: 'jest.config.js' } }));
});

check('cat do arquivo protegido passa', () => {
  assertAllow(run({ toolName: 'bash', toolArgs: { command: 'cat .prettierrc.json' } }));
});

check('rodar o lint/test passa', () => {
  assertAllow(run({ toolName: 'bash', toolArgs: { command: 'npx jest --config jest.config.js' } }));
});

check('editar arquivo comum passa', () => {
  assertAllow(run({ toolName: 'edit', toolArgs: { path: 'src/routes.ts', new_str: 'x' } }));
});

check('texto que apenas cita o arquivo protegido passa', () => {
  assertAllow(
    run({
      toolName: 'create',
      toolArgs: {
        path: 'docs/testes.md',
        file_text: 'O threshold de cobertura vive em jest.config.js e nao deve ser baixado.',
      },
    }),
  );
});

// --- contornos via shell -------------------------------------------------------------------

check('redirecionamento sobre arquivo protegido e negado', () => {
  assertDeny(run({ toolName: 'bash', toolArgs: { command: 'echo "{}" > .prettierrc.json' } }));
});

check('append por redirecionamento e negado', () => {
  assertDeny(run({ toolName: 'bash', toolArgs: { command: 'echo x >> .eslintignore' } }));
});

check('sed -i e negado', () => {
  assertDeny(
    run({ toolName: 'bash', toolArgs: { command: "sed -i 's/50/0/' jest.config.js" } }),
    'jest.config.js',
  );
});

check('rm do arquivo protegido e negado', () => {
  assertDeny(run({ toolName: 'bash', toolArgs: { command: 'rm -f .eslintrc.json' } }));
});

check('mv do arquivo protegido e negado', () => {
  assertDeny(
    run({ toolName: 'bash', toolArgs: { command: 'mv jest.config.js jest.config.old.js' } }),
  );
});

check('git checkout do arquivo protegido e negado', () => {
  assertDeny(run({ toolName: 'bash', toolArgs: { command: 'git checkout -- .prettierrc.json' } }));
});

check('prettier --write no proprio config e negado', () => {
  assertDeny(
    run({ toolName: 'bash', toolArgs: { command: 'npx prettier --write .prettierrc.json' } }),
  );
});

check('eslint --fix no proprio config e negado', () => {
  assertDeny(
    run({ toolName: 'bash', toolArgs: { command: 'npx eslint --fix eslint.config.mjs' } }),
  );
});

check('powershell Set-Content e negado', () => {
  assertDeny(
    run({
      toolName: 'powershell',
      toolArgs: { command: "Set-Content -Path jest.config.js -Value ''" },
    }),
  );
});

check('powershell Remove-Item e negado', () => {
  assertDeny(
    run({ toolName: 'powershell', toolArgs: { command: 'Remove-Item .\\.eslintrc.json' } }),
  );
});

check('node -e com writeFileSync e negado', () => {
  assertDeny(
    run({
      toolName: 'bash',
      toolArgs: { command: "node -e \"require('fs').writeFileSync('jest.config.js','')\"" },
    }),
  );
});

check('apply_patch no arquivo protegido e negado', () => {
  assertDeny(run({ toolName: 'apply_patch', toolArgs: { input: PATCH } }), 'jest.config.js');
});

check('2> sobre arquivo protegido e negado', () => {
  assertDeny(run({ toolName: 'bash', toolArgs: { command: 'npm test 2> jest.config.js' } }));
});

check('2>&1 sozinho nao dispara bloqueio', () => {
  assertAllow(
    run({ toolName: 'bash', toolArgs: { command: 'cat jest.config.js 2>&1 | head -5' } }),
  );
});

// --- configuracao por env -------------------------------------------------------------------

check('PROTECT_FILES_PATHS customizado protege outro arquivo', () => {
  assertDeny(
    run(
      { toolName: 'edit', toolArgs: { path: 'tsconfig.json' } },
      { PROTECT_FILES_PATHS: 'tsconfig*.json' },
    ),
    'tsconfig.json',
  );
});

check('PROTECT_FILES_PATHS customizado libera os defaults', () => {
  assertAllow(
    run(
      { toolName: 'edit', toolArgs: { path: 'jest.config.js' } },
      { PROTECT_FILES_PATHS: 'tsconfig*.json' },
    ),
  );
});

check('PROTECT_FILES_ALLOW abre excecao', () => {
  assertAllow(
    run(
      { toolName: 'edit', toolArgs: { path: 'jest.config.e2e.js' } },
      { PROTECT_FILES_ALLOW: 'jest.config.e2e.js' },
    ),
  );
});

check('padrao com barra so pega o caminho indicado', () => {
  const env = { PROTECT_FILES_PATHS: 'config/jest.config.js' };
  assertDeny(run({ toolName: 'edit', toolArgs: { path: 'config/jest.config.js' } }, env));
  assertAllow(run({ toolName: 'edit', toolArgs: { path: 'outro/jest.config.js' } }, env));
});

check('PROTECT_FILES_MESSAGE entra no motivo', () => {
  const out = run(
    { toolName: 'edit', toolArgs: { path: 'jest.config.js' } },
    { PROTECT_FILES_MESSAGE: 'Fale com o time de plataforma.' },
  );
  assertDeny(out);
  assert(
    reasonOf(out).includes('Fale com o time de plataforma.'),
    'mensagem extra ausente',
  );
});

// --- contrato de saida -----------------------------------------------------------------------

check('motivo orienta o agente a passar a alteracao para o humano', () => {
  const reason = reasonOf(run({ toolName: 'edit', toolArgs: { path: 'jest.config.js' } }));
  assert(reason.includes('humano'), 'motivo nao manda envolver o humano');
  assert(reason.includes('diff'), 'motivo nao pede o diff proposto');
});

check('saida e um unico objeto JSON, todo dentro de hookSpecificOutput', () => {
  const out = run({ toolName: 'edit', toolArgs: { path: 'jest.config.js' } });
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
  assert(
    out.json?.hookSpecificOutput?.permissionDecision === 'deny',
    'nao negou payload ilegivel',
  );
  assert(out.status === 2, `exit ${out.status} - fail-closed precisa do exit 2`);
});

// --- configuracao por argumento de linha de comando (o caminho do settings.json) ------------

check('--paths= substitui a lista padrao', () => {
  assertDeny(
    runArgs({ toolName: 'write', toolArgs: { path: 'docker-compose.yml', content: 'x' } }, [
      '--paths=docker-compose.yml',
    ]),
    'docker-compose.yml',
  );
});

check('--paths= por argumento desliga os defaults', () => {
  assertAllow(
    runArgs({ toolName: 'write', toolArgs: { path: 'jest.config.js', content: 'x' } }, [
      '--paths=docker-compose.yml',
    ]),
  );
});

check('--allow= abre excecao dentro do --paths=', () => {
  assertAllow(
    runArgs({ toolName: 'write', toolArgs: { path: 'jest.config.js', content: 'x' } }, [
      '--paths=jest.config.*',
      '--allow=jest.config.js',
    ]),
  );
});

check('--message= entra no motivo da recusa', () => {
  const out = runArgs({ toolName: 'write', toolArgs: { path: 'jest.config.js', content: 'x' } }, [
    '--message=Fale com o time de plataforma.',
  ]);
  assertDeny(out, 'jest.config.js');
  assert(
    reasonOf(out).includes('Fale com o time de plataforma.'),
    'mensagem extra ausente do motivo',
  );
});

check('argumento tem prioridade sobre a env var', () => {
  assertDeny(
    runArgs(
      { toolName: 'write', toolArgs: { path: 'docker-compose.yml', content: 'x' } },
      ['--paths=docker-compose.yml'],
      { PROTECT_FILES_PATHS: 'jest.config.*' },
    ),
    'docker-compose.yml',
  );
});

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  process.stdout.write(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : ` -> ${r.message}`}\n`);
}
process.stdout.write(`\n${results.length - failed.length}/${results.length} passaram\n`);
process.exitCode = failed.length === 0 ? 0 : 1;
