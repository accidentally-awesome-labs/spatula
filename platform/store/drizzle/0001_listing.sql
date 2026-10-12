ALTER TABLE "items" DROP CONSTRAINT "items_status";--> statement-breakpoint
ALTER TABLE "fetches" ALTER COLUMN "item_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "fetches" ADD COLUMN "kind" text DEFAULT 'page' NOT NULL;--> statement-breakpoint
ALTER TABLE "fetches" ADD COLUMN "source_id" text;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "listed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "listed_lastmod" text;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "fetched_lastmod" text;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "last_fetched_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "missing_streak" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "listed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "fetches" ADD CONSTRAINT "fetches_kind" CHECK ("fetches"."kind" in ('page', 'sitemap'));--> statement-breakpoint
ALTER TABLE "fetches" ADD CONSTRAINT "fetches_subject" CHECK (("fetches"."kind" = 'page' and "fetches"."item_id" is not null) or ("fetches"."kind" = 'sitemap' and "fetches"."item_id" is null and "fetches"."source_id" is not null));--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_status" CHECK ("items"."status" in ('live', 'gone', 'refused', 'excluded', 'irrelevant'));