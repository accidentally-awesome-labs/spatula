DROP INDEX "idx_api_keys_hash";--> statement-breakpoint
CREATE UNIQUE INDEX "idx_api_keys_hash" ON "api_keys" USING btree ("key_hash") WHERE revoked_at IS NULL;