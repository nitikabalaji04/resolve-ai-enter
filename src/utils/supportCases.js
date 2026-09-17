import { supabase } from '../integrations/supabase/client'

// Shared read path for every page that renders real case data.
// RLS only returns rows for authenticated users, so these helpers are
// intentionally consistent across Dashboard, Investigations and the
// Agent Dashboard: every page reads the same support_cases rows.

export async function fetchSupportCases() {
  const { data, error } = await supabase
    .from('support_cases')
    .select(
      'case_id, order_id, customer_id, customer_message, intent, decision, reason, action, action_status, verification_status, resolution_status, escalation_reason, case_status, agent_note, resolved_at, created_at'
    )
    .order('created_at', { ascending: false })

  if (error) throw error

  return data || []
}

// Builds a { customer_id: name } lookup used to display real customer names.
export async function fetchCustomerMap() {
  const { data, error } = await supabase
    .from('customers')
    .select('customer_id, name')

  if (error) throw error

  const map = {}

  for (const row of data || []) {
    map[row.customer_id] = row.name
  }

  return map
}

export function isHumanResolved(c) {
  return c.case_status === 'human_resolved'
}

export function isResolved(c) {
  return (
    c.resolution_status === 'resolved' ||
    c.case_status === 'human_resolved'
  )
}

export function isEscalated(c) {
  return (
    c.resolution_status === 'escalated' &&
    c.case_status !== 'human_resolved'
  )
}

export function isActive(c) {
  if (c.case_status === 'human_resolved') return false

  if (c.case_status === 'escalated' || c.case_status === 'in_review') {
    return true
  }

  // Older escalated rows before the human lifecycle existed.
  if (c.case_status == null && c.resolution_status === 'escalated') {
    return true
  }

  return false
}

// Statistics definitions (no double counting):
// - Total: all records
// - Active: escalated or in_review, not human_resolved
// - Resolved: resolution_status = resolved OR case_status = human_resolved
// - Escalated: resolution_status = escalated AND not human_resolved
// - Resolution rate: round(resolved / total * 100), 0 when there are no cases
export function computeStats(rows) {
  const total = rows.length

  const resolved = rows.filter(isResolved).length
  const escalated = rows.filter(isEscalated).length
  const active = rows.filter(isActive).length
  const rate = total === 0 ? 0 : Math.round((resolved / total) * 100)

  return { total, resolved, escalated, active, rate }
}

export function recentStatus(c) {
  if (c.case_status === 'human_resolved' || c.resolution_status === 'resolved') {
    return { label: 'Resolved', className: 'case-status resolved' }
  }

  if (c.case_status === 'in_review') {
    return { label: 'In Review', className: 'case-status investigating' }
  }

  return { label: 'Escalated', className: 'case-status escalated' }
}

export function titleFrom(c) {
  const message = (c.customer_message || '').trim()

  if (!message) return 'No customer message'

  return message.length > 60 ? `${message.slice(0, 60)}…` : message
}

export function customerName(c, customerMap) {
  const name = customerMap && customerMap[c.customer_id]

  return name || c.customer_id || '—'
}

export function capitalize(value) {
  if (!value) return '—'

  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`
}

export function formatDate(value) {
  if (!value) return '—'

  const date = new Date(value)

  if (Number.isNaN(date.getTime())) return '—'

  return date.toLocaleString()
}

export function sameDayLocal(value, compare) {
  const dateA = new Date(value)
  const dateB = new Date(compare)

  if (Number.isNaN(dateA.getTime()) || Number.isNaN(dateB.getTime())) {
    return false
  }

  return (
    dateA.getFullYear() === dateB.getFullYear() &&
    dateA.getMonth() === dateB.getMonth() &&
    dateA.getDate() === dateB.getDate()
  )
}
