import { execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOllamaManager } from './ollama-manager.js';

// ---------------------------------------------------------------------------
// Directory resolution (works with tsx which supports ESM)
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CLI_ROOT = join(__dirname, '..');

// ---------------------------------------------------------------------------
// Tier definitions
// ---------------------------------------------------------------------------

const TIER_GLOBS: Record<string, string[]> = {
  '1': [
    'tests/unit',
    'tests/integration',
    'tests/e2e/contracts-and-resilience.test.ts',
    'tests/e2e/resource-cleanup.test.ts',
    'tests/e2e/workflow.test.ts',
    'tests/e2e/tui-rendering.test.ts',
  ],
  '2': [
    // Tier 1 + mock Ollama tests
    'tests/unit',
    'tests/integration',
    'tests/e2e/contracts-and-resilience.test.ts',
    'tests/e2e/resource-cleanup.test.ts',
    'tests/e2e/workflow.test.ts',
    'tests/e2e/tui-rendering.test.ts',
    'tests/e2e/tier2/pipeline-mock-llm.test.ts',
    'tests/e2e/tier2/pipeline-errors.test.ts',
    'tests/e2e/tier2/conversation.test.ts',
  ],
  '3': [
    // Tier 2 + real Ollama
    'tests/unit',
    'tests/integration',
    'tests/e2e/contracts-and-resilience.test.ts',
    'tests/e2e/resource-cleanup.test.ts',
    'tests/e2e/workflow.test.ts',
    'tests/e2e/tui-rendering.test.ts',
    'tests/e2e/tier2/', // All tier2 tests including real Ollama
  ],
  binary: ['tests/e2e/cli-binary.test.ts'],
  ci: [
    // Same as Tier 2 (deterministic, no real Ollama)
    'tests/unit',
    'tests/integration',
    'tests/e2e/contracts-and-resilience.test.ts',
    'tests/e2e/resource-cleanup.test.ts',
    'tests/e2e/workflow.test.ts',
    'tests/e2e/tui-rendering.test.ts',
    'tests/e2e/tier2/pipeline-mock-llm.test.ts',
    'tests/e2e/tier2/pipeline-errors.test.ts',
    'tests/e2e/tier2/conversation.test.ts',
  ],
  all: ['tests/unit', 'tests/integration', 'tests/e2e/'],
};

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

  console.log(`\nSpatula Test Runner — Tier ${tier}\n`);

  let ollamaStop: (() => Promise<void>) | null = null;

  // Tier 3 and 'all' need Ollama
  if (tier === '3' || tier === 'all') {
    const manager = createOllamaManager();

    const status = await manager.check(model);
    console.log(
      `Ollama: ${status.installed ? `installed (${status.version ?? 'unknown version'})` : 'not installed'}`,
    );
    console.log(`  Serving: ${status.serving ? 'yes' : 'no'}`);
    console.log(`  Model ${model}: ${status.modelPulled ? 'ready' : 'not pulled'}\n`);

    let ollamaReady = status.installed;

    if (!ollamaReady) {
      ollamaReady = await manager.ensureInstalled({ autoYes });
      if (!ollamaReady) {
        console.log('Ollama not available — Tier 3 tests will be skipped.\n');
      }
    }

    if (ollamaReady) {
      // Re-check model status (may have just installed Ollama)
      const serveResult = await manager.ensureServing();
      if (serveResult.wasStarted) {
        ollamaStop = serveResult.stop;
        cleanupFn = ollamaStop;
        console.log('Started Ollama server (will stop after tests).\n');
      }

      if (!status.modelPulled) {
        await manager.ensureModel(model, { autoYes });
      }
    }
  }

  // Resolve test globs
  const globs = TIER_GLOBS[tier] ?? TIER_GLOBS['2'];
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
    });
  } catch (err: unknown) {
    // vitest exits with non-zero on test failures — still print summary
    const exitCode =
      err && typeof err === 'object' && 'status' in err ? (err as { status: number }).status : 1;
    process.exitCode = exitCode;
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  // Cleanup Ollama if we started it
  if (ollamaStop) {
    console.log('\nStopping Ollama server...');
    await ollamaStop();
    cleanupFn = null;
  }

  // Summary
  const separator = '\u2500'.repeat(50);
  console.log(`\n${separator}`);
  console.log(`Tier ${tier} complete in ${elapsed}s`);
  console.log(`${separator}\n`);
}

main().catch((err) => {
  console.error('Test runner failed:', err);
  process.exitCode = 1;
});
