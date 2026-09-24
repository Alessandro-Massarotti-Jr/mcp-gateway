export class CustomError extends Error {
  public level: 'low' | 'medium' | 'high';
  public httpMethod: number;

  constructor({
    name = 'CustomError',
    message = 'An Unexpected Error Occurred',
    level = 'high',
    httpMethod = 500,
  }: {
    name?: string;
    message?: string;
    level?: 'low' | 'medium' | 'high';
    httpMethod?: number;
  }) {
    super(message);
    this.name = name;
    this.level = level;
    this.httpMethod = httpMethod;
  }

  public toJSON() {
    return {
      error: {
        name: this.name,
        message: this.message,
        level: this.level,
        httpMethod: this.httpMethod,
        stack: this.stack,
      },
    };
  }
}
