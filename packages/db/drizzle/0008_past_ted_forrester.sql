CREATE TABLE "user_tenants" (
	"user_id" text NOT NULL,
	"tenant_id" uuid NOT NULL,
	"role" varchar(20) DEFAULT 'member' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_tenants_user_id_tenant_id_pk" PRIMARY KEY("user_id","tenant_id")
);
--> statement-breakpoint
ALTER TABLE "user_tenants" ADD CONSTRAINT "user_tenants_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_user_tenants_user" ON "user_tenants" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_user_tenants_owner" ON "user_tenants" USING btree ("user_id") WHERE role = 'owner';