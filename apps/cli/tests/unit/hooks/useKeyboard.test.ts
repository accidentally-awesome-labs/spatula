import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { Text } from 'ink';
import { useKeyboard } from '../../../src/hooks/useKeyboard.js';
import type { KeyMap } from '../../../src/hooks/useKeyboard.js';

function TestComponent({ keyMap, isActive }: { keyMap: KeyMap; isActive?: boolean }) {
  useKeyboard(keyMap, isActive);
  return React.createElement(Text, null, 'listening');
}

/** Wait for React effects (useEffect in useInput) to settle. */
const waitForEffects = () => new Promise(resolve => setTimeout(resolve, 50));

describe('useKeyboard', () => {
  it('calls handler when matching key is pressed', async () => {
    const handler = vi.fn();
    const keyMap: KeyMap = { d: handler };
    const { stdin } = render(React.createElement(TestComponent, { keyMap }));
    await waitForEffects();
    stdin.write('d');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('does not call handler for unbound keys', async () => {
    const handler = vi.fn();
    const keyMap: KeyMap = { d: handler };
    const { stdin } = render(React.createElement(TestComponent, { keyMap }));
    await waitForEffects();
    stdin.write('x');
    expect(handler).not.toHaveBeenCalled();
  });

  it('supports multiple key bindings', async () => {
    const dHandler = vi.fn();
    const rHandler = vi.fn();
    const keyMap: KeyMap = { d: dHandler, r: rHandler };
    const { stdin } = render(React.createElement(TestComponent, { keyMap }));
    await waitForEffects();
    stdin.write('d');
    stdin.write('r');
    expect(dHandler).toHaveBeenCalledTimes(1);
    expect(rHandler).toHaveBeenCalledTimes(1);
  });

  it('supports arrow key bindings', async () => {
    const upHandler = vi.fn();
    const downHandler = vi.fn();
    const keyMap: KeyMap = { upArrow: upHandler, downArrow: downHandler };
    const { stdin } = render(React.createElement(TestComponent, { keyMap }));
    await waitForEffects();
    stdin.write('\u001B[A'); // up arrow
    stdin.write('\u001B[B'); // down arrow
    expect(upHandler).toHaveBeenCalledTimes(1);
    expect(downHandler).toHaveBeenCalledTimes(1);
  });

  it('supports return key binding', async () => {
    const handler = vi.fn();
    const keyMap: KeyMap = { return: handler };
    const { stdin } = render(React.createElement(TestComponent, { keyMap }));
    await waitForEffects();
    stdin.write('\r');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('supports escape key binding', async () => {
    const handler = vi.fn();
    const keyMap: KeyMap = { escape: handler };
    const { stdin } = render(React.createElement(TestComponent, { keyMap }));
    await waitForEffects();
    stdin.write('\u001B');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('does not call handlers when isActive is false', async () => {
    const handler = vi.fn();
    const keyMap: KeyMap = { d: handler, upArrow: handler };
    const { stdin } = render(
      React.createElement(TestComponent, { keyMap, isActive: false })
    );
    await waitForEffects();
    stdin.write('d');
    stdin.write('\u001B[A'); // up arrow
    expect(handler).not.toHaveBeenCalled();
  });
});
