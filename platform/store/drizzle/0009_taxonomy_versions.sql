CREATE TABLE "taxonomy_versions" (
	"dataset_id" text NOT NULL,
	"version" integer NOT NULL,
	"taxonomy" jsonb NOT NULL,
	"changes" jsonb NOT NULL,
	"actor" jsonb NOT NULL,
	"autonomous" boolean DEFAULT false NOT NULL,
	"proposal_id" text,
	"undoes" integer,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "taxonomy_versions_dataset_id_version_pk" PRIMARY KEY("dataset_id","version"),
	CONSTRAINT "taxonomy_versions_version" CHECK ("taxonomy_versions"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "taxonomy_key" text;--> statement-breakpoint
ALTER TABLE "taxonomy_versions" ADD CONSTRAINT "taxonomy_versions_dataset_id_datasets_id_fk" FOREIGN KEY ("dataset_id") REFERENCES "public"."datasets"("id") ON DELETE cascade ON UPDATE no action;