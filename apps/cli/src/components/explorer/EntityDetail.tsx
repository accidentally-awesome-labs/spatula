import React from 'react';
import { Box, Text } from 'ink';
import type { EntityWithProvenance } from '@accidentally-awesome-labs/spatula-shared';
import { Panel } from '../shared/index.js';

export interface EntityDetailProps {
  entity: EntityWithProvenance;
  scrollOffset?: number;
}

export function EntityDetail({ entity, scrollOffset = 0 }: EntityDetailProps) {
  const provenance = entity.provenance;
  const allFields = Object.keys(entity.mergedData);
  const fields = allFields.slice(scrollOffset);

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Panel title="Entity Detail">
        <Box>
          <Text bold>Quality: </Text>
          <Text>{entity.qualityScore.toFixed(2)}</Text>
          <Text>{'    '}</Text>
          <Text bold>Sources: </Text>
          <Text>{entity.sourceCount}</Text>
          <Text>{'    '}</Text>
          <Text bold>Categories: </Text>
          <Text>{entity.categories.join(', ') || 'none'}</Text>
        </Box>
      </Panel>

      <Box flexDirection="column" paddingX={1} marginTop={1}>
        {fields.map((field) => {
          const value = entity.mergedData[field];
          const prov = provenance[field] as any;
          const displayValue =
            typeof value === 'object' ? JSON.stringify(value) : String(value ?? '');

          return (
            <Box key={field} flexDirection="column" marginBottom={1}>
              <Text bold color="cyan">
                {field}: <Text color="white">{displayValue}</Text>
              </Text>

              {prov && (
                <Box flexDirection="column" paddingLeft={2}>
                  <Text dimColor>
                    {'\u251c\u2500'} provenance: {prov.provenanceType}
                    {prov.sources
                      ? ` (${prov.sources.length} source${prov.sources.length !== 1 ? 's' : ''})`
                      : ''}
                  </Text>

                  {prov.sources && prov.sources.length > 0 && (
                    <>
                      <Text dimColor>{'\u251c\u2500'} sources:</Text>
                      {prov.sources.map((src: any, i: number) => {
                        const domain = (() => {
                          try {
                            return new URL(src.sourceUrl).hostname;
                          } catch {
                            return src.sourceUrl;
                          }
                        })();
                        const isLast = i === prov.sources.length - 1;
                        const prefix = isLast ? '\u2502   \u2514\u2500' : '\u2502   \u251c\u2500';
                        return (
                          <Text key={i} dimColor>
                            {prefix} {domain} {'\u2192'} {JSON.stringify(src.rawValue)}
                            {prov.hadConflict && src.rawValue !== prov.finalValue ? (
                              <Text color="yellow"> (conflict)</Text>
                            ) : null}
                          </Text>
                        );
                      })}
                    </>
                  )}

                  {prov.resolution && (
                    <Text dimColor>
                      {'\u2514\u2500'} resolution: {prov.resolution}
                    </Text>
                  )}
                </Box>
              )}
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}
