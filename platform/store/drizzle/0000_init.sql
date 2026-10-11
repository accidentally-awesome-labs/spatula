CREATE TABLE "datasets" (
	"id" text PRIMARY KEY NOT NULL,
	"revision" integer NOT NULL,
	"definition" jsonb NOT NULL,
	"definition_hash" text NOT NULL,
	"head_generation" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "datasets_revision_positive" CHECK ("datasets"."revision" > 0),
	CONSTRAINT "datasets_head_generation_not_negative" CHECK ("datasets"."head_generation" >= 0)
);
--> statement-breakpoint
CREATE TABLE "entities" (
	"id" text PRIMARY KEY NOT NULL,
	"dataset_id" text NOT NULL,
	"record_type" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entities_status" CHECK ("entities"."status" in ('active', 'merged', 'retired'))
);
--> statement-breakpoint
CREATE TABLE "entity_keys" (
	"dataset_id" text NOT NULL,
	"value" text NOT NULL,
	"entity_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entity_keys_dataset_id_value_pk" PRIMARY KEY("dataset_id","value")
);
--> statement-breakpoint
CREATE TABLE "fetches" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"item_id" text NOT NULL,
	"url" text NOT NULL,
	"final_url" text,
	"policy" text NOT NULL,
	"policy_reason" text,
	"method" text NOT NULL,
	"outcome" text NOT NULL,
	"http_status" integer,
	"content_hash" text,
	"bytes" integer,
	"signals" jsonb,
	"started_at" timestamp with time zone NOT NULL,
	"duration_ms" integer NOT NULL,
	"llm" text,
	"llm_input_tokens" integer DEFAULT 0 NOT NULL,
	"llm_output_tokens" integer DEFAULT 0 NOT NULL,
	"error" text,
	CONSTRAINT "fetches_policy" CHECK ("fetches"."policy" in ('allowed', 'denied')),
	CONSTRAINT "fetches_outcome" CHECK ("fetches"."outcome" in ('changed', 'unchanged', 'gone', 'failed', 'blocked'))
);
--> statement-breakpoint
CREATE TABLE "items" (
	"id" text PRIMARY KEY NOT NULL,
	"dataset_id" text NOT NULL,
	"source_id" text NOT NULL,
	"record_type" text NOT NULL,
	"locator" text NOT NULL,
	"status" text DEFAULT 'live' NOT NULL,
	"entity_id" text,
	"etag" text,
	"last_modified" text,
	"content_hash" text,
	"extract_input_hash" text,
	"extracted_with" text,
	"last_outcome" text,
	"outcome_streak" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "items_status" CHECK ("items"."status" in ('live', 'gone', 'refused', 'excluded'))
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" text PRIMARY KEY NOT NULL,
	"dataset_id" text NOT NULL,
	"status" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"summary" jsonb,
	"error" text,
	CONSTRAINT "runs_status" CHECK ("runs"."status" in ('running', 'complete', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"dataset_id" text NOT NULL,
	"generation" integer NOT NULL,
	"run_id" text,
	"record_count" integer NOT NULL,
	"records_sha256" text NOT NULL,
	"key" text NOT NULL,
	"sha256" text NOT NULL,
	"bytes" integer NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	"report" jsonb NOT NULL,
	CONSTRAINT "snapshots_generation_positive" CHECK ("snapshots"."generation" > 0)
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"dataset_id" text NOT NULL,
	"id" text NOT NULL,
	"kind" text NOT NULL,
	"config" jsonb NOT NULL,
	"removed_at" timestamp with time zone,
	CONSTRAINT "sources_dataset_id_id_pk" PRIMARY KEY("dataset_id","id")
);
--> statement-breakpoint
CREATE TABLE "statements" (
	"id" text PRIMARY KEY NOT NULL,
	"dataset_id" text NOT NULL,
	"item_id" text NOT NULL,
	"property" text NOT NULL,
	"value" jsonb NOT NULL,
	"value_key" text NOT NULL,
	"original" text NOT NULL,
	"path" text NOT NULL,
	"method" text NOT NULL,
	"confidence" double precision NOT NULL,
	"position" integer,
	"fetch_id" text NOT NULL,
	"last_fetch_id" text NOT NULL,
	"first_seen" timestamp with time zone NOT NULL,
	"last_seen" timestamp with time zone NOT NULL,
	"withdrawn_at" timestamp with time zone,
	CONSTRAINT "statements_method" CHECK ("statements"."method" in ('jsonld', 'microdata', 'opengraph', 'rule', 'llm', 'api', 'feed', 'human')),
	CONSTRAINT "statements_confidence" CHECK ("statements"."confidence" >= 0 and "statements"."confidence" <= 1)
);
--> statement-breakpoint
ALTER TABLE "entities" ADD CONSTRAINT "entities_dataset_id_datasets_id_fk" FOREIGN KEY ("dataset_id") REFERENCES "public"."datasets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_keys" ADD CONSTRAINT "entity_keys_dataset_id_datasets_id_fk" FOREIGN KEY ("dataset_id") REFERENCES "public"."datasets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_keys" ADD CONSTRAINT "entity_keys_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fetches" ADD CONSTRAINT "fetches_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fetches" ADD CONSTRAINT "fetches_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_source_fk" FOREIGN KEY ("dataset_id","source_id") REFERENCES "public"."sources"("dataset_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_dataset_id_datasets_id_fk" FOREIGN KEY ("dataset_id") REFERENCES "public"."datasets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "snapshots" ADD CONSTRAINT "snapshots_dataset_id_datasets_id_fk" FOREIGN KEY ("dataset_id") REFERENCES "public"."datasets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "snapshots" ADD CONSTRAINT "snapshots_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_dataset_id_datasets_id_fk" FOREIGN KEY ("dataset_id") REFERENCES "public"."datasets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statements" ADD CONSTRAINT "statements_dataset_id_datasets_id_fk" FOREIGN KEY ("dataset_id") REFERENCES "public"."datasets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statements" ADD CONSTRAINT "statements_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statements" ADD CONSTRAINT "statements_fetch_id_fetches_id_fk" FOREIGN KEY ("fetch_id") REFERENCES "public"."fetches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statements" ADD CONSTRAINT "statements_last_fetch_id_fetches_id_fk" FOREIGN KEY ("last_fetch_id") REFERENCES "public"."fetches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "entities_dataset" ON "entities" USING btree ("dataset_id");--> statement-breakpoint
CREATE INDEX "entity_keys_entity" ON "entity_keys" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "fetches_run" ON "fetches" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "fetches_item" ON "fetches" USING btree ("item_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "items_source_locator" ON "items" USING btree ("dataset_id","source_id","locator");--> statement-breakpoint
CREATE INDEX "items_entity" ON "items" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "runs_dataset" ON "runs" USING btree ("dataset_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "snapshots_generation" ON "snapshots" USING btree ("dataset_id","generation");--> statement-breakpoint
CREATE INDEX "snapshots_run" ON "snapshots" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "statements_current" ON "statements" USING btree ("item_id","property","method","value_key") WHERE "statements"."withdrawn_at" is null;--> statement-breakpoint
CREATE INDEX "statements_item" ON "statements" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "statements_dataset" ON "statements" USING btree ("dataset_id");--> statement-breakpoint
CREATE INDEX "statements_fetch" ON "statements" USING btree ("fetch_id");--> statement-breakpoint
CREATE INDEX "statements_last_fetch" ON "statements" USING btree ("last_fetch_id");