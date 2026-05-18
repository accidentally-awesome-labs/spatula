import type {
  ServiceManager,
  ServiceStatus,
  ProvisionOpts,
  ServiceContext,
  ServiceHandle,
} from './service-manager.js';

export class FirecrawlManager implements ServiceManager {
  name = 'firecrawl';

  async check(): Promise<ServiceStatus> {
    const apiKey = process.env.FIRECRAWL_API_KEY;
    return {
      available: !!apiKey,
      details: { keyPresent: !!apiKey },
    };
  }

  async provision(_opts: ProvisionOpts): Promise<boolean> {
    if (!process.env.FIRECRAWL_API_KEY) {
      console.log('  Firecrawl: FIRECRAWL_API_KEY not set. Set it in .env.test or environment.');
      return false;
    }
    return true;
  }

  async start(_context: ServiceContext): Promise<ServiceHandle> {
    return {
      stop: async () => {},
      connectionInfo: {},
      envVars: { FIRECRAWL_API_KEY: process.env.FIRECRAWL_API_KEY! },
    };
  }

  async healthCheck(): Promise<boolean> {
    return !!process.env.FIRECRAWL_API_KEY;
  }
}
