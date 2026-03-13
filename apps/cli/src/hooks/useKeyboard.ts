import { useInput } from 'ink';

export type KeyHandler = () => void;

export interface KeyMap {
  [key: string]: KeyHandler;
}

/**
 * Hook that maps keypresses to handler functions.
 * Supports single character keys ('d', 'r', 'y', 'n'), special keys
 * ('upArrow', 'downArrow', 'return', 'escape', 'tab').
 */
export function useKeyboard(keyMap: KeyMap): void {
  useInput((input, key) => {
    // Check special keys first
    if (key.upArrow && keyMap.upArrow) { keyMap.upArrow(); return; }
    if (key.downArrow && keyMap.downArrow) { keyMap.downArrow(); return; }
    if (key.leftArrow && keyMap.leftArrow) { keyMap.leftArrow(); return; }
    if (key.rightArrow && keyMap.rightArrow) { keyMap.rightArrow(); return; }
    if (key.return && keyMap.return) { keyMap.return(); return; }
    if (key.escape && keyMap.escape) { keyMap.escape(); return; }
    if (key.tab && keyMap.tab) { keyMap.tab(); return; }

    // Check character keys
    if (input && keyMap[input]) {
      keyMap[input]();
    }
  });
}
