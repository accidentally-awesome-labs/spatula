import { z } from 'zod';
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

const AppConfigSchema = z.object({
  database: z.object({
    url: z.string().min(1, 'database.url is required'),
  }),
  redis: z.object({
    url: z.string().default('redis://localhost:6379'),
  }),
  openrouter: z.object({
    apiKey: z.string().min(1, 'openrouter.apiKey is required'),
  }),
  firecrawl: z.object({
    apiKey: z.string().optional(),
  }),
  server: z.object({
    port: z.coerce.number().default(3000),
    host: z.string().default('0.0.0.0'),
  }),
  logging: z.object({
    level: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
    nodeEnv: z.enum(['development', 'production']).default('development').catch('development'),
  }),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;

function buildRawConfig(): unknown {
  return {
    database: {
      url: process.env['DATABASE_URL'],
    },
    redis: {
      url: process.env['REDIS_URL'],
    },
    openrouter: {
      apiKey: process.env['OPENROUTER_API_KEY'],
    },
    firecrawl: {
      apiKey: process.env['FIRECRAWL_API_KEY'],
    },
    server: {
      port: process.env['PORT'],
      host: process.env['HOST'],
    },
    logging: {
      level: process.env['LOG_LEVEL'],
      nodeEnv: process.env['NODE_ENV'],
    },
  };
}

export function loadConfig(): AppConfig {
  const raw = buildRawConfig();
  const result = AppConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new ConfigError(`Configuration validation failed: ${issues}`);
  }
  return result.data;
}

export function loadConfigSafe(): { config: AppConfig } | { errors: string[] } {
  const raw = buildRawConfig();
  const result = AppConfigSchema.safeParse(raw);
  if (!result.success) {
    const errors = result.error.issues.map(
      (issue) => `${issue.path.join('.')}: ${issue.message}`,
    );
    return { errors };
  }
  return { config: result.data };
}
