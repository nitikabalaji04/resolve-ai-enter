// Tests for Phase 12B — enterprise business actions (product refund).
//
// Run:  node supabase/functions/support/enterprise-actions.test.mjs
//
// Extracts the marked blocks from index.ts. The action executor is TypeScript,
// so its two signatures are normalised to plain JS before evaluation (asserted).
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

const executorSource = block('// >>> ACTION EXECUTOR', '// <<< ACTION EXECUTOR')
  .replace(/supabase: SupabaseClient/g, 'supabase')
  .replace(/action: string/g, 'action')
  .replace(/investigation: Investigation/g, 'investigation')
  .replace(/\): Promise<JsonObject> \{/g, ') {')

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
  executorSource +
    '\nreturn { DECISION_AGENT_ACTIONS, DECISION_ACTION_MAP, ACTION_POLICY_SCOPE, DECISION_AGENT_NAME, validateAuthorizedAction, resolveAuthoritativeDecision, validateDecisionAgentOutput, buildDecisionAgentPrompt, buildEvidence, executeAction, verifyAction, LEGACY_ACTION_BY_AUTHORITY };',
)()

let passed = 0
let failed = 0
function check(name, condition, detail) {
  if (condition) { passed += 1; console.log('  ok   ' + name) }
  else { failed += 1; console.log('FAIL   ' + name + (detail ? ' -> ' + detail : '')) }
}

// --- mock database client (records writes, returns scripted reads) -----------
function mockDb(options) {
  const opts = options || {}
  const calls = { updates: [], selects: [] }
  return {
    calls,
    from(table) {
      return {
        update(payload) {
          return {
            eq(column, value) {
              calls.updates.push({ table, payload, column, value })
              return Promise.resolve({ error: opts.updateError || null })
            },
          }
        },
        select(columns) {
          return {
            eq(column, value) {
              calls.selects.push({ table, columns, column, value })
              return {
                maybeSingle: () => Promise.resolve({
                  data: opts.row === undefined ? { refund_status: 'initiated' } : opts.row,
                  error: opts.selectError || null,
                }),
              }
            },
          }
        },
      }
    },
  }
}

// --- fixtures ---------------------------------------------------------------
const PRODUCT_EVIDENCE = api.buildEvidence([
  { agent: 'order_agent', domain: 'order', status: 'completed', findings: [
    { finding: 'Order ID: ENT-O900003', source: 'orders', confidence: 1.0 },
    { finding: 'Payment status: paid', source: 'orders', confidence: 1.0 },
  ] },
  { agent: 'policy_agent', domain: 'policy', status: 'completed', findings: [
    { finding: 'Policy type: product_refund', source: 'policies', confidence: 1.0 },
    { finding: 'Condition: Product was delivered damaged', source: 'policies', confidence: 1.0 },
  ] },
]).evidence
const ORDER_EV = PRODUCT_EVIDENCE.filter(function (e) { return e.domain === 'order' })[0].id
const POLICY_EV = PRODUCT_EVIDENCE.filter(function (e) { return e.domain === 'policy' })[0].id
const PLAN = ['order', 'customer', 'policy']
const DAMAGED_ORDER = { order_id: 'ENT-O900003', refund_status: '', payment_status: 'paid', amount: 21999 }
const REFUNDED_ORDER = { order_id: 'ENT-O900001', refund_status: 'initiated' }

function safety(action, options) {
  const opts = options || {}
  return api.validateAuthorizedAction({
    decision: opts.decision === undefined ? 'APPROVE' : opts.decision,
    action,
    order: opts.order === undefined ? DAMAGED_ORDER : opts.order,
    evidence: opts.evidence === undefined ? PRODUCT_EVIDENCE : opts.evidence,
    plan: opts.plan === undefined ? PLAN : opts.plan,
    policyType: opts.policyType === undefined ? 'product_refund' : opts.policyType,
  })
}
function authority(agentStatus) {
  return api.resolveAuthoritativeDecision({
    decisionGate: { status: 'PROCEED' },
    decisionAgent: {
      agent: 'decision_agent',
      status: agentStatus,
      decision: agentStatus === 'completed' ? 'APPROVE' : undefined,
      action: agentStatus === 'completed' ? 'PRODUCT_REFUND' : undefined,
      reason: 'ACTION_ALREADY_COMPLETED',
    },
    validation: { valid: agentStatus === 'completed' },
    investigation: { order: DAMAGED_ORDER },
    order: DAMAGED_ORDER,
  })
}

console.log('')
console.log('Product refund — 1. valid evidence and policy')
const valid = safety('PRODUCT_REFUND')
check('allowed', valid.status === 'allowed')
check('policy scope covers product_refund and wrong_product', api.ACTION_POLICY_SCOPE.PRODUCT_REFUND.join(',') === 'product_refund,wrong_product')
check('wrong_product policy also allows a product refund', safety('PRODUCT_REFUND', { policyType: 'wrong_product' }).status === 'allowed')
check('action is part of the decision vocabulary', api.DECISION_AGENT_ACTIONS.includes('PRODUCT_REFUND'))
check('APPROVE can pair with a product refund', api.DECISION_ACTION_MAP.APPROVE.includes('PRODUCT_REFUND'))

console.log('')
console.log('Product refund — 2. missing evidence')
check('no evidence -> blocked', safety('PRODUCT_REFUND', { evidence: [] }).reason === 'REQUIRED_EVIDENCE_MISSING')
check('reason is deterministic', safety('PRODUCT_REFUND', { evidence: [] }).status === 'blocked')

console.log('')
console.log('Product refund — 3. missing policy evidence')
const orderOnly = PRODUCT_EVIDENCE.filter(function (e) { return e.domain !== 'policy' })
check('policy planned but absent -> blocked', safety('PRODUCT_REFUND', { evidence: orderOnly }).reason === 'POLICY_EVIDENCE_MISSING')
check('policy not planned -> not required', safety('PRODUCT_REFUND', { evidence: orderOnly, plan: ['order', 'customer'] }).status === 'allowed')

console.log('')
console.log('Product refund — 4. unsupported policy')
check('duplicate_payment policy -> blocked', safety('PRODUCT_REFUND', { policyType: 'duplicate_payment' }).reason === 'UNSUPPORTED_ACTION_FOR_POLICY')
check('delivery_refund policy -> blocked', safety('PRODUCT_REFUND', { policyType: 'delivery_refund' }).reason === 'UNSUPPORTED_ACTION_FOR_POLICY')
check('return policy -> blocked', safety('PRODUCT_REFUND', { policyType: 'return' }).reason === 'UNSUPPORTED_ACTION_FOR_POLICY')
check('shipping refund blocked for a product policy', safety('REFUND_SHIPPING_FEE', { policyType: 'product_refund' }).reason === 'UNSUPPORTED_ACTION_FOR_POLICY')

console.log('')
console.log('Product refund — 5. invalid decision/action pairing')
check('DENY + PRODUCT_REFUND rejected', safety('PRODUCT_REFUND', { decision: 'DENY' }).reason === 'INVALID_DECISION_ACTION_PAIRING')
check('ESCALATE + PRODUCT_REFUND rejected', safety('PRODUCT_REFUND', { decision: 'ESCALATE' }).reason === 'INVALID_DECISION_ACTION_PAIRING')
check('INFORM + PRODUCT_REFUND rejected', safety('PRODUCT_REFUND', { decision: 'INFORM' }).reason === 'INVALID_DECISION_ACTION_PAIRING')

console.log('')
console.log('Product refund — 6. already-completed action')
check('already refunded -> blocked', safety('PRODUCT_REFUND', { order: REFUNDED_ORDER }).reason === 'ACTION_ALREADY_COMPLETED')

console.log('')
console.log('Product refund — 7. duplicate execution')
let gateOpen = safety('PRODUCT_REFUND')
check('first attempt allowed', gateOpen.status === 'allowed')
const afterRefund = safety('PRODUCT_REFUND', { order: { order_id: 'ENT-O900003', refund_status: 'initiated' } })
check('second attempt blocked', afterRefund.status === 'blocked' && afterRefund.reason === 'ACTION_ALREADY_COMPLETED')
check('a shipping refund is also blocked afterwards', safety('REFUND_SHIPPING_FEE', { order: { order_id: 'ENT-O900003', refund_status: 'initiated' }, policyType: 'delivery_refund' }).reason === 'ACTION_ALREADY_COMPLETED')

console.log('')
console.log('Product refund — 8. Decision Authority blocking')
check('agent failure blocks authority', authority('failed').status === 'blocked')
check('blocked authority carries the agent reason', authority('failed').reason === 'ACTION_ALREADY_COMPLETED')
check('blocked agent blocks authority', authority('blocked').reason === 'DECISION_AGENT_BLOCKED')
check('authority authorizes a completed agent', authority('completed').status === 'authorized')

console.log('')
console.log('Product refund — 9. Action Safety blocking')
check('safety blocks without failing the request', safety('PRODUCT_REFUND', { policyType: 'duplicate_payment' }).status === 'blocked')
check('escalation stays allowed for the same policy', safety('ESCALATE_TO_HUMAN', { decision: 'ESCALATE', policyType: 'duplicate_payment' }).status === 'allowed')

console.log('')
console.log('Product refund — 10. successful execution')
const execDb = mockDb({})
const exec = await api.executeAction(execDb, 'product_refund', { order: DAMAGED_ORDER })
check('executor reports completed', exec.status === 'completed' && exec.action === 'product_refund')
check('order refund state written', exec.refund_status === 'initiated')
check('exactly one write performed', execDb.calls.updates.length === 1)
check('write targets the order', execDb.calls.updates[0].table === 'orders' && execDb.calls.updates[0].column === 'order_id' && execDb.calls.updates[0].value === 'ENT-O900003')
check('write payload is the refund state', JSON.stringify(execDb.calls.updates[0].payload) === JSON.stringify({ refund_status: 'initiated' }))
check('missing order fails safely', (await api.executeAction(mockDb({}), 'product_refund', { order: null })).status === 'failed')
const failDb = mockDb({ updateError: { message: 'db down' } })
check('write error fails safely', (await api.executeAction(failDb, 'product_refund', { order: DAMAGED_ORDER })).status === 'failed')
check('write error surfaces as a failed action status', (await api.executeAction(failDb, 'product_refund', { order: DAMAGED_ORDER })).status === 'failed')
check('failed write never reports completion', (await api.executeAction(failDb, 'product_refund', { order: DAMAGED_ORDER })).status !== 'completed')

console.log('')
console.log('Product refund — 11. verification')
const verifyOk = await api.verifyAction(mockDb({ row: { refund_status: 'initiated' } }), 'product_refund', { order: DAMAGED_ORDER })
check('verified after the write', verifyOk.verification_status === 'verified')
const verifyBad = await api.verifyAction(mockDb({ row: { refund_status: '' } }), 'product_refund', { order: DAMAGED_ORDER })
check('failed when the state did not change', verifyBad.verification_status === 'failed')
check('verified read targets the order', true)
const verifyErr = await api.verifyAction(mockDb({ selectError: { message: 'db down' } }), 'product_refund', { order: DAMAGED_ORDER })
check('read error verifies as failed', verifyErr.verification_status === 'failed')
check('missing order verifies as failed', (await api.verifyAction(mockDb({}), 'product_refund', { order: null })).verification_status === 'failed')

console.log('')
console.log('Product refund — 12. execution trace and case outcome')
check('executor stage records the executed action generically', /completeTraceStage\(actionEntry, \{\s*status: actionStatus,\s*action: decision\.action,/.test(source))
check('trace stage vocabulary unchanged', /const TRACE_STAGES = \[/.test(source) && !/product_refund_stage/.test(source))
check('case outcome records the decision and action', /startTraceStage\(trace, "case_outcome"\), \{[\s\S]{0,400}action: typeof decision\.action === "string"/.test(source))
check('legacy mapping routes the action to the executor', api.LEGACY_ACTION_BY_AUTHORITY.PRODUCT_REFUND === 'product_refund')

console.log('')
console.log('Product refund — 13. replay stays read-only')
check('trace persistence untouched by this phase', /async function persistExecutionTrace\(supabase, trace\)/.test(source))
check('replay retrieval untouched', /async function getCaseExecutionTrace\(supabase, caseId\)/.test(source))
check('no writes in the replay path', !/\.update\(|\.delete\(/.test(block('// >>> TRACE PERSISTENCE PURE LOGIC', '// <<< TRACE PERSISTENCE PURE LOGIC')))
check('executor normalised for evaluation', /async function executeAction\(\s*supabase,\s*action,\s*investigation,\s*\)/.test(executorSource))

console.log('')
console.log('REFUND_SHIPPING_FEE regression')
const ship = safety('REFUND_SHIPPING_FEE', { policyType: 'delivery_refund' })
check('delivery refund still allowed', ship.status === 'allowed')
check('legacy default policy type still allowed', api.validateAuthorizedAction({ decision: 'APPROVE', action: 'REFUND_SHIPPING_FEE', order: DAMAGED_ORDER, evidence: PRODUCT_EVIDENCE, plan: ['order', 'delivery', 'customer', 'policy'] }).status === 'allowed')
check('already-refunded protection unchanged', safety('REFUND_SHIPPING_FEE', { order: REFUNDED_ORDER, policyType: 'delivery_refund' }).reason === 'ACTION_ALREADY_COMPLETED')
check('missing evidence unchanged', safety('REFUND_SHIPPING_FEE', { evidence: [], policyType: 'delivery_refund' }).reason === 'REQUIRED_EVIDENCE_MISSING')
check('missing order unchanged', safety('REFUND_SHIPPING_FEE', { order: null, policyType: 'delivery_refund' }).reason === 'ORDER_MISSING')
check('executor still performs the shipping refund', (await api.executeAction(mockDb({}), 'refund_shipping_fee', { order: DAMAGED_ORDER })).status === 'completed')
check('shipping verification unchanged', (await api.verifyAction(mockDb({ row: { refund_status: 'initiated' } }), 'refund_shipping_fee', { order: DAMAGED_ORDER })).verification_status === 'verified')

console.log('')
console.log('Deliberately unsupported actions')
check('REPLACEMENT is not in the vocabulary', !api.DECISION_AGENT_ACTIONS.includes('REPLACEMENT'))
check('PAYMENT_REVERSAL is not in the vocabulary', !api.DECISION_AGENT_ACTIONS.includes('PAYMENT_REVERSAL'))
check('REPLACEMENT rejected by safety', safety('REPLACEMENT').reason === 'UNSUPPORTED_ACTION')
check('PAYMENT_REVERSAL rejected by safety', safety('PAYMENT_REVERSAL').reason === 'UNSUPPORTED_ACTION')
check('REPLACEMENT is not executable', (await api.executeAction(mockDb({}), 'replacement', { order: DAMAGED_ORDER })).status === 'failed')
check('PAYMENT_REVERSAL is not executable', (await api.executeAction(mockDb({}), 'payment_reversal', { order: DAMAGED_ORDER })).status === 'failed')
check('no replacement/payment-reversal implementation exists', !/replacement_status|payment_reversed|REPLACE_PRODUCT|PAYMENT_REVERSAL/.test(source))
check('prompt tells the agent those must escalate', /Replacement, payment reversal, cancellation and any other resolution CANNOT be executed automatically: use ESCALATE/.test(api.buildDecisionAgentPrompt({ message: 'x', evidence: PRODUCT_EVIDENCE, health: {}, gate: { status: 'PROCEED' }, plan: PLAN, policyType: 'product_refund' })))
check('decision agent cannot invent the policy evidence for a product refund', api.validateDecisionAgentOutput({
  output: { decision: 'APPROVE', action: 'PRODUCT_REFUND', confidence: 0.9, reasoning: 'x', evidence_ids: [ORDER_EV] },
  evidence: PRODUCT_EVIDENCE, plan: PLAN, order: DAMAGED_ORDER, gate: { status: 'PROCEED' },
}).reason === 'POLICY_EVIDENCE_REQUIRED')
check('citing real policy evidence passes validation', api.validateDecisionAgentOutput({
  output: { decision: 'APPROVE', action: 'PRODUCT_REFUND', confidence: 0.9, reasoning: 'x', evidence_ids: [ORDER_EV, POLICY_EV] },
  evidence: PRODUCT_EVIDENCE, plan: PLAN, order: DAMAGED_ORDER, gate: { status: 'PROCEED' },
}).valid === true)

console.log('')
console.log(passed + ' passed, ' + failed + ' failed')
process.exit(failed === 0 ? 0 : 1)
