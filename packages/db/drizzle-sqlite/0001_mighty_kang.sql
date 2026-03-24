PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_source_trust` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`domain` text NOT NULL,
	`trust_level` text NOT NULL,
	`score` real,
	`created_at` text NOT NULL,
	CONSTRAINT "trust_level_check" CHECK("__new_source_trust"."trust_level" IN ('authoritative','high','medium','low'))
);
--> statement-breakpoint
INSERT INTO `__new_source_trust`("id", "job_id", "domain", "trust_level", "score", "created_at") SELECT "id", "job_id", "domain", "trust_level", "score", "created_at" FROM `source_trust`;--> statement-breakpoint
DROP TABLE `source_trust`;--> statement-breakpoint
ALTER TABLE `__new_source_trust` RENAME TO `source_trust`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `sl_source_trust_job_domain_idx` ON `source_trust` (`job_id`,`domain`);--> statement-breakpoint
CREATE INDEX `sl_runs_status_idx` ON `runs` (`status`);