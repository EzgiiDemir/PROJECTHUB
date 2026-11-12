ALTER TABLE "api_tokens" ADD COLUMN "scope" varchar(20) DEFAULT 'full' NOT NULL;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_scope_ck" CHECK ("api_tokens"."scope" in ('full', 'git') and ("api_tokens"."scope" = 'full' or "api_tokens"."project_id" is not null));