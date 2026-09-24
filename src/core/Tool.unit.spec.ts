import { z } from 'zod';
import { ValidationError } from '../errors/ValidationError.js';
import { Tool, type ToolResponse } from './Tool.js';

const ok: ToolResponse = {
  isError: false,
  errorCategory: null,
  isRetryable: null,
  message: 'ok',
  userFriendlyMessage: 'ok',
  data: null,
};

function toolWith(handler: () => Promise<ToolResponse> | ToolResponse): Tool {
  return Tool.create({
    name: 'PING',
    title: 'Ping',
    description: 'Pings',
    inputSchema: {},
    handler,
  });
}

describe('Tool', () => {
  describe('create', () => {
    it('keeps the attributes the provider needs to register the tool', () => {
      const inputSchema = { sql: z.string() };
      const tool = Tool.create({
        name: 'QUERY',
        title: 'Query',
        description: 'Runs SQL',
        inputSchema,
        annotations: { readOnlyHint: true },
        handler: () => ok,
      });

      expect(tool).toMatchObject({
        name: 'QUERY',
        title: 'Query',
        description: 'Runs SQL',
        inputSchema,
        annotations: { readOnlyHint: true },
      });
    });

    it('defaults annotations to an empty object', () => {
      expect(toolWith(() => ok).annotations).toEqual({});
    });
  });

  describe('execute', () => {
    it('returns the response produced by the handler', async () => {
      await expect(toolWith(() => ok).execute({})).resolves.toBe(ok);
    });

    it('forwards the received arguments to the handler', async () => {
      const handler = jest.fn(() => ok);
      const tool = Tool.create({
        name: 'QUERY',
        title: 'Query',
        description: 'Runs SQL',
        inputSchema: { sql: z.string() },
        handler,
      });

      await tool.execute({ sql: 'SELECT 1', params: [1] });
      expect(handler).toHaveBeenCalledWith({ sql: 'SELECT 1', params: [1] });
    });

    it('converts a thrown CustomError into the error envelope', async () => {
      const tool = toolWith(() => {
        throw new ValidationError({
          message: 'queue not found',
          userMessage: 'The given queue does not exist.',
          details: { queue: 'orders' },
        });
      });

      await expect(tool.execute({})).resolves.toEqual({
        isError: true,
        errorCategory: 'validation',
        isRetryable: false,
        message: 'queue not found',
        userFriendlyMessage: 'The given queue does not exist.',
        data: { queue: 'orders' },
      });
    });

    it('converts unexpected exceptions into a transient envelope without leaking details', async () => {
      const tool = toolWith(() => {
        throw new TypeError('cannot read property of undefined');
      });

      const response = await tool.execute({});

      expect(response.isError).toBe(true);
      expect(response.errorCategory).toBe('transient');
      expect(response.isRetryable).toBe(true);
      expect(response.message).toBe('PING: cannot read property of undefined');
      expect(response.userFriendlyMessage).not.toContain('undefined');
    });

    it('converts a rejected promise into the error envelope instead of rejecting', async () => {
      const tool = toolWith(() => Promise.reject(new Error('connect failed')));

      const response = await tool.execute({});

      expect(response.isError).toBe(true);
      expect(response.errorCategory).toBe('transient');
    });
  });
});
