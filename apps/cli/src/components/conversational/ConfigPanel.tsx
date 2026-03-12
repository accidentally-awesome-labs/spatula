import React from 'react';
import { Box, Text } from 'ink';
import type { JobConfig } from '@spatula/core';
import { Panel } from '../shared/Panel.js';

export interface ConfigPanelProps {
  config: JobConfig;
  isValid?: boolean;
}

export function ConfigPanel({ config, isValid }: ConfigPanelProps): React.ReactElement {
  const borderColor = isValid === true ? 'green' : 'cyan';

  return (
    <Panel title="Config" borderColor={borderColor}>
      <Box flexDirection="column" gap={0}>
        {/* Name */}
        <Text>
          <Text bold>{'Name: '}</Text>
          <Text>{config.name || '(not set)'}</Text>
        </Text>

        {/* Description — only if non-empty */}
        {config.description ? (
          <Text>
            <Text bold>{'Desc: '}</Text>
            <Text>{config.description}</Text>
          </Text>
        ) : null}

        {/* Seed URLs */}
        <Box flexDirection="column">
          <Text>
            <Text bold>{'URLs: '}</Text>
            <Text>{config.seedUrls.length === 0 ? '(none)' : String(config.seedUrls.length)}</Text>
          </Text>
          {config.seedUrls.map((url, i) => (
            <Text key={i} color="blue">
              {'  ' + url}
            </Text>
          ))}
        </Box>

        {/* Schema */}
        <Box flexDirection="column">
          <Text>
            <Text bold>{'Schema: '}</Text>
            <Text color="yellow">{config.schema.mode}</Text>
          </Text>
          {config.schema.userFields && config.schema.userFields.length > 0 && (
            <Box flexDirection="column">
              {config.schema.userFields.map((field, i) => (
                <Text key={i}>
                  {'  '}
                  {field.name}
                  {' '}
                  <Text dimColor>({field.type})</Text>
                  {field.required ? <Text color="red">{' *'}</Text> : null}
                </Text>
              ))}
            </Box>
          )}
        </Box>

        {/* Crawl */}
        <Text>
          <Text bold>{'Crawl: '}</Text>
          <Text>
            {'depth=' + config.crawl.maxDepth +
              ' pages=' + config.crawl.maxPages +
              ' concurrency=' + config.crawl.concurrency +
              ' ' + config.crawl.crawlerType}
          </Text>
        </Text>

        {/* Model */}
        <Text>
          <Text bold>{'Model: '}</Text>
          <Text>{config.llm.primaryModel}</Text>
        </Text>

        {/* Validation status */}
        <Box marginTop={1}>
          {isValid === true ? (
            <Text color="green" bold>{'✓ Ready to start'}</Text>
          ) : (
            <Text color="yellow">{'○ Incomplete — keep configuring'}</Text>
          )}
        </Box>
      </Box>
    </Panel>
  );
}
