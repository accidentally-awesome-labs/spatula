// packages/core/tests/unit/config/global-config.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  loadGlobalConfig,
  getGlobalConfigPath,
  saveGlobalConfig,
} from '../../../src/config/global-config.js';
import type { GlobalConfig } from '../../../src/config/types.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Mock fs module — include all functions used by saveGlobalConfig
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    readFileSync: vi.fn(),
    existsSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

// Mock os module
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return {
    ...actual,
    homedir: vi.fn(() => '/home/testuser'),
  };
});

describe('getGlobalConfigPath', () => {
  beforeEach(() => {
    delete process.env.SPATULA_HOME;
  });

  it('returns ~/.spatula/config.yaml by default', () => {
    const path = getGlobalConfigPath();
    expect(path).toBe('/home/testuser/.spatula/config.yaml');
  });

  it('respects SPATULA_HOME env var', () => {
    process.env.SPATULA_HOME = '/custom/spatula';
    const path = getGlobalConfigPath();
    expect(path).toBe('/custom/spatula/config.yaml');
  });
});

describe('loadGlobalConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.SPATULA_HOME;
  });

  it('returns null when config file does not exist', async () => {
    const fs = await import('node:fs');
    (fs.existsSync as any).mockReturnValue(false);

    const config = loadGlobalConfig();
    expect(config).toBeNull();
  });

  it('parses valid global config', async () => {
    const fs = await import('node:fs');
    (fs.existsSync as any).mockReturnValue(true);
    (fs.readFileSync as any).mockReturnValue(`
version: 1
openrouterApiKey: sk_or_test123
llm:
  provider: ollama
  model: llama3.2:8b
crawler: playwright
politeness:
  respectRobotsTxt: true
  delayMs: 1000
`);

    const config = loadGlobalConfig();
    expect(config).not.toBeNull();
    expect(config!.openrouterApiKey).toBe('sk_or_test123');
    expect(config!.llm?.provider).toBe('ollama');
    expect(config!.llm?.model).toBe('llama3.2:8b');
    expect(config!.crawler).toBe('playwright');
    expect(config!.politeness?.delayMs).toBe(1000);
  });

  it('returns config with defaults when file is minimal', async () => {
    const fs = await import('node:fs');
    (fs.existsSync as any).mockReturnValue(true);
    (fs.readFileSync as any).mockReturnValue('version: 1');

    const config = loadGlobalConfig();
    expect(config).not.toBeNull();
    expect(config!.version).toBe(1);
  });

  it('parses remotes config', async () => {
    const fs = await import('node:fs');
    (fs.existsSync as any).mockReturnValue(true);
    (fs.readFileSync as any).mockReturnValue(`
version: 1
remotes:
  prod:
    url: https://api.spatula.dev
    apiKey: sk_live_abc
  staging:
    url: https://staging.spatula.dev
`);

    const config = loadGlobalConfig();
    expect(config!.remotes?.prod?.url).toBe('https://api.spatula.dev');
    expect(config!.remotes?.prod?.apiKey).toBe('sk_live_abc');
    expect(config!.remotes?.staging?.url).toBe('https://staging.spatula.dev');
  });

  it('throws on invalid YAML', async () => {
    const fs = await import('node:fs');
    (fs.existsSync as any).mockReturnValue(true);
    (fs.readFileSync as any).mockReturnValue('{{invalid yaml');

    expect(() => loadGlobalConfig()).toThrow();
  });
});

describe('saveGlobalConfig', () => {
  let realFs: typeof import('node:fs');

  beforeEach(async () => {
    realFs = await vi.importActual<typeof import('node:fs')>('node:fs');
    const fs = await import('node:fs');
    // Wire mocked functions to real implementations for saveGlobalConfig tests
    (fs.readFileSync as any).mockImplementation(realFs.readFileSync);
    (fs.existsSync as any).mockImplementation(realFs.existsSync);
    (fs.writeFileSync as any).mockImplementation(realFs.writeFileSync);
    (fs.mkdirSync as any).mockImplementation(realFs.mkdirSync);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('writes YAML to the config path, creating directory if needed', () => {
    const tmpDir = join(tmpdir(), `spatula-save-test-${Date.now()}`);
    const configPath = join(tmpDir, 'config.yaml');

    const config: GlobalConfig = {
      version: 1,
      remotes: {
        prod: { url: 'https://api.spatula.dev', apiKey: 'sk_live_abc' },
      },
    };

    saveGlobalConfig(config, configPath);

    const reloaded = loadGlobalConfig(configPath);
    expect(reloaded).not.toBeNull();
    expect(reloaded!.remotes?.prod?.url).toBe('https://api.spatula.dev');
    expect(reloaded!.remotes?.prod?.apiKey).toBe('sk_live_abc');

    realFs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('merges with existing config when merge flag is true', () => {
    const tmpDir = join(tmpdir(), `spatula-merge-test-${Date.now()}`);
    realFs.mkdirSync(tmpDir, { recursive: true });
    const configPath = join(tmpDir, 'config.yaml');

    saveGlobalConfig({ version: 1, crawler: 'playwright' } as GlobalConfig, configPath);

    const patch: Partial<GlobalConfig> = {
      remotes: { staging: { url: 'https://staging.spatula.dev' } },
    };
    saveGlobalConfig(patch as GlobalConfig, configPath, { merge: true });

    const reloaded = loadGlobalConfig(configPath);
    expect(reloaded!.crawler).toBe('playwright');
    expect(reloaded!.remotes?.staging?.url).toBe('https://staging.spatula.dev');

    realFs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
