CREATE TABLE "evals" (
	"id" text PRIMARY KEY NOT NULL,
	"dataset_id" text NOT NULL,
	"generation" integer NOT NULL,
	"golden_version" integer NOT NULL,
	"scores" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "evals" ADD CONSTRAINT "evals_dataset_id_datasets_id_fk" FOREIGN KEY ("dataset_id") REFERENCES "public"."datasets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "evals_dataset" ON "evals" USING btree ("dataset_id","created_at");