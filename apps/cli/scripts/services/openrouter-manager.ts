import type {
  ServiceManager,
  ServiceStatus,
  ProvisionOpts,
  ServiceContext,
  ServiceHandle,
} from './service-manager.js';

export class OpenRouterManager implements ServiceManager {
  name = 'openrouter';

  async check(): Promise<ServiceStatus> {
    const apiKey = process.env.OPENROUTER_API_KEY;
    return {
      available: !!apiKey,
      details: { keyPresent: !!apiKey, keyPrefix: apiKey?.slice(0, 8) },
    };
  }

  async provision(_opts: ProvisionOpts): Promise<boolean> {
    if (!process.env.OPENROUTER_API_KEY) {
      console.log('  OpenRouter: OPENROUTER_API_KEY not set. Set it in .env.test or environment.');
      return false;
    }
    return true;
  }

  async start(_context: ServiceContext): Promise<ServiceHandle> {
    const apiKey = process.env.OPENROUTER_API_KEY!;
    // Validate key with lightweight API call
    try {
      const res = await fetch('https://openrouter.ai/api/v1/models', {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) {
        console.log(`  OpenRouter: API key validation failed (HTTP ${res.status})`);
      }
    } catch (err) {
      console.log(`  OpenRouter: Key validation error: ${(err as Error).message}`);
    }
    return {
      stop: async () => {},
      connectionInfo: { validated: true },
      envVars: { OPENROUTER_API_KEY: apiKey },
    };
  }

  async healthCheck(): Promise<boolean> {
    return !!process.env.OPENROUTER_API_KEY;
  }
}
