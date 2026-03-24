ALTER TABLE `exports` ADD `status` text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE `exports` ADD `error` text;--> statement-breakpoint
ALTER TABLE `exports` ADD `completed_at` text;