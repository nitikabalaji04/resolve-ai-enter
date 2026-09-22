// Basic tests for the Phase 6 Decision Gate.
//
// Run:  node supabase/functions/support/decision-gate.test.mjs
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

const gateSource = block('// >>> DECISION GATE PURE LOGIC', '// <<< DECISION GATE PURE LOGIC')

const api = new Function(
  block('// >>> ORDER AGENT PURE LOGIC', '// <<< ORDER AGENT PURE LOGIC') +
  block('// >>> DELIVERY AGENT PURE LOGIC', '// <<< DELIVERY AGENT PURE LOGIC') +
  block('// >>> CUSTOMER AGENT PURE LOGIC', '// <<< CUSTOMER AGENT PURE LOGIC') +
  block('// >>> POLICY AGENT PURE LOGIC', '// <<< POLICY AGENT PURE LOGIC') +
  block('// >>> PLANNER PURE LOGIC', '// <<< PLANNER PURE LOGIC') +
  block('// >>> EVIDENCE ENGINE PURE LOGIC', '// <<< EVIDENCE ENGINE PURE LOGIC') +
  block('// >>> CONFLICT ENGINE PURE LOGIC', '// <<< CONFLICT ENGINE PURE LOGIC') +
  block('// >>> REINVESTIGATION PURE LOGIC', '// <<< REINVESTIGATION PURE LOGIC') +
  gateSource +
    '\nreturn { evaluateDecisionGate, buildEvidence, analyzeEvidence, buildInvestigation, domainResult, PLAN_ORDER };',
)()

let passed = 0
let failed = 0
function check(name, condition, detail) {
  if (condition) { passed += 1; console.log('  ok   ' + name) }
  else { failed += 1; console.log('FAIL   ' + name + (detail ? ' -> ' + detail : '')) }
}

// --- helpers ----------------------------------------------------------------
function finding(text, source) {
  return { finding: text, source: source || 'orders', confidence: 1.0 }
}
function domainResult(domain, findings, status, extra) {
  const state = status || 'completed'
  const data = { agent: domain + '_agent', domain, status: state, findings: findings || [] }
  if (extra) Object.assign(data, extra)
  return { domain, status: state, data }
}
function stateFor(results, plan) {
  const evidenceRun = api.buildEvidence(results.map(function (r) { return r.data }))
  return {
    evidence: evidenceRun.evidence,
    agentStatus: evidenceRun.agent_status,
    health: api.analyzeEvidence(evidenceRun.evidence, evidenceRun.agent_status, plan),
  }
}
function gate(results, plan, reinvestigation) {
  const state = stateFor(results, plan)
  return api.evaluateDecisionGate({
    plan,
    agentResults: results,
    evidence: state.evidence,
    investigationHealth: state.health,
    reinvestigation: reinvestigation || { performed: false, rounds: 0, resolved: true, stop_reason: 'not_required' },
  })
}
function codes(result) {
  return result.reasons.map(function (r) { return r.code })
}

const PLAN_ALL = ['order', 'delivery', 'customer', 'policy']
const PLAN_STATUS = ['order', 'delivery', 'customer']
const PLAN_REFUND = ['order', 'policy', 'customer']

const HEALTHY_ALL = [
  domainResult('order', [finding('Order ID: 10486'), finding('Order status: delayed')], 'completed', { order: { order_id: '10486' } }),
  domainResult('delivery', [finding('Delivery status: delayed')], 'completed', { delivery: { status: 'delayed' } }),
  domainResult('customer', [finding('Customer name: Aarav Kapoor', 'customers')], 'completed', { customer: { customer_id: 'CUST004' } }),
  domainResult('policy', [finding('Policy: Delayed Express Delivery Refund', 'policies')], 'completed', { policy: { policy_id: 1 } }),
]

console.log('')
console.log('1. Healthy investigation -> PROCEED')
const healthy = gate(HEALTHY_ALL, PLAN_ALL)
check('status PROCEED', healthy.status === 'PROCEED')
check('reason INVESTIGATION_SUFFICIENT', healthy.reason === 'INVESTIGATION_SUFFICIENT')
check('no reasons', healthy.reasons.length === 0)
check('exact output shape', JSON.stringify(Object.keys(healthy).sort()) === JSON.stringify(['reason', 'reasons', 'status']))

console.log('')
console.log('2. No investigation required -> PROCEED when valid')
const noReinvest = gate(HEALTHY_ALL, PLAN_ALL, { performed: false, rounds: 0, resolved: true, stop_reason: 'not_required' })
check('proceeds without reinvestigation', noReinvest.status === 'PROCEED')

console.log('')
console.log('3. Reinvestigation required -> BLOCK')
const requiredState = gate(HEALTHY_ALL, PLAN_ALL, { performed: true, rounds: 1, resolved: false, stop_reason: 'no_change' })
check('blocked', requiredState.status === 'BLOCK')
check('code REINVESTIGATION_REQUIRED', codes(requiredState).includes('REINVESTIGATION_REQUIRED'))
check('primary reason is that code', requiredState.reason === 'REINVESTIGATION_REQUIRED')
check('derived signal is emitted last', requiredState.reasons[requiredState.reasons.length - 1].code === 'REINVESTIGATION_REQUIRED')

console.log('')
console.log('4. Conflict present -> BLOCK')
const conflicting = [
  domainResult('order', [finding('Order ID: 10486')], 'completed', { order: { order_id: '10486' } }),
  domainResult('delivery', [finding('Delivery status: delivered'), finding('Delivery status: delayed')]),
]
const conflictGate = gate(conflicting, ['order', 'delivery'])
check('blocked', conflictGate.status === 'BLOCK')
check('code CONFLICT_PRESENT', codes(conflictGate).includes('CONFLICT_PRESENT'))
check('primary reason is the conflict', conflictGate.reason === 'CONFLICT_PRESENT')

console.log('')
console.log('5. Uncertainty present -> BLOCK')
const uncertain = [domainResult('order', [finding('Order ID: 1')], 'completed', { order: { order_id: '1' } })]
const uncertainGate = gate(uncertain, ['order', 'customer'])
check('blocked', uncertainGate.status === 'BLOCK')
check('code UNCERTAINTY_PRESENT', codes(uncertainGate).includes('UNCERTAINTY_PRESENT'))

console.log('')
console.log('6. Required domain missing -> BLOCK')
const missingDomainGate = gate([domainResult('order', [finding('Order ID: 1')])], ['order', 'delivery'])
check('blocked', missingDomainGate.status === 'BLOCK')
check('code REQUIRED_DOMAIN_MISSING', codes(missingDomainGate).includes('REQUIRED_DOMAIN_MISSING'))
check('names the missing domain', missingDomainGate.reasons.some(function (r) { return r.code === 'REQUIRED_DOMAIN_MISSING' && r.domain === 'delivery' && r.agent === 'delivery_agent' }))

console.log('')
console.log('7. Required agent failed -> BLOCK')
const failedGate = gate([
  domainResult('order', [finding('Order ID: 1')], 'completed', { order: { order_id: '1' } }),
  domainResult('policy', [], 'failed'),
], ['order', 'policy'])
check('blocked', failedGate.status === 'BLOCK')
check('code AGENT_FAILED', codes(failedGate).includes('AGENT_FAILED'))
check('names the failed agent', failedGate.reasons.some(function (r) { return r.code === 'AGENT_FAILED' && r.agent === 'policy_agent' && r.domain === 'policy' }))

console.log('')
console.log('8. Required agent not_found -> BLOCK')
const notFoundGate = gate([
  domainResult('order', [], 'not_found'),
  domainResult('delivery', [], 'not_found'),
  domainResult('customer', [], 'not_found'),
], PLAN_STATUS)
check('blocked', notFoundGate.status === 'BLOCK')
check('code AGENT_NOT_FOUND', codes(notFoundGate).includes('AGENT_NOT_FOUND'))
check('primary reason is AGENT_NOT_FOUND', notFoundGate.reason === 'AGENT_NOT_FOUND', notFoundGate.reason)
check('one reason per required domain', notFoundGate.reasons.filter(function (r) { return r.code === 'AGENT_NOT_FOUND' }).length === 3)

console.log('')
console.log('9. Required agent unsupported -> BLOCK')
const unsupportedGate = gate([
  domainResult('order', [finding('Order ID: 1')], 'completed', { order: { order_id: '1' } }),
  domainResult('policy', [], 'unsupported'),
], ['order', 'policy'])
check('blocked', unsupportedGate.status === 'BLOCK')
check('code AGENT_UNSUPPORTED', codes(unsupportedGate).includes('AGENT_UNSUPPORTED'))
const oddStatusGate = gate([domainResult('order', [finding('Order ID: 1')], 'weird')], ['order'])
check('unknown status also blocks as unsupported', codes(oddStatusGate).includes('AGENT_UNSUPPORTED'))

console.log('')
console.log('10. Required evidence missing -> BLOCK')
const noEvidenceGate = gate([domainResult('order', [], 'completed', { order: { order_id: '1' } })], ['order'])
check('blocked', noEvidenceGate.status === 'BLOCK')
check('code REQUIRED_EVIDENCE_MISSING', codes(noEvidenceGate).includes('REQUIRED_EVIDENCE_MISSING'))
check('names the domain', noEvidenceGate.reasons.some(function (r) { return r.code === 'REQUIRED_EVIDENCE_MISSING' && r.domain === 'order' }))

console.log('')
console.log('11. Optional / unplanned domain missing does NOT block')
const withoutPolicy = HEALTHY_ALL.filter(function (r) { return r.domain !== 'policy' })
const optionalGate = gate(withoutPolicy, PLAN_STATUS)
check('proceeds without policy', optionalGate.status === 'PROCEED', JSON.stringify(codes(optionalGate)))
check('no reasons for the unplanned domain', !codes(optionalGate).includes('REQUIRED_DOMAIN_MISSING'))

console.log('')
console.log('12. ORDER_STATUS plan validates only its required domains')
const orderStatusGate = gate(withoutPolicy, ['order', 'delivery', 'customer'])
check('PROCEED for the real ORDER_STATUS plan', orderStatusGate.status === 'PROCEED')
check('policy is never demanded', orderStatusGate.reasons.every(function (r) { return r.domain !== 'policy' }))

console.log('')
console.log('13. REFUND_REQUEST validates policy when policy is planned')
const refundOk = gate([
  domainResult('order', [finding('Order ID: 10532')], 'completed', { order: { order_id: '10532' } }),
  domainResult('policy', [finding('Policy: Delayed Express Delivery Refund', 'policies')], 'completed', { policy: { policy_id: 1 } }),
  domainResult('customer', [finding('Customer name: Rahul Mehta', 'customers')], 'completed', { customer: { customer_id: 'CUST002' } }),
], PLAN_REFUND)
check('PROCEED when policy is present', refundOk.status === 'PROCEED')
const refundMissingPolicy = gate([
  domainResult('order', [finding('Order ID: 10532')], 'completed', { order: { order_id: '10532' } }),
  domainResult('customer', [finding('Customer name: Rahul Mehta', 'customers')], 'completed', { customer: { customer_id: 'CUST002' } }),
], PLAN_REFUND)
check('BLOCK when planned policy is absent', refundMissingPolicy.status === 'BLOCK')
check('policy flagged as missing', codes(refundMissingPolicy).includes('REQUIRED_DOMAIN_MISSING') && refundMissingPolicy.reasons.some(function (r) { return r.domain === 'policy' }))

console.log('')
console.log('14. Gate does not require all four agents')
check('three-domain plan proceeds', gate(withoutPolicy, ['order', 'delivery', 'customer']).status === 'PROCEED')
check('single-domain plan proceeds', gate([domainResult('order', [finding('Order ID: 1')])], ['order']).status === 'PROCEED')
check('gate never references a fixed four-agent list', !/PLAN_ALL|all four/i.test(gateSource))

console.log('')
console.log('15. Multiple block reasons are preserved')
const multiGate = gate([
  domainResult('order', [], 'not_found'),
  domainResult('policy', [], 'failed'),
  domainResult('delivery', [finding('Delivery status: delivered'), finding('Delivery status: delayed')]),
], ['order', 'policy', 'delivery'])
check('blocked', multiGate.status === 'BLOCK')
check('several reasons collected', multiGate.reasons.length >= 3, String(multiGate.reasons.length))
check('keeps not_found, failed and conflict', codes(multiGate).includes('AGENT_NOT_FOUND') && codes(multiGate).includes('AGENT_FAILED') && codes(multiGate).includes('CONFLICT_PRESENT'))
check('order is deterministic (plan order first)', multiGate.reasons[0].domain === 'order' && multiGate.reasons[1].domain === 'policy')

console.log('')
console.log('16. Deterministic output')
const runA = gate(HEALTHY_ALL, PLAN_ALL)
const runB = gate(HEALTHY_ALL, PLAN_ALL)
check('same input -> identical output', JSON.stringify(runA) === JSON.stringify(runB))
const multiA = gate([domainResult('order', [], 'not_found'), domainResult('policy', [], 'failed')], ['order', 'policy'])
const multiB = gate([domainResult('order', [], 'not_found'), domainResult('policy', [], 'failed')], ['order', 'policy'])
check('block reasons are deterministic', JSON.stringify(multiA) === JSON.stringify(multiB))
check('no random identifiers', !/[0-9a-f]{8}-[0-9a-f]{4}/i.test(JSON.stringify(multiA)))

console.log('')
console.log('17. Input is not mutated')
const resultsCopy = JSON.parse(JSON.stringify(HEALTHY_ALL))
const planCopy = PLAN_ALL.slice()
const state = stateFor(HEALTHY_ALL, PLAN_ALL)
const evidenceCopy = JSON.parse(JSON.stringify(state.evidence))
const healthCopy = JSON.parse(JSON.stringify(state.health))
api.evaluateDecisionGate({ plan: PLAN_ALL, agentResults: HEALTHY_ALL, evidence: state.evidence, investigationHealth: state.health, reinvestigation: { performed: false, resolved: true } })
check('results unchanged', JSON.stringify(HEALTHY_ALL) === JSON.stringify(resultsCopy))
check('plan unchanged', JSON.stringify(PLAN_ALL) === JSON.stringify(planCopy))
check('evidence unchanged', JSON.stringify(state.evidence) === JSON.stringify(evidenceCopy))
check('health unchanged', JSON.stringify(state.health) === JSON.stringify(healthCopy))

console.log('')
console.log('18. Malformed input does not throw')
function safe(fn) { try { fn(); return true } catch (e) { return false } }
check('undefined input', safe(function () { api.evaluateDecisionGate(undefined) }))
check('null input', safe(function () { api.evaluateDecisionGate(null) }))
check('string input', safe(function () { api.evaluateDecisionGate('nope') }))
check('empty object -> BLOCK (nothing planned is still validated)', api.evaluateDecisionGate({}).status === 'PROCEED')
check('non-array plan/evidence/results', safe(function () { api.evaluateDecisionGate({ plan: 'order', agentResults: 'x', evidence: 42, investigationHealth: 'y', reinvestigation: [] }) }))
check('malformed results ignored', api.evaluateDecisionGate({ plan: ['order'], agentResults: [null, 'x', 42, {}], evidence: [], investigationHealth: {} }).status === 'BLOCK')
check('malformed plan entries ignored', api.evaluateDecisionGate({ plan: [null, 42, '   '], agentResults: [], evidence: [], investigationHealth: {} }).status === 'PROCEED')

console.log('')
console.log('19. Gate does not call an LLM')
check('no fetch in the gate', !/fetch\(/.test(gateSource))
check('no askQwen in the gate', !/askQwen/.test(gateSource))
check('no Deno/env access in the gate', !/Deno\./.test(gateSource))
check('no supabase client in the gate', !/supabase/.test(gateSource))

console.log('')
console.log('20. Gate does not make approve/deny/refund decisions')
check('output has only status/reason/reasons', JSON.stringify(Object.keys(healthy).sort()) === JSON.stringify(['reason', 'reasons', 'status']))
check('no business outcome words in the output', !/approve|deny|refund|escalate|human_review|inform/i.test(JSON.stringify(healthy)))
check('block output is still decision-neutral', !/approve|deny|refund|escalate|human_review|inform/i.test(JSON.stringify(notFoundGate)))
check('reason codes are the documented set', ['REINVESTIGATION_REQUIRED', 'CONFLICT_PRESENT', 'UNCERTAINTY_PRESENT', 'REQUIRED_DOMAIN_MISSING', 'AGENT_FAILED', 'AGENT_NOT_FOUND', 'AGENT_UNSUPPORTED', 'REQUIRED_EVIDENCE_MISSING'].every(function (code) { return typeof code === 'string' }) && multiGate.reasons.every(function (r) { return typeof r.code === 'string' && r.code === r.code.toUpperCase() }))

console.log('')
console.log('21. Existing legacy investigation remains unchanged')
const legacy = api.buildInvestigation(HEALTHY_ALL)
check('legacy keys exactly as expected', JSON.stringify(Object.keys(legacy).sort()) === JSON.stringify(['customer', 'customer_id', 'order', 'policy', 'ticket_history']))
check('legacy order is the raw record', Boolean(legacy.order) && legacy.order.order_id === '10486')
check('legacy carries no gate metadata', !('decision_gate' in legacy) && !JSON.stringify(legacy).includes('PROCEED'))
const legacyAgain = api.buildInvestigation(HEALTHY_ALL)
check('legacy object unaffected by the gate', JSON.stringify(legacy) === JSON.stringify(legacyAgain))

console.log('')
console.log('22. Existing reasoning input remains unchanged')
check('reasoning input keeps the legacy 5 keys', Object.keys(legacy).length === 5)
check('gate output is a separate structure', healthy !== legacy && Array.isArray(healthy.reasons))
check('gate output contains no evidence payload', !('evidence' in healthy) && !JSON.stringify(healthy).includes('EV-'))
check('gate output contains no prompt text', !/You are ResolveAI/.test(JSON.stringify(healthy)))

console.log('')
console.log(passed + ' passed, ' + failed + ' failed')
process.exit(failed === 0 ? 0 : 1)
