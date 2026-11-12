ALTER TABLE "secrets" ADD COLUMN "rotation_interval_days" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "secrets" ADD COLUMN "expires_at" timestamp with time zone;