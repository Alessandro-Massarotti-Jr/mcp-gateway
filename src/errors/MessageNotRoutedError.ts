import { CustomError } from './CustomError.js';

/** The broker accepted the message but no queue is bound to route it. */
export class MessageNotRoutedError extends CustomError {
  constructor({ exchange, routingKey }: { exchange: string; routingKey: string }) {
    super({
      name: 'MessageNotRoutedError',
      message: `Message published to "${exchange}" with routing key "${routingKey}" was not routed to any queue`,
      userMessage:
        'The message was accepted by the broker, but no queue is bound to this exchange with that routing key.',
      level: 'medium',
      category: 'business',
      httpMethod: 422,
      details: { exchange, routingKey, routed: false },
    });
  }
}
