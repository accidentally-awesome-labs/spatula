import React, { useState } from 'react';
import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';
import type { ChatMessage } from '../../store/index.js';
import { Spinner } from '../shared/Spinner.js';

export interface ChatViewProps {
  messages: ChatMessage[];
  onSubmit: (input: string) => void;
  isLoading: boolean;
}

function MessageItem({ message }: { message: ChatMessage }): React.ReactElement {
  switch (message.role) {
    case 'user':
      return (
        <Box>
          <Text bold color="green">You: </Text>
          <Text>{message.content}</Text>
        </Box>
      );
    case 'assistant':
      return (
        <Box>
          <Text bold color="magenta">AI: </Text>
          <Text>{message.content}</Text>
        </Box>
      );
    case 'system':
      return (
        <Box>
          <Text dimColor>{message.content}</Text>
        </Box>
      );
  }
}

export function ChatView({
  messages,
  onSubmit,
  isLoading,
}: ChatViewProps): React.ReactElement {
  const [input, setInput] = useState('');

  const handleSubmit = (value: string): void => {
    if (value.trim().length === 0) {
      return;
    }
    onSubmit(value);
    setInput('');
  };

  return (
    <Box flexDirection="column" gap={1}>
      {/* Message list */}
      <Box flexDirection="column">
        {messages.length === 0 && !isLoading && (
          <Text dimColor>Describe what you want to crawl...</Text>
        )}
        {messages.map((msg, i) => (
          <MessageItem key={i} message={msg} />
        ))}
      </Box>

      {/* Loading indicator */}
      {isLoading && <Spinner label="Thinking..." />}

      {/* Input area */}
      <Box>
        <Text bold color="green">{"> "}</Text>
        <TextInput value={input} onChange={setInput} onSubmit={handleSubmit} />
      </Box>
    </Box>
  );
}
