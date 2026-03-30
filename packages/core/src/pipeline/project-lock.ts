import { writeFileSync, readFileSync, unlinkSync, existsSync } from 'node:fs';
import { createLogger } from '@spatula/shared';

const logger = createLogger('project-lock');

export class ProjectLock {
  private readonly lockPath: string;
  private acquired = false;

  constructor(projectDir: string) {
    this.lockPath = `${projectDir}/run.lock`;
  }

  acquire(force = false): boolean {
    if (existsSync(this.lockPath)) {
      const pid = parseInt(readFileSync(this.lockPath, 'utf-8').trim(), 10);
      try {
        process.kill(pid, 0);
        if (!force) { logger.warn({ pid }, 'Another spatula process is running'); return false; }
        logger.info({ pid }, 'Forcing lock takeover');
      } catch { logger.info({ pid }, 'Stale lock detected'); }
    }
    writeFileSync(this.lockPath, String(process.pid));
    this.acquired = true;
    return true;
  }

  release(): void {
    if (this.acquired && existsSync(this.lockPath)) {
      try { unlinkSync(this.lockPath); this.acquired = false; } catch (err) { logger.warn({ err }, 'Failed to release lock'); }
    }
  }

  get isAcquired(): boolean { return this.acquired; }
}
