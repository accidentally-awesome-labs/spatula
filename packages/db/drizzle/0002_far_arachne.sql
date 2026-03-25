CREATE TABLE "dead_letter_queue" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"queue_name" text NOT NULL,
	"job_id" text NOT NULL,
	"tenant_id" uuid,
	"spatula_job_id" uuid,
	"payload" jsonb NOT NULL,
	"error_message" text,
	"error_stack" text,
	"attempts" integer NOT NULL,
	"failed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolution" text
);
--> statement-breakpoint
ALTER TABLE "dead_letter_queue" ADD CONSTRAINT "dead_letter_queue_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dead_letter_queue" ADD CONSTRAINT "dead_letter_queue_spatula_job_id_jobs_id_fk" FOREIGN KEY ("spatula_job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dlq_queue_failed_idx" ON "dead_letter_queue" USING btree ("queue_name","failed_at");--> statement-breakpoint
CREATE INDEX "dlq_tenant_idx" ON "dead_letter_queue" USING btree ("tenant_id");