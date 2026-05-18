export interface CursorEntityRepo {
  findByJobCursor(
    jobId: string,
    tenantId: string,
    limit: number,
    cursor?: string,
    since?: string,
    minQuality?: number,
  ): Promise<{ entities: unknown[]; nextCursor: string | null }>;
}

export async function* fetchEntitiesCursor(
  entityRepo: CursorEntityRepo,
  jobId: string,
  tenantId: string,
  batchSize = 500,
  options?: { minQuality?: number },
): AsyncIterable<unknown[]> {
  let cursor: string | undefined;
  while (true) {
    const batch = await entityRepo.findByJobCursor(
      jobId,
      tenantId,
      batchSize,
      cursor,
      undefined,
      options?.minQuality,
    );
    if (batch.entities.length === 0) break;
    yield batch.entities;
    if (!batch.nextCursor) break;
    cursor = batch.nextCursor;
  }
}
