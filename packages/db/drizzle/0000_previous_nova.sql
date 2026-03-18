CREATE TYPE "public"."action_source" AS ENUM('extraction', 'schema_evolution', 'reconciliation', 'quality_audit');--> statement-breakpoint
CREATE TYPE "public"."action_status" AS ENUM('pending_review', 'approved', 'applied', 'rejected', 'rolled_back');--> statement-breakpoint
CREATE TYPE "public"."crawl_task_status" AS ENUM('pending', 'in_progress', 'completed', 'failed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."crawler_type" AS ENUM('playwright', 'firecrawl');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('pending', 'queued', 'running', 'paused', 'reconciling', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."page_classification" AS ENUM('single_entry', 'multiple_entries', 'navigation', 'irrelevant', 'partial');--> statement-breakpoint
CREATE TYPE "public"."task_priority" AS ENUM('high', 'medium', 'low');--> statement-breakpoint
CREATE TYPE "public"."trust_level" AS ENUM('authoritative', 'high', 'medium', 'low');--> statement-breakpoint
CREATE TABLE "actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"source" "action_source" NOT NULL,
	"status" "action_status" DEFAULT 'pending_review' NOT NULL,
	"confidence" real NOT NULL,
	"reasoning" text NOT NULL,
	"state_changes" jsonb,
	"reviewed_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"applied_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "content_store" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "content_store_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "crawl_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"url" text NOT NULL,
	"depth" integer DEFAULT 0 NOT NULL,
	"status" "crawl_task_status" DEFAULT 'pending' NOT NULL,
	"priority" "task_priority" DEFAULT 'medium' NOT NULL,
	"classification" "page_classification",
	"parent_task_id" uuid,
	"crawler_type" "crawler_type",
	"content_ref" text,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "entities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"merged_data" jsonb NOT NULL,
	"provenance" jsonb NOT NULL,
	"categories" text[] DEFAULT '{}'::text[] NOT NULL,
	"quality_score" real DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entity_sources" (
	"entity_id" uuid NOT NULL,
	"extraction_id" uuid NOT NULL,
	"match_confidence" real NOT NULL,
	CONSTRAINT "entity_sources_entity_id_extraction_id_pk" PRIMARY KEY("entity_id","extraction_id")
);
--> statement-breakpoint
CREATE TABLE "exports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"format" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"include_provenance" boolean DEFAULT false NOT NULL,
	"entity_count" integer,
	"content_ref" text,
	"file_size" integer,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "extractions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"page_id" uuid NOT NULL,
	"schema_version" integer NOT NULL,
	"data" jsonb NOT NULL,
	"unmapped_fields" jsonb DEFAULT '[]'::jsonb,
	"metadata" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"config" jsonb NOT NULL,
	"status" "job_status" DEFAULT 'pending' NOT NULL,
	"schema_id" uuid,
	"stats" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "schemas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"definition" jsonb NOT NULL,
	"parent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "raw_pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"content_ref" text NOT NULL,
	"content_hash" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_trust" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"domain" text NOT NULL,
	"trust_level" "trust_level" NOT NULL,
	"reasoning" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "actions" ADD CONSTRAINT "actions_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "actions" ADD CONSTRAINT "actions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crawl_tasks" ADD CONSTRAINT "crawl_tasks_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crawl_tasks" ADD CONSTRAINT "crawl_tasks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crawl_tasks" ADD CONSTRAINT "crawl_tasks_parent_task_id_crawl_tasks_id_fk" FOREIGN KEY ("parent_task_id") REFERENCES "public"."crawl_tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entities" ADD CONSTRAINT "entities_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entities" ADD CONSTRAINT "entities_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_sources" ADD CONSTRAINT "entity_sources_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_sources" ADD CONSTRAINT "entity_sources_extraction_id_extractions_id_fk" FOREIGN KEY ("extraction_id") REFERENCES "public"."extractions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exports" ADD CONSTRAINT "exports_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exports" ADD CONSTRAINT "exports_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extractions" ADD CONSTRAINT "extractions_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extractions" ADD CONSTRAINT "extractions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extractions" ADD CONSTRAINT "extractions_page_id_raw_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."raw_pages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_schema_id_schemas_id_fk" FOREIGN KEY ("schema_id") REFERENCES "public"."schemas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schemas" ADD CONSTRAINT "schemas_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schemas" ADD CONSTRAINT "schemas_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schemas" ADD CONSTRAINT "schemas_parent_id_schemas_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."schemas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw_pages" ADD CONSTRAINT "raw_pages_task_id_crawl_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."crawl_tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw_pages" ADD CONSTRAINT "raw_pages_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_trust" ADD CONSTRAINT "source_trust_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_trust" ADD CONSTRAINT "source_trust_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "actions_job_type_idx" ON "actions" USING btree ("job_id","type");--> statement-breakpoint
CREATE INDEX "actions_job_status_idx" ON "actions" USING btree ("job_id","status");--> statement-breakpoint
CREATE INDEX "actions_job_created_idx" ON "actions" USING btree ("job_id","created_at");--> statement-breakpoint
CREATE INDEX "crawl_tasks_job_status_idx" ON "crawl_tasks" USING btree ("job_id","status");--> statement-breakpoint
CREATE INDEX "crawl_tasks_job_depth_idx" ON "crawl_tasks" USING btree ("job_id","depth");--> statement-breakpoint
CREATE INDEX "crawl_tasks_url_idx" ON "crawl_tasks" USING btree ("url");--> statement-breakpoint
CREATE INDEX "entities_categories_gin_idx" ON "entities" USING gin ("categories");--> statement-breakpoint
CREATE INDEX "entities_job_quality_idx" ON "entities" USING btree ("job_id","quality_score");--> statement-breakpoint
CREATE INDEX "exports_job_idx" ON "exports" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "exports_tenant_idx" ON "exports" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "extractions_job_schema_idx" ON "extractions" USING btree ("job_id","schema_version");--> statement-breakpoint
CREATE INDEX "extractions_page_idx" ON "extractions" USING btree ("page_id");--> statement-breakpoint
CREATE INDEX "jobs_tenant_status_idx" ON "jobs" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "jobs_tenant_created_idx" ON "jobs" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "schemas_job_version_idx" ON "schemas" USING btree ("job_id","version");--> statement-breakpoint
CREATE INDEX "raw_pages_task_idx" ON "raw_pages" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "raw_pages_content_hash_idx" ON "raw_pages" USING btree ("content_hash");--> statement-breakpoint
CREATE INDEX "source_trust_job_domain_idx" ON "source_trust" USING btree ("job_id","domain");--> statement-breakpoint
CREATE INDEX "source_trust_tenant_idx" ON "source_trust" USING btree ("tenant_id");