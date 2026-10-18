CREATE TABLE "acknowledgments" (
	"id" text PRIMARY KEY NOT NULL,
	"dataset_id" text NOT NULL,
	"consumer" text NOT NULL,
	"generation" integer NOT NULL,
	"snapshot_id" text NOT NULL,
	"outcome" text NOT NULL,
	"detail" text,
	"counts" jsonb,
	"sent_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"body_sha256" text NOT NULL,
	CONSTRAINT "acknowledgments_outcome" CHECK ("acknowledgments"."outcome" in ('applied', 'refused'))
);
--> statement-breakpoint
ALTER TABLE "acknowledgments" ADD CONSTRAINT "acknowledgments_dataset_id_datasets_id_fk" FOREIGN KEY ("dataset_id") REFERENCES "public"."datasets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acknowledgments" ADD CONSTRAINT "acknowledgments_snapshot_id_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "acknowledgments_generation" ON "acknowledgments" USING btree ("dataset_id","consumer","generation");--> statement-breakpoint
CREATE INDEX "acknowledgments_snapshot" ON "acknowledgments" USING btree ("snapshot_id");