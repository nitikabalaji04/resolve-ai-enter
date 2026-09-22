// Basic tests for the Phase 3 Evidence Engine.
//
// Run:  node supabase/functions/support/evidence-engine.test.mjs
//
// Extracts the marked pure-logic blocks from index.ts (single source of truth).
// The evidence engine reads the agents' own name constants, so their blocks are
// extracted too; the planner block provides buildInvestigation().
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
    '\nreturn { SUPPORTED_AGENTS, evidenceId, evidenceFromAgentResult, evidenceKey, buildEvidence, buildInvestigation, domainResult, ORDER_AGENT_NAME, DELIVERY_AGENT_NAME, CUSTOMER_AGENT_NAME, POLICY_AGENT_NAME };',
)()

let passed = 0
let failed = 0
function check(name, condition, detail) {
  if (condition) { passed += 1; console.log('  ok   ' + name) }
  else { failed += 1; console.log('FAIL   ' + name + (detail ? ' -> ' + detail : '')) }
}

const EVIDENCE_KEYS = ['agent', 'confidence', 'domain', 'finding', 'id', 'source']

function evidenceShapeOk(list) {
  return list.every(function (e) {
    return JSON.stringify(Object.keys(e).sort()) === JSON.stringify(EVIDENCE_KEYS)
  })
}

// --- realistic agent results -------------------------------------------------
const orderAgent = {
  agent: 'order_agent', domain: 'order', status: 'completed',
  order: { order_id: '10486' },
  findings: [
    { finding: 'Order ID: 10486', source: 'orders', confidence: 1.0 },
    { finding: 'Product: Noise-Cancelling Earbuds', source: 'orders', confidence: 1.0 },
  ],
}
const deliveryAgent = {
  agent: 'delivery_agent', domain: 'delivery', status: 'completed',
  delivery: { status: 'delayed' },
  findings: [
    { finding: 'Delivery status: delayed', source: 'orders', confidence: 1.0 },
    { finding: 'Recorded delivery delay: 4 day(s)', source: 'orders', confidence: 1.0 },
  ],
}
const customerAgent = {
  agent: 'customer_agent', domain: 'customer', status: 'completed',
  customer: { customer_id: 'CUST004' }, support_history: [],
  findings: [
    { finding: 'Customer name: Aarav Kapoor', source: 'customers', confidence: 1.0 },
    { finding: 'Support history contains 2 ticket(s)', source: 'tickets', confidence: 1.0 },
  ],
}
const policyAgent = {
  agent: 'policy_agent', domain: 'policy', status: 'completed',
  policy: { policy_id: 1 },
  findings: [
    { finding: 'Policy: Delayed Express Delivery Refund', source: 'policies', confidence: 1.0 },
    { finding: 'Condition: Order was shipped using Express delivery', source: 'policies', confidence: 1.0 },
  ],
}

console.log('')
console.log('1. All four agents completed')
const all = api.buildEvidence([orderAgent, deliveryAgent, customerAgent, policyAgent])
check('8 evidence items collected', all.evidence.length === 8, String(all.evidence.length))
check('evidence shape is exact', evidenceShapeOk(all.evidence))
check('all four agents represented', new Set(all.evidence.map(function (e) { return e.agent })).size === 4)
check('agent status has four entries', Object.keys(all.agent_status).length === 4)

console.log('')
console.log('2. Customer-only evidence')
const custOnly = api.buildEvidence([customerAgent])
check('only customer evidence', custOnly.evidence.every(function (e) { return e.agent === 'customer_agent' }))
check('two items', custOnly.evidence.length === 2)
check('customers + tickets provenance kept', custOnly.evidence[0].source === 'customers' && custOnly.evidence[1].source === 'tickets')
check('no other agent status', Object.keys(custOnly.agent_status).join(',') === 'customer_agent')

console.log('')
console.log('3. Order-only evidence')
const orderOnly = api.buildEvidence([orderAgent])
check('only order evidence', orderOnly.evidence.every(function (e) { return e.agent === 'order_agent' && e.domain === 'order' }))
check('two items', orderOnly.evidence.length === 2)

console.log('')
console.log('4. Delivery-only evidence')
const delOnly = api.buildEvidence([deliveryAgent])
check('only delivery evidence', delOnly.evidence.every(function (e) { return e.agent === 'delivery_agent' && e.domain === 'delivery' }))
check('delivery provenance is orders', delOnly.evidence.every(function (e) { return e.source === 'orders' }))
check('two items', delOnly.evidence.length === 2)

console.log('')
console.log('5. Policy-only evidence')
const polOnly = api.buildEvidence([policyAgent])
check('only policy evidence', polOnly.evidence.every(function (e) { return e.agent === 'policy_agent' && e.source === 'policies' }))
check('two items', polOnly.evidence.length === 2)

console.log('')
console.log('6. Multiple agents combined (planner ordering preserved)')
const combined = api.buildEvidence([orderAgent, policyAgent])
check('agents appear in planner order', combined.evidence[0].agent === 'order_agent' && combined.evidence[2].agent === 'policy_agent')
check('4 items', combined.evidence.length === 4)

console.log('')
console.log('7. Failed agent')
const failedAgent = { agent: 'policy_agent', domain: 'policy', status: 'failed', policy: null, findings: [] }
const withFailed = api.buildEvidence([orderAgent, failedAgent])
check('failed agent produces no evidence', withFailed.evidence.every(function (e) { return e.agent !== 'policy_agent' }))
check('failed status is recorded', withFailed.agent_status.policy_agent === 'failed')
check('completed agent still contributes', withFailed.evidence.length === 2)

console.log('')
console.log('8. Not-found agent')
const notFoundAgent = { agent: 'delivery_agent', domain: 'delivery', status: 'not_found', delivery: null, findings: [] }
const withNotFound = api.buildEvidence([orderAgent, notFoundAgent])
check('not_found agent produces no evidence', withNotFound.evidence.every(function (e) { return e.agent !== 'delivery_agent' }))
check('not_found status is recorded', withNotFound.agent_status.delivery_agent === 'not_found')
check('no fabricated evidence', withNotFound.evidence.length === 2)

console.log('')
console.log('9. Missing agent')
const missing = api.buildEvidence([orderAgent])
check('absent agent has no status entry', !('customer_agent' in missing.agent_status) && !('policy_agent' in missing.agent_status))
check('status never invented', Object.keys(missing.agent_status).join(',') === 'order_agent')

console.log('')
console.log('10. Malformed agent result')
const malformed = api.buildEvidence([
  null, undefined, 'nope', 42, ['order_agent'],
  { agent: 'unknown_agent', domain: 'x', status: 'completed', findings: [{ finding: 'x', source: 'y', confidence: 1 }] },
  { agent: 'order_agent', status: 'completed', findings: [{ finding: 'x', source: 'y', confidence: 1 }] },
  { agent: 'order_agent', domain: 'order', status: 'completed', findings: 'nope' },
  { agent: 'order_agent', domain: 'order', status: 'completed', findings: [null, 'x', { finding: '', source: 'orders', confidence: 1 }, { finding: 'ok', source: '', confidence: 1 }, { finding: 'ok', source: 'orders', confidence: '1' }, { finding: 'ok', source: 'orders' }] },
])
check('malformed input produces no evidence', malformed.evidence.length === 0)
check('unsupported agent gets no status', !('unknown_agent' in malformed.agent_status))
check('malformed supported agent still records status', malformed.agent_status.order_agent === 'completed')
check('non-array input is safe', api.buildEvidence('nope').evidence.length === 0 && api.buildEvidence(null).evidence.length === 0)

console.log('')
console.log('11. Empty findings')
const emptyFindings = { agent: 'customer_agent', domain: 'customer', status: 'completed', customer: {}, support_history: [], findings: [] }
const withEmpty = api.buildEvidence([emptyFindings])
check('empty findings produce no evidence', withEmpty.evidence.length === 0)
check('status still summarised', withEmpty.agent_status.customer_agent === 'completed')

console.log('')
console.log('12. Duplicate evidence')
const dup = api.buildEvidence([orderAgent, orderAgent])
check('exact duplicates are collapsed', dup.evidence.length === 2, String(dup.evidence.length))
check('first occurrence kept', dup.evidence[0].id === 'EV-001' && dup.evidence[1].id === 'EV-002')
const dupWithinAgent = api.buildEvidence([{ agent: 'order_agent', domain: 'order', status: 'completed', findings: [orderAgent.findings[0], orderAgent.findings[0]] }])
check('duplicates within one agent are collapsed', dupWithinAgent.evidence.length === 1)

console.log('')
console.log('13. Different findings with the same source')
const sameSource = api.buildEvidence([orderAgent])
check('both order findings kept', sameSource.evidence.length === 2)
check('same source not merged', sameSource.evidence.every(function (e) { return e.source === 'orders' }) && sameSource.evidence[0].finding !== sameSource.evidence[1].finding)

console.log('')
console.log('14. Same finding with different sources')
const shared = { agent: 'order_agent', domain: 'order', status: 'completed', findings: [
  { finding: 'Order ID: 10486', source: 'orders', confidence: 1.0 },
  { finding: 'Order ID: 10486', source: 'tickets', confidence: 1.0 },
] }
const sharedResult = api.buildEvidence([shared])
check('different sources are not merged', sharedResult.evidence.length === 2)
check('sources preserved distinctly', sharedResult.evidence[0].source === 'orders' && sharedResult.evidence[1].source === 'tickets')

console.log('')
console.log('15. Confidence preservation')
const confidences = api.buildEvidence([{ agent: 'order_agent', domain: 'order', status: 'completed', findings: [
  { finding: 'a', source: 'orders', confidence: 1.0 },
  { finding: 'b', source: 'orders', confidence: 0.42 },
  { finding: 'c', source: 'orders', confidence: 0 },
] }])
check('confidence values preserved exactly', confidences.evidence.map(function (e) { return e.confidence }).join(',') === '1,0.42,0')
check('zero confidence kept (not filtered)', confidences.evidence.length === 3)

console.log('')
console.log('16. Source preservation')
check('customers/tickets preserved', custOnly.evidence.map(function (e) { return e.source }).join(',') === 'customers,tickets')
check('policies preserved', polOnly.evidence.every(function (e) { return e.source === 'policies' }))
check('orders preserved', delOnly.evidence.every(function (e) { return e.source === 'orders' }))

console.log('')
console.log('17. Finding text preservation')
const oddText = 'Condition: Order was shipped using Express delivery — 100% intact, "quoted" & spaced  '
const oddResult = api.buildEvidence([{ agent: 'policy_agent', domain: 'policy', status: 'completed', findings: [{ finding: oddText, source: 'policies', confidence: 1.0 }] }])
check('finding text is byte-identical', oddResult.evidence[0].finding === oddText)
check('text is not trimmed or rewritten', oddResult.evidence[0].finding.length === oddText.length)

console.log('')
console.log('18. Deterministic evidence IDs')
check('ids are sequential EV-001..', all.evidence.map(function (e) { return e.id }).join(',') === 'EV-001,EV-002,EV-003,EV-004,EV-005,EV-006,EV-007,EV-008')
check('no UUIDs used', all.evidence.every(function (e) { return /^EV-\d{3}$/.test(e.id) }))
check('id helper pads correctly', api.evidenceId(0) === 'EV-001' && api.evidenceId(9) === 'EV-010' && api.evidenceId(99) === 'EV-100')

console.log('')
console.log('19. Deterministic ordering')
const runA = api.buildEvidence([orderAgent, deliveryAgent, customerAgent, policyAgent])
const runB = api.buildEvidence([orderAgent, deliveryAgent, customerAgent, policyAgent])
check('same input -> identical output', JSON.stringify(runA) === JSON.stringify(runB))
check('input order drives evidence order', runA.evidence[0].agent === 'order_agent' && runA.evidence[7].agent === 'policy_agent')
const reversed = api.buildEvidence([policyAgent, orderAgent])
check('different input order -> different (but deterministic) output', reversed.evidence[0].agent === 'policy_agent')
const inputCopy = JSON.parse(JSON.stringify([orderAgent, deliveryAgent, customerAgent, policyAgent]))
api.buildEvidence([orderAgent, deliveryAgent, customerAgent, policyAgent])
check('input is never mutated', JSON.stringify([orderAgent, deliveryAgent, customerAgent, policyAgent]) === JSON.stringify(inputCopy))

console.log('')
console.log('20. Agent status summary')
check('summary shape', JSON.stringify(Object.keys(all.agent_status).sort()) === JSON.stringify(['customer_agent', 'delivery_agent', 'order_agent', 'policy_agent']))
check('statuses preserved as reported', all.agent_status.customer_agent === 'completed' && all.agent_status.order_agent === 'completed')
check('supported agent list is the four agents', api.SUPPORTED_AGENTS.slice().sort().join(',') === 'customer_agent,delivery_agent,order_agent,policy_agent')
check('agent names come from the agents themselves', api.SUPPORTED_AGENTS.includes(api.ORDER_AGENT_NAME) && api.SUPPORTED_AGENTS.includes(api.POLICY_AGENT_NAME))

console.log('')
console.log('21. Legacy investigation remains unchanged')
const legacyInput = [
  api.domainResult('order', 'completed', orderAgent),
  api.domainResult('delivery', 'completed', deliveryAgent),
  api.domainResult('customer', 'completed', customerAgent),
  api.domainResult('policy', 'completed', policyAgent),
]
const legacy = api.buildInvestigation(legacyInput)
check('legacy keys exactly as expected', JSON.stringify(Object.keys(legacy).sort()) === JSON.stringify(['customer', 'customer_id', 'order', 'policy', 'ticket_history']))
check('legacy object carries no evidence fields', !JSON.stringify(legacy).includes('EV-') && !('evidence' in legacy) && !('agent_status' in legacy))
const legacyAgain = api.buildInvestigation(legacyInput)
check('legacy object unaffected by building evidence', JSON.stringify(legacy) === JSON.stringify(legacyAgain))
const before = JSON.stringify(legacyInput)
api.buildEvidence(legacyInput.map(function (r) { return r.data }))
check('evidence engine does not mutate planner results', JSON.stringify(legacyInput) === before)

console.log('')
console.log('22. Existing reasoning behavior remains unchanged')
check('reasoning input is still the legacy 5-key object', Object.keys(legacy).length === 5)
check('order/customer/policy still raw records', legacy.order.order_id === '10486' && legacy.policy.policy_id === 1 && legacy.customer.customer_id === 'CUST004')
check('evidence is a separate structure', Array.isArray(all.evidence) && all.evidence !== legacy)
check('evidence engine returns only evidence + agent_status', JSON.stringify(Object.keys(all).sort()) === JSON.stringify(['agent_status', 'evidence']))
check('engine output has no decision fields', !('decision' in all) && !('eligibility' in all) && !('status' in all))
check('evidence items carry no decision/status fields', all.evidence.every(function (e) { return !('decision' in e) && !('eligible' in e) && !('status' in e) }))
check('agent_status holds only agent -> status pairs', Object.keys(all.agent_status).every(function (a) { return api.SUPPORTED_AGENTS.includes(a) }) && Object.values(all.agent_status).every(function (v) { return typeof v === 'string' }))

console.log('')
console.log(passed + ' passed, ' + failed + ' failed')
process.exit(failed === 0 ? 0 : 1)
