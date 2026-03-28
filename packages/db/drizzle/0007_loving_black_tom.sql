DROP INDEX "entities_job_quality_idx";--> statement-breakpoint
ALTER TABLE "actions" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "entities" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "exports" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "extractions" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_actions_updated" ON "actions" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "idx_entities_job_tenant" ON "entities" USING btree ("job_id","tenant_id");--> statement-breakpoint
CREATE INDEX "idx_entities_updated" ON "entities" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "idx_exports_job_tenant" ON "exports" USING btree ("job_id","tenant_id");--> statement-breakpoint
CREATE INDEX "idx_exports_updated" ON "exports" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "idx_extractions_job" ON "extractions" USING btree ("job_id","tenant_id");--> statement-breakpoint
CREATE INDEX "idx_extractions_updated" ON "extractions" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "entities_job_quality_idx" ON "entities" USING btree ("job_id","quality_score","id");