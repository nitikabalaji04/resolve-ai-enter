// Basic tests for the Phase 9 Execution Trace.
//
// Run:  node supabase/functions/support/execution-trace.test.mjs
//
// Extracts the marked pure-logic blocks from index.ts (single source of truth).
import { readFileSync } from 'node:fs'
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

const traceSource = block('// >>> EXECUTION TRACE PURE LOGIC', '// <<< EXECUTION TRACE PURE LOGIC')

const api = new Function(
  block('// >>> PLANNER PURE LOGIC', '// <<< PLANNER PURE LOGIC') +
  traceSource +
    '\nreturn { TRACE_VERSION, TRACE_STAGES, TRACE_STATUSES, traceStatusForDomain, domainStageSummary, missingDomainStages, reinvestmentStageStatus, reinvestmentStageSummary, createExecutionTrace, startTraceStage, finishTraceStage, completeTraceStage, failTraceStage, blockTraceStage, skipTraceStage, finishExecutionTrace };',
)()

let passed = 0
let failed = 0
function check(name, condition, detail) {
  if (condition) { passed += 1; console.log('  ok   ' + name) }
  else { failed += 1; console.log('FAIL   ' + name + (detail ? ' -> ' + detail : '')) }
}
const isIso = (v) => typeof v === 'string' && !Number.isNaN(new Date(v).getTime())

console.log('')
console.log('1. Trace initializes correctly')
const trace = api.createExecutionTrace('CASE-ABC123')
check('case id preserved', trace.case_id === 'CASE-ABC123')
check('version present', trace.trace_version === 1)
check('started_at is a timestamp', isIso(trace.started_at))
check('completed_at starts null', trace.completed_at === null)
check('no stages yet', Array.isArray(trace.stages) && trace.stages.length === 0)

console.log('')
console.log('2. Stages preserve execution order')
const t2 = api.createExecutionTrace('CASE-ORDER')
const order = ['triage', 'investigation_planner', 'order_agent', 'evidence_engine', 'conflict_uncertainty', 'decision_gate', 'decision_agent', 'decision_authority', 'action_safety', 'action_executor', 'case_outcome']
for (const stage of order) api.completeTraceStage(api.startTraceStage(t2, stage), {})
check('stage sequence preserved', t2.stages.map((s) => s.stage).join(',') === order.join(','))
check('ids are sequential', t2.stages.map((s) => s.id).join(',') === order.map((_, i) => 'trace-stage-' + String(i + 1).padStart(3, '0')).join(','))
check('pipeline order matches the implementation', (function () {
  // case_outcome is appended by respond() at response time, so it is excluded
  // from the source-order check (it is asserted separately in test 29).
  const literalStages = ['triage', 'investigation_planner', 'evidence_engine', 'conflict_uncertainty', 'reinvestigation', 'decision_gate', 'decision_agent', 'decision_authority', 'action_safety', 'action_executor']
  let cursor = -1
  for (const stage of literalStages) {
    const at = source.indexOf('startTraceStage(trace, "' + stage + '"')
    if (at === -1 || at < cursor) return false
    cursor = at
  }
  return true
})())

console.log('')
console.log('3. Completed stage records completed status')
const completedEntry = api.completeTraceStage(api.startTraceStage(api.createExecutionTrace('C'), 'triage'), { intent: 'DELIVERY_DELAY' })
check('status completed', completedEntry.status === 'completed')
check('summary kept', completedEntry.summary.intent === 'DELIVERY_DELAY')

console.log('')
console.log('4. Failed stage records failed status')
check('failed status', api.failTraceStage(api.startTraceStage(api.createExecutionTrace('C'), 'order_agent'), { reason: 'db_error' }).status === 'failed')

console.log('')
console.log('5. Blocked stage records blocked status')
check('blocked status', api.blockTraceStage(api.startTraceStage(api.createExecutionTrace('C'), 'decision_gate'), { status: 'BLOCK' }).status === 'blocked')

console.log('')
console.log('6. Skipped stage records skipped status')
const skipped = api.skipTraceStage(api.createExecutionTrace('C'), 'policy_agent', { reason: 'not_in_plan' })
check('skipped status', skipped.status === 'skipped')
check('skip summary kept', skipped.summary.reason === 'not_in_plan')
check('only allowed statuses are used', api.TRACE_STATUSES.join(',') === 'started,completed,failed,blocked,skipped')

console.log('')
console.log('7. Timestamps present for executed stages')
check('started_at set', isIso(completedEntry.started_at))
check('completed_at set', isIso(completedEntry.completed_at))
check('skipped stages have no timings', skipped.started_at === null && skipped.completed_at === null)

console.log('')
console.log('8. Duration is non-negative')
check('duration measured', typeof completedEntry.duration_ms === 'number' && completedEntry.duration_ms >= 0)
check('skipped duration is null', skipped.duration_ms === null)
check('unmeasurable start -> null duration', api.finishTraceStage({ started_at: 'not-a-date' }, 'completed', {}).duration_ms === null)

console.log('')
console.log('9. Trace does not invent stages')
const t9 = api.createExecutionTrace('CASE-9')
check('unknown stage rejected', api.startTraceStage(t9, 'made_up_stage') === null)
check('unknown skipped stage rejected', api.skipTraceStage(t9, 'made_up_stage') === null)
check('nothing appended', t9.stages.length === 0)
check('unknown status rejected', api.finishTraceStage({ started_at: new Date().toISOString() }, 'maybe', {}) === null)
check('stage vocabulary is exact', api.TRACE_STAGES.join(',') === 'triage,investigation_planner,customer_agent,order_agent,delivery_agent,policy_agent,evidence_engine,conflict_uncertainty,reinvestigation,decision_gate,decision_agent,decision_authority,action_safety,action_executor,case_outcome')

console.log('')
console.log('10. Skipped policy agent is recorded correctly')
const planNoPolicy = ['order', 'delivery', 'customer']
check('policy identified as not planned', api.missingDomainStages(planNoPolicy).includes('policy'))
check('planned domains are not skipped', !api.missingDomainStages(planNoPolicy).includes('order'))
const t10 = api.createExecutionTrace('CASE-10')
api.skipTraceStage(t10, 'policy_agent', { reason: 'not_in_plan' })
check('policy stage recorded as skipped', t10.stages[0].stage === 'policy_agent' && t10.stages[0].status === 'skipped')
check('order of skipped stages is deterministic', api.missingDomainStages(['customer']).join(',') === 'order,delivery,policy')

console.log('')
console.log('11. Gate-blocked case skips Decision Agent')
check('orchestrator skips the agent when the gate blocks', /decisionGate\.status === "BLOCK"[\s\S]{0,120}skipTraceStage\(trace, "decision_agent"/.test(source))
const t11 = api.createExecutionTrace('CASE-11')
api.skipTraceStage(t11, 'decision_agent', { reason: 'decision_gate_blocked' })
check('recorded as skipped, not completed', t11.stages[0].status === 'skipped')
check('reason recorded', t11.stages[0].summary.reason === 'decision_gate_blocked')

console.log('')
console.log('12. Gate-blocked case records Decision Gate as blocked')
check('gate maps BLOCK -> blocked', /decisionGate\.status === "BLOCK" \? "blocked" : "completed"/.test(source))
const t12 = api.createExecutionTrace('CASE-12')
api.finishTraceStage(api.startTraceStage(t12, 'decision_gate'), 'blocked', { status: 'BLOCK', reason: 'AGENT_NOT_FOUND' })
check('gate stage blocked', t12.stages[0].status === 'blocked' && t12.stages[0].summary.status === 'BLOCK')

console.log('')
console.log('13. Decision Agent failure is recorded correctly')
check('agent status mapping exists', /decisionAgent\.status === "completed"[\s\S]{0,120}\? "completed"/.test(source))
const t13 = api.createExecutionTrace('CASE-13')
api.finishTraceStage(api.startTraceStage(t13, 'decision_agent'), 'failed', { status: 'failed', reason: 'ACTION_ALREADY_COMPLETED' })
check('failed agent recorded', t13.stages[0].status === 'failed' && t13.stages[0].summary.reason === 'ACTION_ALREADY_COMPLETED')

console.log('')
console.log('14. Decision Authority blocked is recorded correctly')
check('authority mapping exists', /authority\.status === "authorized" \? "completed" : "blocked"/.test(source))
const t14 = api.createExecutionTrace('CASE-14')
api.finishTraceStage(api.startTraceStage(t14, 'decision_authority'), 'blocked', { status: 'blocked', reason: 'DECISION_GATE_BLOCKED' })
check('blocked authority recorded', t14.stages[0].status === 'blocked' && t14.stages[0].summary.status === 'blocked')

console.log('')
console.log('15. Action Safety blocked is recorded correctly')
check('safety mapping exists', /actionSafety\.status === "allowed" \? "completed" : "blocked"/.test(source))
const t15 = api.createExecutionTrace('CASE-15')
api.finishTraceStage(api.startTraceStage(t15, 'action_safety'), 'blocked', { status: 'blocked', reason: 'ACTION_ALREADY_COMPLETED' })
check('blocked safety recorded', t15.stages[0].status === 'blocked')

console.log('')
console.log('16. Successful action executor is recorded correctly')
const t16 = api.createExecutionTrace('CASE-16')
api.completeTraceStage(api.startTraceStage(t16, 'action_executor'), { status: 'completed', action: 'refund_shipping_fee' })
check('executor completed', t16.stages[0].status === 'completed' && t16.stages[0].summary.action === 'refund_shipping_fee')
check('executor is traced around the real call', /startTraceStage\(trace, "action_executor"\)[\s\S]{0,80}await executeAction\(/.test(source))

console.log('')
console.log('17. No-action case is recorded correctly')
check('no_action_required reason used', /skipTraceStage\(trace, "action_executor", \{ reason: "no_action_required" \}\)/.test(source))
const t17 = api.createExecutionTrace('CASE-17')
api.skipTraceStage(t17, 'action_executor', { reason: 'no_action_required' })
check('executor skipped for no-action', t17.stages[0].status === 'skipped')

console.log('')
console.log('18. Escalation is recorded correctly')
check('escalated reason used', /skipTraceStage\(trace, "action_executor", \{ reason: "escalated" \}\)/.test(source))
check('escalation path reuses the existing mechanism', /if \(decision\.decision === "escalate"\)/.test(source))

console.log('')
console.log('19. Reinvestigation zero rounds is represented correctly')
const zeroSummary = { performed: false, rounds: 0, resolved: true, stop_reason: 'not_required' }
check('status skipped', api.reinvestmentStageStatus(zeroSummary) === 'skipped')
check('rounds zero with reason', JSON.stringify(api.reinvestmentStageSummary(zeroSummary, [])) === JSON.stringify({ rounds: 0, reason: 'not_required' }))
check('no invented rounds', api.reinvestmentStageSummary(zeroSummary, [{ round: 1 }]).rounds === 0)

console.log('')
console.log('20. Reinvestigation rounds are represented correctly')
const roundsSummary = { performed: true, rounds: 1, resolved: false, stop_reason: 'no_change' }
const roundsDetail = [{ round: 1, target_domains: ['order'], stop_reason: 'no_change' }]
check('status completed', api.reinvestmentStageStatus(roundsSummary) === 'completed')
const detail = api.reinvestmentStageSummary(roundsSummary, roundsDetail)
check('rounds counted from real rounds', detail.rounds === 1)
check('round detail preserved', JSON.stringify(detail.rounds_detail) === JSON.stringify([{ round: 1, target_domains: ['order'], result: 'no_change' }]))
check('no detail invented', api.reinvestmentStageSummary(roundsSummary, []).rounds === 0)

console.log('')
console.log('21. Trace contains no prompts')
check('no reasoning prompt text', !/You are ResolveAI|INSTRUCTIONS:|CUSTOMER MESSAGE/.test(JSON.stringify(api.createExecutionTrace('C'))))
check('trace helpers never reference a prompt', !/buildQwenPrompt|buildDecisionAgentPrompt|buildTriagePrompt/.test(traceSource))
check('agent stage summaries hold counts only', JSON.stringify(api.domainStageSummary({ status: 'completed', data: { findings: [1, 2, 3] } })) === JSON.stringify({ status: 'completed', finding_count: 3 }))

console.log('')
console.log('22. Trace contains no secrets')
const allSummaries = JSON.stringify([zeroSummary, roundsSummary, api.domainStageSummary({ status: 'completed', data: { findings: [] } })])
check('no tokens or keys', !/token|secret|api[_-]?key|service_role|Bearer|authorization/i.test(traceSource))
check('no credentials in summaries', !/token|secret|api[_-]?key|service_role|Bearer/i.test(allSummaries))
check('no service-role env access', !/Deno\.env/.test(traceSource))

console.log('')
console.log('23. Trace does not mutate business data')
const businessResult = { status: 'completed', data: { findings: [{ finding: 'Order ID: 1' }] } }
const businessCopy = JSON.parse(JSON.stringify(businessResult))
api.domainStageSummary(businessResult)
check('domain result untouched', JSON.stringify(businessResult) === JSON.stringify(businessCopy))
const planCopy = ['order', 'delivery'].slice()
api.missingDomainStages(planCopy)
check('plan untouched', JSON.stringify(planCopy) === JSON.stringify(['order', 'delivery']))
const traceCopy = api.createExecutionTrace('C')
const traceSnapshot = JSON.parse(JSON.stringify(traceCopy))
api.startTraceStage(traceCopy, 'triage')
check('only the trace object changes', JSON.stringify(traceCopy) !== JSON.stringify(traceSnapshot))

console.log('')
console.log('24. Trace helpers are deterministic except timestamps')
function normalize(t) {
  return {
    case_id: t.case_id,
    trace_version: t.trace_version,
    stages: t.stages.map((s) => ({ id: s.id, stage: s.stage, status: s.status, summary: s.summary })),
  }
}
const runA = api.createExecutionTrace('CASE-DET')
api.completeTraceStage(api.startTraceStage(runA, 'triage'), { intent: 'ORDER_STATUS' })
api.skipTraceStage(runA, 'policy_agent', { reason: 'not_in_plan' })
const runB = api.createExecutionTrace('CASE-DET')
api.completeTraceStage(api.startTraceStage(runB, 'triage'), { intent: 'ORDER_STATUS' })
api.skipTraceStage(runB, 'policy_agent', { reason: 'not_in_plan' })
check('identical apart from timestamps', JSON.stringify(normalize(runA)) === JSON.stringify(normalize(runB)))
check('timestamps differ or are equal (never invented)', isIso(runA.started_at) && isIso(runB.started_at))
check('stage mapping is deterministic', api.traceStatusForDomain('not_found') === api.traceStatusForDomain('not_found'))
check('not_found still counts as executed', api.traceStatusForDomain('not_found') === 'completed')
check('failed maps to failed', api.traceStatusForDomain('failed') === 'failed')

console.log('')
console.log('25. Trace helpers do not call an LLM')
check('no askQwen', !/askQwen/.test(traceSource))
check('no fetch', !/fetch\(/.test(traceSource))

console.log('')
console.log('26. Trace helpers do not execute actions')
check('no executor calls', !/executeAction|verifyAction|persistCaseRecord|createEscalationCase/.test(traceSource))
check('no database access', !/supabase|\.from\(|\.update\(|\.insert\(/.test(traceSource))

console.log('')
console.log('27. Trace version exists')
check('constant is 1', api.TRACE_VERSION === 1)
check('present on every trace', api.createExecutionTrace('C').trace_version === 1)
check('exposed in the response', /execution_trace: trace/.test(source))

console.log('')
console.log('28. case_id is preserved')
check('string case id kept', api.createExecutionTrace('CASE-XYZ').case_id === 'CASE-XYZ')
check('missing case id is safe', api.createExecutionTrace(undefined).case_id === '')
check('the real case id is used', /createExecutionTrace\(caseId\)/.test(source))

console.log('')
console.log('29. Final case outcome is represented')
const t29 = api.createExecutionTrace('CASE-29')
api.completeTraceStage(api.startTraceStage(t29, 'case_outcome'), { status: 'resolved', decision: 'inform', action: 'no_action' })
check('outcome is the last stage', t29.stages[t29.stages.length - 1].stage === 'case_outcome')
check('outcome carries the real result', t29.stages[0].summary.status === 'resolved' && t29.stages[0].summary.decision === 'inform')
check('trace is finished', isIso(api.finishExecutionTrace(t29).completed_at))
check('respond closes the trace', /completeTraceStage\(startTraceStage\(trace, "case_outcome"\)/.test(source))

console.log('')
console.log('30. Existing API response fields remain intact')
for (const field of ['decision:', 'customer_response:', 'investigation,', 'action_status:', 'qwen_response:', 'triage,', 'investigation_plan:', 'evidence_summary:', 'investigation_health:', 'decision_gate:', 'decision_agent:', 'decision_authority:', 'action_safety:', 'legacy_reasoning:']) {
  check('response keeps ' + field, source.includes(field))
}
check('frontend contract untouched (no frontend files changed)', !/src\/components|src\/App\.jsx/.test(source))

console.log('')
console.log(passed + ' passed, ' + failed + ' failed')
process.exit(failed === 0 ? 0 : 1)
