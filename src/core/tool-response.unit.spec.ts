import { failure, isRetryableCategory, success, type ToolResponse } from './tool-response.js';

describe('tool-response', () => {
  describe('success', () => {
    it('monta o envelope de sucesso com os campos de erro neutralizados', () => {
      const response = success({
        message: 'Query executed',
        userFriendlyMessage: 'Consulta executada.',
        data: { rows: 2 },
      });

      expect(response).toEqual<ToolResponse<{ rows: number }>>({
        isError: false,
        errorCategory: null,
        isRetryable: null,
        message: 'Query executed',
        userFriendlyMessage: 'Consulta executada.',
        data: { rows: 2 },
      });
    });

    it('usa null quando nenhum dado é informado', () => {
      const response = success({ message: 'ok', userFriendlyMessage: 'ok' });
      expect(response.data).toBeNull();
    });
  });

  describe('failure', () => {
    it.each([
      ['transient' as const, true],
      ['validation' as const, false],
      ['business' as const, false],
      ['permission' as const, false],
    ])('define isRetryable para a categoria %s como %s', (category, expected) => {
      const response = failure({
        errorCategory: category,
        message: 'boom',
        userFriendlyMessage: 'Falhou.',
      });

      expect(response.isError).toBe(true);
      expect(response.errorCategory).toBe(category);
      expect(response.isRetryable).toBe(expected);
    });

    it('permite sobrescrever isRetryable explicitamente', () => {
      const response = failure({
        errorCategory: 'business',
        message: 'boom',
        userFriendlyMessage: 'Falhou.',
        isRetryable: true,
      });

      expect(response.isRetryable).toBe(true);
    });

    it('carrega detalhes no campo data quando informados', () => {
      const response = failure({
        errorCategory: 'validation',
        message: 'invalid',
        userFriendlyMessage: 'Inválido.',
        data: { field: 'sql' },
      });

      expect(response.data).toEqual({ field: 'sql' });
    });
  });

  describe('isRetryableCategory', () => {
    it('considera apenas transient como reexecutável por padrão', () => {
      expect(isRetryableCategory('transient')).toBe(true);
      expect(isRetryableCategory('validation')).toBe(false);
      expect(isRetryableCategory('business')).toBe(false);
      expect(isRetryableCategory('permission')).toBe(false);
    });
  });
});
