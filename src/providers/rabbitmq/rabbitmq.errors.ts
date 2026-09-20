import { ToolError, getErrorMessage, isTransientSystemError } from '../../core/errors.js';
import { type ToolErrorCategory } from '../../core/tool-response.js';

type Classification = {
  category: ToolErrorCategory;
  userFriendlyMessage: string;
};

/** Códigos de erro AMQP 0-9-1 devolvidos pelo broker. */
const BY_AMQP_CODE: Record<number, Classification> = {
  311: {
    category: 'business',
    userFriendlyMessage: 'A mensagem é maior do que o limite aceito pelo broker.',
  },
  312: {
    category: 'business',
    userFriendlyMessage:
      'Não existe fila ligada a esta exchange/routing key: a mensagem não foi roteada.',
  },
  403: {
    category: 'permission',
    userFriendlyMessage: 'O usuário do RabbitMQ não tem permissão para esta operação.',
  },
  404: {
    category: 'validation',
    userFriendlyMessage: 'A fila ou exchange informada não existe no broker.',
  },
  405: {
    category: 'business',
    userFriendlyMessage: 'O recurso está bloqueado por outro consumidor exclusivo.',
  },
  406: {
    category: 'business',
    userFriendlyMessage:
      'Os parâmetros informados não batem com os da fila/exchange já existente no broker.',
  },
  501: {
    category: 'business',
    userFriendlyMessage: 'O broker recusou o quadro enviado (erro de protocolo).',
  },
  503: {
    category: 'validation',
    userFriendlyMessage: 'O comando enviado ao broker não é permitido neste contexto.',
  },
  504: {
    category: 'transient',
    userFriendlyMessage: 'O canal com o RabbitMQ foi encerrado. Tente novamente.',
  },
  506: {
    category: 'transient',
    userFriendlyMessage: 'O broker está sem recursos no momento. Tente novamente em instantes.',
  },
  530: {
    category: 'permission',
    userFriendlyMessage: 'Acesso negado ao virtual host informado na URL de conexão.',
  },
  541: {
    category: 'transient',
    userFriendlyMessage: 'Erro interno do RabbitMQ. Tente novamente em instantes.',
  },
};

function extractAmqpCode(error: unknown): number | null {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'number') return code;

  // Erros de canal chegam como "Channel closed by server: 404 (NOT-FOUND) ...".
  const match = /\b(\d{3})\s*\(/.exec(getErrorMessage(error));
  if (match?.[1]) return Number.parseInt(match[1], 10);
  return null;
}

/** Converte erros do `amqplib` em `ToolError` com categoria adequada. */
export function mapRabbitMqError(error: unknown, operation: string): ToolError {
  if (error instanceof ToolError) return error;

  const message = getErrorMessage(error);
  const amqpCode = extractAmqpCode(error);
  const details: Record<string, unknown> = {};
  if (amqpCode !== null) details.amqpCode = amqpCode;

  const classification = amqpCode !== null ? BY_AMQP_CODE[amqpCode] : undefined;
  if (classification) {
    return new ToolError(`${operation}: ${message}`, {
      category: classification.category,
      userFriendlyMessage: classification.userFriendlyMessage,
      cause: error,
      details: Object.keys(details).length > 0 ? details : null,
    });
  }

  if (/ACCESS_REFUSED|access to vhost/i.test(message)) {
    return new ToolError(`${operation}: ${message}`, {
      category: 'permission',
      userFriendlyMessage: 'Credenciais inválidas ou sem permissão no RabbitMQ.',
      cause: error,
      details: Object.keys(details).length > 0 ? details : null,
    });
  }

  if (isTransientSystemError(error)) {
    return new ToolError(`${operation}: ${message}`, {
      category: 'transient',
      userFriendlyMessage: 'O RabbitMQ está indisponível no momento. Tente novamente em instantes.',
      cause: error,
      details: Object.keys(details).length > 0 ? details : null,
    });
  }

  return new ToolError(`${operation}: ${message}`, {
    category: 'business',
    userFriendlyMessage: 'Não foi possível concluir a operação no RabbitMQ.',
    cause: error,
    details: Object.keys(details).length > 0 ? details : null,
  });
}
