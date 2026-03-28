export interface ContentStore {
  store(key: string, content: string): Promise<string>;
  retrieve(ref: string): Promise<string>;
  delete(ref: string): Promise<void>;
  storeBinary(key: string, data: Uint8Array): Promise<string>;
  retrieveBinary(ref: string): Promise<Uint8Array | null>;
  getDownloadUrl?(ref: string, expiresInSeconds?: number): Promise<string>;
}

export function supportsPresignedUrls(
  store: ContentStore,
): store is ContentStore & { getDownloadUrl: (ref: string, expiresIn?: number) => Promise<string> } {
  return typeof (store as any).getDownloadUrl === 'function';
}
