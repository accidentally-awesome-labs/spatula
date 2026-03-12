import React from 'react';
import { Box } from 'ink';
import { useStore } from 'zustand';
import type { CliStore } from '../../store/index.js';
import { ChatView } from './ChatView.js';
import { ConfigPanel } from './ConfigPanel.js';

export interface ConversationalViewProps {
  store: CliStore;
  onStartJob: (config: Record<string, unknown>) => void;
}

export function ConversationalView({
  store,
  onStartJob: _onStartJob,
}: ConversationalViewProps): React.ReactElement {
  const config = useStore(store, (s) => s.config);
  const messages = useStore(store, (s) => s.messages);
  const isLoading = useStore(store, (s) => s.isLoading);
  const isValid = useStore(store, (s) => s.validateConfig().valid);
  const addMessage = useStore(store, (s) => s.addMessage);

  const handleSubmit = (input: string): void => {
    addMessage({ role: 'user', content: input });
  };

  return (
    <Box flexGrow={1}>
      <Box flexGrow={1}>
        <ChatView messages={messages} onSubmit={handleSubmit} isLoading={isLoading} />
      </Box>
      <Box width={40}>
        <ConfigPanel config={config} isValid={isValid} />
      </Box>
    </Box>
  );
}
