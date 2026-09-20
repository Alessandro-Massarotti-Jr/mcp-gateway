import { ToolError } from '../../core/errors.js';
import { assertDataOnlySql, splitStatements } from './postgres.sql-guard.js';

const context = { operation: 'POSTGRES_QUERY' };

function reject(sql: string): ToolError {
  try {
    assertDataOnlySql(sql, context);
  } catch (error) {
    if (error instanceof ToolError) return error;
    throw error;
  }
  throw new Error(`Esperava recusa para: ${sql}`);
}

describe('splitStatements', () => {
  it('não divide dentro de string com ponto e vírgula', () => {
    expect(splitStatements("SELECT * FROM t WHERE nome = 'a;b'")).toHaveLength(1);
  });

  it('não divide dentro de bloco dollar-quoted', () => {
    expect(splitStatements('SELECT $tag$ a; b $tag$')).toHaveLength(1);
  });

  it('não confunde placeholder posicional com dollar quoting', () => {
    expect(splitStatements('SELECT * FROM t WHERE id = $1')).toEqual([
      'SELECT * FROM t WHERE id = $1',
    ]);
  });

  it('remove comentários de linha e de bloco aninhado', () => {
    const statements = splitStatements('SELECT 1 -- ; DROP TABLE t\n/* a /* b */ c */');

    expect(statements).toHaveLength(1);
    expect(statements[0]).not.toContain('DROP');
  });

  it('não divide dentro de identificador entre aspas', () => {
    expect(splitStatements('SELECT * FROM "tabela;estranha"')).toHaveLength(1);
  });

  it('ignora ponto e vírgula final', () => {
    expect(splitStatements('SELECT 1;')).toEqual(['SELECT 1']);
  });
});

describe('assertDataOnlySql', () => {
  describe('comandos aceitos', () => {
    it.each([
      ['SELECT * FROM "User"', 'SELECT'],
      ['select 1', 'SELECT'],
      ['INSERT INTO t (a) VALUES ($1)', 'INSERT'],
      ['UPDATE t SET a = $1 WHERE id = $2', 'UPDATE'],
      ['DELETE FROM t WHERE id = $1', 'DELETE'],
      ['WITH x AS (SELECT 1) SELECT * FROM x', 'WITH'],
      ['VALUES (1), (2)', 'VALUES'],
      ['TABLE "Park"', 'TABLE'],
      ['SHOW search_path', 'SHOW'],
      ['EXPLAIN ANALYZE SELECT 1', 'EXPLAIN'],
      ['EXPLAIN (ANALYZE, FORMAT JSON) UPDATE t SET a = 1', 'EXPLAIN'],
      ['(SELECT 1) UNION (SELECT 2)', 'SELECT'],
    ])('aceita %s', (sql, command) => {
      expect(assertDataOnlySql(sql, context)).toBe(command);
    });

    it('aceita INSERT como corpo de um WITH', () => {
      expect(
        assertDataOnlySql('WITH novos AS (SELECT 1 AS a) INSERT INTO t (a) SELECT a FROM novos', {
          operation: 'POSTGRES_QUERY',
        }),
      ).toBe('WITH');
    });

    it('aceita comentário antes do comando', () => {
      expect(assertDataOnlySql('-- relatório\nSELECT 1', context)).toBe('SELECT');
    });
  });

  describe('DDL e mudanças de estrutura', () => {
    it.each([
      'CREATE TABLE t (id int)',
      'ALTER TABLE t ADD COLUMN a int',
      'DROP TABLE t',
      'TRUNCATE TABLE t',
      'CREATE INDEX idx ON t (a)',
      'GRANT SELECT ON t TO alguem',
      'REVOKE SELECT ON t FROM alguem',
      'COMMENT ON TABLE t IS $$x$$',
      'REINDEX TABLE t',
      'VACUUM FULL t',
      'CREATE OR REPLACE FUNCTION f() RETURNS void AS $$ BEGIN END $$ LANGUAGE plpgsql',
      'DO $$ BEGIN EXECUTE $x$DROP TABLE t$x$; END $$',
      'CALL procedimento()',
      'SET ROLE postgres',
      'BEGIN',
      'COMMIT',
      'COPY t FROM STDIN',
      'LOCK TABLE t',
      'CREATE TEMP TABLE tmp AS SELECT 1',
    ])('recusa %s', (sql) => {
      const error = reject(sql);

      expect(error.category).toBe('validation');
      expect(error.details).toMatchObject({ command: expect.any(String) });
    });

    it('recusa comando desconhecido em vez de deixar passar', () => {
      expect(reject('MERGE INTO t USING o ON t.id = o.id').category).toBe('validation');
    });
  });

  describe('bypasses conhecidos', () => {
    it('recusa DDL escondido atrás de um comando permitido', () => {
      expect(reject('UPDATE t SET a = 1; DROP TABLE outra').message).toContain(
        'multiple statements',
      );
    });

    it('não deixa barra invertida esconder o fim da string', () => {
      // Com standard_conforming_strings ligado, a string termina em \ e o
      // DROP é uma instrução de verdade. A guarda precisa enxergar duas.
      expect(reject("SELECT 'a\\'; DROP TABLE t; --'").message).toContain('multiple statements');
    });

    it('recusa DDL comentado de forma a reabrir depois', () => {
      expect(reject('SELECT 1; /* nada */ ALTER TABLE t DROP COLUMN a').message).toContain(
        'multiple statements',
      );
    });

    it('recusa SELECT ... INTO, que cria tabela', () => {
      expect(reject('SELECT * INTO nova FROM antiga').userFriendlyMessage).toContain('INTO');
    });

    it('recusa EXPLAIN ANALYZE que executaria um CREATE TABLE AS', () => {
      const error = reject('EXPLAIN ANALYZE CREATE TABLE nova AS SELECT 1');

      expect(error.details).toMatchObject({ explainTarget: 'CREATE' });
    });

    it('recusa EXPLAIN sem alvo identificável', () => {
      expect(reject('EXPLAIN (ANALYZE)').category).toBe('validation');
    });

    it('recusa SQL só com comentário', () => {
      expect(reject('-- nada aqui').message).toContain('empty');
    });
  });

  describe('mensagens', () => {
    it('identifica a instrução pela posição dentro de uma transação', () => {
      try {
        assertDataOnlySql('DROP TABLE t', { operation: 'POSTGRES_TRANSACTION', statementIndex: 2 });
      } catch (error) {
        expect((error as ToolError).userFriendlyMessage).toContain('#3');
        return;
      }
      throw new Error('Esperava recusa');
    });

    it('lista os comandos permitidos na resposta', () => {
      const error = reject('DROP TABLE t');

      expect(error.userFriendlyMessage).toContain('SELECT');
      expect(error.details).toMatchObject({ allowedCommands: expect.arrayContaining(['UPDATE']) });
    });
  });
});
