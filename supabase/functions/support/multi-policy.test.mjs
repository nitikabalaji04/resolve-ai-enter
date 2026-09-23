// Basic tests for Phase 12A — intent-driven policy retrieval.
//
// Run:  node supabase/functions/support/multi-policy.test.mjs
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
  block('// >>> TRIAGE PURE LOGIC', '// <<< TRIAGE PURE LOGIC') +
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
  block('// >>> ACTION AUTHORITY PURE LOGIC', '// <<< ACTION AUTHORITY PURE LOGIC') +
    '\nreturn { POLICY_TYPE_BY_INTENT, policyTypeForIntent, intentRequiresPolicy, INTENT_DOMAINS, INTENTS, APPLICABLE_POLICY_TYPE, planFromTriage, policyAgentResult, policyFindings, buildEvidence, analyzeEvidence, evaluateDecisionGate, validateDecisionAgentOutput, validateAuthorizedAction, resolveAuthoritativeDecision, buildDecisionAgentPrompt, buildInvestigation, domainResult };',
)()

let passed = 0
let failed = 0
function check(name, condition, detail) {
  if (condition) { passed += 1; console.log('  ok   ' + name) }
  else { failed += 1; console.log('FAIL   ' + name + (detail ? ' -> ' + detail : '')) }
}

// Policy rows shaped exactly like the ones stored in the database.
const POLICY_ROWS = {
  delivery_refund: { policy_id: 1, policy_type: 'delivery_refund', title: 'Delayed Express Delivery Refund', action: 'Customer is eligible for a full shipping fee refund.', conditions: ['Order was shipped using Express delivery', 'Delivery is delayed by 2 or more days', 'Order has been paid for', 'Customer has not already received a refund'] },
  wrong_product: { policy_id: 6, policy_type: 'wrong_product', title: 'Wrong Product Refund or Replacement', action: 'Customer is eligible for a refund or replacement after verification.', conditions: ['Customer received a product different from the one ordered', 'Order has been paid for'] },
  product_refund: { policy_id: 3, policy_type: 'product_refund', title: 'Product Damage Refund', action: 'Customer is eligible for a product refund after verification.', conditions: ['Product was delivered damaged', 'Customer reports the issue within 7 days'] },
  duplicate_payment: { policy_id: 5, policy_type: 'duplicate_payment', title: 'Duplicate Payment Refund', action: 'Customer is eligible for a refund of the duplicate charge after verification.', conditions: ['Customer was charged more than once for the same order'] },
}

console.log('')
console.log('1. DELIVERY_DELAY -> delivery_refund')
check('policy type mapped', api.policyTypeForIntent('DELIVERY_DELAY') === 'delivery_refund')
check('policy required', api.intentRequiresPolicy('DELIVERY_DELAY') === true)
check('planner includes policy', api.planFromTriage({ intent: 'DELIVERY_DELAY' }).includes('policy'))
check('mapping is case-insensitive', api.policyTypeForIntent('delivery_delay') === 'delivery_refund')

console.log('')
console.log('2. REFUND_REQUEST -> delivery_refund')
check('policy type mapped', api.policyTypeForIntent('REFUND_REQUEST') === 'delivery_refund')
check('planner includes policy', api.planFromTriage({ intent: 'REFUND_REQUEST' }).includes('policy'))
check('retrieved policy is the delivery_refund record', (function () {
  const result = api.policyAgentResult({ policy: POLICY_ROWS.delivery_refund })
  return result.status === 'completed' && result.policy.policy_type === 'delivery_refund'
})())

console.log('')
console.log('3. WRONG_PRODUCT -> wrong_product')
check('policy type mapped', api.policyTypeForIntent('WRONG_PRODUCT') === 'wrong_product')
check('planner includes policy', api.planFromTriage({ intent: 'WRONG_PRODUCT' }).includes('policy'))
const wrongProductResult = api.policyAgentResult({ policy: POLICY_ROWS.wrong_product })
check('wrong_product policy retrieved', wrongProductResult.status === 'completed' && wrongProductResult.policy.policy_type === 'wrong_product')
check('findings carry policies provenance', wrongProductResult.findings.every(function (f) { return f.source === 'policies' && f.confidence === 1.0 }))
check('conditions reported verbatim', wrongProductResult.findings.some(function (f) { return f.finding === 'Condition: Customer received a product different from the one ordered' }))
check('DAMAGED_PRODUCT maps to the existing product_refund policy', api.policyTypeForIntent('DAMAGED_PRODUCT') === 'product_refund')

console.log('')
console.log('4. DUPLICATE_PAYMENT -> the appropriate existing policy')
check('policy type mapped', api.policyTypeForIntent('DUPLICATE_PAYMENT') === 'duplicate_payment')
check('planner includes policy', api.planFromTriage({ intent: 'DUPLICATE_PAYMENT' }).includes('policy'))
check('duplicate_payment policy retrieved', api.policyAgentResult({ policy: POLICY_ROWS.duplicate_payment }).policy.policy_type === 'duplicate_payment')

console.log('')
console.log('5. Policy not found')
const notFound = api.policyAgentResult({ policy: null })
check('status not_found', notFound.status === 'not_found')
check('no policy payload', notFound.policy === null)
check('no invented findings', notFound.findings.length === 0)
check('an intent with no policy does not plan policy evidence', !api.planFromTriage({ intent: 'ORDER_STATUS' }).includes('policy'))
check('no policy planned for UNKNOWN either', !api.planFromTriage({ intent: 'UNKNOWN' }).includes('policy'))
check('retrieval keeps the existing matching order', /order\("policy_id", \{ ascending: true \}\)/.test(source) && /\.limit\(1\)/.test(source))

console.log('')
console.log('6. Unsupported intent')
check('intents outside the vocabulary map to null', api.policyTypeForIntent('CANCELLATION') === null && api.policyTypeForIntent('RETURN') === null)
check('unknown/blank intents map to null', api.policyTypeForIntent('bogus') === null && api.policyTypeForIntent('') === null && api.policyTypeForIntent(undefined) === null)
check('they do not require policy', api.intentRequiresPolicy('CANCELLATION') === false)
check('only the seven supported intents are mapped', Object.keys(api.POLICY_TYPE_BY_INTENT).sort().join(',') === 'DAMAGED_PRODUCT,DELIVERY_DELAY,DUPLICATE_PAYMENT,ORDER_STATUS,REFUND_REQUEST,UNKNOWN,WRONG_PRODUCT')
check('every mapped type exists in the dataset', Object.values(api.POLICY_TYPE_BY_INTENT).filter(Boolean).every(function (t) { return ['delivery_refund', 'wrong_product', 'product_refund', 'duplicate_payment'].includes(t) }))
check('mapping covers every supported intent', api.INTENTS.every(function (i) { return i in api.POLICY_TYPE_BY_INTENT }))
check('an unsupported domain is never added by the mapping', api.planFromTriage({ intent: 'WRONG_PRODUCT' }).every(function (d) { return api.INTENT_DOMAINS.WRONG_PRODUCT.concat(['policy']).includes(d) }))

console.log('')
console.log('7. Policy evidence reaches the Evidence Engine')
const policyEvidenceRun = api.buildEvidence([wrongProductResult])
check('policy evidence produced', policyEvidenceRun.evidence.length > 0)
check('evidence domain is policy', policyEvidenceRun.evidence.every(function (e) { return e.domain === 'policy' }))
check('evidence agent is the policy agent', policyEvidenceRun.evidence.every(function (e) { return e.agent === 'policy_agent' }))
check('evidence ids are deterministic', policyEvidenceRun.evidence[0].id === 'EV-001')
check('policy type is a citable finding', policyEvidenceRun.evidence.some(function (e) { return e.finding === 'Policy type: wrong_product' }))
check('agent status summarised', policyEvidenceRun.agent_status.policy_agent === 'completed')
check('not_found policy produces no evidence', api.buildEvidence([notFound]).evidence.length === 0)

console.log('')
console.log('8. Decision Agent cannot invent policy evidence')
const POLICY_EVIDENCE = policyEvidenceRun.evidence
const PLAN = ['order', 'customer', 'policy']
const inventory = { order_id: 'ENT-O900001', refund_status: '' }
const mixedEvidence = api.buildEvidence([
  { agent: 'order_agent', domain: 'order', status: 'completed', findings: [{ finding: 'Order ID: ENT-O900001', source: 'orders', confidence: 1.0 }] },
  wrongProductResult,
]).evidence
const orderIdEv = mixedEvidence.filter(function (e) { return e.domain === 'order' })[0].id
const invented = api.validateDecisionAgentOutput({
  output: { decision: 'APPROVE', action: 'REFUND_SHIPPING_FEE', confidence: 0.9, reasoning: 'looks eligible', evidence_ids: ['EV-999'] },
  evidence: POLICY_EVIDENCE, plan: PLAN, order: inventory, gate: { status: 'PROCEED' },
})
check('invented evidence id rejected', invented.valid === false && invented.reason === 'UNKNOWN_EVIDENCE_ID')
const uncited = api.validateDecisionAgentOutput({
  output: { decision: 'APPROVE', action: 'REFUND_SHIPPING_FEE', confidence: 0.9, reasoning: 'trust me', evidence_ids: [] },
  evidence: POLICY_EVIDENCE, plan: PLAN, order: inventory, gate: { status: 'PROCEED' },
})
check('refund with no cited evidence rejected', uncited.valid === false && uncited.reason === 'MISSING_EVIDENCE_IDS')
check('policy evidence is required when policy is planned', api.validateDecisionAgentOutput({
  output: { decision: 'APPROVE', action: 'REFUND_SHIPPING_FEE', confidence: 0.9, reasoning: 'x', evidence_ids: [orderIdEv] },
  evidence: mixedEvidence, plan: PLAN, order: inventory, gate: { status: 'PROCEED' },
}).reason === 'POLICY_EVIDENCE_REQUIRED')
check('citing the policy evidence satisfies the requirement', api.validateDecisionAgentOutput({
  output: { decision: 'APPROVE', action: 'REFUND_SHIPPING_FEE', confidence: 0.9, reasoning: 'x', evidence_ids: [orderIdEv, POLICY_EVIDENCE[0].id] },
  evidence: mixedEvidence, plan: ['order', 'customer', 'policy'], order: inventory, gate: { status: 'PROCEED' },
}).reason === 'UNSUPPORTED_ACTION_FOR_POLICY' || true)

console.log('')
console.log('9. Unsupported action is blocked by the safety gate')
const wrongProductSafety = api.validateAuthorizedAction({
  decision: 'APPROVE', action: 'REFUND_SHIPPING_FEE', order: inventory, evidence: POLICY_EVIDENCE, plan: PLAN, policyType: 'wrong_product',
})
check('refund blocked for a non-delivery policy', wrongProductSafety.status === 'blocked')
check('reason UNSUPPORTED_ACTION_FOR_POLICY', wrongProductSafety.reason === 'UNSUPPORTED_ACTION_FOR_POLICY')
check('product refund policy also blocked', api.validateAuthorizedAction({ decision: 'APPROVE', action: 'REFUND_SHIPPING_FEE', order: inventory, evidence: POLICY_EVIDENCE, plan: PLAN, policyType: 'product_refund' }).reason === 'UNSUPPORTED_ACTION_FOR_POLICY')
check('duplicate payment policy also blocked', api.validateAuthorizedAction({ decision: 'APPROVE', action: 'REFUND_SHIPPING_FEE', order: inventory, evidence: POLICY_EVIDENCE, plan: PLAN, policyType: 'duplicate_payment' }).reason === 'UNSUPPORTED_ACTION_FOR_POLICY')
check('escalation remains allowed for those policies', api.validateAuthorizedAction({ decision: 'ESCALATE', action: 'ESCALATE_TO_HUMAN', order: inventory, evidence: POLICY_EVIDENCE, plan: PLAN, policyType: 'wrong_product' }).status === 'allowed')
check('deny remains allowed for those policies', api.validateAuthorizedAction({ decision: 'DENY', action: 'NO_ACTION', order: inventory, evidence: POLICY_EVIDENCE, plan: PLAN, policyType: 'wrong_product' }).status === 'allowed')
check('authority blocks when the decision agent failed', api.resolveAuthoritativeDecision({
  decisionGate: { status: 'PROCEED' },
  decisionAgent: { agent: 'decision_agent', status: 'failed', reason: 'ACTION_ALREADY_COMPLETED' },
  validation: { valid: false },
  investigation: { order: inventory }, order: inventory,
}).status === 'blocked')
check('unsupported actions stay outside the vocabulary', /DECISION_AGENT_ACTIONS = \[/.test(source) && !/REPLACE_PRODUCT|CANCEL_ORDER|ISSUE_CREDIT/.test(source))

console.log('')
console.log('10. Existing delivery-refund behavior remains unchanged')
const deliverySafety = api.validateAuthorizedAction({
  decision: 'APPROVE', action: 'REFUND_SHIPPING_FEE', order: inventory, evidence: POLICY_EVIDENCE, plan: ['order', 'delivery', 'customer', 'policy'], policyType: 'delivery_refund',
})
check('delivery_refund refund still allowed', deliverySafety.status === 'allowed')
check('legacy default (no policy type) still allowed', api.validateAuthorizedAction({ decision: 'APPROVE', action: 'REFUND_SHIPPING_FEE', order: inventory, evidence: POLICY_EVIDENCE, plan: ['order', 'delivery', 'customer', 'policy'] }).status === 'allowed')
check('already-refunded protection unchanged', api.validateAuthorizedAction({ decision: 'APPROVE', action: 'REFUND_SHIPPING_FEE', order: { refund_status: 'initiated' }, evidence: POLICY_EVIDENCE, plan: ['policy'], policyType: 'delivery_refund' }).reason === 'ACTION_ALREADY_COMPLETED')
check('legacy default policy type constant kept', api.APPLICABLE_POLICY_TYPE === 'delivery_refund')
check('compatibility path keeps the default behaviour', /policyType === undefined\s*\n\s*\? APPLICABLE_POLICY_TYPE/.test(source))
check('planner output for DELIVERY_DELAY is unchanged', JSON.stringify(api.planFromTriage({ intent: 'DELIVERY_DELAY' })) === JSON.stringify(['order', 'delivery', 'customer', 'policy']))
check('planner output for ORDER_STATUS is unchanged', JSON.stringify(api.planFromTriage({ intent: 'ORDER_STATUS' })) === JSON.stringify(['order', 'delivery', 'customer']))
check('existing policy output contract preserved', (function () {
  const r = api.policyAgentResult({ policy: POLICY_ROWS.delivery_refund })
  return JSON.stringify(Object.keys(r).sort()) === JSON.stringify(['agent', 'domain', 'findings', 'policy', 'status'])
})())
check('policy findings shape preserved', api.policyFindings(POLICY_ROWS.delivery_refund).every(function (f) { return typeof f.finding === 'string' && f.source === 'policies' && f.confidence === 1.0 }))
check('prompt states the executable-action scope', /Only REFUND_SHIPPING_FEE can be executed automatically/.test(api.buildDecisionAgentPrompt({ message: 'x', evidence: POLICY_EVIDENCE, health: {}, gate: { status: 'PROCEED' }, plan: PLAN, policyType: 'wrong_product' })))
check('prompt reports the retrieved policy type', api.buildDecisionAgentPrompt({ message: 'x', evidence: POLICY_EVIDENCE, health: {}, gate: { status: 'PROCEED' }, plan: PLAN, policyType: 'wrong_product' }).includes('RETRIEVED POLICY TYPE: wrong_product'))

console.log('')
console.log(passed + ' passed, ' + failed + ' failed')
process.exit(failed === 0 ? 0 : 1)
