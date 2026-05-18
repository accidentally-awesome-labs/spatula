// apps/cli/src/components/SchemaConflict.tsx
import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { SchemaDiff } from '../lib/schema-diff.js';

interface SchemaConflictProps {
  diff: SchemaDiff;
  onResolve: (choice: 'remote' | 'local' | 'merge') => void;
}

export function SchemaConflict({ diff, onResolve }: SchemaConflictProps) {
  const [selected, setSelected] = useState(0);
  const options: Array<{ key: 'remote' | 'local' | 'merge'; label: string; desc: string }> = [
    { key: 'remote', label: 'Use remote', desc: 'replaces local with remote' },
    { key: 'local', label: 'Keep local', desc: 'ignore remote changes' },
    { key: 'merge', label: 'Merge', desc: 'keep all fields from both' },
  ];

  useInput((input, key) => {
    if (key.upArrow) setSelected((s) => Math.max(0, s - 1));
    if (key.downArrow) setSelected((s) => Math.min(options.length - 1, s + 1));
    if (key.return) onResolve(options[selected].key);
    if (input === '1') onResolve('remote');
    if (input === '2') onResolve('local');
    if (input === '3') onResolve('merge');
  });

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold>Schema differences detected</Text>
      <Text> </Text>

      {diff.localOnly.length > 0 && (
        <Box flexDirection="column">
          <Text dimColor> Local only:</Text>
          {diff.localOnly.map((f) => (
            <Text key={f.name} color="yellow">
              {' '}
              - {f.name} ({f.type})
            </Text>
          ))}
        </Box>
      )}

      {diff.remoteOnly.length > 0 && (
        <Box flexDirection="column">
          <Text dimColor> Remote only:</Text>
          {diff.remoteOnly.map((f) => (
            <Text key={f.name} color="green">
              {' '}
              + {f.name} ({f.type})
            </Text>
          ))}
        </Box>
      )}

      {diff.changed.length > 0 && (
        <Box flexDirection="column">
          <Text dimColor> Changed:</Text>
          {diff.changed.map((c) => (
            <Box key={c.name} flexDirection="column">
              <Text color="cyan"> ~ {c.name}</Text>
              {c.differences.map((d, i) => (
                <Text key={i} dimColor>
                  {' '}
                  {d}
                </Text>
              ))}
            </Box>
          ))}
        </Box>
      )}

      <Text> </Text>
      <Text bold>Resolution:</Text>
      {options.map((opt, i) => (
        <Text key={opt.key}>
          {i === selected ? ' ❯ ' : '   '}
          <Text bold={i === selected}>
            [{i + 1}] {opt.label}
          </Text>
          <Text dimColor> — {opt.desc}</Text>
        </Text>
      ))}
    </Box>
  );
}
