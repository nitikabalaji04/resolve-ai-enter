// Basic tests for the Phase 5 Re-investigation Loop.
//
// Run:  node supabase/functions/support/reinvestigation.test.mjs
//
// Extracts the marked pure-logic blocks from index.ts (single source of truth).
// The loop takes its domain execution as an injected `step`, so these tests drive
// the REAL loop logic with scripted results.
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

const api = new Function(
  block('// >>> ORDER AGENT PURE LOGIC', '// <<< ORDER AGENT PURE LOGIC') +
  block('// >>> DELIVERY AGENT PURE LOGIC', '// <<< DELIVERY AGENT PURE LOGIC') +
  block('// >>> CUSTOMER AGENT PURE LOGIC', '// <<< CUSTOMER AGENT PURE LOGIC') +
  block('// >>> POLICY AGENT PURE LOGIC', '// <<< POLICY AGENT PURE LOGIC') +
  block('// >>> PLANNER PURE LOGIC', '// <<< PLANNER PURE LOGIC') +
  block('// >>> EVIDENCE ENGINE PURE LOGIC', '// <<< EVIDENCE ENGINE PURE LOGIC') +
  block('// >>> CONFLICT ENGINE PURE LOGIC', '// <<< CONFLICT ENGINE PURE LOGIC') +
  block('// >>> REINVESTIGATION PURE LOGIC', '// <<< REINVESTIGATION PURE LOGIC') +
    '\nreturn { MAX_REINVESTIGATION_ROUNDS, selectReinvestigationTargets, investigationSignature, mergeDomainResults, reinvestmentRoundOutcome, runReinvestmentLoop, buildEvidence, analyzeEvidence, buildInvestigation, PLAN_ORDER };',
)()

let passed = 0
let failed = 0
function check(name, condition, detail) {
  if (condition) { passed += 1; console.log('  ok   ' + name) }
  else { failed += 1; console.log('FAIL   ' + name + (detail ? ' -> ' + detail : '')) }
}

// --- helpers ----------------------------------------------------------------
function agentResult(agent, domain, findings, status) {
  return { agent, domain, status: status || 'completed', findings }
}
function domainResult(domain, findings, status, extra) {
  const state = status || 'completed'
  const data = { agent: domain + '_agent', domain, status: state, findings: findings || [] }
  if (extra) Object.assign(data, extra)
  return { domain, status: state, data }
}
function finding(text) {
  return { finding: text, source: 'orders', confidence: 1.0 }
}
function stateFor(results, plan) {
  const evidenceRun = api.buildEvidence(results.map(function (r) { return r.data }))
  return {
    evidence: evidenceRun.evidence,
    agentStatus: evidenceRun.agent_status,
    health: api.analyzeEvidence(evidenceRun.evidence, evidenceRun.agent_status, plan),
  }
}

const HEALTHY_RESULTS = [
  domainResult('order', [finding('Order ID: 10486'), finding('Order status: delayed')], 'completed', { order: { order_id: '10486', customer_id: 'CUST004' } }),
  domainResult('delivery', [finding('Delivery status: delayed')], 'completed', { delivery: { status: 'delayed' } }),
  domainResult('customer', [finding('Customer name: Aarav Kapoor')], 'completed', { customer: { customer_id: 'CUST004', name: 'Aarav Kapoor' }, support_history: [] }),
  domainResult('policy', [finding('Policy: Delayed Express Delivery Refund')], 'completed', { policy: { policy_id: 1 } }),
]
const PLAN = ['order', 'delivery', 'customer', 'policy']
const PLAN_OD = ['order', 'delivery']
const PLAN_ODC = ['order', 'delivery', 'customer']

const CONFLICTING_RESULTS = [
  domainResult('order', [finding('Order ID: 10486')], 'completed', { order: { order_id: '10486', customer_id: 'CUST004' } }),
  domainResult('delivery', [finding('Delivery status: delivered'), finding('Delivery status: delayed')], 'completed', { delivery: { status: 'delivered' } }),
]

const NOT_FOUND_RESULTS = [
  domainResult('order', [], 'not_found'),
  domainResult('delivery', [], 'not_found'),
  domainResult('customer', [], 'not_found'),
]

console.log('')
console.log('1. No reinvestigation required')
{
  const state = stateFor(HEALTHY_RESULTS, PLAN)
  let stepCalls = 0
  const run = await api.runReinvestmentLoop({
    plan: PLAN, results: HEALTHY_RESULTS, evidence: state.evidence, agentStatus: state.agentStatus, health: state.health,
    step: async function () { stepCalls += 1; return [] },
  })
  check('no round performed', run.summary.performed === false && run.summary.rounds === 0)
  check('resolved true', run.summary.resolved === true)
  check('stop_reason not_required', run.summary.stop_reason === 'not_required')
  check('executor never called', stepCalls === 0)
  check('only the initial round in history', run.history.length === 1 && run.history[0].round === 0)
}

console.log('')
console.log('2. One conflict triggers targeted reinvestigation')
{
  const state = stateFor(CONFLICTING_RESULTS, PLAN_OD)
  const seen = []
  await api.runReinvestmentLoop({
    plan: PLAN_OD, results: CONFLICTING_RESULTS, evidence: state.evidence, agentStatus: state.agentStatus, health: state.health,
    step: async function (domains) { seen.push(domains.slice()); return [domainResult('delivery', [finding('Delivery status: delivered')])] },
  })
  check('reinvestigation performed', seen.length === 1)
  check('targets the conflicting domain', JSON.stringify(seen[0]) === JSON.stringify(['delivery']))
}

console.log('')
console.log('3. Missing domain triggers targeted reinvestigation')
{
  const partial = [domainResult('order', [finding('Order ID: 1')]), domainResult('customer', [finding('Customer name: A')])]
  const state = stateFor(partial, PLAN)
  const seen = []
  await api.runReinvestmentLoop({
    plan: PLAN, results: partial, evidence: state.evidence, agentStatus: state.agentStatus, health: state.health,
    step: async function (domains) { seen.push(domains.slice()); return [] },
  })
  check('missing domains targeted', JSON.stringify(seen[0]) === JSON.stringify(['delivery', 'policy']), JSON.stringify(seen[0]))
}

console.log('')
console.log('4. Agent failure triggers targeted reinvestigation')
{
  const results = [domainResult('order', [finding('Order ID: 1')]), domainResult('policy', [], 'failed')]
  const state = stateFor(results, PLAN)
  const seen = []
  await api.runReinvestmentLoop({
    plan: PLAN, results, evidence: state.evidence, agentStatus: state.agentStatus, health: state.health,
    step: async function (domains) { seen.push(domains.slice()); return [] },
  })
  check('failed agent domain targeted', seen[0].includes('policy'), JSON.stringify(seen[0]))
}

console.log('')
console.log('5. Low confidence targets the correct domain')
{
  const results = [
    domainResult('order', [finding('Order ID: 1')]),
    domainResult('delivery', [{ finding: 'Delivery status: delayed', source: 'orders', confidence: 0.2 }]),
  ]
  const state = stateFor(results, PLAN)
  const seen = []
  await api.runReinvestmentLoop({
    plan: PLAN, results, evidence: state.evidence, agentStatus: state.agentStatus, health: state.health,
    step: async function (domains) { seen.push(domains.slice()); return [] },
  })
  check('low-confidence domain targeted', seen[0].includes('delivery'), JSON.stringify(seen[0]))
}

console.log('')
console.log('6. Conflict resolves after round 1')
{
  const state = stateFor(CONFLICTING_RESULTS, PLAN_OD)
  const run = await api.runReinvestmentLoop({
    plan: PLAN_OD, results: CONFLICTING_RESULTS, evidence: state.evidence, agentStatus: state.agentStatus, health: state.health,
    step: async function () { return [domainResult('delivery', [finding('Delivery status: delivered')])] },
  })
  check('one round ran', run.summary.rounds === 1)
  check('resolved', run.summary.resolved === true)
  check('stop_reason conflict_resolved', run.summary.stop_reason === 'conflict_resolved')
  check('health now clean', run.health.conflict_status === 'none' && run.health.uncertainty_status === 'none')
  check('round recorded as stopped', run.rounds[0].stopped === true && run.rounds[0].changed === true)
  check('round objects carry only investigation metadata', JSON.stringify(Object.keys(run.rounds[0]).sort()) === JSON.stringify(['after', 'before', 'changed', 'round', 'stop_reason', 'stopped', 'target_domains']))
}

console.log('')
console.log('7. Conflict remains after round 1 (no change)')
{
  const state = stateFor(CONFLICTING_RESULTS, PLAN_OD)
  const run = await api.runReinvestmentLoop({
    plan: PLAN_OD, results: CONFLICTING_RESULTS, evidence: state.evidence, agentStatus: state.agentStatus, health: state.health,
    step: async function () { return [domainResult('delivery', [finding('Delivery status: delivered'), finding('Delivery status: delayed')])] },
  })
  check('stopped after one round', run.summary.rounds === 1)
  check('not resolved', run.summary.resolved === false)
  check('stop_reason no_change', run.summary.stop_reason === 'no_change')
  check('conflict still detected', run.health.conflict_status === 'detected')
}

console.log('')
console.log('8. Conflict resolves after round 2')
{
  const state = stateFor(CONFLICTING_RESULTS, PLAN_OD)
  let call = 0
  const run = await api.runReinvestmentLoop({
    plan: PLAN_OD, results: CONFLICTING_RESULTS, evidence: state.evidence, agentStatus: state.agentStatus, health: state.health,
    step: async function () {
      call += 1
      return call === 1
        ? [domainResult('delivery', [finding('Delivery status: delayed'), finding('Delivery status: shipped')])]
        : [domainResult('delivery', [finding('Delivery status: delayed')])]
    },
  })
  check('two rounds ran', run.summary.rounds === 2, String(run.summary.rounds))
  check('resolved on round 2', run.summary.resolved === true)
  check('stop_reason conflict_resolved', run.summary.stop_reason === 'conflict_resolved')
  check('both rounds recorded', run.rounds.length === 2 && run.rounds[1].changed === true)
}

console.log('')
console.log('9. Maximum two rounds enforced')
{
  const state = stateFor(CONFLICTING_RESULTS, PLAN_OD)
  let calls = 0
  const run = await api.runReinvestmentLoop({
    plan: PLAN_OD, results: CONFLICTING_RESULTS, evidence: state.evidence, agentStatus: state.agentStatus, health: state.health,
    step: async function () {
      calls += 1
      return [domainResult('delivery', [finding('Delivery status: value ' + calls), finding('Delivery status: other ' + calls)])]
    },
  })
  check('max rounds constant is 2', api.MAX_REINVESTIGATION_ROUNDS === 2)
  check('executor called at most twice', calls <= 2, String(calls))
  check('stop_reason max_rounds_reached', run.summary.stop_reason === 'max_rounds_reached', run.summary.stop_reason)
  check('not resolved', run.summary.resolved === false)
  check('summary reports the cap', run.summary.max_rounds === 2)
}

console.log('')
console.log('10. No-change detection')
{
  const state = stateFor(CONFLICTING_RESULTS, PLAN_OD)
  let calls = 0
  const run = await api.runReinvestmentLoop({
    plan: PLAN_OD, results: CONFLICTING_RESULTS, evidence: state.evidence, agentStatus: state.agentStatus, health: state.health,
    step: async function () { calls += 1; return [domainResult('delivery', [finding('Delivery status: delivered'), finding('Delivery status: delayed')])] },
  })
  check('identical result stops the loop', calls === 1 && run.summary.stop_reason === 'no_change')
  check('signature helper detects equality', api.investigationSignature(state.evidence, state.agentStatus) === api.investigationSignature(run.evidence, run.agentStatus))
}

console.log('')
console.log('11. Nonexistent order does not loop indefinitely')
{
  const state = stateFor(NOT_FOUND_RESULTS, PLAN_ODC)
  let calls = 0
  const run = await api.runReinvestmentLoop({
    plan: PLAN_ODC, results: NOT_FOUND_RESULTS, evidence: state.evidence, agentStatus: state.agentStatus, health: state.health,
    step: async function (domains) { calls += 1; return domains.map(function (d) { return domainResult(d, [], 'not_found') }) },
  })
  check('uncertainty was detected first', state.health.requires_reinvestigation === true)
  check('only one round attempted', calls === 1, String(calls))
  check('stop_reason no_change', run.summary.stop_reason === 'no_change')
  check('no infinite loop', run.summary.rounds === 1)
  check('still unresolved', run.summary.resolved === false)
  check('targets were the not_found domains', run.summary.target_domains.join(',') === 'order,delivery,customer')
}

console.log('')
console.log('12. Unsafe / unmapped target does not rerun agents')
{
  const state = stateFor(CONFLICTING_RESULTS, PLAN_OD)
  const unsafeHealth = {
    conflict_status: 'detected',
    uncertainty_status: 'none',
    requires_reinvestigation: true,
    conflicts: [{ type: 'x', domain: 'warehouse', evidence_ids: [], description: 'x' }],
    uncertainties: [],
    missing_domains: [],
  }
  let calls = 0
  const run = await api.runReinvestmentLoop({
    plan: PLAN_OD, results: CONFLICTING_RESULTS, evidence: state.evidence, agentStatus: state.agentStatus, health: unsafeHealth,
    step: async function () { calls += 1; return [] },
  })
  check('unmapped domain dropped', api.selectReinvestigationTargets(unsafeHealth).length === 0)
  check('no agent rerun', calls === 0)
  check('stop_reason no_safe_target', run.summary.stop_reason === 'no_safe_target')
  check('not resolved', run.summary.resolved === false)
}

console.log('')
console.log('13. Only target domains execute')
{
  const partial = [domainResult('order', [finding('Order ID: 1')])]
  const state = stateFor(partial, PLAN)
  const seen = []
  await api.runReinvestmentLoop({
    plan: PLAN, results: partial, evidence: state.evidence, agentStatus: state.agentStatus, health: state.health,
    step: async function (domains) { seen.push(domains.slice()); return domains.map(function (d) { return domainResult(d, [finding('Filler for ' + d)]) }) },
  })
  const requested = seen.flat()
  check('only planned missing domains requested', requested.join(',') === 'delivery,customer,policy', requested.join(','))
  check('order was not re-run', !requested.includes('order'))
}

console.log('')
console.log('14. Non-target domains do not execute')
{
  const partial = [domainResult('order', [finding('Order ID: 1')])]
  const state = stateFor(partial, PLAN)
  const seen = []
  await api.runReinvestmentLoop({
    plan: PLAN, results: partial, evidence: state.evidence, agentStatus: state.agentStatus, health: state.health,
    step: async function (domains) { seen.push(domains.slice()); return [] },
  })
  check('healthy/complete domains are never targeted', seen.flat().every(function (d) { return d !== 'order' }))
}

console.log('')
console.log('15. Evidence history preserves the initial round')
{
  const state = stateFor(CONFLICTING_RESULTS, PLAN_OD)
  const run = await api.runReinvestmentLoop({
    plan: PLAN_OD, results: CONFLICTING_RESULTS, evidence: state.evidence, agentStatus: state.agentStatus, health: state.health,
    step: async function () { return [domainResult('delivery', [finding('Delivery status: delivered')])] },
  })
  check('round 0 is the initial investigation', run.history[0].round === 0 && run.history[0].type === 'initial')
  check('initial evidence preserved unchanged', JSON.stringify(run.history[0].evidence) === JSON.stringify(state.evidence))
  check('initial evidence still holds the conflict', run.history[0].evidence.some(function (e) { return e.finding === 'Delivery status: delayed' }))
}

console.log('')
console.log('16. Evidence history preserves the reinvestigation round')
{
  const state = stateFor(CONFLICTING_RESULTS, PLAN_OD)
  const run = await api.runReinvestmentLoop({
    plan: PLAN_OD, results: CONFLICTING_RESULTS, evidence: state.evidence, agentStatus: state.agentStatus, health: state.health,
    step: async function () { return [domainResult('delivery', [finding('Delivery status: delivered')])] },
  })
  check('round 1 recorded as reinvestigation', run.history[1].round === 1 && run.history[1].type === 'reinvestigation')
  check('round 1 records its targets', JSON.stringify(run.history[1].target_domains) === JSON.stringify(['delivery']))
  check('round 1 evidence rebuilt by the Evidence Engine', run.history[1].evidence.length > 0 && run.history[1].evidence[0].id === 'EV-001')
  check('history keeps both rounds', run.history.length === 2)
}

console.log('')
console.log('17. Deterministic output')
{
  const state = stateFor(CONFLICTING_RESULTS, PLAN_OD)
  const step = async function () { return [domainResult('delivery', [finding('Delivery status: delivered')])] }
  const runA = await api.runReinvestmentLoop({ plan: PLAN_OD, results: CONFLICTING_RESULTS, evidence: state.evidence, agentStatus: state.agentStatus, health: state.health, step })
  const runB = await api.runReinvestmentLoop({ plan: PLAN_OD, results: CONFLICTING_RESULTS, evidence: state.evidence, agentStatus: state.agentStatus, health: state.health, step })
  check('same input -> identical output', JSON.stringify(runA) === JSON.stringify(runB))
  check('no random identifiers', !/[0-9a-f]{8}-[0-9a-f]{4}/i.test(JSON.stringify(runA.summary)))
}

console.log('')
console.log('18. Input is not mutated')
{
  const state = stateFor(CONFLICTING_RESULTS, PLAN_OD)
  const resultsCopy = JSON.parse(JSON.stringify(CONFLICTING_RESULTS))
  const evidenceCopy = JSON.parse(JSON.stringify(state.evidence))
  const healthCopy = JSON.parse(JSON.stringify(state.health))
  await api.runReinvestmentLoop({
    plan: PLAN_OD, results: CONFLICTING_RESULTS, evidence: state.evidence, agentStatus: state.agentStatus, health: state.health,
    step: async function () { return [domainResult('delivery', [finding('Delivery status: delivered')])] },
  })
  check('results unchanged', JSON.stringify(CONFLICTING_RESULTS) === JSON.stringify(resultsCopy))
  check('evidence unchanged', JSON.stringify(state.evidence) === JSON.stringify(evidenceCopy))
  check('health unchanged', JSON.stringify(state.health) === JSON.stringify(healthCopy))
}

console.log('')
console.log('19. Existing legacy investigation remains compatible')
{
  const state = stateFor(CONFLICTING_RESULTS, PLAN_OD)
  const run = await api.runReinvestmentLoop({
    plan: PLAN_OD, results: CONFLICTING_RESULTS, evidence: state.evidence, agentStatus: state.agentStatus, health: state.health,
    step: async function () { return [domainResult('delivery', [finding('Delivery status: delivered')])] },
  })
  const legacy = api.buildInvestigation(run.results)
  check('legacy keys exactly as expected', JSON.stringify(Object.keys(legacy).sort()) === JSON.stringify(['customer', 'customer_id', 'order', 'policy', 'ticket_history']))
  check('legacy order is the raw record', Boolean(legacy.order) && legacy.order.order_id === '10486')
  check('legacy carries no loop metadata', !('summary' in legacy) && !('history' in legacy) && !JSON.stringify(legacy).includes('reinvestigation'))
  check('merged results keep plan order', run.results.map(function (r) { return r.domain }).join(',') === 'order,delivery')
}

console.log('')
console.log('20. Existing reasoning input remains unchanged')
{
  const state = stateFor(HEALTHY_RESULTS, PLAN)
  const before = api.buildInvestigation(HEALTHY_RESULTS)
  const run = await api.runReinvestmentLoop({
    plan: PLAN, results: HEALTHY_RESULTS, evidence: state.evidence, agentStatus: state.agentStatus, health: state.health,
    step: async function () { return [] },
  })
  const after = api.buildInvestigation(run.results)
  check('healthy case leaves the reasoning input identical', JSON.stringify(before) === JSON.stringify(after))
  check('reasoning input keeps the legacy shape', JSON.stringify(Object.keys(after).sort()) === JSON.stringify(['customer', 'customer_id', 'order', 'policy', 'ticket_history']))
  check('raw records preserved', Boolean(after.order) && after.order.order_id === '10486' && Boolean(after.customer) && after.customer.name === 'Aarav Kapoor')
}

console.log('')
console.log('21. Healthy live case performs zero reinvestigation')
{
  const liveLike = [
    domainResult('order', [finding('Order ID: 10482'), finding('Order status: delayed'), finding('Payment status: paid')]),
    domainResult('delivery', [finding('Delivery status: delayed'), finding('Shipping method: Express')]),
    domainResult('customer', [{ finding: 'Customer name: Ananya Sharma', source: 'customers', confidence: 1.0 }, { finding: 'Support history contains 3 ticket(s)', source: 'tickets', confidence: 1.0 }]),
  ]
  const plan = ['order', 'delivery', 'customer']
  const state = stateFor(liveLike, plan)
  let calls = 0
  const run = await api.runReinvestmentLoop({
    plan, results: liveLike, evidence: state.evidence, agentStatus: state.agentStatus, health: state.health,
    step: async function () { calls += 1; return [] },
  })
  check('health is clean', state.health.conflict_status === 'none' && state.health.uncertainty_status === 'none')
  check('zero rounds', run.summary.rounds === 0 && calls === 0)
  check('stop_reason not_required', run.summary.stop_reason === 'not_required')
  check('summary is minimal', JSON.stringify(Object.keys(run.summary).sort()) === JSON.stringify(['max_rounds', 'performed', 'resolved', 'rounds', 'stop_reason', 'target_domains']))
}

console.log('')
console.log('22. Existing decisions/actions remain unchanged')
{
  const state = stateFor(HEALTHY_RESULTS, PLAN)
  const run = await api.runReinvestmentLoop({
    plan: PLAN, results: HEALTHY_RESULTS, evidence: state.evidence, agentStatus: state.agentStatus, health: state.health,
    step: async function () { return [] },
  })
  check('loop output has no decision fields', !('decision' in run) && !('action' in run) && !('resolution_status' in run))
  check('loop output has no decision fields in the summary', !/decision|action|resolution/i.test(JSON.stringify(run.summary)))
  check('healthy case records no round objects', run.rounds.length === 0)
  check('loop never touches the evidence engine output shape', run.evidence.every(function (e) { return typeof e.id === 'string' && typeof e.agent === 'string' }))
}

console.log('')
console.log(passed + ' passed, ' + failed + ' failed')
process.exit(failed === 0 ? 0 : 1)
