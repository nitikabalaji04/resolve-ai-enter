// Basic tests for the Phase 2B Customer Agent.
//
// Run:  node supabase/functions/support/customer-agent.test.mjs
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
const agentBlock = block('// >>> CUSTOMER AGENT PURE LOGIC', '// <<< CUSTOMER AGENT PURE LOGIC')

const api = new Function(
  triageBlock + plannerBlock + agentBlock +
    '\nreturn { DOMAINS, INTENT_DOMAINS, CUSTOMER_AGENT_NAME, planFromTriage, customerFindings, customerAgentResult };',
)()

let passed = 0
let failed = 0
function check(name, condition, detail) {
  if (condition) { passed += 1; console.log('  ok   ' + name) }
  else { failed += 1; console.log('FAIL   ' + name + (detail ? ' -> ' + detail : '')) }
}

const AGENT_KEYS = ['agent', 'customer', 'domain', 'findings', 'status', 'support_history']

function shapeOk(result) {
  return (
    result &&
    JSON.stringify(Object.keys(result).sort()) === JSON.stringify(AGENT_KEYS) &&
    result.agent === 'customer_agent' &&
    result.domain === 'customer' &&
    typeof result.status === 'string' &&
    (result.customer === null || typeof result.customer === 'object') &&
    Array.isArray(result.support_history) &&
    Array.isArray(result.findings)
  )
}

function findingsOk(findings) {
  return findings.every(function (f) {
    return (
      f &&
      typeof f.finding === 'string' && f.finding.trim() !== '' &&
      ['customers', 'tickets'].includes(f.source) &&
      typeof f.confidence === 'number' && f.confidence > 0 && f.confidence <= 1
    )
  })
}

const customerRow = {
  customer_id: 'CUST017',
  name: 'Riya Saxena',
  email: 'riya.saxena@example.com',
  phone: '+91-9876543226',
  membership: 'Premium',
  total_orders: 2,
}

console.log('')
console.log('1. Customer found')
const found = api.customerAgentResult({ customer: customerRow, supportHistory: [] })
check('status is completed', found.status === 'completed')
check('customer row preserved', found.customer && found.customer.name === 'Riya Saxena')
check('structured output shape', shapeOk(found))
check('findings cite customers table', found.findings.every(function (f) { return f.source === 'customers' || f.source === 'tickets' }))
check('findings include the name', found.findings.some(function (f) { return f.finding.includes('Riya Saxena') }))
check('findings include the customer id', found.findings.some(function (f) { return f.finding.includes('CUST017') }))
check('findings include membership', found.findings.some(function (f) { return f.finding.includes('Premium') }))
check('findings include total orders', found.findings.some(function (f) { return f.finding.includes('2') }))
check('findings are well formed', findingsOk(found.findings))
check('contact finding reports availability only', found.findings.some(function (f) { return f.finding === 'Contact details on file: email + phone' }))
check('no raw email leaked into findings', !JSON.stringify(found.findings).includes('riya.saxena@example.com'))

console.log('')
console.log('2. Customer not found')
const notFound = api.customerAgentResult({ customer: null, supportHistory: [] })
check('status is not_found', notFound.status === 'not_found')
check('customer is null', notFound.customer === null)
check('support history empty', notFound.support_history.length === 0)
check('no findings invented', notFound.findings.length === 0)
check('structured output shape', shapeOk(notFound))

console.log('')
console.log('3. Support history available')
const history = [
  { ticket_id: 'TKT1005', status: 'open', created_date: '2026-09-13', subject: 'Express delivery delayed' },
  { ticket_id: 'TKT1016', status: 'open', created_date: '2026-09-14', subject: 'Wrong colour' },
  { ticket_id: 'TKT1001', status: 'resolved', created_date: '2026-09-10', subject: 'Old issue' },
]
const withHistory = api.customerAgentResult({ customer: customerRow, supportHistory: history })
check('status is completed', withHistory.status === 'completed')
check('support history preserved', withHistory.support_history.length === 3)
check('ticket count finding', withHistory.findings.some(function (f) { return f.finding === 'Support history contains 3 ticket(s)' }))
check('open ticket finding', withHistory.findings.some(function (f) { return f.finding === '2 ticket(s) still open' }))
check('latest ticket finding (robust to input ordering)', withHistory.findings.some(function (f) { return f.finding === 'Most recent ticket dated 2026-09-14' }))
const reversed = api.customerAgentResult({ customer: customerRow, supportHistory: history.slice().reverse() })
check('same latest ticket when rows are reversed', reversed.findings.some(function (f) { return f.finding === 'Most recent ticket dated 2026-09-14' }))
check('history findings cite tickets table', withHistory.findings.filter(function (f) { return f.source === 'tickets' }).length >= 3)
check('findings are well formed', findingsOk(withHistory.findings))

console.log('')
console.log('4. Empty support history')
const emptyHistory = api.customerAgentResult({ customer: customerRow, supportHistory: [] })
check('status is completed', emptyHistory.status === 'completed')
check('support history empty', emptyHistory.support_history.length === 0)
check('records that no history exists', emptyHistory.findings.some(function (f) { return f.finding === 'No support history recorded for this customer' }))
check('still reports the customer profile', emptyHistory.findings.some(function (f) { return f.finding.includes('CUST017') }))
check('findings are well formed', findingsOk(emptyHistory.findings))

console.log('')
console.log('5. Database / query failure')
const customerFailed = api.customerAgentResult({ customerError: 'connection reset', customer: customerRow, supportHistory: history })
check('customer query error -> failed', customerFailed.status === 'failed')
check('failure carries no customer', customerFailed.customer === null)
check('failure carries no history', customerFailed.support_history.length === 0)
check('failure invents no findings', customerFailed.findings.length === 0)
check('structured output shape', shapeOk(customerFailed))
const ticketsFailed = api.customerAgentResult({ ticketsError: 'timeout', customer: customerRow, supportHistory: history })
check('ticket query error -> failed', ticketsFailed.status === 'failed')
check('structured output shape', shapeOk(ticketsFailed))

console.log('')
console.log('6. Structured output validation')
for (const result of [found, notFound, withHistory, emptyHistory, customerFailed, ticketsFailed]) {
  check('valid shape for status ' + result.status, shapeOk(result))
}
check('agent name constant', api.CUSTOMER_AGENT_NAME === 'customer_agent')
const sparse = api.customerAgentResult({ customer: { customer_id: 'CUST999' }, supportHistory: [] })
check('sparse row only reports real fields', sparse.findings.some(function (f) { return f.finding === 'Customer ID: CUST999' }) && !sparse.findings.some(function (f) { return f.finding.includes('Membership') }))
check('sparse findings well formed', findingsOk(sparse.findings))

console.log('')
console.log('7. Customer Agent only runs when the plan contains "customer"')
const noCustomerPlan = api.planFromTriage({ intent: 'PIZZA', domains: ['order'] })
check('plan without customer stays without customer', !noCustomerPlan.includes('customer'), noCustomerPlan.join(','))
check('executor would not run the agent for that plan', noCustomerPlan.every(function (d) { return d !== 'customer' }))
const statusPlan = api.planFromTriage({ intent: 'ORDER_STATUS' })
check('ORDER_STATUS plan includes customer', statusPlan.includes('customer'), statusPlan.join(','))
const refundPlan = api.planFromTriage({ intent: 'REFUND_REQUEST' })
check('REFUND_REQUEST plan includes customer', refundPlan.includes('customer'), refundPlan.join(','))
const deliveryPlan = api.planFromTriage({ intent: 'DELIVERY_DELAY' })
check('DELIVERY_DELAY plan includes customer', deliveryPlan.includes('customer'), deliveryPlan.join(','))
check('every intent plan includes customer (current design)', Object.keys(api.INTENT_DOMAINS).every(function (i) { return api.INTENT_DOMAINS[i].includes('customer') }))
check('agent never invents extra domains', api.planFromTriage({ intent: 'ORDER_STATUS' }).every(function (d) { return api.DOMAINS.includes(d) }))

console.log('')
console.log(passed + ' passed, ' + failed + ' failed')
process.exit(failed === 0 ? 0 : 1)
