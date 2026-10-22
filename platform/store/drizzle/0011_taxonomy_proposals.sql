CREATE TABLE "autonomy" (
	"dataset_id" text NOT NULL,
	"kind" text NOT NULL,
	"streak" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "autonomy_dataset_id_kind_pk" PRIMARY KEY("dataset_id","kind"),
	CONSTRAINT "autonomy_streak" CHECK ("autonomy"."streak" >= 0),
	CONSTRAINT "autonomy_kind" CHECK ("autonomy"."kind" in ('add-subcategory', 'add-feature', 'add-value', 'describe'))
);
--> statement-breakpoint
CREATE TABLE "taxonomy_proposals" (
	"id" text PRIMARY KEY NOT NULL,
	"dataset_id" text NOT NULL,
	"run_id" text,
	"kind" text NOT NULL,
	"change" jsonb NOT NULL,
	"change_text" text NOT NULL,
	"change_hash" text NOT NULL,
	"summary" text,
	"why" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"impact" jsonb,
	"status" text DEFAULT 'open' NOT NULL,
	"drop_reason" text,
	"base" integer NOT NULL,
	"version" integer,
	"decided_by" jsonb,
	"edited" boolean DEFAULT false NOT NULL,
	"note" text,
	"created_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone,
	CONSTRAINT "taxonomy_proposals_status" CHECK ("taxonomy_proposals"."status" in ('open', 'accepted', 'rejected', 'applied', 'dropped'))
);
--> statement-breakpoint
ALTER TABLE "autonomy" ADD CONSTRAINT "autonomy_dataset_id_datasets_id_fk" FOREIGN KEY ("dataset_id") REFERENCES "public"."datasets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "taxonomy_proposals" ADD CONSTRAINT "taxonomy_proposals_dataset_id_datasets_id_fk" FOREIGN KEY ("dataset_id") REFERENCES "public"."datasets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "taxonomy_proposals" ADD CONSTRAINT "taxonomy_proposals_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "taxonomy_proposals_change" ON "taxonomy_proposals" USING btree ("dataset_id","change_hash") WHERE "taxonomy_proposals"."status" in ('open', 'rejected', 'applied');--> statement-breakpoint
CREATE INDEX "taxonomy_proposals_dataset" ON "taxonomy_proposals" USING btree ("dataset_id","status","created_at");--> statement-breakpoint
CREATE INDEX "taxonomy_proposals_run" ON "taxonomy_proposals" USING btree ("run_id");