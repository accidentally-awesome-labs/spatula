CREATE TABLE "decision_records" (
	"id" text PRIMARY KEY NOT NULL,
	"dataset_id" text NOT NULL,
	"type" text NOT NULL,
	"subject" text NOT NULL,
	"subject_key" text NOT NULL,
	"state" jsonb NOT NULL,
	"state_hash" text NOT NULL,
	"question" jsonb NOT NULL,
	"criteria_version" integer NOT NULL,
	"adapter" text,
	"probabilities" jsonb NOT NULL,
	"evidence" text NOT NULL,
	"thresholds" jsonb NOT NULL,
	"outcome" text NOT NULL,
	"answer" text,
	"final_answer" text,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"decided_at" timestamp with time zone NOT NULL,
	"finalized_at" timestamp with time zone,
	"superseded_at" timestamp with time zone,
	CONSTRAINT "decision_records_outcome" CHECK ("decision_records"."outcome" in ('rule', 'accepted', 'escalated'))
);
--> statement-breakpoint
CREATE TABLE "judgements" (
	"dataset_id" text NOT NULL,
	"item_id" text NOT NULL,
	"entity_id" text NOT NULL,
	"verdict" text NOT NULL,
	"who" text NOT NULL,
	"confidence" double precision NOT NULL,
	"decision_id" text,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "judgements_item_id_entity_id_pk" PRIMARY KEY("item_id","entity_id"),
	CONSTRAINT "judgements_verdict" CHECK ("judgements"."verdict" in ('same', 'not_same', 'unsure')),
	CONSTRAINT "judgements_who" CHECK ("judgements"."who" in ('rule', 'llm', 'person', 'consumer')),
	CONSTRAINT "judgements_confidence" CHECK ("judgements"."confidence" >= 0 and "judgements"."confidence" <= 1)
);
--> statement-breakpoint
CREATE TABLE "review_items" (
	"id" text PRIMARY KEY NOT NULL,
	"dataset_id" text NOT NULL,
	"kind" text NOT NULL,
	"subject" text NOT NULL,
	"item_id" text,
	"entity_id" text,
	"decision_id" text,
	"question" jsonb NOT NULL,
	"context" jsonb NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"answer" text,
	"created_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "review_items_kind" CHECK ("review_items"."kind" in ('classify', 'match', 'publication')),
	CONSTRAINT "review_items_status" CHECK ("review_items"."status" in ('open', 'decided', 'dismissed'))
);
--> statement-breakpoint
ALTER TABLE "decision_records" ADD CONSTRAINT "decision_records_dataset_id_datasets_id_fk" FOREIGN KEY ("dataset_id") REFERENCES "public"."datasets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "judgements" ADD CONSTRAINT "judgements_dataset_id_datasets_id_fk" FOREIGN KEY ("dataset_id") REFERENCES "public"."datasets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "judgements" ADD CONSTRAINT "judgements_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "judgements" ADD CONSTRAINT "judgements_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "judgements" ADD CONSTRAINT "judgements_decision_id_decision_records_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."decision_records"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_items" ADD CONSTRAINT "review_items_dataset_id_datasets_id_fk" FOREIGN KEY ("dataset_id") REFERENCES "public"."datasets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_items" ADD CONSTRAINT "review_items_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_items" ADD CONSTRAINT "review_items_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_items" ADD CONSTRAINT "review_items_decision_id_decision_records_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."decision_records"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "decision_records_current" ON "decision_records" USING btree ("dataset_id","subject_key","state_hash","criteria_version") WHERE "decision_records"."superseded_at" is null;--> statement-breakpoint
CREATE INDEX "decision_records_subject" ON "decision_records" USING btree ("dataset_id","subject");--> statement-breakpoint
CREATE INDEX "judgements_dataset" ON "judgements" USING btree ("dataset_id");--> statement-breakpoint
CREATE INDEX "judgements_entity" ON "judgements" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "judgements_decision" ON "judgements" USING btree ("decision_id");--> statement-breakpoint
CREATE UNIQUE INDEX "review_items_open" ON "review_items" USING btree ("dataset_id","kind","subject") WHERE "review_items"."status" = 'open';--> statement-breakpoint
CREATE INDEX "review_items_dataset" ON "review_items" USING btree ("dataset_id","status");--> statement-breakpoint
CREATE INDEX "review_items_item" ON "review_items" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "review_items_entity" ON "review_items" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "review_items_decision" ON "review_items" USING btree ("decision_id");