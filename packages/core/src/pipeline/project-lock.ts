import { readFileSync, unlinkSync, existsSync, openSync, writeSync, closeSync } from 'node:fs';
import { createLogger } from '@spatula/shared';

const logger = createLogger('project-lock');

export class ProjectLock {
  private readonly lockPath: string;
  private acquired = false;

  constructor(projectDir: string) {
    this.lockPath = `${projectDir}/run.lock`;
  }

  acquire(force = false): boolean {
    // Check for existing lock — stale detection and force takeover
    if (existsSync(this.lockPath)) {
      const pid = parseInt(readFileSync(this.lockPath, 'utf-8').trim(), 10);
      try {
        process.kill(pid, 0);
        if (!force) { logger.warn({ pid }, 'Another spatula process is running'); return false; }
        logger.info({ pid }, 'Forcing lock takeover');
        unlinkSync(this.lockPath);
      } catch {
        logger.info({ pid }, 'Stale lock detected');
        unlinkSync(this.lockPath);
      }
    }

    // Atomic create — fails if another process raced us
    try {
      const fd = openSync(this.lockPath, 'wx');
      writeSync(fd, String(process.pid));
      closeSync(fd);
      this.acquired = true;
      return true;
    } catch (err: any) {
      if (err.code === 'EEXIST') {
        logger.warn('Lock file appeared after stale check — another process won the race');
        return false;
      }
      throw err;
    }
  }

  release(): void {
    if (this.acquired && existsSync(this.lockPath)) {
      try { unlinkSync(this.lockPath); this.acquired = false; } catch (err) { logger.warn({ err }, 'Failed to release lock'); }
    }
  }

  get isAcquired(): boolean { return this.acquired; }
}
