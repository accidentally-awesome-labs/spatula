import { taxonomySeedSchema, type TaxonomySeed } from '../taxonomy';

/*
 * A small taxonomy for core's tests: three categories, two with subcategories, four functions, and
 * two features, one of each cardinality. The store's fixtures have the same one for the other
 * packages' tests.
 */

/** IDs in order, each valid: tx_ and 20 digits. */
export function countingIds(): () => string {
  let n = 0;
  return () => `tx_${String((n += 1)).padStart(20, '0')}`;
}

export function testTaxonomySeed(): TaxonomySeed {
  return taxonomySeedSchema.parse({
    scope:
      'Hi-fi made for audio: headphones, DACs, and amplifiers. Out of scope: accessories (cables, stands).',
    functions: [
      { slug: 'dac', name: 'DAC', description: 'Converts digital audio to analog' },
      {
        slug: 'pre-amp',
        name: 'Pre-amp',
        description: 'Selects inputs and sets volume at line level',
      },
      {
        slug: 'amplifier',
        name: 'Amplifier',
        description: 'Drives headphones, IEMs, or speakers',
      },
      {
        slug: 'headphones',
        name: 'Headphones',
        description: 'Turns a signal into sound on the ears',
      },
    ],
    shelves: [
      {
        slug: 'headphones',
        name: 'Headphones',
        description: 'Worn over or on the ears with a headband',
        implies: ['headphones'],
        children: [
          {
            slug: 'over-ear',
            name: 'Over-ear',
            description: 'Cups around the ears',
            implies: ['headphones'],
          },
          {
            slug: 'on-ear',
            name: 'On-ear',
            description: 'Pads on the ears',
            implies: ['headphones'],
          },
        ],
      },
      {
        slug: 'dacs',
        name: 'DACs',
        description: 'Convert digital audio to analog',
        implies: ['dac'],
      },
      {
        slug: 'amplifiers',
        name: 'Amplifiers',
        description: 'Set a signal’s level or drive headphones or speakers',
        children: [
          {
            slug: 'headphone-amps',
            name: 'Headphone amps',
            description: 'Drive headphones',
            implies: ['amplifier'],
          },
          {
            slug: 'preamps',
            name: 'Preamps',
            description: 'Set volume at line level',
            implies: ['pre-amp'],
          },
          {
            slug: 'power-amps',
            name: 'Power amps',
            description: 'Drive speakers',
            implies: ['amplifier'],
          },
        ],
      },
    ],
    features: [
      {
        slug: 'back',
        name: 'Back',
        description: 'Whether the cups let sound through',
        cardinality: 'one',
        shelves: ['headphones'],
        values: [
          { slug: 'open', name: 'Open', description: 'Cups that let sound through' },
          { slug: 'closed', name: 'Closed', description: 'Sealed cups' },
        ],
      },
      {
        slug: 'drives',
        name: 'Drives',
        description: 'What its amplifier is built for',
        cardinality: 'many',
        shelves: ['amplifiers'],
        values: [
          { slug: 'iems', name: 'IEMs', description: 'In-ear monitors' },
          { slug: 'headphones', name: 'Headphones', description: 'Headphones' },
          { slug: 'speakers', name: 'Speakers', description: 'Loudspeakers' },
        ],
      },
    ],
  });
}
