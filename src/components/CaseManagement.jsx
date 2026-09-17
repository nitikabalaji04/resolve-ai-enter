import { useEffect, useState } from 'react'
import { supabase } from '../integrations/supabase/client'
import { RefreshCw, Inbox, AlertTriangle, ChevronLeft } from 'lucide-react'

const FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'escalated', label: 'Escalated' },
]

const STATUS_CLASS = {
  resolved: 'case-status resolved',
  escalated: 'case-status escalated',
}

function statusBadge(value) {
  if (!value) {
    return <span className="case-status">—</span>
  }

  const className = STATUS_CLASS[value] || 'case-status'

  return <span className={className}>{value}</span>
}

function formatDate(value) {
  if (!value) return '—'

  const date = new Date(value)

  if (Number.isNaN(date.getTime())) return '—'

  return date.toLocaleString()
}

async function fetchCases() {
  const { data, error } = await supabase
    .from('support_cases')
    .select('*')
    .order('created_at', { ascending: false })

  if (error) throw error

  return data || []
}

// Policy that relates to an approved action. Falls back to the delivery-refund
// policy used by the ResolveAI investigation flow.
const POLICY_TYPE_BY_ACTION = {
  refund_shipping_fee: 'delivery_refund',
}

// Loads the real customer / order / support-history / policy records for a
// case. Read-only — only SELECT queries are issued.
async function fetchCustomerContext(customerId, orderId, action) {
  const customerQuery = customerId
    ? supabase
        .from('customers')
        .select('*')
        .eq('customer_id', customerId)
        .maybeSingle()
    : Promise.resolve({ data: null, error: null })

  const orderQuery = orderId
    ? supabase
        .from('orders')
        .select('*')
        .eq('order_id', orderId)
        .maybeSingle()
    : Promise.resolve({ data: null, error: null })

  const ticketsQuery = customerId
    ? supabase
        .from('tickets')
        .select('*')
        .eq('customer_id', customerId)
        .order('created_date', { ascending: false })
    : Promise.resolve({ data: [], error: null })

  const policyQuery = supabase
    .from('policies')
    .select('*')
    .eq('policy_type', POLICY_TYPE_BY_ACTION[action] || 'delivery_refund')
    .order('policy_id', { ascending: true })
    .limit(1)
    .maybeSingle()

  const [customerRes, orderRes, ticketsRes, policyRes] = await Promise.all([
    customerQuery,
    orderQuery,
    ticketsQuery,
    policyQuery,
  ])

  for (const res of [customerRes, orderRes, ticketsRes, policyRes]) {
    if (res.error) throw res.error
  }

  return {
    customer: customerRes.data ?? null,
    order: orderRes.data ?? null,
    tickets: ticketsRes.data ?? [],
    policy: policyRes.data ?? null,
  }
}

export default function CaseManagement() {
  const [cases, setCases] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [filter, setFilter] = useState('all')
  const [selectedId, setSelectedId] = useState(null)
  const [contextState, setContextState] = useState({
    caseId: null,
    customer: null,
    order: null,
    tickets: [],
    policy: null,
    error: null,
  })

  const refresh = async () => {
    setLoading(true)
    setError(null)

    try {
      setCases(await fetchCases())
    } catch (err) {
      setError(
        err?.message || 'Could not load cases from the database.'
      )
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    let cancelled = false

    const load = async () => {
      try {
        const data = await fetchCases()

        if (!cancelled) {
          setCases(data)
          setLoading(false)
        }
      } catch (err) {
        if (!cancelled) {
          setError(
            err?.message || 'Could not load cases from the database.'
          )
          setLoading(false)
        }
      }
    }

    load()

    return () => {
      cancelled = true
    }
  }, [])

  const filteredCases =
    filter === 'all'
      ? cases
      : cases.filter((c) => c.resolution_status === filter)

  const selectedCase = cases.find((c) => c.case_id === selectedId) || null

  useEffect(() => {
    let cancelled = false

    const load = async () => {
      try {
        const data = await fetchCustomerContext(
          selectedCase?.customer_id,
          selectedCase?.order_id,
          selectedCase?.action
        )

        if (!cancelled) {
          setContextState({
            caseId: selectedCase?.case_id ?? null,
            ...data,
            error: null,
          })
        }
      } catch (err) {
        if (!cancelled) {
          setContextState({
            caseId: selectedCase?.case_id ?? null,
            customer: null,
            order: null,
            tickets: [],
            policy: null,
            error:
              err?.message || 'Could not load case context.',
          })
        }
      }
    }

    load()

    return () => {
      cancelled = true
    }
  }, [selectedCase])

  // Only show context that belongs to the currently selected case.
  const caseContext =
    selectedCase && contextState.caseId === selectedCase.case_id
      ? contextState
      : null

  const contextField = (label, value, full = false) => (
    <div className={`case-context-field ${full ? 'full' : ''}`}>
      <span className="case-context-field-label">{label}</span>

      <span className="case-context-field-value">
        {value === null || value === undefined || value === ''
          ? '—'
          : value}
      </span>
    </div>
  )

  const renderContextLoadingOrError = () => (
    <p className="case-context-note">
      {caseContext?.error
        ? `Could not load context: ${caseContext.error}`
        : 'Loading customer context...'}
    </p>
  )

  return (
    <div className="dashboard-page case-management-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">HUMAN AGENT</p>

          <h1>Case Management</h1>

          <p>
            Review real support cases saved by ResolveAI from the
            Enter Cloud database.
          </p>
        </div>

        <div className="case-heading-actions">
          <button
            type="button"
            className="case-refresh-btn"
            onClick={refresh}
            disabled={loading}
          >
            <RefreshCw size={13} />

            <span>Refresh</span>
          </button>

          <div className="ai-status">
            <span></span>

            {loading ? 'LOADING CASES' : `${cases.length} CASES`}
          </div>
        </div>
      </div>

      {error && (
        <div className="case-error-banner">
          <AlertTriangle size={16} />

          <div>
            <strong>Could not load cases</strong>

            <p>{error}</p>
          </div>

          <button type="button" onClick={refresh}>
            Try again
          </button>
        </div>
      )}

      <div className="case-management-grid">
        <section className="panel case-list-panel">
          <div className="case-filter-row">
            {FILTERS.map((f) => (
              <button
                key={f.value}
                type="button"
                className={`case-filter-btn ${
                  filter === f.value ? 'active' : ''
                }`}
                onClick={() => setFilter(f.value)}
              >
                {f.label}

                <span>
                  {f.value === 'all'
                    ? cases.length
                    : cases.filter(
                        (c) => c.resolution_status === f.value
                      ).length}
                </span>
              </button>
            ))}
          </div>

          <div className="case-list">
            {loading && !error && (
              <div className="case-state-box">
                <RefreshCw size={20} className="case-spin" />

                <p>Loading cases...</p>
              </div>
            )}

            {!loading && !error && filteredCases.length === 0 && (
              <div className="case-state-box">
                <Inbox size={20} />

                <strong>No cases found</strong>

                <p>
                  {filter === 'all'
                    ? 'No support cases have been saved yet. Submit a request from the Customer Support screen to create one.'
                    : `No ${filter} cases in the list yet.`}
                </p>
              </div>
            )}

            {!loading &&
              !error &&
              filteredCases.map((c) => (
                <button
                  key={c.case_id}
                  type="button"
                  className={`case-list-item ${
                    selectedCase?.case_id === c.case_id ? 'active' : ''
                  }`}
                  onClick={() => setSelectedId(c.case_id)}
                >
                  <div className="case-list-top">
                    <strong>{c.case_id}</strong>

                    {statusBadge(c.resolution_status)}
                  </div>

                  <div className="case-list-meta">
                    <span>
                      Customer {c.customer_id || '—'} · Order{' '}
                      {c.order_id || '—'}
                    </span>

                    <span>{formatDate(c.created_at)}</span>
                  </div>

                  <p className="case-list-message">
                    {c.customer_message || 'No message recorded.'}
                  </p>
                </button>
              ))}
          </div>
        </section>

        <section className="panel case-detail-panel">
          {!selectedCase ? (
            <div className="case-detail-empty">
              <Inbox size={22} />

              <strong>Select a case</strong>

              <p>
                Choose a case from the list to see its full
                investigation and decision details.
              </p>
            </div>
          ) : (
            <>
              <div className="case-detail-header">
                <div>
                  <p className="eyebrow">CASE DETAILS</p>

                  <h3>{selectedCase.case_id}</h3>
                </div>

                {statusBadge(selectedCase.resolution_status)}
              </div>

              <div className="case-detail-body">
                <div className="case-detail-field full">
                  <span className="case-detail-label">
                    CUSTOMER MESSAGE
                  </span>

                  <p className="case-detail-text">
                    {selectedCase.customer_message || '—'}
                  </p>
                </div>

                <div className="case-detail-field full">
                  <span className="case-detail-label">INTENT</span>

                  <p className="case-detail-text">
                    {selectedCase.intent || '—'}
                  </p>
                </div>

                <div className="case-detail-field">
                  <span className="case-detail-label">AI DECISION</span>

                  <p className="case-detail-text">
                    {selectedCase.decision || '—'}
                  </p>
                </div>

                <div className="case-detail-field">
                  <span className="case-detail-label">ACTION</span>

                  <p className="case-detail-text">
                    {selectedCase.action || '—'}
                  </p>
                </div>

                <div className="case-detail-field full">
                  <span className="case-detail-label">REASON</span>

                  <p className="case-detail-text">
                    {selectedCase.reason || '—'}
                  </p>
                </div>

                <div className="case-detail-field full">
                  <span className="case-detail-label">EVIDENCE</span>

                  <div className="evidence-list">
                    {Array.isArray(selectedCase.evidence) &&
                    selectedCase.evidence.length > 0 ? (
                      selectedCase.evidence.map((item, index) => (
                        <div key={index} className="evidence-item">
                          <span className="evidence-dot" />

                          <p>{item}</p>
                        </div>
                      ))
                    ) : (
                      <p className="case-detail-text">—</p>
                    )}
                  </div>
                </div>

                <div className="case-detail-field">
                  <span className="case-detail-label">
                    ACTION STATUS
                  </span>

                  <p className="case-detail-text">
                    {selectedCase.action_status || '—'}
                  </p>
                </div>

                <div className="case-detail-field">
                  <span className="case-detail-label">
                    VERIFICATION STATUS
                  </span>

                  <p className="case-detail-text">
                    {selectedCase.verification_status || '—'}
                  </p>
                </div>

                <div className="case-detail-field">
                  <span className="case-detail-label">
                    RESOLUTION STATUS
                  </span>

                  <p className="case-detail-text">
                    {selectedCase.resolution_status || '—'}
                  </p>
                </div>

                <div className="case-detail-field">
                  <span className="case-detail-label">CREATED AT</span>

                  <p className="case-detail-text">
                    {formatDate(selectedCase.created_at)}
                  </p>
                </div>

                <div
                  className={`case-detail-field full ${
                    selectedCase.escalation_reason
                      ? ''
                      : 'case-detail-empty-field'
                  }`}
                >
                  <span className="case-detail-label">
                    ESCALATION REASON
                  </span>

                  <p className="case-detail-text">
                    {selectedCase.escalation_reason || 'Not escalated — no escalation reason.'}
                  </p>
                </div>

                <div className="case-detail-section full">
                  <span className="case-detail-label">
                    CUSTOMER INFORMATION
                  </span>

                  {caseContext === null ? (
                    renderContextLoadingOrError()
                  ) : !caseContext.customer ? (
                    <p className="case-context-note">
                      Customer not found
                    </p>
                  ) : (
                    <div className="case-context-content">
                      {contextField(
                        'Customer ID',
                        caseContext.customer.customer_id
                      )}

                      {contextField('Name', caseContext.customer.name)}

                      {contextField(
                        'Email',
                        caseContext.customer.email
                      )}

                      {contextField(
                        'Phone',
                        caseContext.customer.phone
                      )}

                      {contextField(
                        'Membership',
                        caseContext.customer.membership
                      )}

                      {contextField(
                        'Total Orders',
                        caseContext.customer.total_orders
                      )}
                    </div>
                  )}
                </div>

                <div className="case-detail-section full">
                  <span className="case-detail-label">
                    ORDER INFORMATION
                  </span>

                  {caseContext === null ? (
                    renderContextLoadingOrError()
                  ) : !caseContext.order ? (
                    <p className="case-context-note">
                      Order not found
                    </p>
                  ) : (
                    <div className="case-context-content">
                      {contextField(
                        'Order ID',
                        caseContext.order.order_id
                      )}

                      {contextField(
                        'Product',
                        caseContext.order.product
                      )}

                      {contextField('Amount', caseContext.order.amount)}

                      {contextField(
                        'Shipping / Delivery Type',
                        caseContext.order.shipping_type
                      )}

                      {contextField(
                        'Delivery Status',
                        caseContext.order.status
                      )}

                      {contextField(
                        'Days Delayed',
                        caseContext.order.delivery_days_delayed
                      )}

                      {contextField(
                        'Expected Delivery',
                        caseContext.order.expected_delivery
                      )}

                      {contextField(
                        'Actual Delivery',
                        caseContext.order.actual_delivery
                      )}

                      {contextField(
                        'Payment Status',
                        caseContext.order.payment_status
                      )}

                      {contextField(
                        'Refund Status',
                        caseContext.order.refund_status
                      )}
                    </div>
                  )}
                </div>

                <div className="case-detail-section full">
                  <span className="case-detail-label">
                    SUPPORT HISTORY
                  </span>

                  {caseContext === null ? (
                    renderContextLoadingOrError()
                  ) : caseContext.tickets.length === 0 ? (
                    <p className="case-context-note">
                      No support history found for this customer.
                    </p>
                  ) : (
                    <div className="case-ticket-list">
                      {caseContext.tickets.map((ticket) => (
                        <div
                          key={ticket.ticket_id}
                          className="case-ticket-item"
                        >
                          <div className="case-ticket-top">
                            <strong>
                              {ticket.subject || ticket.ticket_id}
                            </strong>

                            <span
                              className={`case-ticket-status ${
                                ticket.status || ''
                              }`}
                            >
                              {ticket.status || '—'}
                            </span>
                          </div>

                          <p>{ticket.message}</p>

                          <div className="case-ticket-meta">
                            <span>{ticket.ticket_id}</span>

                            <span>{ticket.priority}</span>

                            <span>{ticket.created_date}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="case-detail-section full">
                  <span className="case-detail-label">
                    POLICY CONTEXT
                  </span>

                  {caseContext === null ? (
                    renderContextLoadingOrError()
                  ) : !caseContext.policy ? (
                    <p className="case-context-note">
                      Policy not found
                    </p>
                  ) : (
                    <div className="case-context-content">
                      {contextField(
                        'Policy',
                        caseContext.policy.title
                      )}

                      {contextField(
                        'Policy Type',
                        caseContext.policy.policy_type
                      )}

                      <div className="case-context-field full">
                        <span className="case-context-field-label">
                          Conditions
                        </span>

                        <ul className="case-policy-conditions">
                          {Array.isArray(caseContext.policy.conditions) &&
                            caseContext.policy.conditions.map(
                              (condition, index) => (
                                <li key={index}>{condition}</li>
                              )
                            )}
                        </ul>
                      </div>

                      <div className="case-context-field full">
                        <span className="case-context-field-label">
                          Action
                        </span>

                        <span className="case-context-field-value">
                          {caseContext.policy.action}
                        </span>
                      </div>
                    </div>
                  )}
                </div>

                <div className="case-detail-back">
                  <ChevronLeft size={14} />

                  <button
                    type="button"
                    onClick={() => setSelectedId(null)}
                  >
                    Back to list
                  </button>
                </div>
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  )
}
