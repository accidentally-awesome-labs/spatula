import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { ChatView } from '../../../../src/components/conversational/ChatView.js';
import type { ChatMessage } from '../../../../src/store/index.js';

describe('ChatView', () => {
  const noop = vi.fn();

  it('renders welcome message when no messages', () => {
    const { lastFrame } = render(
      <ChatView messages={[]} onSubmit={noop} isLoading={false} />,
    );
    expect(lastFrame()).toContain('Describe what you want to crawl');
  });

  it('renders user messages with "You: " prefix', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'I want to scrape recipes' },
    ];
    const { lastFrame } = render(
      <ChatView messages={messages} onSubmit={noop} isLoading={false} />,
    );
    expect(lastFrame()).toContain('You:');
    expect(lastFrame()).toContain('I want to scrape recipes');
  });

  it('renders assistant messages with "AI: " prefix', () => {
    const messages: ChatMessage[] = [
      { role: 'assistant', content: 'I can help with that!' },
    ];
    const { lastFrame } = render(
      <ChatView messages={messages} onSubmit={noop} isLoading={false} />,
    );
    expect(lastFrame()).toContain('AI:');
    expect(lastFrame()).toContain('I can help with that!');
  });

  it('renders system messages in dim style', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'Configuration updated' },
    ];
    const { lastFrame } = render(
      <ChatView messages={messages} onSubmit={noop} isLoading={false} />,
    );
    expect(lastFrame()).toContain('Configuration updated');
  });

  it('shows loading indicator when isLoading is true', () => {
    const { lastFrame } = render(
      <ChatView messages={[]} onSubmit={noop} isLoading={true} />,
    );
    expect(lastFrame()).toContain('Thinking');
  });

  it('does not show loading indicator when isLoading is false', () => {
    const { lastFrame } = render(
      <ChatView messages={[]} onSubmit={noop} isLoading={false} />,
    );
    expect(lastFrame()).not.toContain('Thinking');
  });

  it('calls onSubmit when user presses Enter with text', () => {
    const onSubmit = vi.fn();
    const { stdin } = render(
      <ChatView messages={[]} onSubmit={onSubmit} isLoading={false} />,
    );
    stdin.write('hello world');
    stdin.write('\r');
    expect(onSubmit).toHaveBeenCalledWith('hello world');
  });

  it('does not submit empty input', () => {
    const onSubmit = vi.fn();
    const { stdin } = render(
      <ChatView messages={[]} onSubmit={onSubmit} isLoading={false} />,
    );
    stdin.write('\r');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('does not submit whitespace-only input', () => {
    const onSubmit = vi.fn();
    const { stdin } = render(
      <ChatView messages={[]} onSubmit={onSubmit} isLoading={false} />,
    );
    stdin.write('   ');
    stdin.write('\r');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('renders the input prompt', () => {
    const { lastFrame } = render(
      <ChatView messages={[]} onSubmit={noop} isLoading={false} />,
    );
    expect(lastFrame()).toContain('>');
  });

  it('renders multiple messages in order', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Scrape recipes from allrecipes.com' },
      { role: 'assistant', content: 'Setting up recipe crawler' },
      { role: 'system', content: 'Added seed URL' },
    ];
    const { lastFrame } = render(
      <ChatView messages={messages} onSubmit={noop} isLoading={false} />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain('You:');
    expect(frame).toContain('Scrape recipes from allrecipes.com');
    expect(frame).toContain('AI:');
    expect(frame).toContain('Setting up recipe crawler');
    expect(frame).toContain('Added seed URL');
  });
});
