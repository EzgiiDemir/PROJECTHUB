CREATE TABLE "capability_profiles" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"project_id" uuid NOT NULL,
	"revision" varchar(200) NOT NULL,
	"status" varchar(20) NOT NULL,
	"capabilities" jsonb NOT NULL,
	"source" varchar(40) NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"stale_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "capability_profiles_status_ck" CHECK (status IN ('supported', 'unsupported', 'misconfigured', 'stale', 'unknown'))
);
--> statement-breakpoint
CREATE TABLE "entity_relations" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid,
	"from_entity_id" uuid NOT NULL,
	"to_entity_id" uuid NOT NULL,
	"kind" varchar(80) NOT NULL,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"detection_method" varchar(80) NOT NULL,
	"source_type" varchar(60) NOT NULL,
	"source_ref" varchar(500),
	"revision" varchar(200),
	"confidence" varchar(20) DEFAULT 'unknown' NOT NULL,
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_until" timestamp with time zone,
	"last_verified_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entity_relations_status_ck" CHECK (status IN ('active', 'stale', 'disputed', 'expired')),
	CONSTRAINT "entity_relations_confidence_ck" CHECK (confidence IN ('verified', 'high', 'medium', 'low', 'inferred', 'unknown'))
);
--> statement-breakpoint
CREATE TABLE "event_records" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"sequence" bigint GENERATED ALWAYS AS IDENTITY (sequence name "event_records_sequence_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"organization_id" uuid NOT NULL,
	"project_id" uuid,
	"event_type" varchar(120) NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"correlation_id" uuid NOT NULL,
	"causation_id" uuid,
	"actor_type" varchar(20),
	"actor_id" uuid,
	"actor_label" varchar(200),
	"source_type" varchar(60),
	"source_id" varchar(255),
	"revision" varchar(200),
	"environment_id" uuid,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Domain events are evidence, not mutable queue state. Keep the database as the final integrity boundary.
CREATE OR REPLACE FUNCTION event_records_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'event_records is append-only (% blocked)', TG_OP USING ERRCODE = 'insufficient_privilege';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER event_records_no_update BEFORE UPDATE OR DELETE ON event_records
  FOR EACH ROW EXECUTE FUNCTION event_records_immutable();
--> statement-breakpoint
CREATE TRIGGER event_records_no_truncate BEFORE TRUNCATE ON event_records
  FOR EACH STATEMENT EXECUTE FUNCTION event_records_immutable();
--> statement-breakpoint
CREATE TABLE "execution_evidence" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid,
	"workflow_run_id" uuid,
	"workflow_step_id" uuid,
	"kind" varchar(60) NOT NULL,
	"subject_type" varchar(60) NOT NULL,
	"subject_id" varchar(255),
	"source_type" varchar(60) NOT NULL,
	"source_ref" varchar(500),
	"environment_id" uuid,
	"revision" varchar(200),
	"tool_name" varchar(120),
	"tool_version" varchar(100),
	"artifact_id" uuid,
	"checksum" varchar(128),
	"result" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "observations" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid,
	"entity_id" uuid,
	"subject_type" varchar(60) NOT NULL,
	"subject_id" varchar(255),
	"key" varchar(120) NOT NULL,
	"value" jsonb NOT NULL,
	"source_type" varchar(60) NOT NULL,
	"source_ref" varchar(500),
	"revision" varchar(200),
	"environment_id" uuid,
	"confidence" varchar(20) DEFAULT 'unknown' NOT NULL,
	"evidence_id" uuid,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_until" timestamp with time zone,
	"superseded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "observations_confidence_ck" CHECK (confidence IN ('verified', 'high', 'medium', 'low', 'inferred', 'unknown'))
);
--> statement-breakpoint
CREATE TABLE "policy_decisions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid,
	"workflow_run_id" uuid,
	"workflow_step_id" uuid,
	"policy_key" varchar(100) NOT NULL,
	"policy_version" integer DEFAULT 1 NOT NULL,
	"decision" varchar(30) NOT NULL,
	"risk_level" varchar(20) NOT NULL,
	"reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"input_hash" varchar(128) NOT NULL,
	"decided_by_type" varchar(20) NOT NULL,
	"decided_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "policy_decisions_decision_ck" CHECK (decision IN ('allow', 'deny', 'requires_approval')),
	CONSTRAINT "policy_decisions_risk_ck" CHECK (risk_level IN ('low', 'medium', 'high', 'critical'))
);
--> statement-breakpoint
CREATE TABLE "software_entities" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid,
	"kind" varchar(50) NOT NULL,
	"external_key" varchar(300) NOT NULL,
	"name" varchar(200) NOT NULL,
	"lifecycle" varchar(30) DEFAULT 'active' NOT NULL,
	"ref_type" varchar(60),
	"ref_id" varchar(255),
	"owner_id" uuid,
	"team_id" uuid,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verification_results" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid,
	"workflow_run_id" uuid NOT NULL,
	"workflow_step_id" uuid,
	"key" varchar(100) NOT NULL,
	"status" varchar(20) NOT NULL,
	"summary" text NOT NULL,
	"expected" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"observed" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"evidence_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"verified_at" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verification_results_status_ck" CHECK (status IN ('passed', 'failed', 'inconclusive', 'expired'))
);
--> statement-breakpoint
CREATE TABLE "workflow_runs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid,
	"correlation_id" uuid NOT NULL,
	"trigger_event_id" uuid,
	"definition_key" varchar(100) NOT NULL,
	"definition_version" integer DEFAULT 1 NOT NULL,
	"title" varchar(300) NOT NULL,
	"status" varchar(30) DEFAULT 'pending' NOT NULL,
	"phase" varchar(60),
	"trigger_type" varchar(40) NOT NULL,
	"trigger_ref" varchar(255),
	"base_revision" varchar(200),
	"environment_id" uuid,
	"risk_level" varchar(20) DEFAULT 'low' NOT NULL,
	"requested_by_type" varchar(20) NOT NULL,
	"requested_by" uuid,
	"idempotency_key" varchar(255),
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_runs_status_ck" CHECK (status IN ('pending', 'running', 'waiting', 'succeeded', 'failed', 'cancelled', 'unknown', 'partially_completed', 'needs_reconciliation')),
	CONSTRAINT "workflow_runs_risk_ck" CHECK (risk_level IN ('low', 'medium', 'high', 'critical'))
);
--> statement-breakpoint
CREATE TABLE "workflow_steps" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workflow_run_id" uuid NOT NULL,
	"parent_step_id" uuid,
	"key" varchar(80) NOT NULL,
	"name" varchar(160) NOT NULL,
	"seq" integer NOT NULL,
	"status" varchar(30) DEFAULT 'pending' NOT NULL,
	"idempotency_key" varchar(255),
	"attempt" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 1 NOT NULL,
	"input" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"output" jsonb,
	"checkpoint" jsonb,
	"error" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_steps_status_ck" CHECK (status IN ('pending', 'running', 'waiting', 'passed', 'failed', 'skipped', 'cancelled', 'unknown', 'needs_reconciliation'))
);
--> statement-breakpoint
ALTER TABLE "capability_profiles" ADD CONSTRAINT "capability_profiles_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_relations" ADD CONSTRAINT "entity_relations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_relations" ADD CONSTRAINT "entity_relations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_relations" ADD CONSTRAINT "entity_relations_from_entity_id_software_entities_id_fk" FOREIGN KEY ("from_entity_id") REFERENCES "public"."software_entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_relations" ADD CONSTRAINT "entity_relations_to_entity_id_software_entities_id_fk" FOREIGN KEY ("to_entity_id") REFERENCES "public"."software_entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_records" ADD CONSTRAINT "event_records_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_records" ADD CONSTRAINT "event_records_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_evidence" ADD CONSTRAINT "execution_evidence_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_evidence" ADD CONSTRAINT "execution_evidence_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_evidence" ADD CONSTRAINT "execution_evidence_workflow_run_id_workflow_runs_id_fk" FOREIGN KEY ("workflow_run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_evidence" ADD CONSTRAINT "execution_evidence_workflow_step_id_workflow_steps_id_fk" FOREIGN KEY ("workflow_step_id") REFERENCES "public"."workflow_steps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observations" ADD CONSTRAINT "observations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observations" ADD CONSTRAINT "observations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observations" ADD CONSTRAINT "observations_entity_id_software_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."software_entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observations" ADD CONSTRAINT "observations_evidence_id_execution_evidence_id_fk" FOREIGN KEY ("evidence_id") REFERENCES "public"."execution_evidence"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_decisions" ADD CONSTRAINT "policy_decisions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_decisions" ADD CONSTRAINT "policy_decisions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_decisions" ADD CONSTRAINT "policy_decisions_workflow_run_id_workflow_runs_id_fk" FOREIGN KEY ("workflow_run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_decisions" ADD CONSTRAINT "policy_decisions_workflow_step_id_workflow_steps_id_fk" FOREIGN KEY ("workflow_step_id") REFERENCES "public"."workflow_steps"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_decisions" ADD CONSTRAINT "policy_decisions_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "software_entities" ADD CONSTRAINT "software_entities_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "software_entities" ADD CONSTRAINT "software_entities_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "software_entities" ADD CONSTRAINT "software_entities_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "software_entities" ADD CONSTRAINT "software_entities_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_results" ADD CONSTRAINT "verification_results_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_results" ADD CONSTRAINT "verification_results_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_results" ADD CONSTRAINT "verification_results_workflow_run_id_workflow_runs_id_fk" FOREIGN KEY ("workflow_run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_results" ADD CONSTRAINT "verification_results_workflow_step_id_workflow_steps_id_fk" FOREIGN KEY ("workflow_step_id") REFERENCES "public"."workflow_steps"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_trigger_event_id_event_records_id_fk" FOREIGN KEY ("trigger_event_id") REFERENCES "public"."event_records"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_steps" ADD CONSTRAINT "workflow_steps_workflow_run_id_workflow_runs_id_fk" FOREIGN KEY ("workflow_run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "capability_profiles_revision_uq" ON "capability_profiles" USING btree ("project_id","revision");--> statement-breakpoint
CREATE INDEX "capability_profiles_project_observed_idx" ON "capability_profiles" USING btree ("project_id","observed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "entity_relations_identity_uq" ON "entity_relations" USING btree ("from_entity_id","to_entity_id","kind","source_type","source_ref");--> statement-breakpoint
CREATE INDEX "entity_relations_from_idx" ON "entity_relations" USING btree ("from_entity_id","kind");--> statement-breakpoint
CREATE INDEX "entity_relations_to_idx" ON "entity_relations" USING btree ("to_entity_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "event_records_sequence_uq" ON "event_records" USING btree ("sequence");--> statement-breakpoint
CREATE INDEX "event_records_org_sequence_idx" ON "event_records" USING btree ("organization_id","sequence");--> statement-breakpoint
CREATE INDEX "event_records_project_sequence_idx" ON "event_records" USING btree ("project_id","sequence");--> statement-breakpoint
CREATE INDEX "event_records_correlation_idx" ON "event_records" USING btree ("correlation_id","sequence");--> statement-breakpoint
CREATE INDEX "event_records_source_idx" ON "event_records" USING btree ("source_type","source_id");--> statement-breakpoint
CREATE INDEX "execution_evidence_run_idx" ON "execution_evidence" USING btree ("workflow_run_id","created_at");--> statement-breakpoint
CREATE INDEX "execution_evidence_subject_idx" ON "execution_evidence" USING btree ("subject_type","subject_id","created_at");--> statement-breakpoint
CREATE INDEX "execution_evidence_revision_idx" ON "execution_evidence" USING btree ("project_id","revision");--> statement-breakpoint
CREATE INDEX "observations_subject_idx" ON "observations" USING btree ("subject_type","subject_id","key","observed_at");--> statement-breakpoint
CREATE INDEX "observations_project_key_idx" ON "observations" USING btree ("project_id","key","observed_at");--> statement-breakpoint
CREATE INDEX "policy_decisions_run_idx" ON "policy_decisions" USING btree ("workflow_run_id","created_at");--> statement-breakpoint
CREATE INDEX "policy_decisions_policy_idx" ON "policy_decisions" USING btree ("policy_key","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "software_entities_key_uq" ON "software_entities" USING btree ("organization_id","kind","external_key");--> statement-breakpoint
CREATE INDEX "software_entities_project_kind_idx" ON "software_entities" USING btree ("project_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "verification_results_key_uq" ON "verification_results" USING btree ("workflow_run_id","key");--> statement-breakpoint
CREATE INDEX "verification_results_status_idx" ON "verification_results" USING btree ("project_id","status","verified_at");--> statement-breakpoint
CREATE INDEX "workflow_runs_project_created_idx" ON "workflow_runs" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "workflow_runs_status_idx" ON "workflow_runs" USING btree ("organization_id","status","created_at");--> statement-breakpoint
CREATE INDEX "workflow_runs_correlation_idx" ON "workflow_runs" USING btree ("correlation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_runs_idempotency_uq" ON "workflow_runs" USING btree ("organization_id","idempotency_key") WHERE idempotency_key IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_steps_seq_uq" ON "workflow_steps" USING btree ("workflow_run_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_steps_key_uq" ON "workflow_steps" USING btree ("workflow_run_id","key");--> statement-breakpoint
CREATE INDEX "workflow_steps_status_idx" ON "workflow_steps" USING btree ("status","updated_at");
