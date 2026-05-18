import type {
  ServiceManager,
  ServiceStatus,
  ProvisionOpts,
  ServiceContext,
  ServiceHandle,
} from './service-manager.js';
import { createOllamaManager } from '../ollama-manager.js';

export class OllamaServiceManager implements ServiceManager {
  name = 'ollama';
  private model: string;
  private inner = createOllamaManager();

  constructor(opts: { model: string }) {
    this.model = opts.model;
  }

  async check(): Promise<ServiceStatus> {
    const status = await this.inner.check(this.model);
    return {
      available: status.installed,
      version: status.version,
      details: { serving: status.serving, modelPulled: status.modelPulled },
    };
  }

  async provision(opts: ProvisionOpts): Promise<boolean> {
    return this.inner.ensureInstalled({ autoYes: opts.autoYes });
  }

  async start(context: ServiceContext): Promise<ServiceHandle> {
    const serveResult = await this.inner.ensureServing();
    await this.inner.ensureModel(this.model, { autoYes: context.autoYes });
    return {
      stop: serveResult.wasStarted ? serveResult.stop : async () => {},
      connectionInfo: { model: this.model },
      envVars: { OLLAMA_BASE_URL: 'http://localhost:11434' },
    };
  }

  async healthCheck(): Promise<boolean> {
    return this.inner.isAvailable();
  }
}
