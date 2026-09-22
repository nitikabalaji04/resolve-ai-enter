// Basic tests for Phase 10 — persistent execution trace + read-only replay.
//
// Run:  node supabase/functions/support/case-replay.test.mjs
//
// Extracts the marked pure-logic blocks from index.ts (single source of truth)
// and reads the real migration for the schema/RLS assertions.
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, 'index.ts'), 'utf8')

function block(startMarker, endMarker) {
  const start = source.indexOf(startMarker)
  const end = source.indexOf(endMarker)
  if (start === -1 || end === -1) {
    console.error('FAIL: markers not found: ' + startMarker)
    process.exit(1)
  }
  const bodyStart = source.indexOf('\n', start + startMarker.length) + 1
  return source.slice(bodyStart, end)
}

const persistenceSource = block('// >>> TRACE PERSISTENCE PURE LOGIC', '// <<< TRACE PERSISTENCE PURE LOGIC')

const api = new Function(
  block('// >>> EXECUTION TRACE PURE LOGIC', '// <<< EXECUTION TRACE PURE LOGIC') +
  persistenceSource +
    '\nreturn { TRACE_TABLE, persistExecutionTrace, getCaseExecutionTrace, createExecutionTrace, startTraceStage, completeTraceStage, failTraceStage, blockTraceStage, skipTraceStage, finishExecutionTrace };',
)()

// The migration that created the trace table.
const migrationsDir = join(here, '..', '..', 'migrations')
let migrationSql = ''
for (const file of readdirSync(migrationsDir)) {
  const text = readFileSync(join(migrationsDir, file), 'utf8')
  if (text.includes('case_investigation_traces')) migrationSql += '\n' + text
}

let passed = 0
let failed = 0
function check(name, condition, detail) {
  if (condition) { passed += 1; console.log('  ok   ' + name) }
  else { failed += 1; console.log('FAIL   ' + name + (detail ? ' -> ' + detail : '')) }
}

// --- mock supabase client ---------------------------------------------------
function mockClient(options) {
  const opts = options || {}
  const calls = { tables: [], inserted: [], selects: [] }
  const client = {
    calls,
    from(table) {
      calls.tables.push(table)
      return {
        insert(payload) {
          calls.inserted.push({ table, payload })
          return Promise.resolve({ error: opts.insertError || null })
        },
        select(columns) {
          calls.selects.push({ table, columns })
          return {
            eq(column, value) {
              calls.selects[calls.selects.length - 1].eq = { column, value }
              return {
                maybeSingle() {
                  if (opts.selectThrows) throw new Error('boom')
                  return Promise.resolve({ data: opts.row === undefined ? null : opts.row, error: opts.selectError || null })
                },
              }
            },
          }
        },
      }
    },
  }
  return client
}

// A realistic stored trace built with the real Phase 9 helpers.
function buildTrace(caseId) {
  const trace = api.createExecutionTrace(caseId)
  api.completeTraceStage(api.startTraceStage(trace, 'triage'), { intent: 'REFUND_REQUEST', urgency: 'normal', confidence: 0.95, source: 'llm' })
  api.completeTraceStage(api.startTraceStage(trace, 'order_agent'), { status: 'completed', finding_count: 11 })
  api.skipTraceStage(trace, 'delivery_agent', { reason: 'not_in_plan' })
  api.completeTraceStage(api.startTraceStage(trace, 'decision_agent'), { status: 'failed', decision: null, action: null, confidence: null, evidence_ids: [], reason: 'ACTION_ALREADY_COMPLETED' })
  api.blockTraceStage(api.startTraceStage(trace, 'decision_authority'), { status: 'blocked', decision: null, action: null, reason: 'ACTION_ALREADY_COMPLETED' })
  api.skipTraceStage(trace, 'action_executor', { reason: 'escalated' })
  api.completeTraceStage(api.startTraceStage(trace, 'case_outcome'), { status: 'escalated', decision: 'escalate', action: 'human_review' })
  return api.finishExecutionTrace(trace)
}

console.log('')
console.log('1. Trace table / schema assumptions match the real migration')
check('table created', /create table public\.case_investigation_traces/.test(migrationSql))
check('identity primary key', /id bigint generated always as identity primary key/.test(migrationSql))
check('case_id text not null', /case_id text not null/.test(migrationSql))
check('trace_version integer default 1', /trace_version integer not null default 1/.test(migrationSql))
check('trace jsonb not null', /trace jsonb not null/.test(migrationSql))
check('created_at timestamptz default now()', /created_at timestamptz not null default now\(\)/.test(migrationSql))
check('FK to the real support_cases PK', /references public\.support_cases \(case_id\) on delete cascade/.test(migrationSql))
check('helper targets the same table', api.TRACE_TABLE === 'case_investigation_traces')

console.log('')
console.log('2. Trace object can be persisted')
const trace = buildTrace('CASE-P10')
const client = mockClient({})
const write = await api.persistExecutionTrace(client, trace)
check('write reported ok', write.ok === true && write.reason === 'STORED')
check('inserted into the trace table', client.calls.inserted.length === 1 && client.calls.inserted[0].table === 'case_investigation_traces')
const storedRow = client.calls.inserted[0].payload

console.log('')
console.log('3. case_id is preserved')
check('row case_id', storedRow.case_id === 'CASE-P10')
check('trace case_id', storedRow.trace.case_id === 'CASE-P10')

console.log('')
console.log('4. trace_version is preserved')
check('row version', storedRow.trace_version === 1)
check('trace version', storedRow.trace.trace_version === 1)

console.log('')
console.log('5. Stages are preserved')
check('same stage count', storedRow.trace.stages.length === trace.stages.length)
check('every stage kept', JSON.stringify(storedRow.trace.stages) === JSON.stringify(trace.stages))
check('stage names kept', storedRow.trace.stages.map((s) => s.stage).join(',') === 'triage,order_agent,delivery_agent,decision_agent,decision_authority,action_executor,case_outcome')

console.log('')
console.log('6. Timestamps are preserved')
check('trace started_at', storedRow.trace.started_at === trace.started_at)
check('trace completed_at', storedRow.trace.completed_at === trace.completed_at)
check('stage timestamps kept', storedRow.trace.stages[0].started_at === trace.stages[0].started_at && storedRow.trace.stages[0].completed_at === trace.stages[0].completed_at)
check('skipped stage has null timings', storedRow.trace.stages[2].started_at === null && storedRow.trace.stages[2].completed_at === null)

console.log('')
console.log('7. Durations are preserved')
check('durations identical', JSON.stringify(storedRow.trace.stages.map((s) => s.duration_ms)) === JSON.stringify(trace.stages.map((s) => s.duration_ms)))
check('skipped duration stays null', storedRow.trace.stages[2].duration_ms === null)

console.log('')
console.log('8. Stage ordering is preserved')
check('order identical', storedRow.trace.stages.map((s) => s.id).join(',') === trace.stages.map((s) => s.id).join(','))
check('ids sequential', trace.stages.map((s) => s.id).join(',') === 'trace-stage-001,trace-stage-002,trace-stage-003,trace-stage-004,trace-stage-005,trace-stage-006,trace-stage-007')

console.log('')
console.log('9. Summaries are preserved')
check('summaries identical', JSON.stringify(storedRow.trace.stages.map((s) => s.summary)) === JSON.stringify(trace.stages.map((s) => s.summary)))
check('triage summary kept', storedRow.trace.stages[0].summary.intent === 'REFUND_REQUEST')
check('failure reason kept', storedRow.trace.stages[3].summary.reason === 'ACTION_ALREADY_COMPLETED')

console.log('')
console.log('10. Persisted trace is not mutated during retrieval')
const readClient = mockClient({ row: { case_id: storedRow.case_id, trace_version: storedRow.trace_version, trace: storedRow.trace, created_at: '2026-09-22T00:00:00.000Z' } })
const before = JSON.stringify(storedRow.trace)
const read = await api.getCaseExecutionTrace(readClient, 'CASE-P10')
check('retrieval found', read.status === 'found')
check('stored trace untouched by retrieval', JSON.stringify(storedRow.trace) === before)
check('no writes during retrieval', readClient.calls.inserted.length === 0)

console.log('')
console.log('11. Retrieval returns the historical trace unchanged')
check('identical to the stored trace', JSON.stringify(read.trace) === before)
check('stage count matches', read.trace.stages.length === 7)
check('version reported', read.trace_version === 1)
check('stored_at reported', read.stored_at === '2026-09-22T00:00:00.000Z')
check('queries only the trace table', readClient.calls.selects[0].table === 'case_investigation_traces')
check('filtered by case_id', readClient.calls.selects[0].eq.column === 'case_id' && readClient.calls.selects[0].eq.value === 'CASE-P10')

console.log('')
console.log('12. Missing case returns a safe not-found')
const missing = await api.getCaseExecutionTrace(mockClient({ row: null }), 'CASE-NOPE')
check('status not_found', missing.status === 'not_found')
check('no trace returned', missing.trace === null)
check('empty case id is not found', (await api.getCaseExecutionTrace(mockClient({}), '   ')).status === 'not_found')
check('read error is safe', (await api.getCaseExecutionTrace(mockClient({ selectError: { message: 'db down' } }), 'CASE-X')).status === 'failed')
check('throwing client is safe', (await api.getCaseExecutionTrace(mockClient({ selectThrows: true }), 'CASE-X')).status === 'failed')

console.log('')
console.log('13. Replay does not call an LLM')
check('no askQwen in the persistence/replay helpers', !/askQwen/.test(persistenceSource))
check('no fetch', !/fetch\(/.test(persistenceSource))
check('no prompt builders', !/buildQwenPrompt|buildDecisionAgentPrompt|buildTriagePrompt/.test(persistenceSource))

console.log('')
console.log('14. Replay does not execute actions')
check('no executor calls', !/executeAction|verifyAction|createEscalationCase/.test(persistenceSource))
check('no refund writes', !/refund_status/.test(persistenceSource))

console.log('')
console.log('15. Replay does not modify business data')
check('the only insert targets the trace table', /from\(TRACE_TABLE\)\.insert\(/.test(persistenceSource) && (persistenceSource.match(/\.insert\(/g) || []).length === 1)
check('retrieval performs no insert', (persistenceSource.match(/\.insert\(/g) || []).length === 1)
check('no update or delete anywhere in the helpers', !/\.update\(|\.delete\(/.test(persistenceSource))

console.log('')
console.log('16. Replay does not reconstruct from current order state')
check('no reads of orders/customers/support_cases', !/from\("orders"\)|from\("customers"\)|from\("support_cases"\)|from\('orders'\)/.test(persistenceSource))
check('the only table read is the trace table', (persistenceSource.match(/\.from\(/g) || []).length === 2)
check('the stored trace is returned as-is', /return\s*\{[\s\S]{0,120}trace: data\.trace/.test(persistenceSource))

console.log('')
console.log('17. Trace write failure does not fail the support case')
const failing = await api.persistExecutionTrace(mockClient({ insertError: { code: '42501', message: 'permission denied' } }), trace)
check('reported not ok', failing.ok === false)
check('no throw', typeof failing.reason === 'string')
const throwing = await api.persistExecutionTrace({ from() { throw new Error('boom') } }, trace)
check('throwing client is contained', throwing.ok === false && throwing.reason === 'INSERT_FAILED')
check('missing client is safe', (await api.persistExecutionTrace(null, trace)).ok === false)
check('invalid trace rejected safely', (await api.persistExecutionTrace(mockClient({}), { case_id: '' })).reason === 'INVALID_TRACE')
check('persistence is best-effort in the orchestrator', /const tracePersistence = await persistExecutionTrace\(supabase, trace\)/.test(source))
check('the response is still returned after a write attempt', /return json\(\{/.test(source))

console.log('')
console.log('18. Trace write failure does not trigger an action retry')
check('no action execution in the persistence path', !/executeAction/.test(persistenceSource))
check('persistence runs after the outcome stage', source.indexOf('completeTraceStage(startTraceStage(trace, "case_outcome")') < source.indexOf('await persistExecutionTrace(supabase, trace)'))
check('no retry loop', !/for \(|while \(/.test(persistenceSource))

console.log('')
console.log('19. Trace contains no prompts')
check('no prompt text in a stored trace', !/You are ResolveAI|INSTRUCTIONS:|CUSTOMER MESSAGE|Return ONLY valid JSON/.test(JSON.stringify(storedRow.trace)))
check('helpers never touch prompts', !/prompt/i.test(persistenceSource))

console.log('')
console.log('20. Trace contains no secrets')
check('no secret keywords in helpers', !/token|secret|api[_-]?key|service_role|Bearer|authorization/i.test(persistenceSource.replace(/Authorization/g, '')))
check('no env access in helpers', !/Deno\.env/.test(persistenceSource))
check('stored trace has no credentials', !/token|secret|api[_-]?key|service_role|Bearer/i.test(JSON.stringify(storedRow.trace)))

console.log('')
console.log('21. Anonymous / public access is denied')
check('RLS enabled', /alter table public\.case_investigation_traces enable row level security/.test(migrationSql))
check('policy targets authenticated only', /for select to authenticated/.test(migrationSql))
check('no anon policy', !/to anon/.test(migrationSql) && !/public\b.*using/.test(migrationSql))
check('endpoint requires authentication', /Authentication required\.[\s\S]{0,20}401/.test(source))
check('endpoint rejects non-agents', /not authorized as a support agent[\s\S]{0,20}403/.test(source))

console.log('')
console.log('22. Authorized agent access follows the existing RLS model')
check('agent predicate mirrors the other tables', /exists \(select 1 from public\.agent_profiles ap where ap\.user_id = auth\.uid\(\) and ap\.active = true and ap\.role in \('agent','admin'\)\)/.test(migrationSql))
check('endpoint re-checks the same predicate', /from\("agent_profiles"\)[\s\S]{0,200}eq\("active", true\)[\s\S]{0,80}in\("role", \["agent", "admin"\]\)/.test(source))
check('service-role client used for the write', /persistExecutionTrace\(supabase, trace\)/.test(source))

console.log('')
console.log('23. No broad RLS policy exists')
check('no using (true)', !/using\s*\(\s*true\s*\)/.test(migrationSql))
check('policy is scoped', /using \(exists \(select 1 from public\.agent_profiles/.test(migrationSql))
check('exactly one policy created', (migrationSql.match(/create policy/g) || []).length === 1)

console.log('')
console.log('24. No UPDATE/DELETE access')
check('no update policy', !/for update/.test(migrationSql))
check('no delete policy', !/for delete/.test(migrationSql))
check('no insert policy for clients', !/for insert/.test(migrationSql))
check('replay is read-only', /read-only|READ-ONLY/i.test(persistenceSource) || !/\.update\(/.test(persistenceSource))

console.log('')
console.log('25. Duplicate persistence is handled safely')
const duplicate = await api.persistExecutionTrace(mockClient({ insertError: { code: '23505', message: 'duplicate key' } }), trace)
check('duplicate treated as already stored', duplicate.ok === true && duplicate.reason === 'ALREADY_STORED')
check('unique constraint backs it', /case_id text not null unique/.test(migrationSql))

console.log('')
console.log('26. Multiple legitimate executions are not overwritten')
check('each execution has its own case id', /const caseId = `CASE-\$\{crypto\.randomUUID\(\)/.test(source))
check('no upsert/overwrite in persistence', !/upsert/.test(persistenceSource))
check('the stored trace is never updated', !/\.update\(/.test(persistenceSource))
const second = mockClient({})
await api.persistExecutionTrace(second, buildTrace('CASE-P10-B'))
check('a different case stores its own row', second.calls.inserted[0].payload.case_id === 'CASE-P10-B')

console.log('')
console.log('27. Existing support-case persistence remains unchanged')
check('persistCaseRecord still defined once', (source.match(/function persistCaseRecord/g) || []).length === 1)
check('still called on the outcome paths', (source.match(/await persistCaseRecord\(supabase, \{/g) || []).length >= 3)
check('support_cases columns untouched by the migration', !/alter table public\.support_cases/.test(migrationSql))

console.log('')
console.log('28. Existing execution_trace response remains compatible')
check('execution_trace still returned', /execution_trace: trace/.test(source))
check('previous additive fields kept', ['decision_gate:', 'decision_agent:', 'decision_authority:', 'action_safety:', 'legacy_reasoning:', 'evidence_summary:'].every((f) => source.includes(f)))
check('GET route added without touching POST behaviour', /if \(req\.method === "GET"\)/.test(source) && /const body = \(await req\.json\(\)\)/.test(source))

console.log('')
console.log(passed + ' passed, ' + failed + ' failed')
process.exit(failed === 0 ? 0 : 1)
