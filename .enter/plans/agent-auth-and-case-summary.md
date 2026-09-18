# ResolveAI — Agent Authorization (RLS) + Simplified Case Management Detail

## Context

Two targeted improvements to ResolveAI:

1. **Authorization gap**: today any authenticated user (any email/password signup) can open Case Management, the Agent Dashboard, and read all `support_cases`/`customers`/`orders`/`tickets`/`policies` because the RLS `*_select_authenticated` policies are `USING (true)`. Authorization must be moved to the database: only authenticated users who hold an **active agent profile** may read agent data, use agent pages, run agent case actions, or call the `case-summary` function.

2. **Case Management detail is too dense**: the detail view shows everything at once. Make the default view a brief operational summary; move the deep context (evidence, Customer 360, Order 360, support history, policy, AI summary, timestamps) behind a "View Details" expander. Keep all functionality and data intact.

Decisions locked:
- Authorize **only** `nitikabalaji04@gmail.com` (auth user `dbb6fb2c-950d-4933-a4b6-2ea72f6db0bf`).
- `agent-verify@example.com` (auth user `e53509f5-a333-477e-a35d-26639ad44e0c`) stays UNAUTHORIZED and is the "unauthorized authenticated user" test account (known test password from project history).
- `moulika@gmail.com` stays unauthorized.
- Dashboard / Investigations pages are NOT re-gated in the UI (no redesign); their data is now RLS-blocked for non-agents, so they render their existing empty states for unauthorized users. Customer Support stays fully public (it reads no protected tables directly — it only displays the `support` function's response; that function runs with the service role and is untouched).

## Database changes (via `supabase_migration`, preserving all data)

### Migration A — new `agent_profiles` table (new, dedicated table; no existing table touched)
```sql
create table public.agent_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  email text not null unique,
  role text not null default 'agent' check (role in ('agent','admin')),
  active boolean not null default true,
  created_at timestamptz not null default now()
);
alter table public.agent_profiles enable row level security;
-- user may read only their own profile (drives the frontend check)
create policy agent_profiles_select_authenticated
  on public.agent_profiles for select to authenticated
  using (auth.uid() = user_id);

-- seed the real agent (idempotent)
insert into public.agent_profiles (user_id, email, role, active)
values ('dbb6fb2c-950d-4933-a4b6-2ea72f6db0bf', 'nitikabalaji04@gmail.com', 'agent', true)
on conflict (email) do nothing;
```

### Migration B — tighten RLS on the 5 protected tables (drop + recreate policies)
Agent predicate (used everywhere):
```sql
exists (
  select 1 from public.agent_profiles ap
  where ap.user_id = auth.uid()
    and ap.active = true
    and ap.role in ('agent','admin')
)
```
- `customers_select_authenticated`, `orders_select_authenticated`, `tickets_select_authenticated`, `policies_select_authenticated`: `USING (true)` → agent predicate.
- `support_cases_select_authenticated`: `USING (true)` → agent predicate.
- `support_cases_update_authenticated`: recreate with the agent predicate in BOTH `USING` and `WITH CHECK`. The existing column-scoped `UPDATE` grants on `case_status, agent_id, agent_email, agent_note, resolved_at, updated_at` remain untouched — no broad INSERT/UPDATE/DELETE grants are added.
- No anon policies; `support` function keeps working (service role bypasses RLS).

## Frontend changes

### `src/App.jsx`
- Add `isAgent` + `agentCheckDone` state. New effect keyed on `session?.user?.id`: query `agent_profiles` via `supabase.from('agent_profiles').select('role').eq('user_id', session.user.id).eq('active', true).maybeSingle()` (async, `cancelled` flag — follow the repo's react-hooks-safe async-load pattern). Any error ⇒ `isAgent = false` (fail closed).
- Update `renderAgentGate`: while `sessionLoading || !agentCheckDone` show the existing session check; no session ⇒ `AgentLogin`; session but `!isAgent` ⇒ new "not authorized" panel with copy: **"Your account is not authorized as a support agent."** (+ hint that only approved agents can access Case Management / Agent Dashboard); authorized ⇒ render the page.
- Pass-through unchanged: `renderCaseManagement` still receives `user={session?.user ?? null}`.

### `src/index.css`
- Small styles for: `.not-authorized` panel (reuse theme tokens — muted color, border, panel background) and the Case Management summary grid / "View Details" toggle (below).

### `src/components/AgentLogin.jsx`
- Only copy fix: signup success notice must not claim agent status (e.g. "Account created. Approved agents can now sign in."). No auth logic changes.

## Backend change — `supabase/functions/case-summary/index.ts`

After `auth.getUser(jwt)` succeeds, verify the caller holds an active agent profile:
```ts
const { data: profile } = await supabase
  .from("agent_profiles")
  .select("id")
  .eq("user_id", userData.user.id)
  .eq("active", true)
  .in("role", ["agent", "admin"])
  .maybeSingle();
if (!profile) return json({ error: "Your account is not authorized as a support agent." }, 403);
```
Deploy via `supabase_deploy_edge_function` (function `case-summary`).

## Case Management UI simplification — `src/components/CaseManagement.jsx`

Keep all data/fetching/actions. Restructure the detail body only:

- **Default view (top of `case-detail-body`)**: a compact summary grid showing:
  - Case ID (already in header)
  - Customer: `caseContext?.customer?.name` → else `customer_id` → else **"Not available"**
  - Order: `#${order_id}` or **"Not available"**
  - Issue: truncated `customer_message` (~80 chars)
  - AI Decision: uppercase `decision` or "—"
  - Reason: `reason` or "—"
  - Action: human label (`refund_shipping_fee` → "Refund Shipping Fee", `human_review` → "Human Review", `no_action` → "No Action")
  - Status: existing `statusBadge(resolution_status)`
- `renderAgentActions()` stays visible in the default view (operational controls for escalated cases).
- **"View Details" toggle** (new `showDetails` state, default `false`): when open, renders every existing detailed section unchanged — AI CASE SUMMARY, CUSTOMER MESSAGE, INTENT, EVIDENCE, ACTION/VERIFICATION/RESOLUTION statuses, CREATED AT, ESCALATION REASON, CUSTOMER INFORMATION, ORDER INFORMATION, SUPPORT HISTORY, POLICY CONTEXT, Back to list.
- Add CSS for the summary grid, labels, and toggle button.

## Implementation checklist

- [ ] `supabase_migration`: create `agent_profiles` + RLS select-own-row policy + seed `nitikabalaji04@gmail.com` (idempotent).
- [ ] `supabase_migration`: recreate the 5 `*_select_authenticated` policies on `customers`, `orders`, `tickets`, `policies`, `support_cases` with the agent predicate.
- [ ] `supabase_migration`: recreate `support_cases_update_authenticated` with agent predicate in USING + WITH CHECK; verify the 6-column UPDATE grant list is unchanged via `information_schema.role_column_grants`.
- [ ] Verify via `supabase_read_query` + `pg_policies`: exactly 1 policy on `agent_profiles`; 6 policies on the protected tables, all agent-gated; `support_cases` still has no INSERT/DELETE policy.
- [ ] `src/App.jsx`: add `isAgent`/`agentCheckDone` state + agent-profile effect (async, cancelled-flag pattern).
- [ ] `src/App.jsx`: `renderAgentGate` denies non-agents with the "not authorized" panel; shows login when signed out; keeps session-check while loading.
- [ ] `src/index.css`: `.not-authorized` + Case Management summary/toggle styles.
- [ ] `src/components/AgentLogin.jsx`: signup notice copy (no agent claim).
- [ ] `supabase/functions/case-summary/index.ts`: agent authorization check (403 for non-agents) + `supabase_deploy_edge_function case-summary`.
- [ ] `src/components/CaseManagement.jsx`: summary grid + "View Details" toggle (all existing sections preserved under it); agent actions visible in default view.

## Verification checklist

Build/lint:
- [ ] `pnpm run lint` and `pnpm run build` pass.

Database/RLS (read-only checks):
- [ ] `agent_profiles` contains exactly one row: nitikabalaji04 / active / role agent.
- [ ] `pg_policies` shows agent-gated predicates on the 5 tables; `agent_profiles` select-own-row only; no new INSERT/DELETE policies; column grants unchanged.
- [ ] `support_cases`, `customers`, `orders`, `tickets`, `policies` row counts unchanged by the migrations.

Negative path (real E2E, unauthorized auth user):
- [ ] Sign in as `agent-verify@example.com` via the auth REST API (test password from project history) and obtain a JWT.
- [ ] With that JWT: `SELECT` on `support_cases`/`customers`/`orders`/`tickets`/`policies` returns 0 rows (RLS denies).
- [ ] With that JWT: invoke `case-summary` → 403 "not authorized".
- [ ] With that JWT: `UPDATE support_cases SET agent_note=...` affects 0 rows (RLS denies).
- [ ] Frontend gate logic: non-agent session renders the "Your account is not authorized as a support agent." panel (code-level; verified against the RLS behavior).

Positive path (authorized agent):
- [ ] Confirm `agent_profiles` row for `dbb6fb2c-...` (nitikabalaji04) exists/active and satisfies the RLS predicate (verified by query). Interactive login with the real password is the user's to confirm (password not exposed/changed); DB-level authorization is verified by the policy predicate.
- [ ] `case-summary` authorization code path returns 200 only when a profile row exists (verified by code + predicate; full interactive check is user-confirmed).

Public / regression:
- [ ] Logged-out Customer Support: invoke the `support` function (public) with an inform message → INFORM/RESOLVED (unchanged).
- [ ] One existing-valid-order flow re-checked end-to-end (e.g. "status of order 10486" → inform/resolved; "order 552" → escalate, no fallback).
- [ ] Case Management detail: default view shows the brief summary; "View Details" reveals all previous sections; agent actions (Start Review / Resolve / Keep Escalated / note) still work for an agent session.

Deployment:
- [ ] Migrations applied, `case-summary` deployed; frontend built by the framework; no external platform used.

## Files to change
- `supabase/functions/case-summary/index.ts`
- `src/App.jsx`
- `src/index.css`
- `src/components/AgentLogin.jsx`
- `src/components/CaseManagement.jsx`
- Database: `agent_profiles` (new), RLS policies on 5 existing tables
