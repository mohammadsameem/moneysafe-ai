-- Row Level Security on every app table, with NO policies, and no table privileges for Supabase's public roles.
--
-- Why: Supabase exposes the "public" schema over its REST API to the `anon` and `authenticated` roles. This app never uses
-- that API (it connects as the table OWNER through the pooler), so those roles must be able to read and write nothing.
-- With RLS on and no policy, a role that is not the owner sees no rows; the REVOKE below removes even the table privileges.
--
-- The app is not affected: the owner role bypasses RLS (no FORCE ROW LEVEL SECURITY here, on purpose).
-- Idempotent: ENABLE ROW LEVEL SECURITY and REVOKE can both be repeated safely.
-- To undo (not recommended): ALTER TABLE "<name>" DISABLE ROW LEVEL SECURITY; and GRANT what you need back.
ALTER TABLE "action_executions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_activity" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "approval_records" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "dispute_outcomes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "disputes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "evidence_artefacts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "insights_cache" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "llm_daily_usage" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "llm_rate_limits" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "orders" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "signal_weights" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$
DECLARE
  role_name text;
  table_name text;
BEGIN
  -- The roles exist on Supabase only; on a plain Postgres there is nothing to revoke.
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      FOREACH table_name IN ARRAY ARRAY[
        'action_executions', 'agent_activity', 'approval_records', 'dispute_outcomes', 'disputes', 'evidence_artefacts',
        'insights_cache', 'llm_daily_usage', 'llm_rate_limits', 'orders', 'settings', 'signal_weights'
      ] LOOP
        EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE public.%I FROM %I', table_name, role_name);
      END LOOP;
    END IF;
  END LOOP;
END
$$;
