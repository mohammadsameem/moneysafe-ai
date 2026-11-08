CREATE TABLE "action_executions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"approval_record_id" uuid NOT NULL,
	"dispute_id" uuid NOT NULL,
	"action_type" text NOT NULL,
	"approved_payload" jsonb NOT NULL,
	"original_draft" text,
	"edited_draft" text,
	"paypal_request_id" uuid NOT NULL,
	"paypal_response" jsonb,
	"executed_at" text,
	"is_simulated" boolean DEFAULT false NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "action_executions_approval_record_id_unique" UNIQUE("approval_record_id")
);
--> statement-breakpoint
CREATE TABLE "agent_activity" (
	"id" uuid PRIMARY KEY NOT NULL,
	"ref_order_id" uuid,
	"ref_dispute_id" uuid,
	"session_id" text,
	"step_type" text NOT NULL,
	"tool_name" text NOT NULL,
	"input_summary" text NOT NULL,
	"output_summary" text NOT NULL,
	"duration_ms" integer NOT NULL,
	"status" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approval_records" (
	"id" uuid PRIMARY KEY NOT NULL,
	"dispute_id" uuid NOT NULL,
	"action_type" text NOT NULL,
	"merchant_user_id" text NOT NULL,
	"decision" text NOT NULL,
	"payload_hash" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dispute_outcomes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"dispute_id" uuid NOT NULL,
	"outcome" text NOT NULL,
	"risk_score_snapshot" integer NOT NULL,
	"verdict_snapshot" text NOT NULL,
	"win_probability_snapshot" numeric NOT NULL,
	"signal_weights_id" uuid,
	"is_simulated" boolean DEFAULT false NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "dispute_outcomes_dispute_id_unique" UNIQUE("dispute_id")
);
--> statement-breakpoint
CREATE TABLE "disputes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"paypal_dispute_id" text,
	"order_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"buyer_message" text,
	"disputed_amount_usd" numeric NOT NULL,
	"deadline_offset_hours" integer,
	"deadline_at" text NOT NULL,
	"status" text NOT NULL,
	"outcome" text,
	"outcome_is_simulated" boolean DEFAULT false NOT NULL,
	"base_win_probability" numeric,
	"llm_adjustment" numeric,
	"win_probability" numeric,
	"win_likelihood_label" text,
	"system_recommendation" text,
	"override_recommendation" text,
	"final_recommendation" text,
	"recommendation_source" text,
	"reasoning" text,
	"evidence_used" jsonb,
	"evidence_gaps" jsonb,
	"draft_response" text,
	"analysis_computed_at" text,
	"risk_score_snapshot" integer,
	"session_id" text,
	"is_seed" boolean DEFAULT false NOT NULL,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "disputes_paypal_dispute_id_unique" UNIQUE("paypal_dispute_id")
);
--> statement-breakpoint
CREATE TABLE "evidence_artefacts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"order_id" uuid NOT NULL,
	"artefact_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"source" text NOT NULL,
	"is_mocked" boolean DEFAULT false NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "insights_cache" (
	"id" uuid PRIMARY KEY NOT NULL,
	"summary" text,
	"used_fallback" boolean DEFAULT false NOT NULL,
	"input_fingerprint" text NOT NULL,
	"generated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "llm_daily_usage" (
	"day" text PRIMARY KEY NOT NULL,
	"call_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "llm_rate_limits" (
	"session_id" text PRIMARY KEY NOT NULL,
	"call_count" integer DEFAULT 0 NOT NULL,
	"window_start" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"paypal_order_id" text,
	"paypal_capture_id" text,
	"buyer_email" text NOT NULL,
	"buyer_is_first_time" boolean NOT NULL,
	"payment_attempt_count" integer DEFAULT 1 NOT NULL,
	"shipping_method" text NOT NULL,
	"billing_country" varchar(2) NOT NULL,
	"shipping_country" varchar(2) NOT NULL,
	"amount_usd" numeric NOT NULL,
	"currency" varchar(3) DEFAULT 'USD' NOT NULL,
	"status" text NOT NULL,
	"risk_score" integer,
	"verdict" text,
	"ai_explanation" text,
	"used_fallback" boolean DEFAULT false NOT NULL,
	"verification_draft" jsonb,
	"evidence_completeness" integer,
	"signal_breakdown" jsonb,
	"weights_id" uuid,
	"session_id" text,
	"is_seed" boolean DEFAULT false NOT NULL,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "orders_paypal_order_id_unique" UNIQUE("paypal_order_id")
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"merchant_avg_order_value_usd" numeric DEFAULT 85 NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signal_weights" (
	"id" uuid PRIMARY KEY NOT NULL,
	"country_mismatch" integer DEFAULT 20 NOT NULL,
	"first_time_high_value" integer DEFAULT 20 NOT NULL,
	"rush_shipping" integer DEFAULT 15 NOT NULL,
	"high_relative_value" integer DEFAULT 20 NOT NULL,
	"disposable_email" integer DEFAULT 15 NOT NULL,
	"repeated_attempts" integer DEFAULT 10 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"resolved_since_last_proposal" integer DEFAULT 0 NOT NULL,
	"proposed_country_mismatch" integer,
	"proposed_first_time_high_value" integer,
	"proposed_rush_shipping" integer,
	"proposed_high_relative_value" integer,
	"proposed_disposable_email" integer,
	"proposed_repeated_attempts" integer,
	"proposal_reasoning" text,
	"proposal_created_at" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "action_executions" ADD CONSTRAINT "action_executions_approval_record_id_approval_records_id_fk" FOREIGN KEY ("approval_record_id") REFERENCES "public"."approval_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_executions" ADD CONSTRAINT "action_executions_dispute_id_disputes_id_fk" FOREIGN KEY ("dispute_id") REFERENCES "public"."disputes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_activity" ADD CONSTRAINT "agent_activity_ref_order_id_orders_id_fk" FOREIGN KEY ("ref_order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_activity" ADD CONSTRAINT "agent_activity_ref_dispute_id_disputes_id_fk" FOREIGN KEY ("ref_dispute_id") REFERENCES "public"."disputes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_records" ADD CONSTRAINT "approval_records_dispute_id_disputes_id_fk" FOREIGN KEY ("dispute_id") REFERENCES "public"."disputes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispute_outcomes" ADD CONSTRAINT "dispute_outcomes_dispute_id_disputes_id_fk" FOREIGN KEY ("dispute_id") REFERENCES "public"."disputes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispute_outcomes" ADD CONSTRAINT "dispute_outcomes_signal_weights_id_signal_weights_id_fk" FOREIGN KEY ("signal_weights_id") REFERENCES "public"."signal_weights"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_artefacts" ADD CONSTRAINT "evidence_artefacts_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_weights_id_signal_weights_id_fk" FOREIGN KEY ("weights_id") REFERENCES "public"."signal_weights"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "approval_records_dispute_action_approved_idx" ON "approval_records" USING btree ("dispute_id","action_type") WHERE "approval_records"."decision" = 'approved';