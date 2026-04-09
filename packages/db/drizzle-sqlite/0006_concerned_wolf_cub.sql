PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_extractions` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`page_id` text,
	`schema_version` integer NOT NULL,
	`data` text NOT NULL,
	`unmapped_fields` text DEFAULT '[]',
	`metadata` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`run_id` text,
	`page_url` text
);
--> statement-breakpoint
INSERT INTO `__new_extractions`("id", "job_id", "page_id", "schema_version", "data", "unmapped_fields", "metadata", "created_at", "updated_at") SELECT "id", "job_id", "page_id", "schema_version", "data", "unmapped_fields", "metadata", "created_at", "updated_at" FROM `extractions`;--> statement-breakpoint
DROP TABLE `extractions`;--> statement-breakpoint
ALTER TABLE `__new_extractions` RENAME TO `extractions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `sl_extractions_job_schema_idx` ON `extractions` (`job_id`,`schema_version`);--> statement-breakpoint
CREATE INDEX `sl_extractions_page_idx` ON `extractions` (`page_id`);--> statement-breakpoint
CREATE INDEX `sl_extractions_run_id_idx` ON `extractions` (`run_id`);--> statement-breakpoint
ALTER TABLE `actions` ADD `run_id` text;--> statement-breakpoint
CREATE INDEX `sl_actions_run_id_idx` ON `actions` (`run_id`);