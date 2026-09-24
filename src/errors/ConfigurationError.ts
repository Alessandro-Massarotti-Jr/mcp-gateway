import { CustomError } from './CustomError';

export class ConfigurationError extends CustomError {
  constructor() {
    super({
      name: 'ConfigurationError',
      message: 'A configuration error occurred.',
      level: 'high',
      httpMethod: 500,
    });
  }
}
