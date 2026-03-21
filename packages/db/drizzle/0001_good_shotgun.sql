ALTER TABLE "content_store" ALTER COLUMN "content" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "content_store" ADD COLUMN "binary_content" "bytea";--> statement-breakpoint
ALTER TABLE "content_store" ADD CONSTRAINT content_at_least_one CHECK (content IS NOT NULL OR binary_content IS NOT NULL);--> statement-breakpoint
ALTER TABLE "content_store" ADD CONSTRAINT content_not_both CHECK (NOT (content IS NOT NULL AND binary_content IS NOT NULL));