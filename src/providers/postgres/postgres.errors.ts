import { ToolError, getErrorMessage, isTransientSystemError } from '../../core/errors.js';
import { type ToolErrorCategory } from '../../core/tool-response.js';

type Classification = {
  category: ToolErrorCategory;
  userFriendlyMessage: string;
};

/** SQLSTATEs específicos que não seguem a regra da classe (2 primeiros dígitos). */
const BY_CODE: Record<string, Classification> = {
  '42501': {
    category: 'permission',
    userFriendlyMessage: 'O usuário do banco não tem permissão para executar esta operação.',
  },
  '40001': {
    category: 'transient',
    userFriendlyMessage: 'Conflito de concorrência no banco. Tente executar novamente.',
  },
  '40P01': {
    category: 'transient',
    userFriendlyMessage: 'Deadlock detectado no banco. Tente executar novamente.',
  },
  '55P03': {
    category: 'transient',
    userFriendlyMessage: 'Registro bloqueado por outra transação. Tente novamente em instantes.',
  },
  '57014': {
    category: 'transient',
    userFriendlyMessage: 'A consulta excedeu o tempo limite e foi cancelada.',
  },
  '3D000': {
    category: 'validation',
    userFriendlyMessage: 'O banco de dados informado não existe.',
  },
  '3F000': {
    category: 'validation',
    userFriendlyMessage: 'O schema informado não existe.',
  },
};

/** Classes de SQLSTATE (dois primeiros caracteres). */
const BY_CLASS: Record<string, Classification> = {
  '08': {
    category: 'transient',
    userFriendlyMessage: 'Falha de conexão com o PostgreSQL. Tente novamente em instantes.',
  },
  '53': {
    category: 'transient',
    userFriendlyMessage: 'O PostgreSQL está sem recursos no momento. Tente novamente em instantes.',
  },
  '57': {
    category: 'transient',
    userFriendlyMessage: 'O PostgreSQL interrompeu a operação. Tente novamente em instantes.',
  },
  '28': {
    category: 'permission',
    userFriendlyMessage: 'Credenciais inválidas ou sem autorização no PostgreSQL.',
  },
  '42': {
    category: 'validation',
    userFriendlyMessage: 'A instrução SQL é inválida ou referencia objetos inexistentes.',
  },
  '22': {
    category: 'validation',
    userFriendlyMessage: 'Algum valor enviado é inválido para o tipo da coluna.',
  },
  '23': {
    category: 'business',
    userFriendlyMessage:
      'A operação viola uma regra de integridade do banco (chave, unicidade ou nulo).',
  },
  '25': {
    category: 'business',
    userFriendlyMessage: 'A transação está em um estado que não permite esta operação.',
  },
};

function classify(code: string | undefined): Classification | null {
  if (!code) return null;
  const exact = BY_CODE[code];
  if (exact) return exact;
  return BY_CLASS[code.slice(0, 2)] ?? null;
}

/** Converte erros do driver `pg` em `ToolError` com categoria adequada. */
export function mapPostgresError(error: unknown, operation: string): ToolError {
  if (error instanceof ToolError) return error;

  const code = (error as { code?: unknown } | null)?.code;
  const sqlState = typeof code === 'string' ? code : undefined;
  const classification = classify(sqlState);
  const message = getErrorMessage(error);

  const details: Record<string, unknown> = {};
  if (sqlState) details.sqlState = sqlState;
  for (const field of ['detail', 'hint', 'table', 'column', 'constraint', 'schema'] as const) {
    const value = (error as Record<string, unknown> | null)?.[field];
    if (typeof value === 'string' && value.length > 0) details[field] = value;
  }

  if (classification) {
    return new ToolError(`${operation}: ${message}`, {
      category: classification.category,
      userFriendlyMessage: classification.userFriendlyMessage,
      cause: error,
      details: Object.keys(details).length > 0 ? details : null,
    });
  }

  if (isTransientSystemError(error)) {
    return new ToolError(`${operation}: ${message}`, {
      category: 'transient',
      userFriendlyMessage:
        'O PostgreSQL está indisponível no momento. Tente novamente em instantes.',
      cause: error,
      details: Object.keys(details).length > 0 ? details : null,
    });
  }

  return new ToolError(`${operation}: ${message}`, {
    category: 'business',
    userFriendlyMessage: 'Não foi possível concluir a operação no PostgreSQL.',
    cause: error,
    details: Object.keys(details).length > 0 ? details : null,
  });
}
