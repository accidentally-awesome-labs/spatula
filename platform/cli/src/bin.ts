import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { failureLine, main } from './main';

// pnpm runs root scripts from the repository root; INIT_CWD is where the command was typed.
const here = process.env.INIT_CWD ?? process.cwd();

/**
 * Writes a file whole or not at all. The data goes to a temporary file beside the target, which is
 * then renamed over it, so a write that fails or is cut short never leaves half a file in the
 * target's place.
 */
async function writeWhole(target: string, data: string): Promise<void> {
  const directory = dirname(target);
  await mkdir(directory, { recursive: true });
  const temporary = join(directory, `.${basename(target)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, data, { flag: 'wx' });
    await rename(temporary, target);
  } catch (error) {
    // The write's own error is the one to report, even if the clean-up fails too.
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

try {
  process.exitCode = await main(process.argv.slice(2), {
    io: {
      out: (line) => console.log(line),
      err: (line) => console.error(line),
      readFile: (path) => readFile(resolve(here, path), 'utf8'),
      writeFile: (path, data) => writeWhole(resolve(here, path), data),
      sleep: (ms) => sleep(ms),
    },
    env: process.env,
  });
} catch (error) {
  // Whatever escapes main, such as an answer the API never gives, still reaches the terminal as
  // one printable line, not a raw trace.
  console.error(failureLine(error));
  process.exitCode = 1;
}
