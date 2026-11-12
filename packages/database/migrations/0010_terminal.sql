CREATE TABLE "terminal_commands" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"session_id" uuid NOT NULL,
	"command" text NOT NULL,
	"status" varchar(20) DEFAULT 'queued' NOT NULL,
	"exit_code" integer,
	"output" text DEFAULT '' NOT NULL,
	"commit_sha" varchar(40),
	"sync_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "terminal_commands_status_ck" CHECK (status IN ('queued', 'running', 'done', 'failed', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "terminal_sessions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"branch" varchar(200) NOT NULL,
	"head_commit" varchar(40),
	"status" varchar(20) DEFAULT 'starting' NOT NULL,
	"auto_sync" boolean DEFAULT true NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "terminal_sessions_status_ck" CHECK (status IN ('starting', 'ready', 'closed', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "terminal_commands" ADD CONSTRAINT "terminal_commands_session_id_terminal_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."terminal_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "terminal_sessions" ADD CONSTRAINT "terminal_sessions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "terminal_sessions" ADD CONSTRAINT "terminal_sessions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "terminal_sessions" ADD CONSTRAINT "terminal_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "terminal_commands_session_idx" ON "terminal_commands" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE INDEX "terminal_sessions_project_user_idx" ON "terminal_sessions" USING btree ("project_id","user_id");