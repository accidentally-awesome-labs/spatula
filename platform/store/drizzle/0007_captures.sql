CREATE TABLE "captures" (
	"id" text PRIMARY KEY NOT NULL,
	"dataset_id" text NOT NULL,
	"item_id" text NOT NULL,
	"source_id" text NOT NULL,
	"fetch_id" text NOT NULL,
	"url" text NOT NULL,
	"final_url" text NOT NULL,
	"http_status" integer,
	"etag" text,
	"last_modified" text,
	"fetched_at" timestamp with time zone NOT NULL,
	"content_hash" text NOT NULL,
	"bytes" integer,
	"stored_bytes" integer,
	"signals" jsonb,
	"read_key" text,
	"reader" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "statements" ADD COLUMN "capture_id" text;--> statement-breakpoint
ALTER TABLE "captures" ADD CONSTRAINT "captures_dataset_id_datasets_id_fk" FOREIGN KEY ("dataset_id") REFERENCES "public"."datasets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "captures" ADD CONSTRAINT "captures_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "captures" ADD CONSTRAINT "captures_fetch_id_fetches_id_fk" FOREIGN KEY ("fetch_id") REFERENCES "public"."fetches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "captures_item" ON "captures" USING btree ("item_id","fetched_at");--> statement-breakpoint
CREATE INDEX "captures_dataset_source" ON "captures" USING btree ("dataset_id","source_id");--> statement-breakpoint
CREATE INDEX "captures_content" ON "captures" USING btree ("content_hash");--> statement-breakpoint
CREATE INDEX "captures_fetch" ON "captures" USING btree ("fetch_id");--> statement-breakpoint
ALTER TABLE "statements" ADD CONSTRAINT "statements_capture_id_captures_id_fk" FOREIGN KEY ("capture_id") REFERENCES "public"."captures"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "items_content" ON "items" USING btree ("content_hash");--> statement-breakpoint
CREATE INDEX "statements_capture" ON "statements" USING btree ("capture_id");