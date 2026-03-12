import React from 'react';
import { Box, Text } from 'ink';
import { useStore } from 'zustand';
import type { CliStore } from '../store/index.js';
import { Header, KeyboardHints } from './shared/index.js';
import { ConversationalView } from './conversational/ConversationalView.js';
import type { KeyHint } from './shared/index.js';

export interface AppProps {
  store: CliStore;
  onStartJob: (config: Record<string, unknown>) => void;
  onExit: () => void;
}

const hints: KeyHint[] = [
  { key: 'Enter', description: 'Send' },
  { key: 'Ctrl+C', description: 'Quit' },
];

export function App({
  store,
  onStartJob,
  onExit: _onExit,
}: AppProps): React.ReactElement {
  const mode = useStore(store, (s) => s.mode);

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Header mode={mode} />
      <Box flexGrow={1}>
        {mode === 'conversational' && (
          <ConversationalView store={store} onStartJob={onStartJob} />
        )}
        {mode === 'dashboard' && (
          <Text>Dashboard mode — coming in Phase 9b</Text>
        )}
        {mode === 'review' && (
          <Text>Review mode — coming in Phase 9b</Text>
        )}
        {mode === 'explorer' && (
          <Text>Explorer mode — coming in Phase 9c</Text>
        )}
      </Box>
      <KeyboardHints hints={hints} />
    </Box>
  );
}
