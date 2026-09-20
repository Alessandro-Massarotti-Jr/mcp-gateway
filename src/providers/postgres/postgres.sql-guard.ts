import { validationError } from '../../core/errors.js';

/**
 * Guarda das tools de escrita do PostgreSQL: o gateway altera dados,
 * nunca a estrutura do banco.
 *
 * A regra é uma allowlist de comandos — qualquer coisa fora dela é recusada,
 * de modo que um comando novo ou exótico falhe fechado em vez de passar batido.
 *
 * Limite conhecido: a guarda lê o comando, não o que ele executa. Um
 * `SELECT` que chama uma função com DDL dentro (dblink, procedures) continua
 * passando. A barreira definitiva contra mudança de estrutura é um role sem
 * privilégio de DDL no próprio banco; isto aqui é a rede de proteção.
 */

/** Comandos que apenas leem ou alteram dados. */
const ALLOWED_COMMANDS = new Set([
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'WITH',
  'VALUES',
  'TABLE',
  'SHOW',
  'EXPLAIN',
]);

/** `EXPLAIN ANALYZE` executa de verdade, então o alvo também passa pela regra. */
const ALLOWED_EXPLAIN_TARGETS = new Set([
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'WITH',
  'VALUES',
  'TABLE',
]);

/** Palavras que podem aparecer entre `EXPLAIN` e a instrução analisada. */
const EXPLAIN_OPTION_WORDS = new Set([
  'ANALYZE',
  'ANALYSE',
  'VERBOSE',
  'COSTS',
  'SETTINGS',
  'GENERIC_PLAN',
  'BUFFERS',
  'WAL',
  'TIMING',
  'SUMMARY',
  'MEMORY',
  'SERIALIZE',
  'FORMAT',
  'TRUE',
  'FALSE',
  'ON',
  'OFF',
  'TEXT',
  'XML',
  'JSON',
  'YAML',
  'NONE',
]);

const ALLOWED_LIST = [...ALLOWED_COMMANDS].join(', ');

function matchDollarTag(sql: string, index: number): string | null {
  // `$1` é placeholder posicional; só `$$` e `$tag$` abrem dollar quoting.
  const match = /^\$\$|^\$[A-Za-z_][A-Za-z0-9_]*\$/.exec(sql.slice(index));
  return match ? match[0] : null;
}

/**
 * Varre o SQL separando as instruções de topo e neutralizando comentários,
 * strings, identificadores citados e blocos dollar-quoted — o texto devolvido
 * serve só para identificar comandos, nunca para executar.
 *
 * Dentro de `'...'` apenas `''` escapa. Tratar `\'` como escape (válido só em
 * strings `E'...'`) permitiria esconder um `;` separador dentro da string e
 * passar DDL adiante; do jeito atual, o pior caso é uma divisão a mais, que
 * vira recusa.
 */
export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let index = 0;

  while (index < sql.length) {
    const char = sql[index] as string;
    const next = sql[index + 1];

    if (char === '-' && next === '-') {
      while (index < sql.length && sql[index] !== '\n') index += 1;
      current += ' ';
      continue;
    }

    // Comentário de bloco: o PostgreSQL permite aninhamento.
    if (char === '/' && next === '*') {
      let depth = 1;
      index += 2;
      while (index < sql.length && depth > 0) {
        if (sql[index] === '/' && sql[index + 1] === '*') {
          depth += 1;
          index += 2;
          continue;
        }
        if (sql[index] === '*' && sql[index + 1] === '/') {
          depth -= 1;
          index += 2;
          continue;
        }
        index += 1;
      }
      current += ' ';
      continue;
    }

    if (char === "'") {
      index += 1;
      while (index < sql.length) {
        if (sql[index] === "'") {
          if (sql[index + 1] === "'") {
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        index += 1;
      }
      current += ' literal ';
      continue;
    }

    if (char === '"') {
      index += 1;
      while (index < sql.length) {
        if (sql[index] === '"') {
          if (sql[index + 1] === '"') {
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        index += 1;
      }
      current += ' identifier ';
      continue;
    }

    if (char === '$') {
      const tag = matchDollarTag(sql, index);
      if (tag) {
        const end = sql.indexOf(tag, index + tag.length);
        index = end === -1 ? sql.length : end + tag.length;
        current += ' literal ';
        continue;
      }
    }

    if (char === ';') {
      statements.push(current);
      current = '';
      index += 1;
      continue;
    }

    current += char;
    index += 1;
  }

  statements.push(current);
  return statements
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

function tokenize(statement: string): string[] {
  return statement.match(/[A-Za-z_][A-Za-z0-9_]*|\(|\)|[^\s]/g) ?? [];
}

/** Primeiro comando da instrução, ignorando parênteses de abertura. */
function firstCommand(tokens: string[]): string | null {
  for (const token of tokens) {
    if (token === '(') continue;
    if (/^[A-Za-z_]/.test(token)) return token.toUpperCase();
    return null;
  }
  return null;
}

/** Comando analisado por um `EXPLAIN`, pulando suas opções. */
function explainTarget(tokens: string[]): string | null {
  let depth = 0;

  for (const token of tokens.slice(1)) {
    if (token === '(') {
      depth += 1;
      continue;
    }
    if (token === ')') {
      depth -= 1;
      continue;
    }
    if (depth > 0) continue;

    if (!/^[A-Za-z_]/.test(token)) continue;

    const word = token.toUpperCase();
    if (EXPLAIN_OPTION_WORDS.has(word)) continue;
    return word;
  }

  return null;
}

/**
 * `SELECT ... INTO nova_tabela` cria tabela: é DDL disfarçado de SELECT.
 * Só é legítimo o `INTO` que vem logo depois de `INSERT` — inclusive quando
 * o INSERT é o corpo de um `WITH`.
 */
function hasCreatingInto(tokens: string[]): boolean {
  let depth = 0;
  let previous: string | null = null;

  for (const token of tokens) {
    if (token === '(') {
      depth += 1;
      previous = null;
      continue;
    }
    if (token === ')') {
      depth -= 1;
      previous = null;
      continue;
    }

    if (!/^[A-Za-z_]/.test(token)) continue;

    const word = token.toUpperCase();
    if (depth === 0 && word === 'INTO' && previous !== 'INSERT') return true;
    previous = word;
  }

  return false;
}

export type SqlGuardContext = {
  /** Nome da operação, usado na mensagem técnica (ex.: POSTGRES_QUERY). */
  operation: string;
  /** Posição da instrução dentro de uma transação, quando houver. */
  statementIndex?: number;
};

function describeTarget(context: SqlGuardContext): string {
  return context.statementIndex === undefined
    ? 'A instrução'
    : `A instrução #${context.statementIndex + 1}`;
}

/**
 * Recusa qualquer SQL que não seja leitura ou alteração de dados.
 * Devolve o comando identificado quando a instrução é aceita.
 */
export function assertDataOnlySql(sql: string, context: SqlGuardContext): string {
  const statements = splitStatements(sql);

  if (statements.length === 0) {
    throw validationError(
      `${context.operation}: empty SQL statement`,
      'Informe uma instrução SQL para ser executada.',
    );
  }

  if (statements.length > 1) {
    throw validationError(
      `${context.operation}: multiple statements are not allowed (${statements.length} found)`,
      `${describeTarget(context)} contém mais de um comando separado por ";". ` +
        'Envie um comando por chamada — use a tool de transação para executar vários.',
      { statementCount: statements.length },
    );
  }

  const tokens = tokenize(statements[0] as string);
  const command = firstCommand(tokens);

  if (!command) {
    throw validationError(
      `${context.operation}: could not identify the SQL command`,
      `${describeTarget(context)} não começa com um comando SQL reconhecível.`,
    );
  }

  if (!ALLOWED_COMMANDS.has(command)) {
    throw validationError(
      `${context.operation}: command "${command}" is not allowed (data-only gateway)`,
      `${describeTarget(context)} usa "${command}", que altera a estrutura do banco ou o ` +
        'estado da sessão. Esta ferramenta só altera dados. ' +
        `Comandos permitidos: ${ALLOWED_LIST}.`,
      { command, allowedCommands: [...ALLOWED_COMMANDS] },
    );
  }

  if (command === 'EXPLAIN') {
    const target = explainTarget(tokens);
    if (!target || !ALLOWED_EXPLAIN_TARGETS.has(target)) {
      throw validationError(
        `${context.operation}: EXPLAIN target "${target ?? 'unknown'}" is not allowed`,
        `${describeTarget(context)} usa EXPLAIN sobre "${target ?? 'um comando não reconhecido'}". ` +
          'Com ANALYZE o comando é executado de verdade, então só é aceito EXPLAIN de ' +
          'leitura ou alteração de dados.',
        { command, explainTarget: target },
      );
    }
  }

  if (hasCreatingInto(tokens)) {
    throw validationError(
      `${context.operation}: SELECT ... INTO creates a table`,
      `${describeTarget(context)} usa "INTO" para gravar o resultado em uma nova tabela, ` +
        'o que cria estrutura. Use INSERT INTO em uma tabela que já existe.',
      { command },
    );
  }

  return command;
}
