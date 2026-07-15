#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { asMarkDown, recursivelyCollectAllDependencies } from 'license-checker-rseidelsohn';

const repoRoot = resolve(import.meta.dirname, '..');
const outputPath = join(repoRoot, 'THIRD_PARTY_NOTICES.md');
const customFormatPath = join(repoRoot, 'scripts/notices-template.json');
const customFormat = JSON.parse(readFileSync(customFormatPath, 'utf8'));
const workDir = mkdtempSync(join(tmpdir(), 'spatula-notices-'));
const packDir = join(workDir, 'packs');
const installDir = join(workDir, 'install');
const keepWorkDir = process.env.SPATULA_KEEP_NOTICE_TEMP === '1';

process.once('exit', () => {
  if (!keepWorkDir) rmSync(workDir, { recursive: true, force: true });
});
if (keepWorkDir) console.log(`Notice workspace: ${workDir}`);
mkdirSync(packDir, { recursive: true });
mkdirSync(installDir, { recursive: true });

const packages = [
  '@accidentally-awesome-labs/spatula-core-types',
  '@accidentally-awesome-labs/spatula-client',
  '@accidentally-awesome-labs/spatula-shared',
  '@accidentally-awesome-labs/spatula-core',
  '@accidentally-awesome-labs/spatula-db',
  '@accidentally-awesome-labs/spatula-queue',
  '@accidentally-awesome-labs/spatula-api',
  '@accidentally-awesome-labs/spatula',
];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed (${result.status})\n${result.stdout ?? ''}${result.stderr ?? ''}`,
    );
  }

  return result;
}

for (const name of packages) {
  run('corepack', ['pnpm', '--filter', name, 'pack', '--pack-destination', packDir], {
    capture: true,
  });
}

const tarballs = readdirSync(packDir)
  .filter((name) => name.endsWith('.tgz'))
  .map((name) => join(packDir, name));

if (tarballs.length !== packages.length) {
  throw new Error(`Expected ${packages.length} package tarballs, found ${tarballs.length}.`);
}

writeFileSync(
  join(installDir, 'package.json'),
  `${JSON.stringify(
    {
      name: 'spatula-notice-root',
      version: '0.0.0',
      private: true,
    },
    null,
    2,
  )}\n`,
);

// A clean npm install gives the license scanner a conventional node_modules tree.
// Lifecycle scripts are unnecessary for license discovery and are deliberately disabled.
run('npm', [
  'install',
  '--prefix',
  installDir,
  '--ignore-scripts',
  '--no-audit',
  '--no-fund',
  '--cache',
  join(workDir, 'npm-cache'),
  ...tarballs,
]);

const installedManifest = JSON.parse(readFileSync(join(installDir, 'package.json'), 'utf8'));
const missingPackages = packages.filter((name) => !installedManifest.dependencies?.[name]);
if (missingPackages.length > 0) {
  throw new Error(`Temporary install is missing packages: ${missingPackages.join(', ')}.`);
}

function collectInstalledPackages(nodeModulesDir, collected, visited) {
  if (!existsSync(nodeModulesDir)) return;

  for (const entry of readdirSync(nodeModulesDir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (entry.name.startsWith('.')) continue;

    const entryPath = join(nodeModulesDir, entry.name);
    const packageDirs = entry.name.startsWith('@')
      ? readdirSync(entryPath, { withFileTypes: true })
          .filter((child) => child.isDirectory() || child.isSymbolicLink())
          .map((child) => join(entryPath, child.name))
      : [entryPath];

    for (const packageDir of packageDirs) {
      const realPackageDir = realpathSync(packageDir);
      if (visited.has(realPackageDir)) continue;
      visited.add(realPackageDir);

      const manifestPath = join(realPackageDir, 'package.json');
      if (!existsSync(manifestPath)) continue;
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      if (manifest.name && manifest.version) {
        collected.set(`${manifest.name}@${manifest.version}`, {
          ...manifest,
          path: realPackageDir,
          dependencies: {},
          extraneous: false,
          root: false,
        });
      }

      collectInstalledPackages(join(realPackageDir, 'node_modules'), collected, visited);
    }
  }
}

// The checker's legacy installed-package reader loses manifest metadata with
// current npm releases. Build its input tree directly from this production-only
// install, then retain its license discovery and Markdown renderer.
const installedPackages = new Map();
collectInstalledPackages(join(installDir, 'node_modules'), installedPackages, new Set());
if (installedPackages.size === 0) {
  throw new Error('Temporary install contains no discoverable packages.');
}

const discoveredLicenses = recursivelyCollectAllDependencies({
  _args: { direct: Infinity },
  basePath: null,
  color: false,
  customFormat,
  data: {},
  deps: {
    name: 'spatula-notice-root',
    version: '0.0.0',
    path: installDir,
    private: true,
    root: true,
    dependencies: Object.fromEntries(installedPackages),
  },
  development: false,
  production: false,
  unknown: false,
  currentRecursionDepth: 0,
  clarifications: {},
});

const licenses = Object.fromEntries(
  Object.entries(discoveredLicenses)
    .filter(
      ([name]) =>
        name !== 'spatula-notice-root@0.0.0' && !name.startsWith('@accidentally-awesome-labs/'),
    )
    .sort(([left], [right]) => left.localeCompare(right)),
);

const entries = Object.entries(licenses);
if (entries.length === 0) {
  throw new Error('License scan returned no third-party production dependencies.');
}

const firstPartyEntry = entries.find(([name]) => name.startsWith('@accidentally-awesome-labs/'));
if (firstPartyEntry) {
  throw new Error(`First-party package leaked into notices: ${firstPartyEntry[0]}.`);
}

const missingLicense = entries.find(([, details]) => !details.licenses);
if (missingLicense) {
  throw new Error(`Package is missing license metadata: ${missingLicense[0]}.`);
}

const header = `<!-- AUTO-GENERATED: Do not edit manually. Regenerate with \`pnpm run generate:notices\`. Must be regenerated on every release cut (LEGAL-04). -->

# Third-Party Notices

Auto-generated list of third-party production dependencies and their licenses.
Regenerate with \`pnpm run generate:notices\` before each release (LEGAL-04).

---

`;
const noticeBody = asMarkDown(licenses, customFormat).replace(/[ \t]+$/gm, '');
writeFileSync(outputPath, `${header}${noticeBody}\n`);
console.log(`Generated ${entries.length} third-party notices.`);
