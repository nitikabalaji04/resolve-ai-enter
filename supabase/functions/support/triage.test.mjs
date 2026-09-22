// Basic tests for the ResolveAI Triage Agent pure logic (Phase 1).
//
// Run:  node supabase/functions/support/triage.test.mjs
//
// The Enter deploy bundler ships only index.ts, so the pure triage logic lives
// inline in index.ts between the "TRIAGE PURE LOGIC" markers. This harness
// extracts and exercises exactly that code - single source of truth, no drift.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, 'index.ts'), 'utf8')

const START = '// >>> TRIAGE PURE LOGIC'
const END = '// <<< TRIAGE PURE LOGIC'
const start = source.indexOf(START)
const end = source.indexOf(END)

if (start === -1 || end === -1) {
  console.error('FAIL: triage markers not found in index.ts')
  process.exit(1)
}

const bodyStart = source.indexOf('\n', start + START.length) + 1
const section = source.slice(bodyStart, end)

const api = new Function(
  section + '\nreturn { INTENTS, URGENCIES, DOMAINS, domainsForIntent, classifyByKeywords, validateTriage, buildTriagePrompt };',
)()

let passed = 0
let failed = 0

function check(name, condition, detail) {
  if (condition) {
    passed += 1
    console.log('  ok   ' + name)
  } else {
    failed += 1
    console.log('FAIL   ' + name + (detail ? ' -> ' + detail : ''))
  }
}

const EXPECTED_INTENTS = [
  'DELIVERY_DELAY',
  'WRONG_PRODUCT',
  'DAMAGED_PRODUCT',
  'REFUND_REQUEST',
  'DUPLICATE_PAYMENT',
  'ORDER_STATUS',
  'UNKNOWN',
]

console.log('')
console.log('Supported intents / urgency / domains')
for (const intent of EXPECTED_INTENTS) {
  check('intent ' + intent + ' is supported', api.INTENTS.includes(intent))
}
check('urgency values', JSON.stringify(api.URGENCIES) === JSON.stringify(['low', 'normal', 'high', 'urgent']))
check('domain values', JSON.stringify(api.DOMAINS) === JSON.stringify(['customer', 'order', 'delivery', 'policy']))

console.log('')
console.log('Deterministic classification per intent')
const classificationCases = [
  ['My express order is delayed by 4 days and still not delivered.', 'DELIVERY_DELAY'],
  ['I received the wrong product, this is not what I ordered.', 'WRONG_PRODUCT'],
  ['The monitor arrived damaged with a cracked screen.', 'DAMAGED_PRODUCT'],
  ['I want a refund for my order please.', 'REFUND_REQUEST'],
  ['I was charged twice for the same order.', 'DUPLICATE_PAYMENT'],
  ['Can you tell me the status of my order?', 'ORDER_STATUS'],
  ['Hello, I have a general question.', 'UNKNOWN'],
]
for (const pair of classificationCases) {
  const message = pair[0]
  const expected = pair[1]
  const result = api.classifyByKeywords(message)
  check('"' + message + '" -> ' + expected, result.intent === expected, 'got ' + result.intent)
}

console.log('')
console.log('Investigation plan depends on intent (not one hard-coded path)')
for (const intent of api.INTENTS) {
  const domains = api.domainsForIntent(intent)
  check(intent + ' has a non-empty plan', Array.isArray(domains) && domains.length > 0)
  check(intent + ' plan uses valid domains', domains.every(function (d) { return api.DOMAINS.includes(d) }))
}
const statusPlan = api.domainsForIntent('ORDER_STATUS').join(',')
const refundPlan = api.domainsForIntent('REFUND_REQUEST').join(',')
check('plans differ between intents', statusPlan !== refundPlan, statusPlan + ' vs ' + refundPlan)
check('ORDER_STATUS plan includes delivery', api.domainsForIntent('ORDER_STATUS').includes('delivery'))
check('REFUND_REQUEST plan includes policy', api.domainsForIntent('REFUND_REQUEST').includes('policy'))
check('UNKNOWN plan has no policy domain', !api.domainsForIntent('UNKNOWN').includes('policy'))
check('classifier output carries a plan', api.classifyByKeywords('my order is late').domains.length > 0)

console.log('')
console.log('Valid triage output is accepted and normalized')
const normalized = api.validateTriage({
  intent: 'delivery_delay',
  urgency: 'HIGH',
  domains: ['Order', 'delivery', 'order'],
  reason: 'Late delivery',
  confidence: 0.94,
})
check('valid output accepted', normalized !== null)
check('intent normalized to uppercase', normalized && normalized.intent === 'DELIVERY_DELAY')
check('urgency normalized to lowercase', normalized && normalized.urgency === 'high')
check('domains normalized and de-duplicated', normalized && JSON.stringify(normalized.domains) === JSON.stringify(['order', 'delivery']))
check('reason trimmed', normalized && normalized.reason === 'Late delivery')
check('confidence preserved', normalized && normalized.confidence === 0.94)

console.log('')
console.log('Malformed / invalid output is rejected')
const invalidCases = [
  ['null', null],
  ['undefined', undefined],
  ['a string', 'DELIVERY_DELAY'],
  ['an array', ['DELIVERY_DELAY']],
  ['an empty object', {}],
  ['missing intent', { urgency: 'normal', domains: ['order'], reason: 'x', confidence: 0.5 }],
  ['unsupported intent', { intent: 'PIZZA', urgency: 'normal', domains: ['order'], reason: 'x', confidence: 0.5 }],
  ['unsupported urgency', { intent: 'ORDER_STATUS', urgency: 'whenever', domains: ['order'], reason: 'x', confidence: 0.5 }],
  ['domains not an array', { intent: 'ORDER_STATUS', urgency: 'normal', domains: 'order', reason: 'x', confidence: 0.5 }],
  ['empty domains', { intent: 'ORDER_STATUS', urgency: 'normal', domains: [], reason: 'x', confidence: 0.5 }],
  ['unsupported domain', { intent: 'ORDER_STATUS', urgency: 'normal', domains: ['warehouse'], reason: 'x', confidence: 0.5 }],
  ['non-string domain', { intent: 'ORDER_STATUS', urgency: 'normal', domains: [42], reason: 'x', confidence: 0.5 }],
  ['missing reason', { intent: 'ORDER_STATUS', urgency: 'normal', domains: ['order'], confidence: 0.5 }],
  ['blank reason', { intent: 'ORDER_STATUS', urgency: 'normal', domains: ['order'], reason: '   ', confidence: 0.5 }],
  ['missing confidence', { intent: 'ORDER_STATUS', urgency: 'normal', domains: ['order'], reason: 'x' }],
  ['string confidence', { intent: 'ORDER_STATUS', urgency: 'normal', domains: ['order'], reason: 'x', confidence: '0.9' }],
  ['confidence above 1', { intent: 'ORDER_STATUS', urgency: 'normal', domains: ['order'], reason: 'x', confidence: 1.5 }],
  ['negative confidence', { intent: 'ORDER_STATUS', urgency: 'normal', domains: ['order'], reason: 'x', confidence: -0.1 }],
  ['NaN confidence', { intent: 'ORDER_STATUS', urgency: 'normal', domains: ['order'], reason: 'x', confidence: Number.NaN }],
]
for (const pair of invalidCases) {
  check('rejects ' + pair[0], api.validateTriage(pair[1]) === null)
}

console.log('')
console.log('Triage prompt contract')
const prompt = api.buildTriagePrompt('Where is my order?')
check('prompt includes the customer message', prompt.includes('Where is my order?'))
for (const intent of EXPECTED_INTENTS) {
  check('prompt lists intent ' + intent, prompt.includes(intent))
}
for (const domain of api.DOMAINS) {
  check('prompt lists domain ' + domain, prompt.includes(domain))
}
check('prompt asks for JSON only', prompt.toLowerCase().includes('markdown'))

console.log('')
console.log(passed + ' passed, ' + failed + ' failed')
process.exit(failed === 0 ? 0 : 1)
