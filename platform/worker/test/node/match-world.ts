import type { Definition, PagesSource } from '@spatula/core';
import { testDefinition } from '@spatula/store/fixtures';
import { expect } from 'vitest';
import { productPage, standardRoutes, URLS } from '../pages';
import { fakeDecider } from './fakes';
import { entityOf, refresh, worldFor } from './runs';

/*
 * The worlds the match and review tests share: maker A's pages saying what a test needs them to,
 * a third page for maker A, and the two versions of one headphone that a name alone can't tell
 * apart.
 */

/** The test dataset, with maker-a's two pages saying what a test needs them to. */
export function routesWith(a1: Record<string, unknown>, a2: Record<string, unknown>) {
  const routes = standardRoutes();
  routes[URLS.a1] = { status: 200, body: productPage(a1) };
  routes[URLS.a2] = { status: 200, body: productPage(a2) };
  return routes;
}

export const DT_80 = { name: 'DT 770 PRO', gtin13: '4010118471063' };
export const DT_250 = { name: 'DT 770 PRO', gtin13: '4010118471070' };
export const URL_A3 = 'https://maker-a.example/products/a3';

/** The test dataset with a third page for maker A, at a3. */
export function withThirdPage(definition: Definition): Definition {
  const makerA = definition.sources[0] as PagesSource;
  return {
    ...definition,
    sources: [{ ...makerA, pages: [...makerA.pages, URL_A3] }, definition.sources[1]!],
  };
}

/**
 * Two versions, split in the first run, and a page that gives only their name. The decider says
 * the 250 is a version of the 80, and `otherwise` is what it says of the page and each record: by
 * default it is sure the page is the same as whichever it is asked about, and a test that wants a
 * person asked about both passes probabilities that aren't sure.
 */
export async function versionsAndAPage(
  datasetId: string,
  otherwise: Record<string, number> = { same: 0.98 },
) {
  const routes = routesWith(DT_80, DT_250);
  routes[URL_A3] = { status: 200, body: productPage({ name: 'DT 770 PRO' }) };
  const definition = withThirdPage(testDefinition(datasetId));
  const {
    world,
    pages: [a1, a2, page],
  } = await worldFor(definition, routes);
  const scripted = fakeDecider(
    (request): Record<string, number> =>
      request.evidence.startsWith(`Record A (${URLS.a2}):`) ? { variant: 0.97 } : otherwise,
  );
  world.ports.decider = scripted.decider;
  await refresh(world, datasetId);
  const [e1, e2] = [(await entityOf(a1!.id))!, (await entityOf(a2!.id))!];
  expect(await entityOf(page!.id)).toBeNull();
  // The questions about the page are asked in the next run: one is accepted, and the other isn't.
  const second = await refresh(world, datasetId);
  return { world, definition, scripted, page: page!, e1, e2, second };
}
