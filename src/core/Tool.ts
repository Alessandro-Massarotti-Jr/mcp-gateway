import { type z } from 'zod';
import { CustomError } from '../errors/CustomError.js';

export type ToolErrorCategory = 'transient' | 'validation' | 'business' | 'permission';

export type ToolResponse<T = unknown> = {
  isError: boolean;
  errorCategory?: ToolErrorCategory | null;
  isRetryable?: boolean | null;
  message: string;
  userFriendlyMessage: string;
  data?: T | null;
};

type ToolAnnotations = {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
};

type ToolHandler<TShape extends z.ZodRawShape> = (
  args: z.infer<z.ZodObject<TShape>>,
) => Promise<ToolResponse> | ToolResponse;

type ToolAttributes<TShape extends z.ZodRawShape> = {
  name: string;
  title: string;
  description: string;
  inputSchema: TShape;
  annotations?: ToolAnnotations;
  handler: ToolHandler<TShape>;
};

export class Tool {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: z.ZodRawShape;
  readonly annotations: ToolAnnotations;
  private readonly handler: (args: unknown) => Promise<ToolResponse> | ToolResponse;

  private constructor(attributes: ToolAttributes<z.ZodRawShape>) {
    this.name = attributes.name;
    this.title = attributes.title;
    this.description = attributes.description;
    this.inputSchema = attributes.inputSchema;
    this.annotations = attributes.annotations ?? {};
    this.handler = attributes.handler as (args: unknown) => Promise<ToolResponse> | ToolResponse;
  }

  static create<TShape extends z.ZodRawShape>(attributes: ToolAttributes<TShape>): Tool {
    return new Tool(attributes as unknown as ToolAttributes<z.ZodRawShape>);
  }

  async execute(args: unknown): Promise<ToolResponse> {
    try {
      return await this.handler(args);
    } catch (error) {
      if (error instanceof CustomError) {
        return {
          isError: true,
          errorCategory: error.category,
          isRetryable: error.category === 'transient',
          message: error.message,
          userFriendlyMessage: error.userMessage,
          data: Object.keys(error.details).length > 0 ? error.details : null,
        };
      }

      return {
        isError: true,
        errorCategory: 'transient',
        isRetryable: true,
        message: `${this.name}: ${error instanceof Error ? error.message : String(error)}`,
        userFriendlyMessage: 'An unexpected error occurred. Please try again.',
        data: null,
      };
    }
  }
}
