import { z } from 'zod';

const CurrencyNormalization = z.object({
  type: z.literal('currency'),
  config: z.object({
    targetCurrency: z.string().optional(),
    decimalPlaces: z.number().default(2),
  }),
});

const EnumNormalization = z.object({
  type: z.literal('enum'),
  config: z.object({
    canonicalValues: z.array(z.string()),
    synonymMap: z.record(z.string()),
  }),
});

const ListNormalization = z.object({
  type: z.literal('list'),
  config: z.object({
    separator: z.string().optional(),
  }),
});

const TextNormalization = z.object({
  type: z.literal('text'),
  config: z.object({
    casing: z.enum(['title', 'lower', 'upper', 'preserve']).default('title'),
    trim: z.boolean().default(true),
    collapseWhitespace: z.boolean().default(true),
  }),
});

const MeasurementNormalization = z.object({
  type: z.literal('measurement'),
  config: z.object({
    targetUnit: z.string().optional(),
    format: z.string().optional(),
  }),
});

const BooleanNormalization = z.object({
  type: z.literal('boolean'),
  config: z.object({
    trueValues: z.array(z.string()).default(['yes', 'true', '1', 'available']),
    falseValues: z.array(z.string()).default(['no', 'false', '0', 'unavailable']),
  }),
});

const LLMNormalization = z.object({
  type: z.literal('llm'),
  config: z.object({
    instruction: z.string(),
  }),
});

export const NormalizationRule = z.discriminatedUnion('type', [
  CurrencyNormalization,
  EnumNormalization,
  ListNormalization,
  TextNormalization,
  MeasurementNormalization,
  BooleanNormalization,
  LLMNormalization,
]);

export type NormalizationRule = z.infer<typeof NormalizationRule>;
