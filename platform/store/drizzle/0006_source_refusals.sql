ALTER TABLE "sources" ADD COLUMN "blocked_runs" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "refused_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "last_probe_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "last_probe" text;--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "counted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_blocked_runs" CHECK ("sources"."blocked_runs" >= 0);--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_last_probe" CHECK ("sources"."last_probe" in ('blocked', 'no answer'));