import { ToolError, getErrorMessage, isTransientSystemError } from '../../core/errors.js';
import { type ToolErrorCategory } from '../../core/tool-response.js';

type Classification = {
  category: ToolErrorCategory;
  userFriendlyMessage: string;
};

/** Códigos de erro do servidor MongoDB que têm tratamento próprio. */
const BY_SERVER_CODE: Record<number, Classification> = {
  2: { category: 'validation', userFriendlyMessage: 'Algum parâmetro enviado é inválido.' },
  9: {
    category: 'validation',
    userFriendlyMessage: 'O comando enviado ao MongoDB está malformado.',
  },
  13: {
    category: 'permission',
    userFriendlyMessage: 'O usuário do MongoDB não tem permissão para esta operação.',
  },
  14: { category: 'validation', userFriendlyMessage: 'Tipo de dado inválido em algum campo.' },
  18: {
    category: 'permission',
    userFriendlyMessage: 'Falha de autenticação no MongoDB. Verifique usuário e senha.',
  },
  26: {
    category: 'validation',
    userFriendlyMessage: 'A coleção ou o banco informado não existe.',
  },
  40: {
    category: 'validation',
    userFriendlyMessage: 'Os operadores de atualização enviados são conflitantes.',
  },
  50: {
    category: 'transient',
    userFriendlyMessage: 'A operação excedeu o tempo limite no MongoDB. Tente novamente.',
  },
  73: { category: 'validation', userFriendlyMessage: 'O nome do banco ou coleção é inválido.' },
  89: {
    category: 'transient',
    userFriendlyMessage: 'Tempo limite de rede ao falar com o MongoDB. Tente novamente.',
  },
  91: {
    category: 'transient',
    userFriendlyMessage: 'O MongoDB está desligando. Tente novamente em instantes.',
  },
  121: {
    category: 'validation',
    userFriendlyMessage: 'O documento não passou nas regras de validação da coleção.',
  },
  11000: {
    category: 'business',
    userFriendlyMessage: 'Já existe um registro com essa chave única.',
  },
  11001: {
    category: 'business',
    userFriendlyMessage: 'Já existe um registro com essa chave única.',
  },
  13435: {
    category: 'transient',
    userFriendlyMessage: 'O nó do MongoDB não é o primário. Tente novamente em instantes.',
  },
};

/** Nomes de classe de erro do driver, usados quando não há código numérico. */
const BY_ERROR_NAME: Record<string, Classification> = {
  MongoServerSelectionError: {
    category: 'transient',
    userFriendlyMessage:
      'Não foi possível alcançar o MongoDB. Verifique a conexão e tente novamente.',
  },
  MongoNetworkError: {
    category: 'transient',
    userFriendlyMessage: 'Falha de rede ao falar com o MongoDB. Tente novamente em instantes.',
  },
  MongoNetworkTimeoutError: {
    category: 'transient',
    userFriendlyMessage: 'Tempo limite de rede ao falar com o MongoDB. Tente novamente.',
  },
  MongoTopologyClosedError: {
    category: 'transient',
    userFriendlyMessage: 'A conexão com o MongoDB foi encerrada. Tente novamente.',
  },
  MongoNotConnectedError: {
    category: 'transient',
    userFriendlyMessage: 'A conexão com o MongoDB ainda não está pronta. Tente novamente.',
  },
  MongoParseError: {
    category: 'validation',
    userFriendlyMessage: 'A URL de conexão ou algum parâmetro do MongoDB é inválido.',
  },
  MongoInvalidArgumentError: {
    category: 'validation',
    userFriendlyMessage: 'Algum argumento enviado ao MongoDB é inválido.',
  },
  BSONError: {
    category: 'validation',
    userFriendlyMessage: 'O documento ou filtro enviado não é um BSON/JSON válido.',
  },
  BSONTypeError: {
    category: 'validation',
    userFriendlyMessage: 'O documento ou filtro enviado contém um tipo inválido.',
  },
};

/** Converte erros do driver MongoDB em `ToolError` com categoria adequada. */
export function mapMongoError(error: unknown, operation: string): ToolError {
  if (error instanceof ToolError) return error;

  const message = getErrorMessage(error);
  const candidate = error as { code?: unknown; name?: unknown; codeName?: unknown } | null;

  const details: Record<string, unknown> = {};
  if (typeof candidate?.code === 'number') details.code = candidate.code;
  if (typeof candidate?.codeName === 'string') details.codeName = candidate.codeName;
  if (typeof candidate?.name === 'string') details.driverError = candidate.name;

  const classification =
    (typeof candidate?.code === 'number' ? BY_SERVER_CODE[candidate.code] : undefined) ??
    (typeof candidate?.name === 'string' ? BY_ERROR_NAME[candidate.name] : undefined);

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
      userFriendlyMessage: 'O MongoDB está indisponível no momento. Tente novamente em instantes.',
      cause: error,
      details: Object.keys(details).length > 0 ? details : null,
    });
  }

  return new ToolError(`${operation}: ${message}`, {
    category: 'business',
    userFriendlyMessage: 'Não foi possível concluir a operação no MongoDB.',
    cause: error,
    details: Object.keys(details).length > 0 ? details : null,
  });
}
