// Basic tests for the Phase 2D Delivery Agent.
//
// Run:  node supabase/functions/support/delivery-agent.test.mjs
//
// Extracts the marked pure-logic blocks from index.ts (single source of truth).
// The delivery view is produced by the existing deliverySnapshot() derivation,
// which lives in the planner block, so that block is extracted too.
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
const deliveryBlock = block('// >>> DELIVERY AGENT PURE LOGIC', '// <<< DELIVERY AGENT PURE LOGIC')

const api = new Function(
  triageBlock + plannerBlock + deliveryBlock +
    '\nreturn { DOMAINS, INTENT_DOMAINS, DELIVERY_AGENT_NAME, planFromTriage, deliverySnapshot, hasDeliveryInfo, deliveryFindings, deliveryAgentResult, buildInvestigation, domainResult };',
)()

let passed = 0
let failed = 0
function check(name, condition, detail) {
  if (condition) { passed += 1; console.log('  ok   ' + name) }
  else { failed += 1; console.log('FAIL   ' + name + (detail ? ' -> ' + detail : '')) }
}

const AGENT_KEYS = ['agent', 'delivery', 'domain', 'findings', 'status']
const STATUSES = ['completed', 'not_found', 'failed']

function shapeOk(result) {
  return (
    result &&
    JSON.stringify(Object.keys(result).sort()) === JSON.stringify(AGENT_KEYS) &&
    result.agent === 'delivery_agent' &&
    result.domain === 'delivery' &&
    STATUSES.includes(result.status) &&
    (result.delivery === null || typeof result.delivery === 'object') &&
    Array.isArray(result.findings)
  )
}

function findingsOk(findings) {
  return findings.every(function (f) {
    return (
      f &&
      typeof f.finding === 'string' && f.finding.trim() !== '' &&
      f.source === 'orders' &&
      f.confidence === 1.0
    )
  })
}

const orderRow = {
  order_id: '10486',
  customer_id: 'CUST004',
  product: 'Noise-Cancelling Earbuds',
  status: 'delayed',
  shipping_type: 'Express',
  expected_delivery: '2026-09-11',
  actual_delivery: '',
  delivery_days_delayed: 4,
  payment_status: 'paid',
}

console.log('')
console.log('1. Valid delivery information')
const found = api.deliveryAgentResult({ order: orderRow })
check('status is completed', found.status === 'completed')
check('structured output shape', shapeOk(found))
check('delivery status structured', found.delivery.status === 'delayed')
check('shipping method structured', found.delivery.shipping_type === 'Express')
check('promised date structured', found.delivery.expected_delivery === '2026-09-11')
check('recorded delay structured', found.delivery.delivery_days_delayed === 4)
check('findings cite the orders table', found.findings.every(function (f) { return f.source === 'orders' }))
check('confidence is 1.0', found.findings.every(function (f) { return f.confidence === 1.0 }))
check('finding: delivery status', found.findings.some(function (f) { return f.finding === 'Delivery status: delayed' }))
check('finding: shipping method', found.findings.some(function (f) { return f.finding === 'Shipping method: Express' }))
check('finding: promised date', found.findings.some(function (f) { return f.finding === 'Promised delivery date: 2026-09-11' }))
check('finding: recorded delay', found.findings.some(function (f) { return f.finding === 'Recorded delivery delay: 4 day(s)' }))
check('no finding for an empty actual_delivery', !found.findings.some(function (f) { return f.finding.startsWith('Actual delivery date') }))
check('findings are well formed', findingsOk(found.findings))

const delivered = { order_id: '10492', status: 'delivered', shipping_type: 'Standard', expected_delivery: '2026-09-05', actual_delivery: '2026-09-05', delivery_days_delayed: 0 }
const deliveredResult = api.deliveryAgentResult({ order: delivered })
check('delivered order -> completed', deliveredResult.status === 'completed')
check('actual delivery date reported', deliveredResult.findings.some(function (f) { return f.finding === 'Actual delivery date: 2026-09-05' }))
check('on-schedule delay reported as none', deliveredResult.findings.some(function (f) { return f.finding === 'Recorded delivery delay: none' }))
check('derived delivered flag preserved', deliveredResult.delivery.delivered === true)
check('derived delayed flag preserved', deliveredResult.delivery.delayed === false)

console.log('')
console.log('2. Missing delivery fields')
const noDelivery = api.deliveryAgentResult({ order: { order_id: '99999', product: 'X' } })
check('order with no delivery fields -> not_found', noDelivery.status === 'not_found')
check('delivery payload is null', noDelivery.delivery === null)
check('no findings invented', noDelivery.findings.length === 0)
const defaultOnly = api.deliveryAgentResult({ order: { order_id: '99999', delivery_days_delayed: 0 } })
check('numeric default only -> not_found', defaultOnly.status === 'not_found')
const blankStrings = api.deliveryAgentResult({ order: { order_id: '99999', status: '   ', shipping_type: '', expected_delivery: '', actual_delivery: '', delivery_days_delayed: 0 } })
check('blank strings are treated as missing', blankStrings.status === 'not_found')
check('findings never invented for missing fields', blankStrings.findings.length === 0)
const sparse = api.deliveryAgentResult({ order: { order_id: '10490', status: 'processing' } })
check('status alone counts as delivery info', sparse.status === 'completed')
check('only real fields become findings', sparse.findings.length === 1 && sparse.findings[0].finding === 'Delivery status: processing')
check('findings are well formed', findingsOk(sparse.findings))

console.log('')
console.log('3. Missing order / not-found')
const missingOrder = api.deliveryAgentResult({ order: null })
check('no order -> not_found', missingOrder.status === 'not_found')
check('delivery payload is null', missingOrder.delivery === null)
check('no findings invented', missingOrder.findings.length === 0)
check('structured output shape', shapeOk(missingOrder))
check('non-object order -> not_found', api.deliveryAgentResult({ order: 'nope' }).status === 'not_found')

console.log('')
console.log('4. Shared order-query failure')
const failedResult = api.deliveryAgentResult({ orderError: 'connection reset', order: orderRow })
check('query error -> failed', failedResult.status === 'failed')
check('failure carries no delivery payload', failedResult.delivery === null)
check('failure invents no findings', failedResult.findings.length === 0)
check('structured output shape', shapeOk(failedResult))

console.log('')
console.log('5. Structured output validation')
for (const result of [found, deliveredResult, noDelivery, defaultOnly, sparse, missingOrder, failedResult]) {
  check('valid shape for status ' + result.status, shapeOk(result))
}
check('agent name constant', api.DELIVERY_AGENT_NAME === 'delivery_agent')
check('only allowed statuses produced', [found, missingOrder, failedResult].every(function (r) { return STATUSES.includes(r.status) }))
check('non-completed results never carry findings', noDelivery.findings.length === 0 && missingOrder.findings.length === 0 && failedResult.findings.length === 0)

console.log('')
console.log('6. Findings contain only real stored fields')
const weird = { order_id: 'X', status: 'delayed', shipping_type: 'Express', expected_delivery: '2026-09-11', actual_delivery: '', delivery_days_delayed: 2, amount: 999, product: 'Item', customer_id: 'CUST009', payment_status: 'paid' }
const weirdResult = api.deliveryAgentResult({ order: weird })
check('delivery findings never mention product/amount/payment', !weirdResult.findings.some(function (f) { return /Product|amount|Payment/.test(f.finding) }))
check('exactly the delivery fields are reported', weirdResult.findings.length === 4, JSON.stringify(weirdResult.findings))
check('every finding maps to a stored field', weirdResult.findings.every(function (f) { return /^Delivery status|^Shipping method|^Promised delivery date|^Actual delivery date|^Recorded delivery delay/.test(f.finding) }))
check('findings are well formed', findingsOk(weirdResult.findings))

console.log('')
console.log('7. Delivery Agent only runs when the plan contains "delivery"')
const noDeliveryPlan = api.planFromTriage({ intent: 'REFUND_REQUEST' })
check('REFUND_REQUEST plan omits delivery', !noDeliveryPlan.includes('delivery'), noDeliveryPlan.join(','))
const noDeliveryAdvisory = api.planFromTriage({ intent: 'PIZZA', domains: ['order', 'customer'] })
check('advisory plan without delivery stays without it', !noDeliveryAdvisory.includes('delivery'), noDeliveryAdvisory.join(','))
check('executor would not run the agent for those plans', noDeliveryPlan.every(function (d) { return d !== 'delivery' }))
check('ORDER_STATUS plan includes delivery', api.planFromTriage({ intent: 'ORDER_STATUS' }).includes('delivery'))
check('DELIVERY_DELAY plan includes delivery', api.planFromTriage({ intent: 'DELIVERY_DELAY' }).includes('delivery'))
check('WRONG_PRODUCT plan omits delivery', !api.planFromTriage({ intent: 'WRONG_PRODUCT' }).includes('delivery'))
check('plans never invent unsupported domains', api.planFromTriage({ intent: 'DELIVERY_DELAY', domains: ['warehouse'] }).every(function (d) { return api.DOMAINS.includes(d) }))

console.log('')
console.log('8. Legacy investigation stays compatible')
const orderAgent = { agent: 'order_agent', domain: 'order', status: 'completed', order: orderRow, findings: [] }
const customerAgent = { agent: 'customer_agent', domain: 'customer', status: 'completed', customer: { customer_id: 'CUST004', name: 'Aarav Kapoor' }, support_history: [{ ticket_id: 'T1' }], findings: [] }
const withDelivery = api.buildInvestigation([
  api.domainResult('order', 'completed', orderAgent),
  api.domainResult('delivery', 'completed', found),
  api.domainResult('customer', 'completed', customerAgent),
])
const withoutDelivery = api.buildInvestigation([
  api.domainResult('order', 'completed', orderAgent),
  api.domainResult('customer', 'completed', customerAgent),
])
check('legacy keys exactly as expected', JSON.stringify(Object.keys(withDelivery).sort()) === JSON.stringify(['customer', 'customer_id', 'order', 'policy', 'ticket_history']))
check('order is still the raw order row', withDelivery.order.order_id === '10486' && !('agent' in withDelivery.order))
check('delivery domain does not change the legacy object', JSON.stringify(withDelivery) === JSON.stringify(withoutDelivery))
const failedDeliveryLegacy = api.buildInvestigation([api.domainResult('delivery', 'failed', failedResult)])
check('failed delivery domain leaves the legacy object empty', failedDeliveryLegacy.order === null && failedDeliveryLegacy.customer === null && failedDeliveryLegacy.ticket_history.length === 0)

console.log('')
console.log('9. Existing delivery-delay behavior unchanged')
const snap = api.deliverySnapshot(orderRow)
check('snapshot keeps the recorded delay value', snap.delivery_days_delayed === 4)
check('snapshot delayed flag is days > 0', snap.delayed === true)
check('snapshot delivered flag is status === delivered', snap.delivered === false)
const snapZero = api.deliverySnapshot({ status: 'processing', delivery_days_delayed: 0 })
check('zero delay is not flagged as delayed', snapZero.delayed === false && snapZero.delivery_days_delayed === 0)
const snapMissing = api.deliverySnapshot({ status: 'processing' })
check('missing delay is null, not invented', snapMissing.delivery_days_delayed === null && snapMissing.delayed === false)
check('snapshot of a non-object is null', api.deliverySnapshot(null) === null && api.deliverySnapshot('x') === null)
check('hasDeliveryInfo agrees with the snapshot for real orders', api.hasDeliveryInfo(snap) === true)
check('agent delivery payload is the unchanged snapshot', JSON.stringify(found.delivery) === JSON.stringify(api.deliverySnapshot(orderRow)))

console.log('')
console.log(passed + ' passed, ' + failed + ' failed')
process.exit(failed === 0 ? 0 : 1)
