import {
  identityClaims,
  newId,
  resolveIdentity,
  survive,
  type Definition,
  type FieldValue,
} from '@spatula/core';
import { and, asc, eq } from 'drizzle-orm';
import type { Executor } from './client';
import { entities, entityKeys, items } from './schema';
import { currentStatements, type CurrentStatement } from './statements';

export interface EntityResolution {
  created: number;
  /** Pages newly joined to an entity that already existed. */
  linked: number;
  conflicts: number;
  unresolved: number;
  notes: string[];
}

/**
 * Joins each live page to the entity it describes. Pages already joined claim their keys first,
 * so a new page finds them. A page that isn't joined yet follows its strongest claim that has an
 * owner, or starts a new entity, with a canonical ID assigned once. A claim another entity
 * already owns is reported as a conflict and changes nothing: merging is a decision for a person
 * or the decision cascade, not for this step.
 */
export async function resolveEntities(
  db: Executor,
  input: { datasetId: string; definition: Definition },
): Promise<EntityResolution> {
  const { datasetId, definition } = input;
  return db.transaction(async (tx) => {
    // Pushed in place: copying each item's list for every statement would be quadratic.
    const said = new Map<string, CurrentStatement[]>();
    for (const statement of await currentStatements(tx, datasetId)) {
      const list = said.get(statement.itemId);
      if (list === undefined) said.set(statement.itemId, [statement]);
      else list.push(statement);
    }
    const pages = await tx
      .select({
        id: items.id,
        locator: items.locator,
        recordType: items.recordType,
        entityId: items.entityId,
      })
      .from(items)
      .where(and(eq(items.datasetId, datasetId), eq(items.status, 'live')))
      .orderBy(asc(items.sourceId), asc(items.locator));
    const owners = new Map(
      (
        await tx
          .select({ value: entityKeys.value, entityId: entityKeys.entityId })
          .from(entityKeys)
          .where(eq(entityKeys.datasetId, datasetId))
      ).map((key) => [key.value, key.entityId]),
    );

    const result: EntityResolution = {
      created: 0,
      linked: 0,
      conflicts: 0,
      unresolved: 0,
      notes: [],
    };
    const joined = pages.filter((page) => page.entityId !== null);
    const unjoined = pages.filter((page) => page.entityId === null);
    for (const page of [...joined, ...unjoined]) {
      const recordType = definition.recordTypes[page.recordType];
      if (recordType === undefined) continue;
      const values: Record<string, FieldValue[]> = {};
      for (const [name, field] of survive(recordType, said.get(page.id) ?? []))
        values[name] = field.values;
      const claims = identityClaims(recordType, values);

      let entityId = page.entityId;
      if (entityId === null) {
        const resolution = resolveIdentity(claims, owners);
        if (resolution.kind === 'unresolvable') {
          result.unresolved += 1;
          result.notes.push(
            `${page.locator} has nothing to identify it by yet, so it has no entity`,
          );
          continue;
        }
        if (resolution.kind === 'existing') {
          entityId = resolution.entityId;
          result.linked += 1;
        } else {
          entityId = newId('sp');
          await tx
            .insert(entities)
            .values({ id: entityId, datasetId, recordType: page.recordType });
          result.created += 1;
        }
        await tx.update(items).set({ entityId }).where(eq(items.id, page.id));
      }

      for (const claim of claims) {
        const owner = owners.get(claim.value);
        if (owner === undefined) {
          owners.set(claim.value, entityId);
          await tx.insert(entityKeys).values({ datasetId, value: claim.value, entityId });
        } else if (owner !== entityId) {
          result.conflicts += 1;
          result.notes.push(
            `${page.locator} claims ${claim.value}, which belongs to ${owner}, while the page belongs to ${entityId}`,
          );
        }
      }
    }
    return result;
  });
}
