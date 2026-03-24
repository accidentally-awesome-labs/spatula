CREATE TABLE `actions` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	`source` text NOT NULL,
	`status` text DEFAULT 'pending_review' NOT NULL,
	`confidence` real NOT NULL,
	`reasoning` text NOT NULL,
	`state_changes` text,
	`reviewed_by` text,
	`created_at` text NOT NULL,
	`applied_at` text,
	CONSTRAINT "source_check" CHECK("actions"."source" IN ('extraction','schema_evolution','reconciliation','quality_audit')),
	CONSTRAINT "status_check" CHECK("actions"."status" IN ('pending_review','approved','applied','rejected','rolled_back'))
);
--> statement-breakpoint
CREATE INDEX `sl_actions_job_type_idx` ON `actions` (`job_id`,`type`);--> statement-breakpoint
CREATE INDEX `sl_actions_job_status_idx` ON `actions` (`job_id`,`status`);--> statement-breakpoint
CREATE INDEX `sl_actions_job_created_idx` ON `actions` (`job_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `crawl_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`url` text NOT NULL,
	`depth` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`priority` text DEFAULT 'medium' NOT NULL,
	`classification` text,
	`parent_task_id` text,
	`crawler_type` text,
	`content_ref` text,
	`metadata` text DEFAULT '{}',
	`created_at` text NOT NULL,
	`processed_at` text,
	`priority_score` integer,
	`error_message` text,
	`attempts` integer DEFAULT 0,
	`completed_at` text,
	CONSTRAINT "status_check" CHECK("crawl_tasks"."status" IN ('pending','in_progress','completed','failed','skipped')),
	CONSTRAINT "priority_check" CHECK("crawl_tasks"."priority" IN ('critical','high','medium','low')),
	CONSTRAINT "classification_check" CHECK("crawl_tasks"."classification" IN ('single_entry','multiple_entries','navigation','irrelevant','partial') OR "crawl_tasks"."classification" IS NULL)
);
--> statement-breakpoint
CREATE INDEX `sl_crawl_tasks_job_status_idx` ON `crawl_tasks` (`job_id`,`status`);--> statement-breakpoint
CREATE INDEX `sl_crawl_tasks_job_depth_idx` ON `crawl_tasks` (`job_id`,`depth`);--> statement-breakpoint
CREATE INDEX `sl_crawl_tasks_url_idx` ON `crawl_tasks` (`url`);--> statement-breakpoint
CREATE TABLE `entities` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`merged_data` text NOT NULL,
	`provenance` text NOT NULL,
	`categories` text DEFAULT '[]' NOT NULL,
	`quality_score` real DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`source_count` integer DEFAULT 0,
	`updated_at` text
);
--> statement-breakpoint
CREATE INDEX `sl_entities_job_quality_idx` ON `entities` (`job_id`,`quality_score`);--> statement-breakpoint
CREATE TABLE `entity_sources` (
	`entity_id` text NOT NULL,
	`extraction_id` text NOT NULL,
	`match_confidence` real NOT NULL,
	PRIMARY KEY(`entity_id`, `extraction_id`)
);
--> statement-breakpoint
CREATE TABLE `exports` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text,
	`format` text NOT NULL,
	`file_path` text NOT NULL,
	`entity_count` integer,
	`file_size` integer,
	`include_provenance` integer DEFAULT false,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `extractions` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`page_id` text NOT NULL,
	`schema_version` integer NOT NULL,
	`data` text NOT NULL,
	`unmapped_fields` text DEFAULT '[]',
	`metadata` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `sl_extractions_job_schema_idx` ON `extractions` (`job_id`,`schema_version`);--> statement-breakpoint
CREATE INDEX `sl_extractions_page_idx` ON `extractions` (`page_id`);--> statement-breakpoint
CREATE TABLE `llm_usage` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text,
	`model` text NOT NULL,
	`prompt_tokens` integer NOT NULL,
	`completion_tokens` integer NOT NULL,
	`total_tokens` integer NOT NULL,
	`cost_usd` real NOT NULL,
	`purpose` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `sl_llm_usage_run_idx` ON `llm_usage` (`run_id`);--> statement-breakpoint
CREATE INDEX `sl_llm_usage_created_idx` ON `llm_usage` (`created_at`);--> statement-breakpoint
CREATE TABLE `pages` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`job_id` text NOT NULL,
	`content_ref` text NOT NULL,
	`content_hash` text NOT NULL,
	`metadata` text DEFAULT '{}',
	`created_at` text NOT NULL,
	`url` text,
	`status_code` integer,
	`title` text,
	`classification` text,
	`content_path` text,
	`needs_reextraction` integer DEFAULT false,
	`reextraction_reason` text
);
--> statement-breakpoint
CREATE INDEX `sl_pages_task_idx` ON `pages` (`task_id`);--> statement-breakpoint
CREATE INDEX `sl_pages_content_hash_idx` ON `pages` (`content_hash`);--> statement-breakpoint
CREATE INDEX `sl_pages_job_idx` ON `pages` (`job_id`);--> statement-breakpoint
CREATE TABLE `project_meta` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`source` text DEFAULT 'local' NOT NULL,
	`config_snapshot` text NOT NULL,
	`started_at` text NOT NULL,
	`completed_at` text,
	`pages_crawled` integer DEFAULT 0,
	`pages_reextracted` integer DEFAULT 0,
	`entities_created` integer DEFAULT 0,
	`llm_tokens_used` integer DEFAULT 0,
	`llm_cost_usd` real DEFAULT 0,
	`error_message` text,
	CONSTRAINT "status_check" CHECK("runs"."status" IN ('running','paused','completed','failed','pulled'))
);
--> statement-breakpoint
CREATE TABLE `schemas` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`version` integer NOT NULL,
	`definition` text NOT NULL,
	`parent_id` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `sl_schemas_job_version_idx` ON `schemas` (`job_id`,`version`);--> statement-breakpoint
CREATE TABLE `source_trust` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`domain` text NOT NULL,
	`trust_level` text NOT NULL,
	`score` real,
	`created_at` text
);
--> statement-breakpoint
CREATE INDEX `sl_source_trust_job_domain_idx` ON `source_trust` (`job_id`,`domain`);