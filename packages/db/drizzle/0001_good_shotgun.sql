ALTER TABLE "content_store" ALTER COLUMN "content" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "content_store" ADD COLUMN "binary_content" "bytea";