// Basic tests for the Phase 4 Conflict & Uncertainty Engine.
//
// Run:  node supabase/functions/support/conflict-engine.test.mjs
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

const api = new Function(
  block('// >>> ORDER AGENT PURE LOGIC', '// <<< ORDER AGENT PURE LOGIC') +
  block('// >>> DELIVERY AGENT PURE LOGIC', '// <<< DELIVERY AGENT PURE LOGIC') +
  block('// >>> CUSTOMER AGENT PURE LOGIC', '// <<< CUSTOMER AGENT PURE LOGIC') +
  block('// >>> POLICY AGENT PURE LOGIC', '// <<< POLICY AGENT PURE LOGIC') +
  block('// >>> PLANNER PURE LOGIC', '// <<< PLANNER PURE LOGIC') +
  block('// >>> EVIDENCE ENGINE PURE LOGIC', '// <<< EVIDENCE ENGINE PURE LOGIC') +
  block('// >>> CONFLICT ENGINE PURE LOGIC', '// <<< CONFLICT ENGINE PURE LOGIC') +
    '\nreturn { buildEvidence, analyzeEvidence, splitFinding, CONFIDENCE_THRESHOLD, SINGLE_VALUED_DIMENSIONS, REINVESTIGATION_TRIGGERS, buildInvestigation, domainResult };',
)()

let passed = 0
let failed = 0
function check(name, condition, detail) {
  if (condition) { passed += 1; console.log('  ok   ' + name) }
  else { failed += 1; console.log('FAIL   ' + name + (detail ? ' -> ' + detail : '')) }
}

const PLAN = ['order', 'delivery', 'customer', 'policy']

// Healthy agent results (mirrors a real case).
const healthyAgents = [
  { agent: 'order_agent', domain: 'order', status: 'completed', findings: [
    { finding: 'Order ID: 10486', source: 'orders', confidence: 1.0 },
    { finding: 'Order status: delayed', source: 'orders', confidence: 1.0 },
  ] },
  { agent: 'delivery_agent', domain: 'delivery', status: 'completed', findings: [
    { finding: 'Delivery status: delayed', source: 'orders', confidence: 1.0 },
  ] },
  { agent: 'customer_agent', domain: 'customer', status: 'completed', findings: [
    { finding: 'Customer name: Aarav Kapoor', source: 'customers', confidence: 1.0 },
  ] },
  { agent: 'policy_agent', domain: 'policy', status: 'completed', findings: [
    { finding: 'Policy: Delayed Express Delivery Refund', source: 'policies', confidence: 1.0 },
  ] },
]

const healthyEvidence = api.buildEvidence(healthyAgents)
const healthyStatus = healthyEvidence.agent_status
const healthy = api.analyzeEvidence(healthyEvidence.evidence, healthyStatus, PLAN)

// Helper: engine-produced evidence ids for synthetic findings.
function evidenceFor(findings, domain, agent) {
  return api.buildEvidence([{ agent: agent, domain: domain, status: 'completed', findings: findings }])
}

console.log('')
console.log('1. No conflicts')
check('conflict_status none', healthy.conflict_status === 'none')
check('conflicts empty', healthy.conflicts.length === 0)
check('no fabricated conflict objects', JSON.stringify(healthy.conflicts) === '[]')

console.log('')
console.log('2. Delivery status conflict')
const deliveryConflict = api.analyzeEvidence(
  evidenceFor([
    { finding: 'Delivery status: delivered', source: 'orders', confidence: 1.0 },
    { finding: 'Delivery status: delayed', source: 'orders', confidence: 1.0 },
  ], 'delivery', 'delivery_agent').evidence,
  { delivery_agent: 'completed' },
  ['delivery'],
)
check('conflict detected', deliveryConflict.conflict_status === 'detected')
check('conflict type', deliveryConflict.conflicts[0].type === 'delivery_status_conflict')
check('conflict domain', deliveryConflict.conflicts[0].domain === 'delivery')
check('conflict description', deliveryConflict.conflicts[0].description === 'Conflicting delivery status evidence')

console.log('')
console.log('3. Order status conflict')
const orderConflict = api.analyzeEvidence(
  evidenceFor([
    { finding: 'Order status: delivered', source: 'orders', confidence: 1.0 },
    { finding: 'Order status: processing', source: 'orders', confidence: 1.0 },
  ], 'order', 'order_agent').evidence,
  { order_agent: 'completed' },
  ['order'],
)
check('conflict detected', orderConflict.conflict_status === 'detected')
check('conflict type', orderConflict.conflicts[0].type === 'order_status_conflict')
check('conflict domain', orderConflict.conflicts[0].domain === 'order')

console.log('')
console.log('4. Same dimension with compatible values')
const compatible = api.analyzeEvidence(
  evidenceFor([
    { finding: 'Delivery status: delayed', source: 'orders', confidence: 1.0 },
    { finding: 'Delivery status: Delayed', source: 'orders', confidence: 1.0 },
  ], 'delivery', 'delivery_agent').evidence,
  { delivery_agent: 'completed' },
  ['delivery'],
)
check('same value (case-insensitive) is not a conflict', compatible.conflict_status === 'none')
check('no conflict objects', compatible.conflicts.length === 0)

console.log('')
console.log('5. Different dimensions are not conflicts')
const different = api.analyzeEvidence(
  evidenceFor([
    { finding: 'Shipping type: Express', source: 'orders', confidence: 1.0 },
    { finding: 'Order status: shipped', source: 'orders', confidence: 1.0 },
  ], 'order', 'order_agent').evidence,
  { order_agent: 'completed' },
  ['order'],
)
check('unrelated facts are not conflicts', different.conflict_status === 'none')
check('shipping type vs order status not flagged', different.conflicts.length === 0)
const listValued = api.analyzeEvidence(
  evidenceFor([
    { finding: 'Condition: Order was shipped using Express delivery', source: 'policies', confidence: 1.0 },
    { finding: 'Condition: Delivery is delayed by 2 or more days', source: 'policies', confidence: 1.0 },
  ], 'policy', 'policy_agent').evidence,
  { policy_agent: 'completed' },
  ['policy'],
)
check('list-valued conditions are not conflicts', listValued.conflict_status === 'none')
check('findings without a dimension are ignored', api.splitFinding('no colon here') === null)

console.log('')
console.log('6. Agent failure')
const failure = api.analyzeEvidence(
  healthyEvidence.evidence.filter(function (e) { return e.domain !== 'policy' }),
  { order_agent: 'completed', delivery_agent: 'completed', customer_agent: 'completed', policy_agent: 'failed' },
  PLAN,
)
check('uncertainty detected', failure.uncertainty_status === 'detected')
const failureItem = failure.uncertainties.find(function (u) { return u.type === 'agent_failure' })
check('agent_failure recorded', failureItem && failureItem.agent === 'policy_agent')
check('failure description', failureItem && failureItem.description === 'Policy evidence unavailable because the policy agent failed')
check('failed domain listed as missing', failure.missing_domains.join(',') === 'policy')
check('conflict_status stays none', failure.conflict_status === 'none')

console.log('')
console.log('7. Agent not_found')
const notFound = api.analyzeEvidence([], { order_agent: 'not_found' }, ['order'])
check('uncertainty detected', notFound.uncertainty_status === 'detected')
check('agent_not_found recorded', notFound.uncertainties[0].type === 'agent_not_found' && notFound.uncertainties[0].agent === 'order_agent')
check('missing domain recorded', notFound.missing_domains.join(',') === 'order')

console.log('')
console.log('8. Missing required domain')
const missingDomain = api.analyzeEvidence(
  healthyEvidence.evidence.filter(function (e) { return e.domain !== 'delivery' }),
  { order_agent: 'completed', customer_agent: 'completed', policy_agent: 'completed' },
  PLAN,
)
const missingItem = missingDomain.uncertainties.find(function (u) { return u.type === 'missing_domain' })
check('missing_domain recorded', missingItem && missingItem.domain === 'delivery')
check('missing domain description', missingItem && missingItem.description === 'Delivery evidence is unavailable')
check('missing_domains lists it', missingDomain.missing_domains.join(',') === 'delivery')

console.log('')
console.log('9. Low-confidence evidence')
const lowConfidence = api.analyzeEvidence(
  evidenceFor([
    { finding: 'Delivery status: delayed', source: 'orders', confidence: 0.3 },
    { finding: 'Shipping method: Express', source: 'orders', confidence: 1.0 },
  ], 'delivery', 'delivery_agent').evidence,
  { delivery_agent: 'completed' },
  ['delivery'],
)
const weakItem = lowConfidence.uncertainties.find(function (u) { return u.type === 'low_confidence' })
check('low_confidence recorded', weakItem && weakItem.domain === 'delivery')
check('threshold documented', api.CONFIDENCE_THRESHOLD === 0.5)
check('only the weak item referenced', weakItem.evidence_ids.join(',') === 'EV-001')
check('confidence at the threshold is acceptable', api.analyzeEvidence(
  evidenceFor([{ finding: 'Delivery status: delayed', source: 'orders', confidence: 0.5 }], 'delivery', 'delivery_agent').evidence,
  { delivery_agent: 'completed' },
  ['delivery'],
).uncertainty_status === 'none')

console.log('')
console.log('10. Multiple conflicts')
const multi = api.analyzeEvidence(
  evidenceFor([
    { finding: 'Delivery status: delivered', source: 'orders', confidence: 1.0 },
    { finding: 'Delivery status: delayed', source: 'orders', confidence: 1.0 },
    { finding: 'Payment status: paid', source: 'orders', confidence: 1.0 },
    { finding: 'Payment status: pending', source: 'orders', confidence: 1.0 },
  ], 'order', 'order_agent').evidence,
  { order_agent: 'completed' },
  ['order'],
)
check('both conflicts detected', multi.conflicts.length === 2, String(multi.conflicts.length))
check('conflict types distinct', multi.conflicts[0].type !== multi.conflicts[1].type)

console.log('')
console.log('11. Conflict references valid evidence IDs')
const conflictEvidence = evidenceFor([
  { finding: 'Delivery status: delivered', source: 'orders', confidence: 1.0 },
  { finding: 'Delivery status: delayed', source: 'orders', confidence: 1.0 },
], 'delivery', 'delivery_agent').evidence
const realIds = conflictEvidence.map(function (e) { return e.id })
const referenced = api.analyzeEvidence(conflictEvidence, { delivery_agent: 'completed' }, ['delivery']).conflicts[0].evidence_ids
check('ids exist in the evidence set', referenced.every(function (id) { return realIds.includes(id) }))
check('both conflicting items referenced', referenced.join(',') === realIds.join(','))
check('ids are engine-format', referenced.every(function (id) { return /^EV-\d{3}$/.test(id) }))

console.log('')
console.log('12. No fabricated evidence IDs')
check('no extra ids invented', referenced.length === 2)
const singleConflict = api.analyzeEvidence(
  conflictEvidence.concat([{ id: 'EV-009', agent: 'order_agent', domain: 'order', finding: 'Order ID: 1', source: 'orders', confidence: 1.0 }]),
  { delivery_agent: 'completed' },
  ['delivery'],
).conflicts[0]
check('unrelated evidence is not referenced', !singleConflict.evidence_ids.includes('EV-009'))
check('missing ids are never emitted', api.analyzeEvidence(
  [{ agent: 'delivery_agent', domain: 'delivery', finding: 'Delivery status: delivered', source: 'orders', confidence: 1 },
   { agent: 'delivery_agent', domain: 'delivery', finding: 'Delivery status: delayed', source: 'orders', confidence: 1 }],
  { delivery_agent: 'completed' },
  ['delivery'],
).conflicts[0].evidence_ids.length === 0)

console.log('')
console.log('13. No uncertainty when sufficient evidence exists')
check('uncertainty_status none', healthy.uncertainty_status === 'none')
check('no uncertainty objects', healthy.uncertainties.length === 0)
check('no missing domains', healthy.missing_domains.length === 0)

console.log('')
console.log('14. requires_reinvestigation = false for healthy evidence')
check('healthy case needs no re-investigation', healthy.requires_reinvestigation === false)
check('flag is a boolean', typeof healthy.requires_reinvestigation === 'boolean')

console.log('')
console.log('15. requires_reinvestigation = true for genuine conflict')
check('conflict forces re-investigation', deliveryConflict.requires_reinvestigation === true)
check('order conflict forces re-investigation', orderConflict.requires_reinvestigation === true)

console.log('')
console.log('16. requires_reinvestigation = true for important uncertainty')
check('agent failure triggers it', failure.requires_reinvestigation === true)
check('not_found triggers it', notFound.requires_reinvestigation === true)
check('missing domain triggers it', missingDomain.requires_reinvestigation === true)
check('low confidence triggers it', lowConfidence.requires_reinvestigation === true)
check('trigger list is explicit', api.REINVESTIGATION_TRIGGERS.join(',') === 'agent_failure,agent_not_found,missing_domain,low_confidence')

console.log('')
console.log('17. Deterministic output')
const runA = api.analyzeEvidence(healthyEvidence.evidence, healthyStatus, PLAN)
const runB = api.analyzeEvidence(healthyEvidence.evidence, healthyStatus, PLAN)
check('same input -> identical output', JSON.stringify(runA) === JSON.stringify(runB))
const conflictRunA = api.analyzeEvidence(conflictEvidence, { delivery_agent: 'completed' }, ['delivery'])
const conflictRunB = api.analyzeEvidence(conflictEvidence, { delivery_agent: 'completed' }, ['delivery'])
check('conflicts are deterministic', JSON.stringify(conflictRunA) === JSON.stringify(conflictRunB))
check('output has no random ids', !/[0-9a-f]{8}-[0-9a-f]{4}/i.test(JSON.stringify(conflictRunA)))

console.log('')
console.log('18. Input is not mutated')
const evidenceCopy = JSON.parse(JSON.stringify(healthyEvidence.evidence))
const statusCopy = JSON.parse(JSON.stringify(healthyStatus))
const planCopy = PLAN.slice()
api.analyzeEvidence(healthyEvidence.evidence, healthyStatus, PLAN)
check('evidence unchanged', JSON.stringify(healthyEvidence.evidence) === JSON.stringify(evidenceCopy))
check('agent status unchanged', JSON.stringify(healthyStatus) === JSON.stringify(statusCopy))
check('required plan unchanged', JSON.stringify(PLAN) === JSON.stringify(planCopy))

console.log('')
console.log('19. Malformed evidence handled safely')
check('non-array evidence', api.analyzeEvidence('nope', {}, PLAN).conflict_status === 'none')
check('null evidence', api.analyzeEvidence(null, null, null).conflict_status === 'none')
check('malformed items ignored', api.analyzeEvidence([null, 'x', 42, [], {}, { finding: 1 }, { finding: 'Order status: x' }], {}, []).conflicts.length === 0)
check('missing agentStatus with sufficient evidence is safe', api.analyzeEvidence(healthyEvidence.evidence, undefined, PLAN).uncertainty_status === 'none')
check('missing agentStatus with no evidence -> missing domains', api.analyzeEvidence([], undefined, PLAN).missing_domains.length === 4)
check('a missing status alone is never invented as a failure', api.analyzeEvidence(healthyEvidence.evidence, {}, PLAN).uncertainties.every(function (u) { return u.type !== 'agent_failure' }))
check('non-array plan is safe', api.analyzeEvidence(healthyEvidence.evidence, healthyStatus, 'order').missing_domains.length === 0)
check('malformed plan entries ignored', api.analyzeEvidence(healthyEvidence.evidence, healthyStatus, [null, 42, '   ']).missing_domains.length === 0)
check('never throws', (function () {
  try {
    api.analyzeEvidence(undefined, undefined, undefined)
    return true
  } catch (e) {
    return false
  }
})())

console.log('')
console.log('20. Existing reasoning input unchanged')
const legacyInput = [
  api.domainResult('order', 'completed', healthyAgents[0]),
  api.domainResult('delivery', 'completed', healthyAgents[1]),
  api.domainResult('customer', 'completed', healthyAgents[2]),
  api.domainResult('policy', 'completed', healthyAgents[3]),
]
const legacy = api.buildInvestigation(legacyInput)
check('legacy keys exactly as expected', JSON.stringify(Object.keys(legacy).sort()) === JSON.stringify(['customer', 'customer_id', 'order', 'policy', 'ticket_history']))
check('legacy object carries no health/conflict fields', !('investigation_health' in legacy) && !('conflicts' in legacy) && !JSON.stringify(legacy).includes('EV-'))
check('health output is a separate structure', JSON.stringify(Object.keys(healthy).sort()) === JSON.stringify(['conflict_status', 'conflicts', 'missing_domains', 'requires_reinvestigation', 'uncertainties', 'uncertainty_status']))
check('health output has no decision fields', !('decision' in healthy) && !('action' in healthy) && !('resolution_status' in healthy))
const legacyAgain = api.buildInvestigation(legacyInput)
check('legacy object unaffected by the conflict engine', JSON.stringify(legacy) === JSON.stringify(legacyAgain))

console.log('')
console.log(passed + ' passed, ' + failed + ' failed')
process.exit(failed === 0 ? 0 : 1)
