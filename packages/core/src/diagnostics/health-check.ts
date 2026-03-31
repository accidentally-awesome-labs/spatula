export type CheckStatus = 'pass' | 'fail' | 'warn';
export type CheckCategory = 'system' | 'server' | 'project';

export interface HealthCheckResult {
  status: CheckStatus;
  message: string;
}

export interface HealthCheck {
  name: string;
  category: CheckCategory;
  run(): Promise<HealthCheckResult>;
}

export interface CheckResult extends HealthCheckResult {
  name: string;
  category: CheckCategory;
}

export class HealthCheckRegistry {
  private checks: HealthCheck[] = [];

  register(check: HealthCheck): void {
    this.checks.push(check);
  }

  async runChecks(categories: CheckCategory[]): Promise<CheckResult[]> {
    const applicable = this.checks.filter((c) => categories.includes(c.category));
    const results: CheckResult[] = [];

    for (const check of applicable) {
      try {
        const result = await check.run();
        results.push({ name: check.name, category: check.category, ...result });
      } catch (err) {
        results.push({
          name: check.name,
          category: check.category,
          status: 'fail',
          message: (err as Error).message,
        });
      }
    }

    return results;
  }
}
