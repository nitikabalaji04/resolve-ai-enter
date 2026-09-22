// Basic tests for the Phase 7 Decision Agent.
//
// Run:  node supabase/functions/support/decision-agent.test.mjs
//
// Extracts the marked pure-logic blocks from index.ts (single source of truth).
// The LLM call itself is I/O; everything validated here is the deterministic
// schema/safety layer plus the gate/LLM-failure plumbing.
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

const agentSource = block('// >>> DECISION AGENT PURE LOGIC', '// <<< DECISION AGENT PURE LOGIC')

const api = new Function(
  block('// >>> ORDER AGENT PURE LOGIC', '// <<< ORDER AGENT PURE LOGIC') +
  block('// >>> DELIVERY AGENT PURE LOGIC', '// <<< DELIVERY AGENT PURE LOGIC') +
  block('// >>> CUSTOMER AGENT PURE LOGIC', '// <<< CUSTOMER AGENT PURE LOGIC') +
  block('// >>> POLICY AGENT PURE LOGIC', '// <<< POLICY AGENT PURE LOGIC') +
  block('// >>> PLANNER PURE LOGIC', '// <<< PLANNER PURE LOGIC') +
  block('// >>> EVIDENCE ENGINE PURE LOGIC', '// <<< EVIDENCE ENGINE PURE LOGIC') +
  block('// >>> CONFLICT ENGINE PURE LOGIC', '// <<< CONFLICT ENGINE PURE LOGIC') +
  block('// >>> REINVESTIGATION PURE LOGIC', '// <<< REINVESTIGATION PURE LOGIC') +
  block('// >>> DECISION GATE PURE LOGIC', '// <<< DECISION GATE PURE LOGIC') +
  agentSource +
    '\nreturn { DECISION_AGENT_NAME, DECISION_AGENT_DECISIONS, DECISION_AGENT_ACTIONS, DECISION_ACTION_MAP, EVIDENCE_REQUIRED_DECISIONS, blockedDecisionAgentResult, decisionAgentLlmFailure, validateDecisionAgentOutput, buildDecisionAgentPrompt, buildEvidence, analyzeEvidence, evaluateDecisionGate, buildInvestigation, domainResult };',
)()

let passed = 0
let failed = 0
function check(name, condition, detail) {
  if (condition) { passed += 1; console.log('  ok   ' + name) }
  else { failed += 1; console.log('FAIL   ' + name + (detail ? ' -> ' + detail : '')) }
}

// --- fixtures ---------------------------------------------------------------
function finding(text, source) {
  return { finding: text, source: source || 'orders', confidence: 1.0 }
}
function domainResult(domain, findings, status, extra) {
  const state = status || 'completed'
  const data = { agent: domain + '_agent', domain, status: state, findings: findings || [] }
  if (extra) Object.assign(data, extra)
  return { domain, status: state, data }
}
function idsFor(evidence, domain) {
  return evidence.filter(function (e) { return e.domain === domain }).map(function (e) { return e.id })
}

const RESULTS = [
  domainResult('order', [finding('Order ID: 10532'), finding('Order status: delayed'), finding('Payment status: paid')], 'completed', { order: { order_id: '10532', refund_status: '' } }),
  domainResult('delivery', [finding('Delivery status: delayed'), finding('Shipping method: Express')], 'completed', { delivery: { status: 'delayed' } }),
  domainResult('customer', [finding('Customer name: Rahul Mehta', 'customers')], 'completed', { customer: { customer_id: 'CUST002' } }),
  domainResult('policy', [finding('Policy: Delayed Express Delivery Refund', 'policies'), finding('Condition: Order was shipped using Express delivery', 'policies')], 'completed', { policy: { policy_id: 1 } }),
]
const PLAN = ['order', 'delivery', 'customer', 'policy']

const evidenceRun = api.buildEvidence(RESULTS.map(function (r) { return r.data }))
const EVIDENCE = evidenceRun.evidence
const HEALTH = api.analyzeEvidence(EVIDENCE, evidenceRun.agent_status, PLAN)
const GATE_OK = api.evaluateDecisionGate({ plan: PLAN, agentResults: RESULTS, evidence: EVIDENCE, investigationHealth: HEALTH, reinvestigation: { performed: false, resolved: true } })
const GATE_BLOCK = { status: 'BLOCK', reason: 'AGENT_NOT_FOUND', reasons: [{ code: 'AGENT_NOT_FOUND' }] }

const ORDER_ID_EV = idsFor(EVIDENCE, 'order')[0]
const POLICY_ID_EV = idsFor(EVIDENCE, 'policy')[0]
const CUSTOMER_ID_EV = idsFor(EVIDENCE, 'customer')[0]
const NOT_REFUNDED = { order_id: '10532', refund_status: '' }
const ALREADY_REFUNDED = { order_id: '10482', refund_status: 'initiated' }

function validate(output, order) {
  return api.validateDecisionAgentOutput({
    output,
    evidence: EVIDENCE,
    plan: PLAN,
    order: order === undefined ? NOT_REFUNDED : order,
    gate: GATE_OK,
  })
}
function approveOutput(overrides) {
  const base = {
    decision: 'APPROVE',
    action: 'REFUND_SHIPPING_FEE',
    confidence: 0.94,
    reasoning: 'Express delivery delayed 3 days and the order is paid, so the policy applies.',
    evidence_ids: [ORDER_ID_EV, POLICY_ID_EV],
  }
  return Object.assign(base, overrides || {})
}

console.log('')
console.log('1. Valid APPROVE decision')
const approve = validate(approveOutput())
check('accepted', approve.valid === true, JSON.stringify(approve))
check('decision normalised', approve.decision === 'APPROVE')
check('action normalised', approve.action === 'REFUND_SHIPPING_FEE')
check('confidence preserved', approve.confidence === 0.94)
check('cited ids preserved', JSON.stringify(approve.evidence_ids) === JSON.stringify([ORDER_ID_EV, POLICY_ID_EV]))

console.log('')
console.log('2. Valid DENY decision')
const deny = validate({ decision: 'DENY', action: 'NO_ACTION', confidence: 0.8, reasoning: 'Standard delivery does not meet the policy.', evidence_ids: [POLICY_ID_EV] })
check('accepted', deny.valid === true, JSON.stringify(deny))
check('deny maps to NO_ACTION', deny.action === 'NO_ACTION')

console.log('')
console.log('3. Valid INFORM decision')
const inform = validate({ decision: 'INFORM', action: 'NO_ACTION', confidence: 0.9, reasoning: 'Customer asked for the order status.', evidence_ids: [ORDER_ID_EV] })
check('accepted', inform.valid === true, JSON.stringify(inform))

console.log('')
console.log('4. Valid ESCALATE decision')
const escalate = validate({ decision: 'ESCALATE', action: 'ESCALATE_TO_HUMAN', confidence: 0.7, reasoning: 'Evidence is insufficient to decide safely.', evidence_ids: [] })
check('accepted with no citations', escalate.valid === true, JSON.stringify(escalate))
check('escalation is not evidence-mandatory', api.EVIDENCE_REQUIRED_DECISIONS.includes('ESCALATE') === false)

console.log('')
console.log('5. Valid evidence IDs')
check('every cited id exists', approve.evidence_ids.every(function (id) { return EVIDENCE.some(function (e) { return e.id === id }) }))
check('ids are trimmed before matching', validate(approveOutput({ evidence_ids: ['  ' + ORDER_ID_EV + '  ', POLICY_ID_EV] })).valid === true)

console.log('')
console.log('6. Unknown evidence ID rejected')
const invented = validate(approveOutput({ evidence_ids: ['EV-999'] }))
check('rejected', invented.valid === false)
check('reason UNKNOWN_EVIDENCE_ID', invented.reason === 'UNKNOWN_EVIDENCE_ID')

console.log('')
console.log('7. Missing evidence IDs rejected')
const noIds = validate(approveOutput({ evidence_ids: [] }))
check('rejected', noIds.valid === false)
check('reason MISSING_EVIDENCE_IDS', noIds.reason === 'MISSING_EVIDENCE_IDS')
check('non-array ids rejected', validate(approveOutput({ evidence_ids: 'EV-001' })).reason === 'INVALID_EVIDENCE_IDS')
check('blank id rejected', validate(approveOutput({ evidence_ids: ['  '] })).reason === 'INVALID_EVIDENCE_IDS')

console.log('')
console.log('8. Invalid decision rejected')
check('unknown decision', validate(approveOutput({ decision: 'MAYBE' })).reason === 'INVALID_DECISION')
check('missing decision', validate(approveOutput({ decision: undefined })).reason === 'INVALID_DECISION')
check('numeric decision', validate(approveOutput({ decision: 7 })).reason === 'INVALID_DECISION')

console.log('')
console.log('9. Invalid action rejected')
check('unknown action', validate(approveOutput({ action: 'SEND_CASH' })).reason === 'INVALID_ACTION')
check('mismatched pairing', validate(approveOutput({ action: 'NO_ACTION' })).reason === 'INVALID_ACTION')
check('escalate with refund action', validate({ decision: 'ESCALATE', action: 'REFUND_SHIPPING_FEE', confidence: 0.5, reasoning: 'x', evidence_ids: [ORDER_ID_EV] }).reason === 'INVALID_ACTION')

console.log('')
console.log('10. Confidence below 0 rejected')
check('rejected', validate(approveOutput({ confidence: -0.1 })).reason === 'INVALID_CONFIDENCE')

console.log('')
console.log('11. Confidence above 1 rejected')
check('rejected', validate(approveOutput({ confidence: 1.2 })).reason === 'INVALID_CONFIDENCE')
check('non-numeric confidence', validate(approveOutput({ confidence: '0.9' })).reason === 'INVALID_CONFIDENCE')
check('NaN confidence', validate(approveOutput({ confidence: Number.NaN })).reason === 'INVALID_CONFIDENCE')
check('boundary values accepted', validate(approveOutput({ confidence: 0 })).valid === true && validate(approveOutput({ confidence: 1 })).valid === true)

console.log('')
console.log('12. Empty reasoning rejected')
check('blank reasoning', validate(approveOutput({ reasoning: '   ' })).reason === 'EMPTY_REASONING')
check('missing reasoning', validate(approveOutput({ reasoning: undefined })).reason === 'EMPTY_REASONING')

console.log('')
console.log('13. Malformed model output rejected')
check('null', validate(null).reason === 'INVALID_MODEL_OUTPUT')
check('string', validate('APPROVE').reason === 'INVALID_MODEL_OUTPUT')
check('array', validate([]).reason === 'INVALID_MODEL_OUTPUT')
check('undefined', validate(undefined).reason === 'INVALID_MODEL_OUTPUT')

console.log('')
console.log('14. LLM timeout handled safely')
const timeout = api.decisionAgentLlmFailure({ status: 'error', message: 'timeout' })
check('error -> failed', timeout.status === 'failed')
check('reason LLM_UNAVAILABLE', timeout.reason === 'LLM_UNAVAILABLE')
check('not_configured -> failed', api.decisionAgentLlmFailure({ status: 'not_configured' }).reason === 'LLM_UNAVAILABLE')
check('success -> no failure', api.decisionAgentLlmFailure({ status: 'success', response: {} }) === null)
check('malformed failure input is safe', api.decisionAgentLlmFailure(undefined).status === 'failed')

console.log('')
console.log('15. Decision Gate BLOCK prevents an automated decision')
const blocked = api.blockedDecisionAgentResult(GATE_BLOCK)
check('blocked result shape', blocked.status === 'blocked' && blocked.reason === 'DECISION_GATE_BLOCKED')
check('no business decision invented', !('decision' in blocked) && !('action' in blocked))
check('PROCEED is not blocked', api.blockedDecisionAgentResult(GATE_OK) === null)
check('validator also refuses when the gate blocks', api.validateDecisionAgentOutput({ output: approveOutput(), evidence: EVIDENCE, plan: PLAN, order: NOT_REFUNDED, gate: GATE_BLOCK }).reason === 'DECISION_GATE_BLOCKED')

console.log('')
console.log('16. Decision Agent does not execute actions')
check('no database writes', !/\.update\(|\.insert\(|\.delete\(/.test(agentSource))
check('no supabase client', !/supabase/.test(agentSource))
check('no action execution', !/executeAction|persistCaseRecord|verifyAction/.test(agentSource))
check('no direct fetch', !/fetch\(/.test(agentSource))
check('no refund_status write', !/refund_status\s*:/.test(agentSource))

console.log('')
console.log('17. Already-refunded order cannot receive another refund')
const alreadyRefunded = validate(approveOutput(), ALREADY_REFUNDED)
check('rejected', alreadyRefunded.valid === false)
check('reason ACTION_ALREADY_COMPLETED', alreadyRefunded.reason === 'ACTION_ALREADY_COMPLETED')
check('non-refund decisions still allowed', validate({ decision: 'INFORM', action: 'NO_ACTION', confidence: 0.9, reasoning: 'status', evidence_ids: [ORDER_ID_EV] }, ALREADY_REFUNDED).valid === true)
check('escalation still allowed', validate({ decision: 'ESCALATE', action: 'ESCALATE_TO_HUMAN', confidence: 0.6, reasoning: 'already refunded', evidence_ids: [] }, ALREADY_REFUNDED).valid === true)

console.log('')
console.log('18. Refund requires policy evidence when policy is planned')
const policyEvidenceFree = EVIDENCE.filter(function (e) { return e.domain !== 'policy' })
const noPolicyEvidence = api.validateDecisionAgentOutput({ output: approveOutput({ evidence_ids: [ORDER_ID_EV] }), evidence: policyEvidenceFree, plan: PLAN, order: NOT_REFUNDED, gate: GATE_OK })
check('rejected when no policy evidence exists', noPolicyEvidence.reason === 'POLICY_EVIDENCE_REQUIRED')
check('a cited id missing from the evidence set fails earlier', api.validateDecisionAgentOutput({ output: approveOutput(), evidence: policyEvidenceFree, plan: PLAN, order: NOT_REFUNDED, gate: GATE_OK }).reason === 'UNKNOWN_EVIDENCE_ID')
const notCitingPolicy = validate(approveOutput({ evidence_ids: [ORDER_ID_EV] }))
check('rejected when policy is not cited', notCitingPolicy.reason === 'POLICY_EVIDENCE_REQUIRED')
const policyNotPlanned = api.validateDecisionAgentOutput({ output: approveOutput(), evidence: EVIDENCE, plan: ['order', 'customer'], order: NOT_REFUNDED, gate: GATE_OK })
check('policy requirement only applies when planned', policyNotPlanned.valid === true, JSON.stringify(policyNotPlanned))

console.log('')
console.log('19. Approve without required evidence rejected')
check('no citations', validate(approveOutput({ evidence_ids: [] })).reason === 'MISSING_EVIDENCE_IDS')
check('only customer evidence cited', validate(approveOutput({ evidence_ids: [CUSTOMER_ID_EV] })).reason === 'POLICY_EVIDENCE_REQUIRED')

console.log('')
console.log('20. Unsupported action rejected')
check('replacement action rejected', validate(approveOutput({ action: 'REPLACE_PRODUCT' })).reason === 'INVALID_ACTION')
check('lowercase is normalised, not rejected', validate(approveOutput({ decision: 'approve', action: 'refund_shipping_fee' })).valid === true)
check('allowed vocabularies are exactly as documented', api.DECISION_AGENT_DECISIONS.join(',') === 'APPROVE,DENY,INFORM,ESCALATE' && api.DECISION_AGENT_ACTIONS.join(',') === 'REFUND_SHIPPING_FEE,NO_ACTION,ESCALATE_TO_HUMAN')

console.log('')
console.log('21. Deterministic validation')
const runA = validate(approveOutput())
const runB = validate(approveOutput())
check('same input -> identical output', JSON.stringify(runA) === JSON.stringify(runB))
const badA = validate(approveOutput({ evidence_ids: ['EV-999'] }))
const badB = validate(approveOutput({ evidence_ids: ['EV-999'] }))
check('same failure -> identical reason', JSON.stringify(badA) === JSON.stringify(badB))
check('no random identifiers', !/[0-9a-f]{8}-[0-9a-f]{4}/i.test(JSON.stringify(runA)))

console.log('')
console.log('22. Validator does not mutate its input')
const outputCopy = JSON.parse(JSON.stringify(approveOutput()))
const evidenceCopy = JSON.parse(JSON.stringify(EVIDENCE))
const planCopy = PLAN.slice()
const orderCopy = JSON.parse(JSON.stringify(NOT_REFUNDED))
const input = { output: approveOutput(), evidence: EVIDENCE, plan: PLAN, order: NOT_REFUNDED, gate: GATE_OK }
api.validateDecisionAgentOutput(input)
check('output unchanged', JSON.stringify(input.output) === JSON.stringify(outputCopy))
check('evidence unchanged', JSON.stringify(EVIDENCE) === JSON.stringify(evidenceCopy))
check('plan unchanged', JSON.stringify(PLAN) === JSON.stringify(planCopy))
check('order unchanged', JSON.stringify(NOT_REFUNDED) === JSON.stringify(orderCopy))

console.log('')
console.log('23. No invented evidence')
const mixed = validate(approveOutput({ evidence_ids: [ORDER_ID_EV, POLICY_ID_EV, 'EV-777'] }))
check('one invented id fails the whole decision', mixed.valid === false && mixed.reason === 'UNKNOWN_EVIDENCE_ID')
check('accepted ids are always a subset of real evidence', approve.evidence_ids.every(function (id) { return EVIDENCE.some(function (e) { return e.id === id }) }))
check('evidence ids come from the Evidence Engine format', EVIDENCE.every(function (e) { return /^EV-\d{3}$/.test(e.id) }))

console.log('')
console.log('24. Prompt contains evidence-grounding instructions')
const prompt = api.buildDecisionAgentPrompt({ message: 'I want a refund for order 10532.', evidence: EVIDENCE, health: HEALTH, gate: GATE_OK, plan: PLAN })
check('includes the customer message', prompt.includes('I want a refund for order 10532.'))
check('includes real evidence ids', prompt.includes(ORDER_ID_EV) && prompt.includes(POLICY_ID_EV))
check('includes the evidence lines', prompt.includes('Order ID: 10532'))
check('lists allowed decisions', ['APPROVE', 'DENY', 'INFORM', 'ESCALATE'].every(function (d) { return prompt.includes(d) }))
check('lists allowed actions', ['REFUND_SHIPPING_FEE', 'NO_ACTION', 'ESCALATE_TO_HUMAN'].every(function (a) { return prompt.includes(a) }))
check('forbids inventing evidence', /never invent evidence ids/i.test(prompt))
check('forbids inventing facts', /never invent facts/i.test(prompt))
check('tells it to escalate when unsure', /insufficient.*ESCALATE/is.test(prompt))
check('requires JSON only', /return ONLY valid JSON/i.test(prompt))
check('states it does not act', /never perform actions/i.test(prompt))
check('includes the investigation health', prompt.includes('conflict=none') && prompt.includes('uncertainty=none'))
check('includes the gate status', prompt.includes('DECISION GATE: PROCEED'))
check('exposes no secrets', !/token|secret|api[_-]?key/i.test(prompt))

console.log('')
console.log('25. Existing reasoning remains available')
check('reasoning prompt still present in the function', source.includes('You are ResolveAI, an autonomous customer support reasoning agent'))
check('buildQwenPrompt still defined', /function buildQwenPrompt\(/.test(source))
check('decision agent prompt is a separate builder', /function buildDecisionAgentPrompt\(/.test(source) && !/buildDecisionAgentPrompt[\s\S]{0,200}You are ResolveAI, an autonomous customer support reasoning agent/.test(source))
check('existing decision validation untouched', /function validateQwenDecision\(/.test(source))

console.log('')
console.log('26. Existing legacy investigation remains unchanged')
const legacy = api.buildInvestigation(RESULTS)
check('legacy keys exactly as expected', JSON.stringify(Object.keys(legacy).sort()) === JSON.stringify(['customer', 'customer_id', 'order', 'policy', 'ticket_history']))
check('legacy order is the raw record', Boolean(legacy.order) && legacy.order.order_id === '10532')
check('legacy carries no decision-agent metadata', !('decision_agent' in legacy) && !JSON.stringify(legacy).includes('decision_agent'))

console.log('')
console.log(passed + ' passed, ' + failed + ' failed')
process.exit(failed === 0 ? 0 : 1)
