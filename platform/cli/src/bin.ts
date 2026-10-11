import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { main } from './main';

// pnpm runs root scripts from the repository root; INIT_CWD is where the command was typed.
const here = process.env.INIT_CWD ?? process.cwd();

process.exitCode = await main(process.argv.slice(2), {
  io: {
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    readFile: (path) => readFile(resolve(here, path), 'utf8'),
    async writeFile(path, data) {
      const target = resolve(here, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, data);
    },
    sleep: (ms) => sleep(ms),
  },
  env: process.env,
});
