import { ConfigError } from './errors.js';

export function getEnvOrThrow(key: string): string {
  const value = process.env[key];
  if (value === undefined || value === '') {
    throw new ConfigError(`Required environment variable ${key} is not set`);
  }
  return value;
}

export function getEnvOrDefault(key: string, defaultValue: string): string {
  return process.env[key] ?? defaultValue;
}
