import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

export interface PromptIO {
  input: Readable & { isTTY?: boolean; setRawMode?: (mode: boolean) => void };
  output: Writable & { isTTY?: boolean };
}

export const processPromptIO: PromptIO = {
  input: process.stdin,
  output: process.stdout,
};

export class PromptCancelledError extends Error {
  constructor() {
    super('Setup cancelled.');
    this.name = 'PromptCancelledError';
  }
}

export async function promptText(
  question: string,
  io: PromptIO = processPromptIO,
): Promise<string> {
  const rl = createInterface({ input: io.input, output: io.output });
  try {
    return await new Promise<string>((resolve) => {
      rl.question(question, (answer) => resolve(answer.trim()));
    });
  } finally {
    rl.close();
  }
}

/** Read a secret without echoing it in an interactive terminal. */
export async function promptSecret(
  question: string,
  io: PromptIO = processPromptIO,
): Promise<string> {
  if (!io.input.isTTY || !io.input.setRawMode) {
    return promptText(question, io);
  }

  return new Promise<string>((resolve, reject) => {
    let value = '';
    const input = io.input;
    const output = io.output;

    const cleanup = () => {
      input.removeListener('data', onData);
      input.setRawMode?.(false);
      input.pause();
    };

    const onData = (chunk: Buffer | string) => {
      const text = String(chunk);
      for (const char of text) {
        if (char === '\u0003') {
          output.write('^C\n');
          cleanup();
          reject(new PromptCancelledError());
          return;
        }
        if (char === '\r' || char === '\n') {
          output.write('\n');
          cleanup();
          resolve(value.trim());
          return;
        }
        if (char === '\u007f' || char === '\b') {
          if (value.length > 0) {
            value = value.slice(0, -1);
            output.write('\b \b');
          }
          continue;
        }
        if (char === '\u0015') {
          while (value.length > 0) {
            value = value.slice(0, -1);
            output.write('\b \b');
          }
          continue;
        }
        if (char >= ' ') {
          value += char;
          output.write('*');
        }
      }
    };

    output.write(question);
    input.setEncoding('utf-8');
    input.setRawMode!(true);
    input.resume();
    input.on('data', onData);
  });
}

export async function promptConfirm(
  question: string,
  defaultValue: boolean,
  io: PromptIO = processPromptIO,
): Promise<boolean> {
  const hint = defaultValue ? 'Y/n' : 'y/N';
  const answer = (await promptText(`${question} [${hint}]: `, io)).toLowerCase();
  if (!answer) return defaultValue;
  return answer === 'y' || answer === 'yes';
}
