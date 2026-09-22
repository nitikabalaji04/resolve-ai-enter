// Basic tests for the Phase 2A Investigation Planner + domain assembly.
//
// Run:  node supabase/functions/support/planner.test.mjs
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

const api = new Function(
  triageBlock + plannerBlock +
    '\nreturn { DOMAINS, INTENT_DOMAINS, PLAN_ORDER, DEFAULT_PLAN, planFromTriage, deliverySnapshot, domainResult, buildInvestigation };',
)()

const asSet = (list) => JSON.stringify(list.slice().sort())
let passed = 0
let failed = 0
function check(name, condition, detail) {
  if (condition) { passed += 1; console.log('  ok   ' + name) }
  else { failed += 1; console.log('FAIL   ' + name + (detail ? ' -> ' + detail : '')) }
}

console.log('')
console.log('Plan normalization (planFromTriage)')
check('keeps requested domains', JSON.stringify(api.planFromTriage({ domains: ['order', 'policy'] })) === JSON.stringify(['order', 'policy']))
check('de-duplicates', JSON.stringify(api.planFromTriage({ domains: ['order', 'order', 'policy'] })) === JSON.stringify(['order', 'policy']))
check('drops unsupported domains', JSON.stringify(api.planFromTriage({ domains: ['order', 'warehouse'] })) === JSON.stringify(['order']))
check('drops non-string entries', JSON.stringify(api.planFromTriage({ domains: ['order', 42, null] })) === JSON.stringify(['order']))
check('stable execution order', JSON.stringify(api.planFromTriage({ domains: ['policy', 'customer', 'order'] })) === JSON.stringify(['order', 'customer', 'policy']))
check('empty plan -> default plan', JSON.stringify(api.planFromTriage({ domains: [] })) === JSON.stringify(api.DEFAULT_PLAN))
check('missing domains -> default plan', JSON.stringify(api.planFromTriage({})) === JSON.stringify(api.DEFAULT_PLAN))
check('non-array domains -> default plan', JSON.stringify(api.planFromTriage({ domains: 'order' })) === JSON.stringify(api.DEFAULT_PLAN))
check('null triage -> default plan', JSON.stringify(api.planFromTriage(null)) === JSON.stringify(api.DEFAULT_PLAN))
check('default plan matches legacy investigation', JSON.stringify(api.DEFAULT_PLAN) === JSON.stringify(['order', 'customer', 'policy']))
check('PLAN_ORDER covers every supported domain', api.DOMAINS.every(function (d) { return api.PLAN_ORDER.includes(d) }) && api.PLAN_ORDER.length === api.DOMAINS.length)
check('never invents a domain', api.planFromTriage({ domains: ['order'] }).every(function (d) { return d === 'order' }))

console.log('')
console.log('Intent drives the executed plan (canonical domains guaranteed)')
check('REFUND_REQUEST intent guarantees policy', asSet(api.planFromTriage({ intent: 'REFUND_REQUEST', domains: ['order'] })) === asSet(['order', 'customer', 'policy']))
check('ORDER_STATUS intent guarantees customer+delivery', asSet(api.planFromTriage({ intent: 'ORDER_STATUS', domains: [] })) === asSet(['order', 'delivery', 'customer']))
check('DELIVERY_DELAY intent gives all four domains', asSet(api.planFromTriage({ intent: 'DELIVERY_DELAY', domains: ['order', 'delivery'] })) === asSet(['order', 'delivery', 'customer', 'policy']))
check('UNKNOWN intent uses its canonical plan', asSet(api.planFromTriage({ intent: 'UNKNOWN' })) === asSet(['customer', 'order']))
check('unsupported intent falls back to advisory domains', asSet(api.planFromTriage({ intent: 'PIZZA', domains: ['policy'] })) === asSet(['policy']))
check('plan never exceeds supported domains', api.planFromTriage({ intent: 'DELIVERY_DELAY', domains: ['warehouse', 'order'] }).every(function (d) { return api.DOMAINS.includes(d) }))
check('advisory extra domain is kept', asSet(api.planFromTriage({ intent: 'ORDER_STATUS', domains: ['policy'] })) === asSet(['order', 'delivery', 'customer', 'policy']))
check('narrow model output cannot drop required domains', asSet(api.planFromTriage({ intent: 'REFUND_REQUEST', domains: ['order', 'delivery'] })) === asSet(['order', 'delivery', 'customer', 'policy']))

console.log('')
console.log('Intent -> plan mapping (spec examples)')
const deliveryPlan = api.planFromTriage({ intent: 'DELIVERY_DELAY' })
check('DELIVERY_DELAY -> order+delivery+customer+policy', asSet(deliveryPlan) === asSet(['order', 'delivery', 'customer', 'policy']), deliveryPlan.join(','))
const statusPlan = api.planFromTriage({ intent: 'ORDER_STATUS' })
check('ORDER_STATUS -> order+delivery+customer', asSet(statusPlan) === asSet(['order', 'delivery', 'customer']), statusPlan.join(','))
const refundPlan = api.planFromTriage({ intent: 'REFUND_REQUEST' })
check('REFUND_REQUEST -> order+policy+customer', asSet(refundPlan) === asSet(['order', 'policy', 'customer']), refundPlan.join(','))
check('plans are not all identical', JSON.stringify(deliveryPlan) !== JSON.stringify(refundPlan))

console.log('')
console.log('Delivery domain view (deliverySnapshot)')
const delayed = api.deliverySnapshot({ status: 'delayed', shipping_type: 'Express', expected_delivery: '2026-09-11', actual_delivery: '', delivery_days_delayed: 4 })
check('delayed snapshot flags delay', delayed.delayed === true && delayed.delivery_days_delayed === 4)
check('delayed snapshot keeps shipping type', delayed.shipping_type === 'Express')
check('delayed snapshot not marked delivered', delayed.delivered === false)
const onTime = api.deliverySnapshot({ status: 'delivered', shipping_type: 'Standard', actual_delivery: '2026-09-05', delivery_days_delayed: 0 })
check('on-time snapshot not delayed', onTime.delayed === false)
check('delivered snapshot marked delivered', onTime.delivered === true)
check('missing order -> null snapshot', api.deliverySnapshot(null) === null)
check('invalid order -> null snapshot', api.deliverySnapshot('nope') === null)
const sparse = api.deliverySnapshot({ status: 'processing' })
check('sparse order invents nothing', sparse.shipping_type === null && sparse.expected_delivery === null && sparse.delivery_days_delayed === null && sparse.delayed === false)

console.log('')
console.log('Domain result contract')
const sample = api.domainResult('order', 'completed', { order_id: '10482' })
check('result has domain/status/data', sample.domain === 'order' && sample.status === 'completed' && sample.data.order_id === '10482')
check('undefined data becomes null', api.domainResult('policy', 'not_found', undefined).data === null)

console.log('')
console.log('Investigation assembly (buildInvestigation)')
const orderRow = { order_id: '10482', customer_id: 'CUST001', status: 'delayed', delivery_days_delayed: 3 }
const customerRow = { customer_id: 'CUST001', name: 'Ananya Sharma' }
const tickets = [{ ticket_id: 'TKT1001' }]
const policyRow = { policy_id: 1, policy_type: 'delivery_refund' }

const full = api.buildInvestigation([
  api.domainResult('order', 'completed', { agent: 'order_agent', domain: 'order', status: 'completed', order: orderRow, findings: [] }),
  api.domainResult('delivery', 'completed', api.deliverySnapshot(orderRow)),
  api.domainResult('customer', 'completed', { agent: 'customer_agent', domain: 'customer', status: 'completed', customer: customerRow, support_history: tickets, findings: [] }),
  api.domainResult('policy', 'completed', { agent: 'policy_agent', domain: 'policy', status: 'completed', policy: policyRow, findings: [] }),
])
check('full plan -> legacy shape (order)', full.order && full.order.order_id === '10482')
check('full plan -> legacy shape (customer)', full.customer && full.customer.name === 'Ananya Sharma')
check('full plan -> legacy shape (tickets)', Array.isArray(full.ticket_history) && full.ticket_history.length === 1)
check('full plan -> legacy shape (policy)', full.policy && full.policy.policy_id === 1)
check('full plan -> legacy shape (customer_id)', full.customer_id === 'CUST001')
check('no extra keys added to investigation', JSON.stringify(Object.keys(full).sort()) === JSON.stringify(['customer', 'customer_id', 'order', 'policy', 'ticket_history']))

const withoutPolicy = api.buildInvestigation([
  api.domainResult('order', 'completed', { agent: 'order_agent', domain: 'order', status: 'completed', order: orderRow, findings: [] }),
  api.domainResult('delivery', 'completed', api.deliverySnapshot(orderRow)),
  api.domainResult('customer', 'completed', { agent: 'customer_agent', domain: 'customer', status: 'completed', customer: customerRow, support_history: tickets, findings: [] }),
])
check('ORDER_STATUS plan leaves policy empty', withoutPolicy.policy === null)
check('ORDER_STATUS plan still has order + customer', withoutPolicy.order.order_id === '10482' && withoutPolicy.customer.name === 'Ananya Sharma')

const deliveryIrrelevant = api.buildInvestigation([
  api.domainResult('order', 'completed', { agent: 'order_agent', domain: 'order', status: 'completed', order: orderRow, findings: [] }),
  api.domainResult('customer', 'completed', { agent: 'customer_agent', domain: 'customer', status: 'completed', customer: customerRow, support_history: tickets, findings: [] }),
  api.domainResult('policy', 'completed', { agent: 'policy_agent', domain: 'policy', status: 'completed', policy: policyRow, findings: [] }),
])
check('delivery domain does not change the assembled investigation', JSON.stringify(deliveryIrrelevant) === JSON.stringify(full))

const missingOrder = api.buildInvestigation([
  api.domainResult('order', 'not_found', null),
  api.domainResult('customer', 'not_found', null),
  api.domainResult('policy', 'completed', { agent: 'policy_agent', domain: 'policy', status: 'completed', policy: policyRow, findings: [] }),
])
check('missing order -> order null', missingOrder.order === null)
check('missing order -> customer_id null', missingOrder.customer_id === null)
check('missing order -> no invented customer', missingOrder.customer === null && missingOrder.ticket_history.length === 0)

const failedDomain = api.buildInvestigation([
  api.domainResult('order', 'failed', null),
  api.domainResult('customer', 'completed', { agent: 'customer_agent', domain: 'customer', status: 'completed', customer: { customer_id: 'CUST009' }, support_history: [], findings: [] }),
  api.domainResult('policy', 'failed', null),
])
check('failed domain treated as absent', failedDomain.order === null && failedDomain.policy === null)
check('failed order still resolves customer_id from customer domain', failedDomain.customer_id === 'CUST009')

const empty = api.buildInvestigation([])
check('no results -> nothing invented', empty.order === null && empty.customer === null && empty.policy === null && empty.customer_id === null && empty.ticket_history.length === 0)

console.log('')
console.log(passed + ' passed, ' + failed + ' failed')
process.exit(failed === 0 ? 0 : 1)
