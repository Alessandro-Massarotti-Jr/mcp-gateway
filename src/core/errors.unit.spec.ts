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
    it('derives isRetryable from the category when not provided', () => {
      expect(
        new ToolError('x', { category: 'transient', userFriendlyMessage: 'y' }).isRetryable,
      ).toBe(true);
      expect(
        new ToolError('x', { category: 'business', userFriendlyMessage: 'y' }).isRetryable,
      ).toBe(false);
    });

    it('converts to the ToolResponse envelope preserving the details', () => {
      const error = new ToolError('SQLSTATE 23505', {
        category: 'business',
        userFriendlyMessage: 'Duplicate record.',
        details: { constraint: 'users_email_key' },
      });

      expect(error.toResponse()).toEqual({
        isError: true,
        errorCategory: 'business',
        isRetryable: false,
        message: 'SQLSTATE 23505',
        userFriendlyMessage: 'Duplicate record.',
        data: { constraint: 'users_email_key' },
      });
    });

    it('keeps the original cause reachable', () => {
      const cause = new Error('root cause');
      const error = new ToolError('wrapped', {
        category: 'transient',
        userFriendlyMessage: 'Try again.',
        cause,
      });

      expect(error.cause).toBe(cause);
    });
  });

  describe('category helpers', () => {
    it('creates errors with the matching category', () => {
      expect(validationError('m', 'u').category).toBe('validation');
      expect(businessError('m', 'u').category).toBe('business');
      expect(transientError('m', 'u').category).toBe('transient');
    });
  });

  describe('getErrorMessage', () => {
    it('extracts the message from an Error', () => {
      expect(getErrorMessage(new Error('failed'))).toBe('failed');
    });

    it('uses name and code when the Error has no message', () => {
      const error = Object.assign(new Error(''), { code: 'ECONNREFUSED' });
      expect(getErrorMessage(error)).toBe('Error: ECONNREFUSED');
    });

    it('uses the name when there is neither message nor code', () => {
      const error = new Error('');
      error.name = 'AggregateError';
      expect(getErrorMessage(error)).toBe('AggregateError');
    });

    it('accepts strings and objects', () => {
      expect(getErrorMessage('text')).toBe('text');
      expect(getErrorMessage({ a: 1 })).toBe('{"a":1}');
    });

    it('never returns an empty string for exotic values', () => {
      expect(getErrorMessage(undefined)).toBe('undefined');
      expect(getErrorMessage({})).toBe('[object Object]');
    });
  });

  describe('isTransientSystemError', () => {
    it.each(['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNRESET'])(
      'recognizes the socket code %s',
      (code) => {
        expect(isTransientSystemError(Object.assign(new Error('x'), { code }))).toBe(true);
      },
    );

    it('recognizes typical unavailability messages', () => {
      expect(isTransientSystemError(new Error('Connection terminated unexpectedly'))).toBe(true);
      expect(isTransientSystemError(new Error('socket hang up'))).toBe(true);
      expect(isTransientSystemError(new Error('Server selection timed out'))).toBe(true);
    });

    it('does not classify domain errors as transient', () => {
      expect(isTransientSystemError(new Error('duplicate key value'))).toBe(false);
    });
  });

  describe('toToolError', () => {
    it('returns the same ToolError when it is already classified', () => {
      const original = validationError('m', 'u');
      expect(toToolError(original, { operation: 'OP' })).toBe(original);
    });

    it('classifies network failures as transient and retryable', () => {
      const error = toToolError(Object.assign(new Error('down'), { code: 'ECONNREFUSED' }), {
        operation: 'OP',
      });

      expect(error.category).toBe('transient');
      expect(error.isRetryable).toBe(true);
      expect(error.message).toContain('OP');
    });

    it('classifies the unknown as business and not retryable', () => {
      const error = toToolError(new Error('something odd'), { operation: 'OP' });
      expect(error.category).toBe('business');
      expect(error.isRetryable).toBe(false);
    });
  });
});
