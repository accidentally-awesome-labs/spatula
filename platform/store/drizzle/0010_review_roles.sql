CREATE TABLE "review_actions" (
	"id" text PRIMARY KEY NOT NULL,
	"dataset_id" text NOT NULL,
	"action" text NOT NULL,
	"subject" text NOT NULL,
	"actor" jsonb NOT NULL,
	"detail" jsonb NOT NULL,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "review_actions_action" CHECK ("review_actions"."action" in ('answer', 'flag', 'suggest', 'accept', 'edit', 'reject', 'apply', 'undo', 'revoke'))
);
--> statement-breakpoint
ALTER TABLE "review_items" ADD COLUMN "answered_by" jsonb;--> statement-breakpoint
ALTER TABLE "review_items" ADD COLUMN "note" text;--> statement-breakpoint
ALTER TABLE "review_items" ADD COLUMN "flagged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "review_items" ADD COLUMN "flag" jsonb;--> statement-breakpoint
ALTER TABLE "review_items" ADD COLUMN "suggestion" jsonb;--> statement-breakpoint
ALTER TABLE "review_actions" ADD CONSTRAINT "review_actions_dataset_id_datasets_id_fk" FOREIGN KEY ("dataset_id") REFERENCES "public"."datasets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "review_actions_dataset" ON "review_actions" USING btree ("dataset_id","at");--> statement-breakpoint
ALTER TABLE "review_items" ADD CONSTRAINT "review_items_flagged" CHECK (("review_items"."flagged_at" is null) = ("review_items"."flag" is null));