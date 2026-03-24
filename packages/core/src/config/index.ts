// Existing
export { DefaultConfigExecutor } from './config-executor.js';

// Project-folder config system (Phase 13)
export * from './types.js';
export { parseProjectYaml, expandFieldShorthand, parseProjectYamlFile } from './yaml-parser.js';
export { loadGlobalConfig, getGlobalConfigPath } from './global-config.js';
export { yamlToJobConfig } from './config-resolver.js';
export type { YamlToJobConfigOptions } from './config-resolver.js';
export { findProjectRoot } from './project-detection.js';

// Config diff engine (Phase 13)
export * from './diff-types.js';
export { normalizeUrl, diffSeeds } from './url-normalizer.js';
export { diffConfigs } from './config-differ.js';
