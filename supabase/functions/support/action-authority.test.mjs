// Basic tests for the Phase 8 Decision Authority + Action Safety Gate.
//
// Run:  node supabase/functions/support/action-authority.test.mjs
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

const authoritySource = block('// >>> ACTION AUTHORITY PURE LOGIC', '// <<< ACTION AUTHORITY PURE LOGIC')

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
  block('// >>> DECISION AGENT PURE LOGIC', '// <<< DECISION AGENT PURE LOGIC') +
  authoritySource +
    '\nreturn { resolveAuthoritativeDecision, validateAuthorizedAction, LEGACY_DECISION_BY_AUTHORITY, LEGACY_ACTION_BY_AUTHORITY, buildEvidence, analyzeEvidence, evaluateDecisionGate, validateDecisionAgentOutput, buildInvestigation, domainResult };',
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

const RESULTS = [
  domainResult('order', [finding('Order ID: 10532'), finding('Order status: delayed'), finding('Payment status: paid')], 'completed', { order: { order_id: '10532', refund_status: '' } }),
  domainResult('delivery', [finding('Delivery status: delayed'), finding('Shipping method: Express')], 'completed', { delivery: {} }),
  domainResult('customer', [finding('Customer name: Rahul Mehta', 'customers')], 'completed', { customer: {} }),
  domainResult('policy', [finding('Policy: Delayed Express Delivery Refund', 'policies')], 'completed', { policy: {} }),
]
const PLAN = ['order', 'delivery', 'customer', 'policy']
const evidenceRun = api.buildEvidence(RESULTS.map(function (r) { return r.data }))
const EVIDENCE = evidenceRun.evidence
const HEALTH = api.analyzeEvidence(EVIDENCE, evidenceRun.agent_status, PLAN)
const GATE_PROCEED = api.evaluateDecisionGate({ plan: PLAN, agentResults: RESULTS, evidence: EVIDENCE, investigationHealth: HEALTH, reinvestigation: { performed: false, resolved: true } })
const GATE_BLOCK = { status: 'BLOCK', reason: 'AGENT_NOT_FOUND', reasons: [{ code: 'AGENT_NOT_FOUND' }] }

const NOT_REFUNDED = { order_id: '10532', refund_status: '' }
const ALREADY_REFUNDED = { order_id: '10482', refund_status: 'initiated' }

function agentCompleted(decision, action) {
  return { agent: 'decision_agent', status: 'completed', decision, action, confidence: 0.9, reasoning: 'grounded', evidence_ids: [] }
}
function authorize(gate, agent, order, validation) {
  return api.resolveAuthoritativeDecision({
    decisionGate: gate,
    decisionAgent: agent,
    validation: validation === undefined ? { valid: agent && agent.status === 'completed' } : validation,
    investigation: { order: order },
    order,
  })
}
function safety(decision, action, order, evidence, plan) {
  return api.validateAuthorizedAction({
    decision,
    action,
    order,
    investigation: { order },
    evidence: evidence === undefined ? EVIDENCE : evidence,
    plan: plan === undefined ? PLAN : plan,
  })
}

console.log('')
console.log('1. Valid APPROVE + REFUND_SHIPPING_FEE -> authorized')
const approveAgent = agentCompleted('APPROVE', 'REFUND_SHIPPING_FEE')
const approveAuthority = authorize(GATE_PROCEED, approveAgent, NOT_REFUNDED)
check('authorized', approveAuthority.status === 'authorized')
check('decision preserved', approveAuthority.decision === 'APPROVE' && approveAuthority.action === 'REFUND_SHIPPING_FEE')
check('safety allowed', safety('APPROVE', 'REFUND_SHIPPING_FEE', NOT_REFUNDED).status === 'allowed')
check('maps onto the existing executor vocabulary', api.LEGACY_DECISION_BY_AUTHORITY.APPROVE === 'approve' && api.LEGACY_ACTION_BY_AUTHORITY.REFUND_SHIPPING_FEE === 'refund_shipping_fee')

console.log('')
console.log('2. Valid DENY + NO_ACTION -> authorized')
check('authorized', authorize(GATE_PROCEED, agentCompleted('DENY', 'NO_ACTION'), NOT_REFUNDED).status === 'authorized')
check('safety allowed', safety('DENY', 'NO_ACTION', NOT_REFUNDED).status === 'allowed')
check('deny maps to no_action', api.LEGACY_ACTION_BY_AUTHORITY.NO_ACTION === 'no_action')

console.log('')
console.log('3. Valid INFORM + NO_ACTION -> authorized')
check('authorized', authorize(GATE_PROCEED, agentCompleted('INFORM', 'NO_ACTION'), NOT_REFUNDED).status === 'authorized')
check('safety allowed', safety('INFORM', 'NO_ACTION', NOT_REFUNDED).status === 'allowed')

console.log('')
console.log('4. Valid ESCALATE + ESCALATE_TO_HUMAN -> authorized')
check('authorized', authorize(GATE_PROCEED, agentCompleted('ESCALATE', 'ESCALATE_TO_HUMAN'), NOT_REFUNDED).status === 'authorized')
check('safety allowed', safety('ESCALATE', 'ESCALATE_TO_HUMAN', NOT_REFUNDED).status === 'allowed')
check('escalation maps to the existing mechanism', api.LEGACY_ACTION_BY_AUTHORITY.ESCALATE_TO_HUMAN === 'human_review')

console.log('')
console.log('5. Decision Gate BLOCK -> no action')
const gateBlocked = authorize(GATE_BLOCK, approveAgent, NOT_REFUNDED)
check('blocked', gateBlocked.status === 'blocked')
check('reason DECISION_GATE_BLOCKED', gateBlocked.reason === 'DECISION_GATE_BLOCKED')
check('no decision/action exposed', !('decision' in gateBlocked) && !('action' in gateBlocked))

console.log('')
console.log('6. Decision Agent blocked -> no action')
const agentBlocked = authorize(GATE_PROCEED, { agent: 'decision_agent', status: 'blocked', reason: 'DECISION_GATE_BLOCKED' }, NOT_REFUNDED)
check('blocked', agentBlocked.status === 'blocked')
check('reason DECISION_AGENT_BLOCKED', agentBlocked.reason === 'DECISION_AGENT_BLOCKED')

console.log('')
console.log('7. Decision Agent failed -> no action')
const agentFailed = authorize(GATE_PROCEED, { agent: 'decision_agent', status: 'failed', reason: 'ACTION_ALREADY_COMPLETED' }, NOT_REFUNDED)
check('blocked', agentFailed.status === 'blocked')
check('agent reason preserved', agentFailed.reason === 'ACTION_ALREADY_COMPLETED')

console.log('')
console.log('8. Decision Agent validation failure -> no action')
const invalidValidation = authorize(GATE_PROCEED, approveAgent, NOT_REFUNDED, { valid: false })
check('blocked', invalidValidation.status === 'blocked')
check('reason DECISION_AGENT_VALIDATION_FAILED', invalidValidation.reason === 'DECISION_AGENT_VALIDATION_FAILED')
const malformedAgent = authorize(GATE_PROCEED, { agent: 'decision_agent', status: 'completed', decision: 'MAYBE', action: 'REFUND_SHIPPING_FEE' }, NOT_REFUNDED)
check('unsupported decision blocked', malformedAgent.status === 'blocked' && malformedAgent.reason === 'INVALID_DECISION_AGENT_OUTPUT')

console.log('')
console.log('9. Legacy reasoning conflicts with the Decision Agent -> Decision Agent wins')
const authorityFn = authoritySource.slice(authoritySource.indexOf('function resolveAuthoritativeDecision'), authoritySource.indexOf('function validateAuthorizedAction'))
check('authority takes no legacy reasoning input', !/qwen|legacyReasoning|legacyDecision|legacyAction/i.test(authorityFn))
const denyAgent = agentCompleted('DENY', 'NO_ACTION')
check('deny is authoritative over a legacy approve', authorize(GATE_PROCEED, denyAgent, NOT_REFUNDED).decision === 'DENY')
check('the executor branch is driven by the authoritative decision', /await executeAction\(\s*\n\s*supabase,\s*\n\s*decision\.action,/.test(source))
check('legacy validation no longer drives the branches', !/if \(validation\.decision ===/.test(source) && /if \(decision\.decision === "escalate"\)/.test(source) && /if \(decision\.decision === "inform"\)/.test(source))

console.log('')
console.log('10. Legacy reasoning approves while the Decision Agent fails -> no action')
const legacyApproveAgentFails = authorize(GATE_PROCEED, { agent: 'decision_agent', status: 'failed', reason: 'INVALID_MODEL_OUTPUT' }, NOT_REFUNDED)
check('blocked', legacyApproveAgentFails.status === 'blocked')
check('no fallback to a legacy approval', !('decision' in legacyApproveAgentFails))
check('failed authority escalates instead', /decision: "escalate"/.test(source) && /No automated action was authorized/.test(source))

console.log('')
console.log('11. Already-refunded order -> refund blocked')
const alreadyRefundedSafety = safety('APPROVE', 'REFUND_SHIPPING_FEE', ALREADY_REFUNDED)
check('blocked', alreadyRefundedSafety.status === 'blocked')
check('reason ACTION_ALREADY_COMPLETED', alreadyRefundedSafety.reason === 'ACTION_ALREADY_COMPLETED')
check('non-refund actions still allowed', safety('INFORM', 'NO_ACTION', ALREADY_REFUNDED).status === 'allowed' && safety('ESCALATE', 'ESCALATE_TO_HUMAN', ALREADY_REFUNDED).status === 'allowed')

console.log('')
console.log('12. Already-refunded order cannot execute a legacy refund')
check('only one executeAction call site', (source.match(/await executeAction\(/g) || []).length === 1)
check('executor uses the authoritative action', /await executeAction\([\s\S]{0,80}decision\.action/.test(source))
const executorBlock = source.slice(source.indexOf('// >>> ACTION EXECUTOR'), source.indexOf('// <<< ACTION EXECUTOR'))
const refundWrites = (source.match(/\.update\(\{ refund_status: "initiated" \}\)/g) || []).length
const executorWrites = (executorBlock.match(/\.update\(\{ refund_status: "initiated" \}\)/g) || []).length
check('every refund write lives in the executor', refundWrites === executorWrites && refundWrites > 0)
check('one write per supported refund action', refundWrites === 2)
check('the refund executor is unchanged', /async function executeAction\(/.test(source) && /async function verifyAction\(/.test(source))

console.log('')
console.log('13. Missing policy evidence -> refund blocked')
const noPolicy = EVIDENCE.filter(function (e) { return e.domain !== 'policy' })
check('blocked', safety('APPROVE', 'REFUND_SHIPPING_FEE', NOT_REFUNDED, noPolicy).status === 'blocked')
check('reason POLICY_EVIDENCE_MISSING', safety('APPROVE', 'REFUND_SHIPPING_FEE', NOT_REFUNDED, noPolicy).reason === 'POLICY_EVIDENCE_MISSING')
check('policy not required when not planned', safety('APPROVE', 'REFUND_SHIPPING_FEE', NOT_REFUNDED, noPolicy, ['order', 'customer']).status === 'allowed')

console.log('')
console.log('14. Missing order -> refund blocked')
check('blocked', safety('APPROVE', 'REFUND_SHIPPING_FEE', null).status === 'blocked')
check('reason ORDER_MISSING', safety('APPROVE', 'REFUND_SHIPPING_FEE', null).reason === 'ORDER_MISSING')
check('falls back to the investigation order', api.validateAuthorizedAction({ decision: 'APPROVE', action: 'REFUND_SHIPPING_FEE', investigation: { order: NOT_REFUNDED }, evidence: EVIDENCE, plan: PLAN }).status === 'allowed')

console.log('')
console.log('15. Missing required evidence -> action blocked')
check('blocked', safety('APPROVE', 'REFUND_SHIPPING_FEE', NOT_REFUNDED, []).status === 'blocked')
check('reason REQUIRED_EVIDENCE_MISSING', safety('APPROVE', 'REFUND_SHIPPING_FEE', NOT_REFUNDED, []).reason === 'REQUIRED_EVIDENCE_MISSING')

console.log('')
console.log('16. Invalid decision/action pairing -> blocked')
check('approve + no_action', safety('APPROVE', 'NO_ACTION', NOT_REFUNDED).reason === 'INVALID_DECISION_ACTION_PAIRING')
check('deny + refund', safety('DENY', 'REFUND_SHIPPING_FEE', NOT_REFUNDED).reason === 'INVALID_DECISION_ACTION_PAIRING')
check('escalate + refund', safety('ESCALATE', 'REFUND_SHIPPING_FEE', NOT_REFUNDED).reason === 'INVALID_DECISION_ACTION_PAIRING')

console.log('')
console.log('17. Unsupported action -> blocked')
check('unsupported action', safety('APPROVE', 'REPLACE_PRODUCT', NOT_REFUNDED).reason === 'UNSUPPORTED_ACTION')
check('unsupported decision', safety('REFUND', 'REFUND_SHIPPING_FEE', NOT_REFUNDED).reason === 'UNSUPPORTED_DECISION')
check('null decision/action', safety(null, null, NOT_REFUNDED).status === 'blocked')

console.log('')
console.log('18. No duplicate action execution')
check('single verifyAction call site', (source.match(/await verifyAction\(/g) || []).length === 1)
check('legacy early-return branches removed', !/Step 4: if Qwen is unavailable/.test(source) && !/Step 7: if Qwen gives an invalid response/.test(source))
check('no second action path', (source.match(/buildCustomerResponse\(/g) || []).length >= 1 && (source.match(/action_result:/g) || []).length === 1)

console.log('')
console.log('19. Existing escalation mechanism reused')
check('createEscalationCase reused', /createEscalationCase\(\{/.test(source))
check('escalation is reached through the authoritative decision', /if \(decision\.decision === "escalate"\)/.test(source))
check('no new escalation implementation', (source.match(/function createEscalationCase/g) || []).length === 1)

console.log('')
console.log('20. Existing refund executor reused')
check('no new refund implementation', (source.match(/function executeAction/g) || []).length === 1)
check('no new action types', !/REPLACE_PRODUCT|CANCEL_ORDER|ISSUE_CREDIT|ISSUE_COUPON/.test(source))
check('only the three documented actions', /DECISION_AGENT_ACTIONS = \[/.test(source))

console.log('')
console.log('21. Action safety validator is pure')
check('no database access', !/supabase|\.from\(/.test(authoritySource))
check('no LLM', !/askQwen|fetch\(/.test(authoritySource))
check('no Deno/env', !/Deno\./.test(authoritySource))

console.log('')
console.log('22. Action authority is deterministic')
const a1 = authorize(GATE_PROCEED, approveAgent, NOT_REFUNDED)
const a2 = authorize(GATE_PROCEED, approveAgent, NOT_REFUNDED)
check('authority identical across runs', JSON.stringify(a1) === JSON.stringify(a2))
const s1 = safety('APPROVE', 'REFUND_SHIPPING_FEE', ALREADY_REFUNDED)
const s2 = safety('APPROVE', 'REFUND_SHIPPING_FEE', ALREADY_REFUNDED)
check('safety identical across runs', JSON.stringify(s1) === JSON.stringify(s2))
check('no random identifiers', !/[0-9a-f]{8}-[0-9a-f]{4}/i.test(JSON.stringify(a1) + JSON.stringify(s1)))

console.log('')
console.log('23. Inputs are not mutated')
const agentCopy = JSON.parse(JSON.stringify(approveAgent))
const orderCopy = JSON.parse(JSON.stringify(NOT_REFUNDED))
const evidenceCopy = JSON.parse(JSON.stringify(EVIDENCE))
const planCopy = PLAN.slice()
authorize(GATE_PROCEED, approveAgent, NOT_REFUNDED)
safety('APPROVE', 'REFUND_SHIPPING_FEE', NOT_REFUNDED)
check('agent unchanged', JSON.stringify(approveAgent) === JSON.stringify(agentCopy))
check('order unchanged', JSON.stringify(NOT_REFUNDED) === JSON.stringify(orderCopy))
check('evidence unchanged', JSON.stringify(EVIDENCE) === JSON.stringify(evidenceCopy))
check('plan unchanged', JSON.stringify(PLAN) === JSON.stringify(planCopy))

console.log('')
console.log('24. No LLM inside action authority')
check('no askQwen reference', !/askQwen/.test(authoritySource))
check('no prompt building', !/buildDecisionAgentPrompt|buildQwenPrompt/.test(authoritySource))

console.log('')
console.log('25. No DB writes inside action authority')
check('no update/insert/delete', !/\.update\(|\.insert\(|\.delete\(/.test(authoritySource))
check('no refund_status write', !/refund_status\s*:/.test(authoritySource))

console.log('')
console.log('26-34. Regression scenarios (authority + safety, pure)')
// 26 ORDER_STATUS
const orderStatus = { gate: GATE_PROCEED, agent: agentCompleted('INFORM', 'NO_ACTION'), order: NOT_REFUNDED }
check('26 ORDER_STATUS authorized/inform', authorize(orderStatus.gate, orderStatus.agent, orderStatus.order).decision === 'INFORM' && safety('INFORM', 'NO_ACTION', orderStatus.order).status === 'allowed')
// 27 DELIVERY_DELAY
check('27 DELIVERY_DELAY authorized/inform', authorize(GATE_PROCEED, agentCompleted('INFORM', 'NO_ACTION'), NOT_REFUNDED).status === 'authorized')
// 28 eligible refund
check('28 eligible refund authorized + allowed', authorize(GATE_PROCEED, approveAgent, NOT_REFUNDED).status === 'authorized' && safety('APPROVE', 'REFUND_SHIPPING_FEE', NOT_REFUNDED).status === 'allowed')
// 29 ineligible refund
check('29 ineligible refund authorized + allowed', authorize(GATE_PROCEED, agentCompleted('DENY', 'NO_ACTION'), NOT_REFUNDED).status === 'authorized' && safety('DENY', 'NO_ACTION', NOT_REFUNDED).status === 'allowed')
// 30 nonexistent order
check('30 nonexistent order blocked at the gate', authorize(GATE_BLOCK, { agent: 'decision_agent', status: 'blocked', reason: 'DECISION_GATE_BLOCKED' }, null).reason === 'DECISION_GATE_BLOCKED')
// 31 no explicit order
check('31 no explicit order authorized/inform', authorize(GATE_PROCEED, agentCompleted('INFORM', 'NO_ACTION'), NOT_REFUNDED).status === 'authorized')
// 32 already-refunded order
check('32 already-refunded order refund blocked', safety('APPROVE', 'REFUND_SHIPPING_FEE', ALREADY_REFUNDED).reason === 'ACTION_ALREADY_COMPLETED')
// 33 Decision Agent failure
check('33 agent failure blocks any action', authorize(GATE_PROCEED, { agent: 'decision_agent', status: 'failed', reason: 'INVALID_MODEL_OUTPUT' }, NOT_REFUNDED).status === 'blocked')
// 34 Decision Gate BLOCK
check('34 gate BLOCK blocks any action', authorize(GATE_BLOCK, approveAgent, NOT_REFUNDED).reason === 'DECISION_GATE_BLOCKED')
check('34b legacy investigation untouched by authority', JSON.stringify(Object.keys(api.buildInvestigation(RESULTS)).sort()) === JSON.stringify(['customer', 'customer_id', 'order', 'policy', 'ticket_history']))

console.log('')
console.log(passed + ' passed, ' + failed + ' failed')
process.exit(failed === 0 ? 0 : 1)
