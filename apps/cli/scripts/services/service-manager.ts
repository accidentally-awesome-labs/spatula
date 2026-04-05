// ---------------------------------------------------------------------------
// ServiceManager interface + ServiceRegistry
// ---------------------------------------------------------------------------
// Pluggable service lifecycle management for the tiered test infrastructure.
// Each service (Ollama, Docker Postgres/Redis, OpenRouter, Firecrawl) is
// wrapped in a ServiceManager. The ServiceRegistry handles dependency
// resolution, ordered startup, and rollback on failure.
// ---------------------------------------------------------------------------

/** Result of checking whether a service is available. */
export interface ServiceStatus {
  available: boolean;
  version?: string;
  details: Record<string, unknown>;
}

/** Options passed to `provision()`. */
export interface ProvisionOpts {
  autoYes: boolean;
}

/** Accumulated context passed to each `start()` call. */
export interface ServiceContext {
  /** Connection info keyed by service name. */
  services: Record<string, Record<string, unknown>>;
  autoYes: boolean;
  /** Merged env vars from all previously-started services. */
  envVars: Record<string, string>;
}

/** Handle returned by a successful `start()`. */
export interface ServiceHandle {
  stop(): Promise<void>;
  connectionInfo: Record<string, unknown>;
  envVars: Record<string, string>;
}

/** Lifecycle contract that every managed service implements. */
export interface ServiceManager {
  readonly name: string;
  readonly dependsOn?: string[];

  /** Fast probe — is the service reachable / key present? */
  check(): Promise<ServiceStatus>;

  /** Install / pull images / prompt user. Returns true if ready. */
  provision(opts: ProvisionOpts): Promise<boolean>;

  /** Start the service. May use connection info from prior services. */
  start(context: ServiceContext): Promise<ServiceHandle>;

  /** Lightweight liveness check after start. */
  healthCheck(): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Result of startAll()
// ---------------------------------------------------------------------------

export interface StartAllResult {
  handles: Map<string, ServiceHandle>;
  envVars: Record<string, string>;
  stopAll(): Promise<void>;
}

// ---------------------------------------------------------------------------
// ServiceRegistry
// ---------------------------------------------------------------------------

export class ServiceRegistry {
  private readonly managers = new Map<string, ServiceManager>();

  /** Register a service manager. */
  register(manager: ServiceManager): void {
    this.managers.set(manager.name, manager);
  }

  /** Retrieve a manager by name, or throw if not registered. */
  get(name: string): ServiceManager {
    const mgr = this.managers.get(name);
    if (!mgr) {
      throw new Error(`ServiceRegistry: unknown service "${name}"`);
    }
    return mgr;
  }

  /**
   * Topological sort of the requested service names using DFS.
   * Respects `dependsOn` declarations. Throws on cycles.
   */
  resolveStartOrder(names: string[]): string[] {
    const order: string[] = [];
    const visited = new Set<string>();
    const visiting = new Set<string>(); // cycle detection

    const visit = (name: string): void => {
      if (visited.has(name)) return;
      if (visiting.has(name)) {
        throw new Error(
          `ServiceRegistry: dependency cycle detected involving "${name}"`,
        );
      }

      visiting.add(name);

      const mgr = this.get(name);
      for (const dep of mgr.dependsOn ?? []) {
        // Auto-include dependencies even if not in the original list
        visit(dep);
      }

      visiting.delete(name);
      visited.add(name);
      order.push(name);
    };

    for (const name of names) {
      visit(name);
    }

    return order;
  }

  /**
   * Start all requested services in dependency order.
   *
   * For each service:
   * 1. `check()` — probe availability
   * 2. `provision(opts)` — install / pull if needed
   * 3. `start(context)` — launch, receiving accumulated env/connection info
   *
   * **Rollback:** if any `start()` throws, all previously-started services
   * are stopped in reverse order before the error is re-thrown.
   *
   * If `provision()` returns `false` (service cannot be made ready) the
   * service is skipped — callers can inspect the returned handles to see
   * which services actually started.
   */
  async startAll(
    names: string[],
    opts: ProvisionOpts,
  ): Promise<StartAllResult> {
    const order = this.resolveStartOrder(names);
    const handles = new Map<string, ServiceHandle>();
    const startedNames: string[] = []; // tracks order for rollback
    const mergedEnvVars: Record<string, string> = {};
    const serviceConnectionInfo: Record<string, Record<string, unknown>> = {};

    for (const name of order) {
      const mgr = this.get(name);

      // 1. Check availability
      await mgr.check();

      // 2. Provision — if it returns false, skip this service
      const ready = await mgr.provision({ autoYes: opts.autoYes });
      if (!ready) {
        continue;
      }

      // 3. Start — with rollback on failure
      const context: ServiceContext = {
        services: { ...serviceConnectionInfo },
        autoYes: opts.autoYes,
        envVars: { ...mergedEnvVars },
      };

      let handle: ServiceHandle;
      try {
        handle = await mgr.start(context);
      } catch (err) {
        // Rollback: stop previously started services in reverse order
        for (const prevName of [...startedNames].reverse()) {
          const prevHandle = handles.get(prevName);
          if (prevHandle) {
            try {
              await prevHandle.stop();
            } catch {
              // Best-effort cleanup — swallow stop errors during rollback
            }
          }
        }
        throw err;
      }

      handles.set(name, handle);
      startedNames.push(name);
      Object.assign(mergedEnvVars, handle.envVars);
      serviceConnectionInfo[name] = handle.connectionInfo;
    }

    const stopAll = async (): Promise<void> => {
      for (const name of [...startedNames].reverse()) {
        const handle = handles.get(name);
        if (handle) {
          try {
            await handle.stop();
          } catch {
            // Best-effort cleanup
          }
        }
      }
    };

    return { handles, envVars: mergedEnvVars, stopAll };
  }
}
