import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { platform } from 'node:os';
import { createInterface } from 'node:readline';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OllamaStatus {
  installed: boolean;
  version?: string;
  serving: boolean;
  modelPulled: boolean;
}

export interface OllamaManager {
  check(model: string): Promise<OllamaStatus>;
  ensureInstalled(opts: { autoYes: boolean }): Promise<boolean>;
  ensureModel(model: string, opts: { autoYes: boolean }): Promise<boolean>;
  ensureServing(): Promise<{ wasStarted: boolean; stop(): Promise<void> }>;
  isAvailable(): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const OLLAMA_BASE_URL = 'http://localhost:11434';
const MIN_VERSION = '0.3.0';
const HEALTH_TIMEOUT_MS = 2_000;
const SERVE_POLL_INTERVAL_MS = 1_000;
const SERVE_POLL_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Interactive confirmation prompt. Auto-accepts in CI environments.
 */
async function confirm(message: string): Promise<boolean> {
  if (process.env.CI) return true;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${message} [y/N] `, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'y');
    });
  });
}

/**
 * Check whether a command exists on the system PATH.
 *
 * NOTE: We intentionally use execSync with hardcoded command names here
 * (not user-supplied input) for OS-level tool detection. This is a build/test
 * script, not application code, and the commands are string literals.
 */
function commandExists(cmd: string): boolean {
  try {
    const whichCmd = platform() === 'win32' ? 'where' : 'which';
    execSync(`${whichCmd} ${cmd}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function parseVersion(raw: string): string | undefined {
  // `ollama --version` output varies:
  //   "ollama version 0.3.6"
  //   "ollama version is 0.3.6"
  //   "0.3.6"
  const match = raw.match(/(\d+\.\d+\.\d+)/);
  return match?.[1];
}

function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function isServing(): Promise<boolean> {
  try {
    const res = await fetchWithTimeout(`${OLLAMA_BASE_URL}/api/tags`, HEALTH_TIMEOUT_MS);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Check if a model is present in `ollama list` output.
 *
 * NOTE: execSync is used intentionally here — the command is a hardcoded
 * literal (`ollama list`) with no user-supplied interpolation.
 */
function isModelInList(model: string): boolean {
  try {
    const output = execSync('ollama list', { encoding: 'utf-8', timeout: 10_000 });
    const lines = output.trim().split('\n');
    // First line is the header — skip it
    const dataLines = lines.slice(1);

    // The model column is the first whitespace-delimited token.
    // Users may request "llama3.2:1b" which should match "llama3.2:1b" in the list.
    const needle = model.toLowerCase();
    return dataLines.some((line) => {
      const name = line.trim().split(/\s+/)[0]?.toLowerCase();
      if (!name) return false;
      return name === needle || name.startsWith(`${needle}-`);
    });
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createOllamaManager(): OllamaManager {
  return {
    // ----- check ----------------------------------------------------------
    async check(model: string): Promise<OllamaStatus> {
      const installed = commandExists('ollama');

      let version: string | undefined;
      if (installed) {
        try {
          const raw = execSync('ollama --version', { encoding: 'utf-8', timeout: 5_000 });
          version = parseVersion(raw);
          if (version && compareSemver(version, MIN_VERSION) < 0) {
            console.log(
              `Warning: Ollama ${version} detected. Tests are validated against >= ${MIN_VERSION}. If tests fail, try updating Ollama.`,
            );
          }
        } catch {
          // version unknown — not fatal
        }
      }

      const serving = await isServing();
      const modelPulled = installed ? isModelInList(model) : false;

      return { installed, version, serving, modelPulled };
    },

    // ----- ensureInstalled ------------------------------------------------
    async ensureInstalled(opts: { autoYes: boolean }): Promise<boolean> {
      if (commandExists('ollama')) return true;

      const os = platform();

      if (os === 'win32') {
        console.log('Please install Ollama from https://ollama.com/download');
        return false;
      }

      let installCmd: string;
      if (os === 'darwin') {
        if (!commandExists('brew')) {
          console.log(
            'Homebrew not found. Please install Ollama manually from https://ollama.com/download',
          );
          return false;
        }
        installCmd = 'brew install ollama';
      } else {
        // linux
        installCmd = 'curl -fsSL https://ollama.com/install.sh | sh';
      }

      if (process.env.CI) {
        console.log('CI detected, auto-installing Ollama');
      } else if (!opts.autoYes) {
        const yes = await confirm(`Ollama not found. Install via \`${installCmd}\`?`);
        if (!yes) return false;
      }

      try {
        console.log(`Running: ${installCmd}`);
        execSync(installCmd, { stdio: 'inherit' });
      } catch {
        console.error('Ollama installation failed.');
        return false;
      }

      return commandExists('ollama');
    },

    // ----- ensureModel ----------------------------------------------------
    async ensureModel(model: string, opts: { autoYes: boolean }): Promise<boolean> {
      if (isModelInList(model)) return true;

      if (process.env.CI) {
        console.log(`CI detected, auto-pulling model ${model}`);
      } else if (!opts.autoYes) {
        const yes = await confirm(`Model ${model} (~1.3GB) not found. Download?`);
        if (!yes) return false;
      }

      try {
        console.log(`Pulling model ${model}...`);
        execSync(`ollama pull ${model}`, { stdio: 'inherit', timeout: 600_000 });
      } catch {
        console.error(`Failed to pull model ${model}.`);
        return false;
      }

      return isModelInList(model);
    },

    // ----- ensureServing --------------------------------------------------
    async ensureServing(): Promise<{ wasStarted: boolean; stop(): Promise<void> }> {
      if (await isServing()) {
        return { wasStarted: false, stop: async () => {} };
      }

      const child: ChildProcess = spawn('ollama', ['serve'], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();

      // Poll until the server is ready
      const deadline = Date.now() + SERVE_POLL_TIMEOUT_MS;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, SERVE_POLL_INTERVAL_MS));
        if (await isServing()) {
          return {
            wasStarted: true,
            stop: async () => {
              try {
                child.kill('SIGTERM');
              } catch {
                // already exited
              }
            },
          };
        }
      }

      // Timed out — kill the child and report failure
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
      throw new Error(`Ollama serve did not become ready within ${SERVE_POLL_TIMEOUT_MS / 1000}s`);
    },

    // ----- isAvailable ----------------------------------------------------
    async isAvailable(): Promise<boolean> {
      return isServing();
    },
  };
}
