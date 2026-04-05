import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ServiceRegistry } from './services/service-manager.js';
import { OllamaServiceManager } from './services/ollama-manager.js';
import { DockerPostgresManager, DockerRedisManager } from './services/docker-manager.js';
import { OpenRouterManager } from './services/openrouter-manager.js';
import { FirecrawlManager } from './services/firecrawl-manager.js';
import { TIERS, resolveGlobs, resolveServices } from './tier-registry.js';

// ---------------------------------------------------------------------------
// Directory resolution (works with tsx which supports ESM)
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CLI_ROOT = join(__dirname, '..');

// ---------------------------------------------------------------------------
// .env.test loader
// ---------------------------------------------------------------------------

function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;
  const lines = readFileSync(path, 'utf-8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
}

// Load env before anything that might read API keys
loadEnvFile(join(CLI_ROOT, 'tests', 'e2e', 'tier4', '.env.test'));

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

interface ParsedArgs {
  tier: string;
  model: string;
  timeout: number;
  yes: boolean;
}

function parseArgs(): ParsedArgs {
  const args: Record<string, string> = {};
  for (const arg of process.argv.slice(2)) {
    const match = arg.match(/^--(\w[\w-]*)=?(.*)$/);
    if (match) args[match[1]] = match[2] || 'true';
  }
  return {
    tier: args.tier ?? '2',
    model: args.model ?? 'llama3.2:1b',
    timeout: Number(args.timeout ?? 300_000),
    yes: args.yes === 'true',
  };
}

// ---------------------------------------------------------------------------
// Signal handlers
// ---------------------------------------------------------------------------

let cleanupFn: (() => Promise<void>) | null = null;

process.on('SIGINT', async () => {
  console.log('\nInterrupted — cleaning up...');
  if (cleanupFn) await cleanupFn();
  process.exit(1);
});

process.on('SIGTERM', async () => {
  if (cleanupFn) await cleanupFn();
  process.exit(1);
});

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs();
  const { tier, model, yes: autoYes } = args;

  const tierDef = TIERS[tier];
  if (!tierDef) {
    console.error(`Unknown tier: "${tier}". Available: ${Object.keys(TIERS).join(', ')}`);
    process.exitCode = 1;
    return;
  }

  console.log(`\nSpatula Test Runner — Tier ${tier} (${tierDef.name})\n`);

  // Build the service registry with all known managers
  const registry = new ServiceRegistry();
  registry.register(new OllamaServiceManager({ model }));
  registry.register(new DockerPostgresManager());
  registry.register(new DockerRedisManager());
  registry.register(new OpenRouterManager());
  registry.register(new FirecrawlManager());

  // Resolve tier → services + globs
  const services = resolveServices(tier);
  const globs = resolveGlobs(tier);

  if (globs.length === 0) {
    console.log('No test globs for this tier — nothing to run.\n');
    return;
  }

  // Start required services (generic — no tier-specific if/else)
  let startResult: Awaited<ReturnType<ServiceRegistry['startAll']>> | null = null;

  if (services.length > 0) {
    console.log('Services:');
    for (const name of services) {
      const s = await registry.get(name).check();
      console.log(`  ${name}: ${s.available ? 'available' : 'not available'}`);
    }
    console.log();

    startResult = await registry.startAll(services, { autoYes });
    Object.assign(process.env, startResult.envVars);
    cleanupFn = startResult.stopAll;
  }

  const startTime = Date.now();

  // Run vitest
  // NOTE: execSync is used here with a hardcoded vitest binary path and
  // controlled glob arguments — no user-supplied shell interpolation.
  try {
    const vitestBin = join(CLI_ROOT, 'node_modules', '.bin', 'vitest');
    execSync(`${vitestBin} run ${globs.join(' ')}`, {
      stdio: 'inherit',
      cwd: CLI_ROOT,
      timeout: args.timeout,
      env: { ...process.env, ...startResult?.envVars },
    });
  } catch (err: unknown) {
    // vitest exits with non-zero on test failures — still print summary
    const exitCode =
      err && typeof err === 'object' && 'status' in err ? (err as { status: number }).status : 1;
    process.exitCode = exitCode;
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  // Cleanup services if any were started
  if (startResult) {
    console.log('\nStopping services...');
    await startResult.stopAll();
    cleanupFn = null;
  }

  // Summary
  const separator = '\u2500'.repeat(50);
  console.log(`\n${separator}`);
  console.log(`Tier ${tier} (${tierDef.name}) complete in ${elapsed}s`);
  console.log(`${separator}\n`);
}

main().catch((err) => {
  console.error('Test runner failed:', err);
  process.exitCode = 1;
});
