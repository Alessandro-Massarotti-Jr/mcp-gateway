import { CustomError } from './CustomError.js';

export class ValidationError extends CustomError {
  constructor({
    message,
    userMessage,
    details = {},
  }: {
    message: string;
    userMessage: string;
    details?: Record<string, unknown>;
  }) {
    super({
      name: 'ValidationError',
      message,
      userMessage,
      level: 'low',
      category: 'validation',
      httpMethod: 400,
      details,
    });
  }
}
