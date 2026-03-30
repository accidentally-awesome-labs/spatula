import { writeFile, readFile, unlink, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import type { ContentStore } from '../interfaces/content-store.js';
import { createLogger } from '@spatula/shared';

const logger = createLogger('local-content-store');

export class LocalContentStore implements ContentStore {
  constructor(private readonly basePath: string) {}

  async store(key: string, content: string): Promise<string> {
    const filePath = join(this.basePath, `${key}.html`);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, content, 'utf-8');
    const ref = `file://${filePath}`;
    logger.debug({ ref, key }, 'content stored locally');
    return ref;
  }

  async retrieve(ref: string): Promise<string> {
    return readFile(this.parseRef(ref), 'utf-8');
  }

  async delete(ref: string): Promise<void> {
    try { await unlink(this.parseRef(ref)); } catch (err: any) { if (err.code !== 'ENOENT') throw err; }
  }

  async storeBinary(key: string, data: Uint8Array): Promise<string> {
    const filePath = join(this.basePath, key);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, data);
    return `file://${filePath}`;
  }

  async retrieveBinary(ref: string): Promise<Uint8Array | null> {
    try { const buf = await readFile(this.parseRef(ref)); return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength); } catch (err: any) { if (err.code === 'ENOENT') return null; throw err; }
  }

  private parseRef(ref: string): string {
    return ref.startsWith('file://') ? ref.slice(7) : ref;
  }
}
