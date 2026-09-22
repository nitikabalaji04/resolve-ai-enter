// Basic tests for the Phase 2C Order Agent.
//
// Run:  node supabase/functions/support/order-agent.test.mjs
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
const agentBlock = block('// >>> ORDER AGENT PURE LOGIC', '// <<< ORDER AGENT PURE LOGIC')

const api = new Function(
  triageBlock + plannerBlock + agentBlock +
    '\nreturn { DOMAINS, INTENT_DOMAINS, ORDER_AGENT_NAME, planFromTriage, orderFindings, orderAgentResult, buildInvestigation, domainResult };',
)()

let passed = 0
let failed = 0
function check(name, condition, detail) {
  if (condition) { passed += 1; console.log('  ok   ' + name) }
  else { failed += 1; console.log('FAIL   ' + name + (detail ? ' -> ' + detail : '')) }
}

const AGENT_KEYS = ['agent', 'domain', 'findings', 'order', 'status']
const STATUSES = ['completed', 'not_found', 'failed']

function shapeOk(result) {
  return (
    result &&
    JSON.stringify(Object.keys(result).sort()) === JSON.stringify(AGENT_KEYS) &&
    result.agent === 'order_agent' &&
    result.domain === 'order' &&
    STATUSES.includes(result.status) &&
    (result.order === null || typeof result.order === 'object') &&
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
  order_id: '10510',
  customer_id: 'CUST017',
  product: 'VR Headset',
  order_date: '2026-08-27',
  expected_delivery: '2026-08-30',
  actual_delivery: '',
  status: 'delayed',
  delivery_days_delayed: 6,
  shipping_type: 'Express',
  amount: 13999,
  payment_status: 'paid',
  refund_status: '',
}

console.log('')
console.log('1. Valid order found')
const found = api.orderAgentResult({ order: orderRow })
check('status is completed', found.status === 'completed')
check('order row preserved', found.order && found.order.order_id === '10510')
check('structured output shape', shapeOk(found))
check('findings cite the orders table', found.findings.every(function (f) { return f.source === 'orders' }))
check('confidence is 1.0 for deterministic facts', found.findings.every(function (f) { return f.confidence === 1.0 }))
check('findings include the order id', found.findings.some(function (f) { return f.finding === 'Order ID: 10510' }))
check('findings include the product', found.findings.some(function (f) { return f.finding === 'Product: VR Headset' }))
check('findings include the status', found.findings.some(function (f) { return f.finding === 'Order status: delayed' }))
check('findings include the order date', found.findings.some(function (f) { return f.finding === 'Order placed on 2026-08-27' }))
check('findings include the promised date', found.findings.some(function (f) { return f.finding === 'Promised delivery date: 2026-08-30' }))
check('findings include shipping type', found.findings.some(function (f) { return f.finding === 'Shipping type: Express' }))
check('findings include the delay', found.findings.some(function (f) { return f.finding === 'Recorded delay: 6 day(s)' }))
check('findings include the amount', found.findings.some(function (f) { return f.finding === 'Order amount: 13999' }))
check('findings include payment status', found.findings.some(function (f) { return f.finding === 'Payment status: paid' }))
check('findings include the owner', found.findings.some(function (f) { return f.finding === 'Order owner: CUST017' }))
check('findings are well formed', findingsOk(found.findings))

console.log('')
console.log('2. Order not found')
const notFound = api.orderAgentResult({ order: null })
check('status is not_found', notFound.status === 'not_found')
check('order is null', notFound.order === null)
check('no findings invented', notFound.findings.length === 0)
check('structured output shape', shapeOk(notFound))

console.log('')
console.log('3. Order with multiple items')
const multi = { order_id: '10511', product: 'Wireless Earbuds + Charging Case', status: 'delivered', delivery_days_delayed: 0 }
const multiResult = api.orderAgentResult({ order: multi })
check('multi-item product reported verbatim', multiResult.findings.some(function (f) { return f.finding === 'Product: Wireless Earbuds + Charging Case' }))
check('product is not split into invented line items', !JSON.stringify(multiResult.findings).includes('Charging Case, '))
check('exactly one product finding', multiResult.findings.filter(function (f) { return f.finding.startsWith('Product:') }).length === 1)
check('on-schedule order reports no delay', multiResult.findings.some(function (f) { return f.finding === 'Recorded delay: none' }))

console.log('')
console.log('4. Missing optional order fields')
const sparse = { order_id: '10490', status: 'processing' }
const sparseResult = api.orderAgentResult({ order: sparse })
check('status is completed', sparseResult.status === 'completed')
check('only the present fields are reported', sparseResult.findings.length === 2, JSON.stringify(sparseResult.findings))
check('reports the order id', sparseResult.findings.some(function (f) { return f.finding === 'Order ID: 10490' }))
check('reports the status', sparseResult.findings.some(function (f) { return f.finding === 'Order status: processing' }))
check('invents no product', !sparseResult.findings.some(function (f) { return f.finding.startsWith('Product:') }))
check('invents no amount', !sparseResult.findings.some(function (f) { return f.finding.startsWith('Order amount:') }))
check('invents no delivery date', !sparseResult.findings.some(function (f) { return f.finding.includes('delivery') }))
check('invents no owner', !sparseResult.findings.some(function (f) { return f.finding.startsWith('Order owner:') }))
check('findings are well formed', findingsOk(sparseResult.findings))
const blank = api.orderAgentResult({ order: { order_id: '10490', product: '   ', status: '' } })
check('blank strings are treated as missing', blank.findings.length === 1 && blank.findings[0].finding === 'Order ID: 10490')
check('null order row is not treated as completed', api.orderAgentResult({ order: 'nope' }).status === 'not_found')

console.log('')
console.log('5. Database / query failure')
const failedResult = api.orderAgentResult({ orderError: 'connection reset', order: orderRow })
check('query error -> failed', failedResult.status === 'failed')
check('failure carries no order', failedResult.order === null)
check('failure invents no findings', failedResult.findings.length === 0)
check('structured output shape', shapeOk(failedResult))

console.log('')
console.log('6. Structured output validation')
for (const result of [found, notFound, multiResult, sparseResult, failedResult]) {
  check('valid shape for status ' + result.status, shapeOk(result))
}
check('agent name constant', api.ORDER_AGENT_NAME === 'order_agent')
check('only allowed statuses are produced', [found, notFound, failedResult].every(function (r) { return STATUSES.includes(r.status) }))
check('non-completed results never carry findings', notFound.findings.length === 0 && failedResult.findings.length === 0)

console.log('')
console.log('7. Order Agent only runs when the plan contains "order"')
const noOrderPlan = api.planFromTriage({ intent: 'PIZZA', domains: ['customer'] })
check('plan without order stays without order', !noOrderPlan.includes('order'), noOrderPlan.join(','))
check('executor would not run the agent for that plan', noOrderPlan.every(function (d) { return d !== 'order' }))
for (const intent of Object.keys(api.INTENT_DOMAINS)) {
  check('intent ' + intent + ' plan includes order', api.planFromTriage({ intent: intent }).includes('order'))
}
check('plans never invent unsupported domains', api.planFromTriage({ intent: 'DELIVERY_DELAY', domains: ['warehouse'] }).every(function (d) { return api.DOMAINS.includes(d) }))

console.log('')
console.log('8. Legacy investigation stays compatible')
const legacy = api.buildInvestigation([
  api.domainResult('order', 'completed', found),
  api.domainResult('customer', 'completed', { agent: 'customer_agent', domain: 'customer', status: 'completed', customer: { customer_id: 'CUST017', name: 'Riya Saxena' }, support_history: [{ ticket_id: 'T1' }], findings: [] }),
  api.domainResult('policy', 'completed', { policy_id: 1, policy_type: 'delivery_refund' }),
])
check('legacy keys exactly as expected', JSON.stringify(Object.keys(legacy).sort()) === JSON.stringify(['customer', 'customer_id', 'order', 'policy', 'ticket_history']))
check('order is the raw order row (not the agent wrapper)', legacy.order && legacy.order.order_id === '10510' && !('agent' in legacy.order))
check('customer_id resolved from the order owner', legacy.customer_id === 'CUST017')
check('customer preserved', legacy.customer && legacy.customer.name === 'Riya Saxena')
check('support history mapped to ticket_history', legacy.ticket_history.length === 1)
check('policy preserved', legacy.policy && legacy.policy.policy_id === 1)
const notFoundLegacy = api.buildInvestigation([api.domainResult('order', 'not_found', notFound)])
check('not_found order -> legacy order null', notFoundLegacy.order === null && notFoundLegacy.customer_id === null)
const failedLegacy = api.buildInvestigation([api.domainResult('order', 'failed', failedResult)])
check('failed order -> legacy order null', failedLegacy.order === null && failedLegacy.customer_id === null)

console.log('')
console.log(passed + ' passed, ' + failed + ' failed')
process.exit(failed === 0 ? 0 : 1)
