import { CustomError } from './CustomError.js';

/** The broker did not confirm a publish before the configured timeout elapsed. */
export class PublisherConfirmTimeoutError extends CustomError {
  constructor({ timeoutMs }: { timeoutMs: number }) {
    super({
      name: 'PublisherConfirmTimeoutError',
      message: `Publisher confirm timed out after ${timeoutMs}ms`,
      userMessage:
        'The broker did not confirm the publish in time. Check the queue before resending.',
      level: 'medium',
      category: 'transient',
      httpMethod: 504,
      details: { timeoutMs },
    });
  }
}
