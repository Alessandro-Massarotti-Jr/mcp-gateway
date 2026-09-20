#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./mask-env.mjs', import.meta.url));

const ENV_FILE = [
  '# credenciais locais',
  'DATABASE_URL=postgres://admin:s3nh4@db.internal:5432/app',
  'SENTRY_DSN="https://abc123@o1.ingest.sentry.io/42"',
  'export FIREBASE_API_KEY=AIzaSyD-super-secreto',
  'EMPTY_VAR=',
  '',
  '# OLD_DATABASE_URL=postgres://admin:antig4@old.internal:5432/legacy',
  '## LEGACY_TOKEN = ghp_tokenAntigoQueNinguemRemoveu',
  'USERS_API_URL=https://users.internal',
].join('\n');

const MULTILINE = [
  'JWT_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----',
  'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQ',
  '-----END PRIVATE KEY-----"',
  'PORT=3333',
].join('\n');

// why: os checks abaixo sao escritos na forma abreviada (`toolName`/`toolArgs`/`toolResult`),
// que e mais curta de ler. Esta traducao os reescreve para o formato real do Claude Code antes
// de chegarem ao hook, entao a suite inteira exercita o caminho de producao sem que nenhum
// check precise repetir o envelope do payload.
//
// hazard: `toolResult` vira `tool_response` E MANTEM A FORMA DE OBJETO. E justamente isso que
// os checks precisam provar: o hook devolve `updatedToolOutput` com a mesma forma que recebeu,
// porque um valor de forma diferente e descartado pelo runtime e o texto cru chega ao modelo.
function toClaudePayload(payload) {
  if (typeof payload === 'string' || payload === null || typeof payload !== 'object') return payload;
  const { toolName, toolArgs, toolResult, sessionId, ...rest } = payload;
  return {
    hook_event_name: 'PostToolUse',
    session_id: sessionId ?? 'selftest',
    ...rest,
    ...(toolName === undefined ? {} : { tool_name: toolName }),
    ...(toolArgs === undefined ? {} : { tool_input: toolArgs }),
    ...(toolResult === undefined ? {} : { tool_response: toolResult }),
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

// why: a saida mascarada nao e mais um texto solto - ela e o `updatedToolOutput`, com a forma
// da saida original da tool. Os checks continuam perguntando "que texto sobrou?", entao esta
// funcao junta as strings de onde quer que elas estejam dentro dessa forma.
function textLeaves(node, out = [], depth = 0) {
  if (depth > 8) return out;
  if (typeof node === 'string') out.push(node);
  else if (Array.isArray(node)) for (const item of node) textLeaves(item, out, depth + 1);
  else if (node !== null && typeof node === 'object') {
    for (const value of Object.values(node)) textLeaves(value, out, depth + 1);
  }
  return out;
}

function maskedTextOf(result) {
  const updated = result.json?.hookSpecificOutput?.updatedToolOutput;
  if (updated === undefined) return '';
  if (typeof updated === 'string') return updated;
  return (
    updated.textResultForLlm ??
    updated.stdout ??
    updated.file?.content ??
    updated.content ??
    textLeaves(updated).join('\n')
  );
}

// hazard: o runtime DESCARTA um `updatedToolOutput` cuja forma nao bate com a saida da tool, e
// ai o conteudo cru chega ao modelo. Este assert e o que impede essa regressao.
function assertSameShape(original, updated, trail = 'raiz') {
  const kind = (value) =>
    value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  assert(
    kind(original) === kind(updated),
    `forma mudou em ${trail}: ${kind(original)} -> ${kind(updated)}`,
  );
  if (Array.isArray(original)) {
    assert(original.length === updated.length, `tamanho do array mudou em ${trail}`);
    original.forEach((item, i) => assertSameShape(item, updated[i], `${trail}[${i}]`));
    return;
  }
  if (original !== null && typeof original === 'object') {
    const a = Object.keys(original).sort().join(',');
    const b = Object.keys(updated).sort().join(',');
    assert(a === b, `chaves mudaram em ${trail}: ${a} -> ${b}`);
    for (const key of Object.keys(original)) {
      assertSameShape(original[key], updated[key], `${trail}.${key}`);
    }
  }
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

check('view .env: mascara valores e preserva nomes', () => {
  const out = run({
    sessionId: 's1',
    timestamp: Date.now(),
    cwd: '.',
    toolName: 'view',
    toolArgs: { path: '.env' },
    toolResult: { resultType: 'success', textResultForLlm: ENV_FILE },
  });
  assert(out.status === 0, `exit ${out.status}`);
  const text = maskedTextOf(out);
  assert(text.includes('DATABASE_URL=<censurado>'), 'DATABASE_URL nao mascarado');
  assert(text.includes('SENTRY_DSN=<censurado>'), 'SENTRY_DSN nao mascarado');
  assert(text.includes('export FIREBASE_API_KEY=<censurado>'), 'export nao preservado');
  assert(!text.includes('s3nh4'), 'senha vazou');
  assert(!text.includes('AIzaSyD-super-secreto'), 'api key vazou');
  assert(!text.includes('sentry.io/42'), 'dsn vazou');
});

check('view .env: preserva comentarios, linhas vazias e valor vazio', () => {
  const out = run({
    toolName: 'view',
    toolArgs: { path: '.env' },
    toolResult: { resultType: 'success', textResultForLlm: ENV_FILE },
  });
  const text = maskedTextOf(out);
  assert(text.includes('# credenciais locais'), 'comentario removido');
  assert(text.includes('EMPTY_VAR='), 'variavel vazia alterada');
  assert(!text.includes('EMPTY_VAR=<censurado>'), 'variavel vazia mascarada a toa');
  assert(text.split('\n').length === ENV_FILE.split('\n').length, 'numero de linhas mudou');
});

check('credencial em linha comentada tambem e mascarada', () => {
  const out = run({
    toolName: 'view',
    toolArgs: { path: '.env' },
    toolResult: { resultType: 'success', textResultForLlm: ENV_FILE },
  });
  const text = maskedTextOf(out);
  assert(!text.includes('antig4'), 'senha em comentario vazou');
  assert(!text.includes('ghp_tokenAntigoQueNinguemRemoveu'), 'token em comentario vazou');
  assert(text.includes('# OLD_DATABASE_URL=<censurado>'), 'comentario simples nao preservou a chave');
  assert(text.includes('## LEGACY_TOKEN = <censurado>'), 'comentario duplo nao preservou a chave');
});

check('saida de rg com prefixo de caminho e mascarada', () => {
  const hit =
    'C:\\Users\\alema\\projetos\\exemplo-api\\.env:PG_SQL_CONN_URL=postgresql://user:p4ss@host:35432/db';
  const out = run({
    toolName: 'rg',
    toolArgs: {
      pattern: '^PG_SQL_CONN_URL=.*$',
      paths: 'C:\\Users\\alema\\projetos\\exemplo-api\\.env',
      output_mode: 'content',
    },
    toolResult: { resultType: 'success', textResultForLlm: hit },
  });
  const text = maskedTextOf(out);
  assert(!text.includes('p4ss'), 'senha vazou na saida do rg');
  assert(!text.includes('35432/db'), 'host e porta vazaram na saida do rg');
  assert(text.includes('PG_SQL_CONN_URL=<censurado>'), 'chave perdida na saida do rg');
  assert(text.includes('.env:'), 'prefixo de caminho foi destruido');
});

check('saida de grep no .env com caminho e numero de linha e mascarada', () => {
  const hit = '.env:18:MONGO_INVITATIONS_COLLECTION=invitations-prod';
  const out = run({
    toolName: 'grep',
    toolArgs: { pattern: 'MONGO_INVITATIONS_COLLECTION', paths: '.env' },
    toolResult: { resultType: 'success', textResultForLlm: hit },
  });
  const text = maskedTextOf(out);
  assert(!text.includes('invitations-prod'), 'valor vazou com prefixo path:lineno:');
  assert(text.includes('MONGO_INVITATIONS_COLLECTION=<censurado>'), 'chave perdida');
  assert(text.includes('.env:18:'), 'prefixo path:lineno: foi destruido');
});

check('view com view_range: numeracao "168. " nao engana o mascarador', () => {
  const ranged = [
    '168.',
    '169. ENTERPRISE_ACCESS_REQUEST_REJECTED_MAIL_TEMPLATE="AccessRequestRejectedTemplate"',
    '170. REVIEW_ENTERPRISE_ACCESS_REQUEST_MAIL_TEMPLATE="AdminReviewEnterpriseAccessRequest"',
    '171.',
    "172. ENTERPRISE_MIN_CREATED_DATE_ALLOWED='2026-07-28'",
    "173. IGNORE_CUSTOMER_OWNER_NO='13030'",
    '177. ABACATE=bonito',
  ].join('\n');
  const out = run({
    toolName: 'view',
    toolArgs: { path: 'C:\\proj\\exemplo-api\\.env', view_range: [168, 177] },
    toolResult: { resultType: 'success', textResultForLlm: ranged },
  });
  const text = maskedTextOf(out);
  assert(!text.includes('AccessRequestRejectedTemplate'), 'valor vazou com numeracao "168. "');
  assert(!text.includes('2026-07-28'), 'data vazou');
  assert(!text.includes('13030'), 'numero vazou');
  assert(!text.includes('bonito'), 'ABACATE vazou');
  assert(text.includes('169. ENTERPRISE_ACCESS_REQUEST_REJECTED_MAIL_TEMPLATE=<censurado>'), 'chave ou numeracao perdida');
  assert(text.includes('177. ABACATE=<censurado>'), 'ultima linha nao mascarada');
  assert(text.split('\n')[0] === '168.', 'linha numerada vazia foi alterada');
});

check('numeracao em outros formatos tambem e coberta', () => {
  for (const linha of ['  12| SECRET=abc', '12→SECRET=abc', '12: SECRET=abc', '  12\tSECRET=abc', '12) SECRET=abc']) {
    const out = run({
      toolName: 'view',
      toolArgs: { path: '.env' },
      toolResult: { resultType: 'success', textResultForLlm: linha },
    });
    assert(!maskedTextOf(out).includes('abc'), `valor vazou no formato: ${JSON.stringify(linha)}`);
  }
});

check('.env.sample e legivel: view passa intacto', () => {
  const out = run({
    toolName: 'view',
    toolArgs: { path: 'C:\\proj\\exemplo-api\\.env.sample' },
    toolResult: { resultType: 'success', textResultForLlm: ENV_FILE },
  });
  assert(out.status === 0, `exit ${out.status}`);
  assert(out.stdout === '', `hook mascarou o .env.sample: ${out.stdout}`);
});

check('.env.example / .env.template / .env.dist tambem sao legiveis', () => {
  for (const name of ['.env.example', 'infra/.env.template', '.env.dist']) {
    const out = run({
      toolName: 'view',
      toolArgs: { path: name },
      toolResult: { resultType: 'success', textResultForLlm: ENV_FILE },
    });
    assert(out.stdout === '', `hook mascarou ${name}`);
  }
});

check('rg no .env.sample passa intacto', () => {
  const hit = '.env.sample:PG_SQL_CONN_URL=postgresql://user:pass@host:5432/db';
  const out = run({
    toolName: 'rg',
    toolArgs: { pattern: '^PG_SQL_CONN_URL=.*$', paths: '.env.sample' },
    toolResult: { resultType: 'success', textResultForLlm: hit },
  });
  assert(out.stdout === '', 'hook mascarou busca no .env.sample');
});

check('busca nos dois arquivos: mascara so as linhas do .env', () => {
  const hits = [
    '.env.sample:PG_SQL_CONN_URL=postgresql://user:pass@host:5432/db',
    '.env:PG_SQL_CONN_URL=postgresql://admin:s3nh4Real@prod.rds.amazonaws.com:35432/app',
  ].join('\n');
  const out = run({
    toolName: 'rg',
    toolArgs: { pattern: '^PG_SQL_CONN_URL=.*$', paths: ['.env.sample', '.env'] },
    toolResult: { resultType: 'success', textResultForLlm: hits },
  });
  const text = maskedTextOf(out);
  assert(!text.includes('s3nh4Real'), 'senha real vazou');
  assert(text.includes('.env.sample:PG_SQL_CONN_URL=postgresql://user:pass@host:5432/db'), 'linha do sample foi mascarada');
  assert(text.includes('.env:PG_SQL_CONN_URL=<censurado>'), 'linha do .env nao foi mascarada');
});

check('MASK_ENV_ALLOW vazio volta a mascarar o sample', () => {
  const out = run(
    {
      toolName: 'view',
      toolArgs: { path: '.env.sample' },
      toolResult: { resultType: 'success', textResultForLlm: ENV_FILE },
    },
    { MASK_ENV_ALLOW: '' },
  );
  assert(!maskedTextOf(out).includes('s3nh4'), 'allowlist vazia nao voltou a mascarar');
});

check('URL solta nao e confundida com atribuicao', () => {
  const out = run({
    toolName: 'view',
    toolArgs: { path: '.env' },
    toolResult: {
      resultType: 'success',
      textResultForLlm: 'https://user:pw@host/path?a=b\nPORT=3333',
    },
  });
  const text = maskedTextOf(out);
  assert(text.includes('https://user:pw@host/path?a=b'), 'URL sem atribuicao foi alterada');
  assert(text.includes('PORT=<censurado>'), 'atribuicao seguinte nao foi mascarada');
});

check('powershell lendo .env e mascarado', () => {
  const out = run({
    toolName: 'powershell',
    toolArgs: {
      command: "$line = Get-Content '.env' | Where-Object { $_ -match '^\\s*PG_SQL_CONN_URL\\s*=' }; $line",
    },
    toolResult: {
      resultType: 'success',
      textResultForLlm: 'PG_SQL_CONN_URL=postgresql://user:p4ss@host:35432/db\n<shellId: 4 completed with exit code 0>',
    },
  });
  const text = maskedTextOf(out);
  assert(!text.includes('p4ss'), 'senha vazou via powershell');
  assert(text.includes('PG_SQL_CONN_URL=<censurado>'), 'chave perdida via powershell');
});

check('bash cat .env: mascara pelo comando', () => {
  const out = run({
    toolName: 'bash',
    toolArgs: { command: 'cat ./.env | head -20' },
    toolResult: { resultType: 'success', textResultForLlm: ENV_FILE },
  });
  assert(!maskedTextOf(out).includes('s3nh4'), 'senha vazou via bash');
});

check('bash printenv: mascara dump de ambiente', () => {
  const out = run({
    toolName: 'bash',
    toolArgs: { command: 'printenv' },
    toolResult: { resultType: 'success', textResultForLlm: ENV_FILE },
  });
  assert(!maskedTextOf(out).includes('s3nh4'), 'senha vazou via printenv');
});

check('.env.production: variantes do arquivo sao cobertas', () => {
  const out = run({
    toolName: 'view',
    toolArgs: { path: 'infra/.env.production' },
    toolResult: { resultType: 'success', textResultForLlm: ENV_FILE },
  });
  assert(!maskedTextOf(out).includes('s3nh4'), 'senha vazou em .env.production');
});

check('payload snake_case (VS Code) e aceito', () => {
  const out = run({
    hook_event_name: 'PostToolUse',
    session_id: 's2',
    tool_name: 'view',
    tool_input: { path: '.env' },
    tool_result: { result_type: 'success', text_result_for_llm: ENV_FILE },
  });
  assert(!maskedTextOf(out).includes('s3nh4'), 'senha vazou no formato snake_case');
  assert(maskedTextOf(out).includes('DATABASE_URL=<censurado>'), 'chave perdida no snake_case');
});

check('saida com numeros de linha e mascarada', () => {
  const numbered = ENV_FILE.split('\n')
    .map((line, index) => `${String(index + 1).padStart(4)}\t${line}`)
    .join('\n');
  const out = run({
    toolName: 'view',
    toolArgs: { path: '.env' },
    toolResult: { resultType: 'success', textResultForLlm: numbered },
  });
  const text = maskedTextOf(out);
  assert(!text.includes('s3nh4'), 'senha vazou com numeracao de linha');
  assert(text.includes('DATABASE_URL=<censurado>'), 'chave perdida com numeracao');
});

check('valor multilinha entre aspas nao vaza continuacao', () => {
  const out = run({
    toolName: 'view',
    toolArgs: { path: '.env' },
    toolResult: { resultType: 'success', textResultForLlm: MULTILINE },
  });
  const text = maskedTextOf(out);
  assert(!text.includes('MIIEvQ'), 'corpo da chave privada vazou');
  assert(!text.includes('BEGIN PRIVATE KEY'), 'cabecalho da chave vazou');
  assert(text.includes('PORT=<censurado>'), 'linha apos o bloco nao foi processada');
});

check('arquivo sem relacao com env passa intacto', () => {
  const out = run({
    toolName: 'view',
    toolArgs: { path: 'src/routes.ts' },
    toolResult: { resultType: 'success', textResultForLlm: 'const port = 3333;\nAPI=1\n' },
  });
  assert(out.status === 0, `exit ${out.status}`);
  assert(out.stdout === '', `hook opinou sobre arquivo comum: ${out.stdout}`);
});

check('stdin invalido nao gera saida nem erro', () => {
  const out = run('isto nao e json');
  assert(out.status === 0, `exit ${out.status}`);
  assert(out.stdout === '', 'produziu saida com stdin invalido');
});

check('resultado vazio nao gera saida', () => {
  const out = run({
    toolName: 'view',
    toolArgs: { path: '.env' },
    toolResult: { resultType: 'success', textResultForLlm: '' },
  });
  assert(out.stdout === '', 'produziu saida para resultado vazio');
});

check('saida e um unico objeto JSON, todo dentro de hookSpecificOutput', () => {
  const out = run({
    toolName: 'view',
    toolArgs: { path: '.env' },
    toolResult: { resultType: 'success', textResultForLlm: ENV_FILE },
  });
  assert(out.stdout.split('\n').length === 1, 'emitiu mais de uma linha');
  // hazard: o runtime valida o objeto inteiro. Campo de decisao solto no topo reprova a
  // validacao e o resultado CRU chega ao modelo - o vazamento exato que este hook existe para
  // evitar.
  assert(Object.keys(out.json).join(',') === 'hookSpecificOutput', 'campos inesperados no topo');
  const hso = out.json.hookSpecificOutput;
  assert(hso.hookEventName === 'PostToolUse', `hookEventName ${hso.hookEventName}`);
  assert(typeof hso.additionalContext === 'string', 'additionalContext ausente');
  // why: a forma da saida original e preservada - o `resultType` continua la, intacto.
  assert(hso.updatedToolOutput.resultType === 'success', 'perdeu a forma da saida original');
});

// --- contrato do updatedToolOutput no Claude Code -------------------------------------------

check('saida do Bash: mascara stdout e preserva a forma {stdout,stderr,interrupted,isImage}', () => {
  const original = { stdout: ENV_FILE, stderr: '', interrupted: false, isImage: false };
  const out = run({
    toolName: 'Bash',
    toolArgs: { command: 'cat .env' },
    toolResult: original,
  });
  const updated = out.json?.hookSpecificOutput?.updatedToolOutput;
  assert(updated !== undefined, 'nao devolveu updatedToolOutput');
  assertSameShape(original, updated);
  assert(!updated.stdout.includes('s3nh4'), 'senha vazou no stdout');
  assert(updated.stdout.includes('DATABASE_URL='), 'perdeu o nome da variavel');
  assert(updated.interrupted === false, 'booleano virou outra coisa');
});

check('saida do Read: mascara file.content e preserva a forma aninhada', () => {
  const original = {
    type: 'text',
    file: {
      filePath: '/repo/.env',
      content: ENV_FILE,
      numLines: 9,
      startLine: 1,
      totalLines: 9,
    },
  };
  const out = run({ toolName: 'Read', toolArgs: { file_path: '/repo/.env' }, toolResult: original });
  const updated = out.json?.hookSpecificOutput?.updatedToolOutput;
  assert(updated !== undefined, 'nao devolveu updatedToolOutput');
  assertSameShape(original, updated);
  assert(!updated.file.content.includes('s3nh4'), 'senha vazou no content');
  assert(updated.file.numLines === 9, 'numero virou outra coisa');
  assert(updated.file.filePath === '/repo/.env', 'caminho nao devia ser tocado');
});

check('a decisao nunca sai no topo do objeto (reprovaria o schema)', () => {
  const out = run({
    toolName: 'Bash',
    toolArgs: { command: 'cat .env' },
    toolResult: { stdout: ENV_FILE, stderr: '', interrupted: false, isImage: false },
  });
  assert(out.json.modifiedResult === undefined, 'saida no formato antigo, de texto solto');
  assert(out.json.updatedToolOutput === undefined, 'updatedToolOutput fora de hookSpecificOutput');
  assert(
    out.json.hookSpecificOutput?.hookEventName === 'PostToolUse',
    'hookEventName ausente ou errado',
  );
});

check('o aviso vai em additionalContext, dentro de hookSpecificOutput', () => {
  const out = run({
    toolName: 'Bash',
    toolArgs: { command: 'cat .env' },
    toolResult: { stdout: ENV_FILE, stderr: '', interrupted: false, isImage: false },
  });
  const note = out.json?.hookSpecificOutput?.additionalContext ?? '';
  assert(note.includes('mask-env'), 'aviso ausente');
  assert(out.json.additionalContext === undefined, 'aviso no topo do objeto reprova o schema');
});

check('--placeholder= por argumento troca o texto do mascaramento', () => {
  const proc = spawnSync(process.execPath, [SCRIPT, '--placeholder=[REDACTED]'], {
    input: JSON.stringify(
      toClaudePayload({
        toolName: 'Bash',
        toolArgs: { command: 'cat .env' },
        toolResult: { stdout: ENV_FILE, stderr: '', interrupted: false, isImage: false },
      }),
    ),
    encoding: 'utf8',
    env: { ...process.env },
  });
  const json = JSON.parse(proc.stdout.trim());
  assert(
    json.hookSpecificOutput.updatedToolOutput.stdout.includes('[REDACTED]'),
    'placeholder do argumento nao foi usado',
  );
});

check('--allow= por argumento libera o arquivo de exemplo', () => {
  const proc = spawnSync(process.execPath, [SCRIPT, '--allow=.env.exemplo'], {
    input: JSON.stringify(
      toClaudePayload({
        toolName: 'Read',
        toolArgs: { file_path: '/repo/.env.exemplo' },
        toolResult: { stdout: ENV_FILE, stderr: '', interrupted: false, isImage: false },
      }),
    ),
    encoding: 'utf8',
    env: { ...process.env },
  });
  assert(proc.stdout.trim() === '', `deveria ficar calado, respondeu: ${proc.stdout}`);
});

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  process.stdout.write(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : ` -> ${r.message}`}\n`);
}
process.stdout.write(`\n${results.length - failed.length}/${results.length} passaram\n`);
process.exitCode = failed.length === 0 ? 0 : 1;
