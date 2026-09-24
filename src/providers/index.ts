import { type Config } from '../core/Config.js';
import { type Logger } from '../core/Logger.js';
import { type Tool } from '../core/Tool.js';

export abstract class Provider {
  readonly name: string;
  isConfigured: boolean = false;
  protected isHealthy: boolean = false;
  protected latencyMs: number | null = null;
  protected details: Record<string, unknown> | null = null;
  protected error: string | null = null;
  tools: Tool[] = [];

  protected logger: Logger;
  protected config: Config;

  constructor({ name, logger, config }: { name: string; logger: Logger; config: Config }) {
    this.name = name;
    this.logger = logger;
    this.config = config;
  }

  abstract status(): Promise<{
    provider: string;
    isConfigured: boolean;
    isHealthy: boolean;
    latencyMs: number | null;
    details: Record<string, unknown> | null;
    errorDetail: string | null;
  }>;
}
