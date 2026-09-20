import {
  ToolError,
  businessError,
  getErrorMessage,
  isTransientSystemError,
  toToolError,
  transientError,
  validationError,
} from './errors.js';

describe('errors', () => {
  describe('ToolError', () => {
    it('deriva isRetryable da categoria quando não informado', () => {
      expect(
        new ToolError('x', { category: 'transient', userFriendlyMessage: 'y' }).isRetryable,
      ).toBe(true);
      expect(
        new ToolError('x', { category: 'business', userFriendlyMessage: 'y' }).isRetryable,
      ).toBe(false);
    });

    it('converte para o envelope ToolResponse preservando os detalhes', () => {
      const error = new ToolError('SQLSTATE 23505', {
        category: 'business',
        userFriendlyMessage: 'Registro duplicado.',
        details: { constraint: 'users_email_key' },
      });

      expect(error.toResponse()).toEqual({
        isError: true,
        errorCategory: 'business',
        isRetryable: false,
        message: 'SQLSTATE 23505',
        userFriendlyMessage: 'Registro duplicado.',
        data: { constraint: 'users_email_key' },
      });
    });

    it('mantém a causa original acessível', () => {
      const cause = new Error('root cause');
      const error = new ToolError('wrapped', {
        category: 'transient',
        userFriendlyMessage: 'Tente novamente.',
        cause,
      });

      expect(error.cause).toBe(cause);
    });
  });

  describe('helpers de categoria', () => {
    it('cria erros com a categoria correspondente', () => {
      expect(validationError('m', 'u').category).toBe('validation');
      expect(businessError('m', 'u').category).toBe('business');
      expect(transientError('m', 'u').category).toBe('transient');
    });
  });

  describe('getErrorMessage', () => {
    it('extrai a mensagem de um Error', () => {
      expect(getErrorMessage(new Error('falhou'))).toBe('falhou');
    });

    it('usa nome e código quando o Error não tem mensagem', () => {
      const error = Object.assign(new Error(''), { code: 'ECONNREFUSED' });
      expect(getErrorMessage(error)).toBe('Error: ECONNREFUSED');
    });

    it('usa o nome quando não há mensagem nem código', () => {
      const error = new Error('');
      error.name = 'AggregateError';
      expect(getErrorMessage(error)).toBe('AggregateError');
    });

    it('aceita strings e objetos', () => {
      expect(getErrorMessage('texto')).toBe('texto');
      expect(getErrorMessage({ a: 1 })).toBe('{"a":1}');
    });

    it('não devolve string vazia para valores exóticos', () => {
      expect(getErrorMessage(undefined)).toBe('undefined');
      expect(getErrorMessage({})).toBe('[object Object]');
    });
  });

  describe('isTransientSystemError', () => {
    it.each(['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNRESET'])(
      'reconhece o código de socket %s',
      (code) => {
        expect(isTransientSystemError(Object.assign(new Error('x'), { code }))).toBe(true);
      },
    );

    it('reconhece mensagens típicas de indisponibilidade', () => {
      expect(isTransientSystemError(new Error('Connection terminated unexpectedly'))).toBe(true);
      expect(isTransientSystemError(new Error('socket hang up'))).toBe(true);
      expect(isTransientSystemError(new Error('Server selection timed out'))).toBe(true);
    });

    it('não classifica erros de domínio como transitórios', () => {
      expect(isTransientSystemError(new Error('duplicate key value'))).toBe(false);
    });
  });

  describe('toToolError', () => {
    it('devolve o mesmo ToolError quando já classificado', () => {
      const original = validationError('m', 'u');
      expect(toToolError(original, { operation: 'OP' })).toBe(original);
    });

    it('classifica falhas de rede como transient e reexecutáveis', () => {
      const error = toToolError(Object.assign(new Error('down'), { code: 'ECONNREFUSED' }), {
        operation: 'OP',
      });

      expect(error.category).toBe('transient');
      expect(error.isRetryable).toBe(true);
      expect(error.message).toContain('OP');
    });

    it('classifica o desconhecido como business e não reexecutável', () => {
      const error = toToolError(new Error('algo estranho'), { operation: 'OP' });
      expect(error.category).toBe('business');
      expect(error.isRetryable).toBe(false);
    });
  });
});
