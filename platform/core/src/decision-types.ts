import type { Question } from './decisions';
import type { FieldDef, FieldValue } from './fields';
import { sha256Hex, stableStringify } from './ids';
import { jsonLdTypes, type Page } from './page';

/*
 * The decisions slice 1 makes. Classifying: which value of a decided field a page's one product
 * has, or "None of these", which takes the page out of the dataset. Matching: whether a page that
 * isn't joined yet describes the same product as an entity, a variant of it, or a different one.
 * Each question's state is what its answer rests on, and its hash is how an unchanged question is
 * recognized and never asked again. A state holds facts already accepted and what a page says
 * about itself, never its free text, which changes with every price.
 */

export const NONE_OF_THESE = 'None of these';
/** Bump when the classification question or its criteria change: pages are then asked again. */
export const CLASSIFY_CRITERIA_VERSION = 1;

const CLASSIFY_CRITERIA = [
  'Choose the value that fits the one product the page is about, as its maker would describe it.',
  `Choose "${NONE_OF_THESE}" when the page is about no single product (a list, a category, an article, a help page), when its product is an accessory, a spare part, merchandise, a gift card, software, or a service, when it sells several different products together, or when its product fits none of the values.`,
  'A model sold with extras, such as a cable, a case, or a creator package, is the model.',
].join('\n');

/** The question that classifies a page, for its decided field. */
export function classifyQuestion(name: string, field: FieldDef): Question {
  return {
    type: 'choice',
    prompt: `Which ${name} does the one product this page is about have?`,
    options: [...(field.values ?? []), NONE_OF_THESE],
  };
}

/** How to classify, with the field's own description of its values when it has one. */
export function classifyCriteria(field: FieldDef): string {
  return field.description === undefined
    ? CLASSIFY_CRITERIA
    : `${CLASSIFY_CRITERIA}\nAbout the values: ${field.description}`;
}

export interface ClassifyState {
  url: string;
  title: string | null;
  breadcrumbs: string[];
  /** The JSON-LD types on the page, each once, in the order the page gives them. */
  types: string[];
  /** How many Product or ProductGroup nodes the page's JSON-LD has. */
  products: number;
  /** The categories its JSON-LD products give, one for each product that states one. */
  categories: string[];
  /**
   * What its statements say: each property's values as text, each once and in order of text, so
   * that the order they were read in doesn't matter. The properties are sorted too.
   */
  values: Record<string, string[]>;
}

/** At most this many values of a property go into a state. */
const STATE_VALUES_MAX = 20;
/** No field keeps a value longer than this many characters. */
const STATE_VALUE_MAX = 600;

/**
 * A page's words as a state keeps them: on one line, cut to `max` characters, and in a form a
 * database takes. Postgres refuses U+0000 in text, and jsonb refuses it and a lone surrogate too,
 * which a JSON-LD string can hold ("\ud800"). A state is stored with the decision it led to, so one
 * stray character in a page's title would fail that record, and a page could choose to. The text
 * is cut before it is made well formed, which also repairs a pair that the cut split.
 */
function stateText(text: string, max: number): string {
  return text
    .replace(/[\p{Cc}\s]+/gu, ' ')
    .trim()
    .slice(0, max)
    .trimEnd()
    .toWellFormed();
}

/**
 * A list of a page's words as a state keeps it: each cleaned, the empty ones dropped, each text
 * once, and only then cut to STATE_VALUES_MAX, in the order given or in order of text. Texts that
 * clean to the same text count as one, and ones that clean to nothing as none, before the cut
 * decides which are kept. Each text is cleaned once, however often a page repeats it.
 */
function stateTexts(texts: readonly string[], max: number, sorted: boolean): string[] {
  const kept = new Set<string>();
  for (const text of new Set(texts)) {
    const clean = stateText(text, max);
    if (clean !== '') kept.add(clean);
  }
  return (sorted ? [...kept].sort() : [...kept]).slice(0, STATE_VALUES_MAX);
}

/**
 * What a page's classification rests on. A title is cut to 300 characters and a crumb to 100, the
 * lengths a page keeps them to already. A type or a category is cut to 200, because either can be
 * as long as the page. Breadcrumbs keep their order, which is a path. A property's values are
 * sorted, so the state and its hash don't depend on the order they were read in.
 */
export function classifyState(page: Page, values: Record<string, FieldValue[]>): ClassifyState {
  let products = 0;
  const categories: string[] = [];
  for (const node of page.jsonLd) {
    if (!jsonLdTypes(node).some((type) => type === 'Product' || type === 'ProductGroup')) continue;
    products += 1;
    const category = typeof node.category === 'string' ? stateText(node.category, 200) : '';
    if (category !== '') categories.push(category);
  }
  const title = page.title === null ? '' : stateText(page.title, 300);
  return {
    url: page.url,
    title: title === '' ? null : title,
    breadcrumbs: page.breadcrumbs
      .map((crumb) => stateText(crumb, 100))
      .filter((crumb) => crumb !== ''),
    types: stateTexts(page.jsonLd.flatMap(jsonLdTypes), 200, false),
    products,
    categories: categories.slice(0, STATE_VALUES_MAX),
    values: Object.fromEntries(
      Object.keys(values)
        .sort()
        .map((name) => [
          name,
          stateTexts((values[name] ?? []).map(valueText), STATE_VALUE_MAX, true),
        ]),
    ),
  };
}

/**
 * A structured-data category answers without asking anyone, so only when the page leaves no doubt.
 * A rule's answer is published as it stands, with no model and no person to look at it. Every
 * product the page has must state a category, and all of them must be the same one of the field's
 * values, in whatever case. A page with a related product, several products, a product that
 * states none, or one whose category is no value (such as Accessories) is left to the deciders.
 * The answer is the value as the definition spells it.
 */
export function classifyRule(state: ClassifyState, field: FieldDef): string | null {
  const { categories, products } = state;
  // There is a product, and each product states a category: no category at all means no product,
  // and fewer categories than products means one states none.
  const [first] = categories;
  if (first === undefined || categories.length !== products) return null;
  const category = first.toLowerCase();
  if (categories.some((other) => other.toLowerCase() !== category)) return null;
  return field.values?.find((value) => value.toLowerCase() === category) ?? null;
}

/** A classification state as evidence for a decider. */
export function stateEvidence(state: ClassifyState): string {
  return [
    `Address: ${state.url}`,
    ...(state.title === null ? [] : [`Title: ${state.title}`]),
    ...(state.breadcrumbs.length === 0 ? [] : [`Breadcrumbs: ${state.breadcrumbs.join(' > ')}`]),
    ...(state.types.length === 0 ? [] : [`Structured data types: ${state.types.join(', ')}`]),
    ...(state.categories.length === 0
      ? []
      : [`Structured data category: ${state.categories.join(', ')}`]),
    ...Object.entries(state.values).map(([name, values]) => `${name}: ${values.join('; ')}`),
  ].join('\n');
}

/** A state's hash: equal states hash alike, whatever order their keys were built in. */
export function stateHash(state: unknown): Promise<string> {
  return sha256Hex(stableStringify(state));
}

export const MATCH_ANSWERS = ['same', 'variant', 'different'] as const;

/** The matching question. What "same" means is the record type's pack's criteria. */
export function matchQuestion(): Question {
  return {
    type: 'choice',
    prompt: 'Are these two records the same product?',
    options: [...MATCH_ANSWERS],
  };
}

export interface MatchSide {
  url: string;
  values: Record<string, FieldValue[]>;
}

/** Both sides of a match question as evidence: each record's values, by property. */
export function matchEvidence(state: { page: MatchSide; entity: MatchSide }): string {
  const side = (label: string, record: MatchSide) => [
    `Record ${label} (${record.url}):`,
    ...Object.keys(record.values)
      .sort()
      .map(
        (name) =>
          `${name}: ${(record.values[name] ?? []).slice(0, STATE_VALUES_MAX).map(valueText).join('; ')}`,
      ),
  ];
  return [...side('A', state.page), '', ...side('B', state.entity)].join('\n');
}

function valueText(value: FieldValue): string {
  return typeof value === 'string' ? value : `${value.label}: ${value.value}`;
}
