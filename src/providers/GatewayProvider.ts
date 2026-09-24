import { type Tool } from '../core/Tool.js';
import { createCheckProvidersStatusTool } from '../tools/check-providers-status.tool.js';
import { BaseProvider, type Provider, type ProviderDeps, type ProviderProbe } from './index.js';

export type GatewayProviderDeps = ProviderDeps & {
  /** Backends whose health the gateway reports on. */
  providers: Provider[];
  startedAt: number;
};

/**
 * Owner of the gateway's own tools. It has no backend: it is always
 * configured, and its tools skip the provider segment of the name
 * (`{GATEWAY_NAME}_{TOOL_NAME}`).
 */
export class GatewayProvider extends BaseProvider {
  static readonly PROVIDER_NAME = 'GATEWAY';

  private readonly providers: Provider[];
  private readonly startedAt: number;

  constructor(deps: GatewayProviderDeps) {
    super(GatewayProvider.PROVIDER_NAME, deps);
    this.providers = deps.providers;
    this.startedAt = deps.startedAt;
  }

  protected get connectionUrl(): string | undefined {
    return undefined;
  }

  override get isConfigured(): boolean {
    return true;
  }

  protected override get toolNameSegment(): string | null {
    return null;
  }

  async connect(): Promise<void> {}

  async disconnect(): Promise<void> {}

  protected probe(): Promise<ProviderProbe> {
    return Promise.resolve({ healthy: true, details: null });
  }

  protected defineTools(): Tool[] {
    return [
      createCheckProvidersStatusTool({
        providers: this.providers,
        gatewayName: this.config.get('GATEWAY_NAME') as string,
        startedAt: this.startedAt,
      }),
    ];
  }
}
