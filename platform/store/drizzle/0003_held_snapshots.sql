ALTER TABLE "snapshots" ALTER COLUMN "generation" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "snapshots" ALTER COLUMN "published_at" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "snapshots" ADD COLUMN "state" text DEFAULT 'published' NOT NULL;--> statement-breakpoint
ALTER TABLE "snapshots" ADD COLUMN "revision" integer;--> statement-breakpoint
ALTER TABLE "snapshots" ADD COLUMN "held_reason" text;--> statement-breakpoint
ALTER TABLE "snapshots" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
UPDATE "snapshots" SET "created_at" = "published_at";--> statement-breakpoint
CREATE INDEX "snapshots_dataset_state" ON "snapshots" USING btree ("dataset_id","state");--> statement-breakpoint
ALTER TABLE "snapshots" ADD CONSTRAINT "snapshots_state" CHECK ("snapshots"."state" in ('published', 'held', 'superseded', 'discarded'));--> statement-breakpoint
ALTER TABLE "snapshots" ADD CONSTRAINT "snapshots_published" CHECK (("snapshots"."state" = 'published') = ("snapshots"."generation" is not null) and ("snapshots"."state" = 'published') = ("snapshots"."published_at" is not null));