import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('list command deprecation', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('prints list deprecation notice', async () => {
    const { printListDeprecation } = await import('../../../src/commands/list.js');
    printListDeprecation();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('deprecated'));
  });

  it('list deprecation mentions spatula remote', async () => {
    const { printListDeprecation } = await import('../../../src/commands/list.js');
    printListDeprecation();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('spatula remote'));
  });

  it('list deprecation mentions spatula status as alternative', async () => {
    const { printListDeprecation } = await import('../../../src/commands/list.js');
    printListDeprecation();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('spatula status'));
  });
});
