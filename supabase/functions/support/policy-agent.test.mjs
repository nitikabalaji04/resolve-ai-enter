// Basic tests for the Phase 2E Policy Agent.
//
// Run:  node supabase/functions/support/policy-agent.test.mjs
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

const triageBlock = block('// >>> TRIAGE PURE LOGIC', '// <<< TRIAGE PURE LOGIC')
const plannerBlock = block('// >>> PLANNER PURE LOGIC', '// <<< PLANNER PURE LOGIC')
const policyBlock = block('// >>> POLICY AGENT PURE LOGIC', '// <<< POLICY AGENT PURE LOGIC')

const api = new Function(
  triageBlock + plannerBlock + policyBlock +
    '\nreturn { DOMAINS, INTENT_DOMAINS, POLICY_AGENT_NAME, APPLICABLE_POLICY_TYPE, planFromTriage, policyFindings, policyAgentResult, buildInvestigation, domainResult };',
)()

let passed = 0
let failed = 0
function check(name, condition, detail) {
  if (condition) { passed += 1; console.log('  ok   ' + name) }
  else { failed += 1; console.log('FAIL   ' + name + (detail ? ' -> ' + detail : '')) }
}

const AGENT_KEYS = ['agent', 'domain', 'findings', 'policy', 'status']
const STATUSES = ['completed', 'not_found', 'failed']

function shapeOk(result) {
  return (
    result &&
    JSON.stringify(Object.keys(result).sort()) === JSON.stringify(AGENT_KEYS) &&
    result.agent === 'policy_agent' &&
    result.domain === 'policy' &&
    STATUSES.includes(result.status) &&
    (result.policy === null || typeof result.policy === 'object') &&
    Array.isArray(result.findings)
  )
}

function findingsOk(findings) {
  return findings.every(function (f) {
    return (
      f &&
      typeof f.finding === 'string' && f.finding.trim() !== '' &&
      f.source === 'policies' &&
      f.confidence === 1.0
    )
  })
}

// The real delivery_refund policy as stored (policy_id 1).
const policyRow = {
  policy_id: 1,
  policy_type: 'delivery_refund',
  title: 'Delayed Express Delivery Refund',
  action: 'Customer is eligible for a full shipping fee refund.',
  conditions: [
    'Order was shipped using Express delivery',
    'Delivery is delayed by 2 or more days',
    'Order has been paid for',
    'Customer has not already received a refund',
  ],
}

console.log('')
console.log('1. Applicable policy found')
const found = api.policyAgentResult({ policy: policyRow })
check('status is completed', found.status === 'completed')
check('policy record preserved', found.policy && found.policy.policy_id === 1)
check('structured output shape', shapeOk(found))
check('findings cite the policies table', found.findings.every(function (f) { return f.source === 'policies' }))
check('confidence is 1.0', found.findings.every(function (f) { return f.confidence === 1.0 }))
check('finding: policy title', found.findings.some(function (f) { return f.finding === 'Policy: Delayed Express Delivery Refund' }))
check('finding: policy type', found.findings.some(function (f) { return f.finding === 'Policy type: delivery_refund' }))
check('finding: policy action', found.findings.some(function (f) { return f.finding === 'Policy action: Customer is eligible for a full shipping fee refund.' }))
check('finding: policy id', found.findings.some(function (f) { return f.finding === 'Policy ID: 1' }))
check('every stored condition reported verbatim', policyRow.conditions.every(function (c) { return found.findings.some(function (f) { return f.finding === 'Condition: ' + c }) }))
check('findings are well formed', findingsOk(found.findings))

console.log('')
console.log('2. Policy not found')
const notFound = api.policyAgentResult({ policy: null })
check('status is not_found', notFound.status === 'not_found')
check('policy is null', notFound.policy === null)
check('no findings invented', notFound.findings.length === 0)
check('structured output shape', shapeOk(notFound))
check('non-object policy -> not_found', api.policyAgentResult({ policy: 'nope' }).status === 'not_found')

console.log('')
console.log('3. Missing optional policy fields')
const sparse = api.policyAgentResult({ policy: { policy_id: 7, policy_type: 'delivery_refund' } })
check('status is completed', sparse.status === 'completed')
check('only present fields reported', sparse.findings.length === 2, JSON.stringify(sparse.findings))
check('reports the id', sparse.findings.some(function (f) { return f.finding === 'Policy ID: 7' }))
check('reports the type', sparse.findings.some(function (f) { return f.finding === 'Policy type: delivery_refund' }))
check('invents no title', !sparse.findings.some(function (f) { return f.finding.startsWith('Policy:') }))
check('invents no action', !sparse.findings.some(function (f) { return f.finding.startsWith('Policy action:') }))
check('invents no conditions', !sparse.findings.some(function (f) { return f.finding.startsWith('Condition:') }))
const blank = api.policyAgentResult({ policy: { policy_id: 2, title: '   ', action: '', conditions: [] } })
check('blank strings treated as missing', !blank.findings.some(function (f) { return f.finding.startsWith('Policy:') }) && !blank.findings.some(function (f) { return f.finding.startsWith('Policy action:') }))
check('empty condition list reported factually', blank.findings.some(function (f) { return f.finding === 'No eligibility conditions recorded for this policy' }))
const badConditions = api.policyAgentResult({ policy: { policy_id: 3, conditions: ['ok', 42, '', null] } })
check('non-string conditions are ignored, not invented', badConditions.findings.filter(function (f) { return f.finding.startsWith('Condition:') }).length === 1)
check('findings are well formed', findingsOk(badConditions.findings))

console.log('')
console.log('4. Policy query failure')
const failedResult = api.policyAgentResult({ policyError: 'connection reset', policy: policyRow })
check('query error -> failed', failedResult.status === 'failed')
check('failure carries no policy', failedResult.policy === null)
check('failure invents no findings', failedResult.findings.length === 0)
check('structured output shape', shapeOk(failedResult))

console.log('')
console.log('5. Structured output validation')
for (const result of [found, notFound, sparse, blank, badConditions, failedResult]) {
  check('valid shape for status ' + result.status, shapeOk(result))
}
check('agent name constant', api.POLICY_AGENT_NAME === 'policy_agent')
check('only allowed statuses produced', [found, notFound, failedResult].every(function (r) { return STATUSES.includes(r.status) }))
check('non-completed results never carry findings', notFound.findings.length === 0 && failedResult.findings.length === 0)

console.log('')
console.log('6. Findings contain only real policy fields')
check('every finding maps to a stored policy field', found.findings.every(function (f) { return /^Policy: |^Policy type: |^Policy action: |^Policy ID: |^Condition: |^No eligibility conditions/.test(f.finding) }))
const allowedFindings = [
  'Policy: ' + policyRow.title,
  'Policy type: ' + policyRow.policy_type,
  'Policy action: ' + policyRow.action,
  'Policy ID: ' + policyRow.policy_id,
].concat(policyRow.conditions.map(function (c) { return 'Condition: ' + c }))
check('findings are only the stored policy fields (no added commentary)', found.findings.every(function (f) { return allowedFindings.includes(f.finding) }))
check('finding count matches the stored fields', found.findings.length === allowedFindings.length, found.findings.length + ' vs ' + allowedFindings.length)
check('conditions are not summarised or rewritten', found.findings.filter(function (f) { return f.finding.startsWith('Condition:') }).every(function (f) { return policyRow.conditions.includes(f.finding.replace('Condition: ', '')) }))
check('no order/customer identifiers leaked into findings', !/CUST\d|order_id|#10482/i.test(JSON.stringify(found.findings)))

console.log('')
console.log('7. Policy Agent only runs when the plan contains "policy"')
check('REFUND_REQUEST plan includes policy', api.planFromTriage({ intent: 'REFUND_REQUEST' }).includes('policy'))
check('DELIVERY_DELAY plan includes policy', api.planFromTriage({ intent: 'DELIVERY_DELAY' }).includes('policy'))
check('WRONG_PRODUCT plan includes policy', api.planFromTriage({ intent: 'WRONG_PRODUCT' }).includes('policy'))
const statusPlan = api.planFromTriage({ intent: 'ORDER_STATUS' })
check('ORDER_STATUS plan omits policy', !statusPlan.includes('policy'), statusPlan.join(','))
const unknownPlan = api.planFromTriage({ intent: 'UNKNOWN' })
check('UNKNOWN plan omits policy', !unknownPlan.includes('policy'), unknownPlan.join(','))
const advisory = api.planFromTriage({ intent: 'PIZZA', domains: ['order'] })
check('advisory plan without policy stays without it', !advisory.includes('policy'), advisory.join(','))
check('plans never invent unsupported domains', api.planFromTriage({ intent: 'DELIVERY_DELAY', domains: ['warehouse'] }).every(function (d) { return api.DOMAINS.includes(d) }))

console.log('')
console.log('8. Legacy investigation stays compatible')
const orderAgent = { agent: 'order_agent', domain: 'order', status: 'completed', order: { order_id: '10486', customer_id: 'CUST004' }, findings: [] }
const customerAgent = { agent: 'customer_agent', domain: 'customer', status: 'completed', customer: { customer_id: 'CUST004', name: 'Aarav Kapoor' }, support_history: [], findings: [] }
const legacy = api.buildInvestigation([
  api.domainResult('order', 'completed', orderAgent),
  api.domainResult('customer', 'completed', customerAgent),
  api.domainResult('policy', 'completed', found),
])
check('legacy keys exactly as expected', JSON.stringify(Object.keys(legacy).sort()) === JSON.stringify(['customer', 'customer_id', 'order', 'policy', 'ticket_history']))
check('legacy policy is the raw policy record', legacy.policy && legacy.policy.policy_id === 1 && !('agent' in legacy.policy))
check('legacy policy keeps every stored field', legacy.policy.title === policyRow.title && legacy.policy.action === policyRow.action && legacy.policy.conditions.length === 4)
const withoutPolicy = api.buildInvestigation([api.domainResult('order', 'completed', orderAgent)])
check('missing policy leaves legacy policy null', withoutPolicy.policy === null)
const notFoundLegacy = api.buildInvestigation([api.domainResult('policy', 'not_found', notFound)])
check('not_found policy leaves legacy policy null', notFoundLegacy.policy === null)
const failedLegacy = api.buildInvestigation([api.domainResult('policy', 'failed', failedResult)])
check('failed policy leaves legacy policy null', failedLegacy.policy === null)

console.log('')
console.log('9. Existing policy matching behavior unchanged')
check('matching type is still delivery_refund', api.APPLICABLE_POLICY_TYPE === 'delivery_refund')
check('agent preserves the raw policy object identity', found.policy === policyRow)
check('legacy policy object identity preserved', legacy.policy === policyRow)
check('agent never rewrites the policy record', JSON.stringify(found.policy) === JSON.stringify(policyRow))
check('conditions are carried as stored (array of strings)', Array.isArray(found.policy.conditions) && found.policy.conditions.every(function (c) { return typeof c === 'string' }))

console.log('')
console.log(passed + ' passed, ' + failed + ' failed')
process.exit(failed === 0 ? 0 : 1)
