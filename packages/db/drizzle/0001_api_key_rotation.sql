ALTER TABLE "api_keys" ADD COLUMN "supersedes" uuid;
--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "superseded_expires_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_supersedes_api_keys_id_fk" FOREIGN KEY ("supersedes") REFERENCES "public"."api_keys"("id") ON DELETE no action ON UPDATE no action;
