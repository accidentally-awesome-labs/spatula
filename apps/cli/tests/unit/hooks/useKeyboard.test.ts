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

type TestStdin = ReturnType<typeof render>['stdin'];

const flushInput = () => new Promise((resolve) => setTimeout(resolve, 0));

async function pressKeyUntil(
  stdin: TestStdin,
  input: string,
  didHandleInput: () => boolean,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    stdin.write(input);
    await flushInput();

    if (didHandleInput()) {
      return;
    }
  }

  throw new Error(`Timed out waiting for input ${JSON.stringify(input)} to be handled`);
}

describe('useKeyboard', () => {
  it('calls handler when matching key is pressed', async () => {
    const handler = vi.fn();
    const keyMap: KeyMap = { d: handler };
    const { stdin } = render(React.createElement(TestComponent, { keyMap }));
    await pressKeyUntil(stdin, 'd', () => handler.mock.calls.length === 1);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('does not call handler for unbound keys', async () => {
    const handler = vi.fn();
    const keyMap: KeyMap = { d: handler };
    const { stdin } = render(React.createElement(TestComponent, { keyMap }));
    await flushInput();
    stdin.write('x');
    await flushInput();
    expect(handler).not.toHaveBeenCalled();
  });

  it('supports multiple key bindings', async () => {
    const dHandler = vi.fn();
    const rHandler = vi.fn();
    const keyMap: KeyMap = { d: dHandler, r: rHandler };
    const { stdin } = render(React.createElement(TestComponent, { keyMap }));
    await pressKeyUntil(stdin, 'd', () => dHandler.mock.calls.length === 1);
    await pressKeyUntil(stdin, 'r', () => rHandler.mock.calls.length === 1);
    expect(dHandler).toHaveBeenCalledTimes(1);
    expect(rHandler).toHaveBeenCalledTimes(1);
  });

  it('supports arrow key bindings', async () => {
    const upHandler = vi.fn();
    const downHandler = vi.fn();
    const keyMap: KeyMap = { upArrow: upHandler, downArrow: downHandler };
    const { stdin } = render(React.createElement(TestComponent, { keyMap }));
    await pressKeyUntil(stdin, '\u001B[A', () => upHandler.mock.calls.length === 1);
    await pressKeyUntil(stdin, '\u001B[B', () => downHandler.mock.calls.length === 1);
    expect(upHandler).toHaveBeenCalledTimes(1);
    expect(downHandler).toHaveBeenCalledTimes(1);
  });

  it('supports return key binding', async () => {
    const handler = vi.fn();
    const keyMap: KeyMap = { return: handler };
    const { stdin } = render(React.createElement(TestComponent, { keyMap }));
    await pressKeyUntil(stdin, '\r', () => handler.mock.calls.length === 1);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('supports escape key binding', async () => {
    const handler = vi.fn();
    const keyMap: KeyMap = { escape: handler };
    const { stdin } = render(React.createElement(TestComponent, { keyMap }));
    await pressKeyUntil(stdin, '\u001B', () => handler.mock.calls.length === 1);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('does not call handlers when isActive is false', async () => {
    const handler = vi.fn();
    const keyMap: KeyMap = { d: handler, upArrow: handler };
    const { stdin } = render(React.createElement(TestComponent, { keyMap, isActive: false }));
    await flushInput();
    stdin.write('d');
    stdin.write('\u001B[A'); // up arrow
    await flushInput();
    expect(handler).not.toHaveBeenCalled();
  });
});
