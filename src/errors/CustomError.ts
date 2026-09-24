export class CustomError extends Error {
  public level: 'low' | 'medium' | 'high';
  public category: 'transient' | 'validation' | 'business' | 'permission';
  public httpMethod: number;
  public details: Record<string, unknown>;
  public userMessage: string;

  constructor({
    name = 'CustomError',
    message = 'An Unexpected Error Occurred',
    userMessage = 'An unexpected error occurred on the server. Please try again later.',
    level = 'high',
    category = 'transient',
    httpMethod = 500,
    details = {},
  }: {
    name?: string;
    message?: string;
    level?: 'low' | 'medium' | 'high';
    category?: 'transient' | 'validation' | 'business' | 'permission';
    httpMethod?: number;
    userMessage?: string;
    details?: Record<string, unknown>;
  }) {
    super(message);
    this.name = name;
    this.level = level;
    this.category = category;
    this.httpMethod = httpMethod;
    this.details = details;
    this.userMessage = userMessage;
  }

  public toJSON(): Record<string, unknown> {
    return {
      error: {
        name: this.name,
        message: this.message,
        userMessage: this.userMessage,
        level: this.level,
        category: this.category,
        httpMethod: this.httpMethod,
        details: this.details,
        stack: this.stack,
      },
    };
  }
}
