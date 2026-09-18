import { useEffect, useRef, useState } from 'react'
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

// Human-readable labels for the action field shown in the case summary.
const ACTION_LABELS = {
  refund_shipping_fee: 'Refund Shipping Fee',
  human_review: 'Human Review',
  no_action: 'No Action',
}

function actionLabel(value) {
  return ACTION_LABELS[value] || value || '—'
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

// Applies a human-agent handling update to one case and returns the fresh row.
// The authenticated session's JWT is sent automatically by the Supabase client;
// RLS limits this to the agent-handling columns.
async function updateSupportCase(caseId, patch) {
  const { data, error } = await supabase
    .from('support_cases')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('case_id', caseId)
    .select()
    .single()

  if (error) throw error

  return data
}

// Sends only the minimum fields needed to summarize the selected case.
function buildSummaryPayload(selectedCase, context) {
  const order = context?.order

  return {
    case_id: selectedCase.case_id,
    customer_message: selectedCase.customer_message,
    intent: selectedCase.intent,
    decision: selectedCase.decision,
    reason: selectedCase.reason,
    evidence: selectedCase.evidence,
    escalation_reason: selectedCase.escalation_reason,
    customer: context?.customer
      ? {
          name: context.customer.name,
          membership: context.customer.membership,
        }
      : null,
    order: order
      ? {
          order_id: order.order_id,
          product: order.product,
          amount: order.amount,
          status: order.status,
          shipping_type: order.shipping_type,
          delivery_days_delayed: order.delivery_days_delayed,
          expected_delivery: order.expected_delivery,
          actual_delivery: order.actual_delivery,
          payment_status: order.payment_status,
          refund_status: order.refund_status,
        }
      : null,
    support_history:
      context?.tickets?.map((t) => ({
        subject: t.subject,
        message: t.message,
        status: t.status,
        created_date: t.created_date,
      })) || [],
    policy: context?.policy
      ? {
          title: context.policy.title,
          action: context.policy.action,
        }
      : null,
  }
}

// Calls the case-summary backend function, which keeps the Qwen API token
// server-side. Returns the validated { issue, investigation, why_escalated,
// recommended_agent_check } object.
async function requestCaseSummary(payload) {
  const { data, error } = await supabase.functions.invoke(
    'case-summary',
    {
      body: { case: payload },
    }
  )

  if (error) {
    throw new Error('AI summary unavailable.')
  }

  if (
    !data ||
    typeof data !== 'object' ||
    typeof data.error === 'string'
  ) {
    throw new Error('AI summary unavailable.')
  }

  return data
}

export default function CaseManagement({ user }) {
  const [cases, setCases] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [filter, setFilter] = useState('all')
  const [selectedId, setSelectedId] = useState(null)
  const [noteDraft, setNoteDraft] = useState('')
  const [actionLoading, setActionLoading] = useState(false)
  const [actionError, setActionError] = useState(null)
  const [actionNotice, setActionNotice] = useState(null)
  const [summaries, setSummaries] = useState({})
  const summaryInFlight = useRef(new Set())
  const [showDetails, setShowDetails] = useState(false)
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

  // Generate an AI Case Summary on demand: only for escalated cases the agent
  // opens, only after the case context is loaded, and at most once per case per
  // session (cached in `summaries`; `summaryInFlight` guards concurrent runs so
  // normal React re-renders never trigger duplicate Qwen calls).
  const needsSummary =
    selectedCase?.resolution_status === 'escalated'

  // Brief default-view values. The full customer/order context stays under
  // "View Details".
  const summaryCustomerName =
    caseContext?.customer?.name ||
    selectedCase?.customer_id ||
    'Not available'

  const summaryIssue = (() => {
    const message = (selectedCase?.customer_message || '').trim()

    if (!message) return 'No customer message'

    return message.length > 80 ? `${message.slice(0, 80)}…` : message
  })()

  useEffect(() => {
    if (!needsSummary || !selectedCase) return

    if (caseContext === null) return

    const caseId = selectedCase.case_id

    if (summaries[caseId]) return

    if (summaryInFlight.current.has(caseId)) return

    summaryInFlight.current.add(caseId)

    let cancelled = false

    const load = async () => {
      try {
        const data = await requestCaseSummary(
          buildSummaryPayload(selectedCase, caseContext)
        )

        if (!cancelled) {
          setSummaries((prev) => ({
            ...prev,
            [caseId]: { status: 'ready', data },
          }))
        }
      } catch (err) {
        if (!cancelled) {
          setSummaries((prev) => ({
            ...prev,
            [caseId]: {
              status: 'error',
              message:
                err?.message || 'AI summary unavailable.',
            },
          }))
        }
      } finally {
        summaryInFlight.current.delete(caseId)
      }
    }

    load()

    return () => {
      cancelled = true
    }
  }, [needsSummary, selectedCase, caseContext, summaries])

  const replaceCaseInList = (updated) => {
    setCases((prev) =>
      prev.map((c) => (c.case_id === updated.case_id ? updated : c))
    )
  }

  const runAction = async (patch, successMessage) => {
    if (!user || !selectedCase) return

    setActionLoading(true)
    setActionError(null)
    setActionNotice(null)

    try {
      const updated = await updateSupportCase(
        selectedCase.case_id,
        patch
      )

      replaceCaseInList(updated)
      setActionNotice(successMessage)
    } catch (err) {
      setActionError(
        err?.message || 'Could not update the case.'
      )
    } finally {
      setActionLoading(false)
    }
  }

  const startReview = () =>
    runAction(
      { case_status: 'in_review' },
      'Review started.'
    )

  const resolveCase = () =>
    runAction(
      {
        case_status: 'human_resolved',
        agent_id: user?.id,
        agent_email: user?.email,
        agent_note: noteDraft || selectedCase?.agent_note || null,
        resolved_at: new Date().toISOString(),
      },
      'Case resolved.'
    )

  const keepEscalated = () =>
    runAction(
      {
        case_status: 'escalated',
        agent_note: noteDraft || selectedCase?.agent_note || null,
      },
      'Case kept escalated.'
    )

  const saveNote = () =>
    runAction(
      { agent_note: noteDraft || null },
      'Note saved.'
    )

  const renderAgentActions = () => {
    if (!user || !selectedCase) return null

    const caseStatus = selectedCase.case_status

    if (caseStatus === 'human_resolved') {
      return (
        <div className="case-detail-section full">
          <span className="case-detail-label">
            HUMAN AGENT HANDLING
          </span>

          <div className="agent-case-status">
            <div className="agent-case-status-row">
              <span>Case Status</span>
              <strong>Human Resolved</strong>
            </div>

            <div className="agent-case-status-row">
              <span>Resolved By</span>
              <strong>{selectedCase.agent_email || '—'}</strong>
            </div>

            <div className="agent-case-status-row">
              <span>Resolved At</span>
              <strong>{formatDate(selectedCase.resolved_at)}</strong>
            </div>

            {selectedCase.agent_note && (
              <div className="agent-case-note">
                <span>Agent Note</span>
                <p>{selectedCase.agent_note}</p>
              </div>
            )}
          </div>
        </div>
      )
    }

    const inReview = caseStatus === 'in_review'

    return (
      <div className="case-detail-section full">
        <span className="case-detail-label">
          HUMAN AGENT HANDLING
        </span>

        <div className="agent-case-status">
          <div className="agent-case-status-row">
            <span>Case Status</span>
            <strong>{inReview ? 'In Review' : 'Escalated'}</strong>
          </div>
        </div>

        {actionError && (
          <div className="agent-action-message error">
            {actionError}
          </div>
        )}

        {actionNotice && (
          <div className="agent-action-message notice">
            {actionNotice}
          </div>
        )}

        <div className="agent-action-row">
          {!inReview && (
            <button
              type="button"
              className="agent-action-btn primary"
              onClick={startReview}
              disabled={actionLoading}
            >
              {actionLoading ? 'Please wait...' : 'Start Review'}
            </button>
          )}

          {inReview && (
            <>
              <button
                type="button"
                className="agent-action-btn primary"
                onClick={resolveCase}
                disabled={actionLoading}
              >
                {actionLoading ? 'Please wait...' : 'Resolve Case'}
              </button>

              <button
                type="button"
                className="agent-action-btn"
                onClick={keepEscalated}
                disabled={actionLoading}
              >
                Keep Escalated
              </button>
            </>
          )}
        </div>

        <div className="agent-note-area">
          <textarea
            value={noteDraft}
            onChange={(e) => setNoteDraft(e.target.value)}
            placeholder="Add an agent note (optional)..."
            rows={3}
          />

          <button
            type="button"
            className="agent-action-btn"
            onClick={saveNote}
            disabled={actionLoading}
          >
            {actionLoading ? 'Saving...' : 'Add Agent Note'}
          </button>
        </div>
      </div>
    )
  }

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
                  onClick={() => {
                    setSelectedId(c.case_id)
                    setNoteDraft(c.agent_note || '')
                    setActionError(null)
                    setActionNotice(null)
                  }}
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
                <div className="case-summary">
                  <div className="case-summary-field">
                    <span>Customer</span>

                    <strong>{summaryCustomerName}</strong>
                  </div>

                  <div className="case-summary-field">
                    <span>Order</span>

                    <strong>
                      {selectedCase.order_id
                        ? `#${selectedCase.order_id}`
                        : 'Not available'}
                    </strong>
                  </div>

                  <div className="case-summary-field full">
                    <span>Issue</span>

                    <strong>{summaryIssue}</strong>
                  </div>

                  <div className="case-summary-field">
                    <span>AI Decision</span>

                    <strong>
                      {(selectedCase.decision || '—').toUpperCase()}
                    </strong>
                  </div>

                  <div className="case-summary-field">
                    <span>Action</span>

                    <strong>{actionLabel(selectedCase.action)}</strong>
                  </div>

                  <div className="case-summary-field full">
                    <span>Reason</span>

                    <strong>{selectedCase.reason || '—'}</strong>
                  </div>

                  <div className="case-summary-field">
                    <span>Status</span>

                    <strong>{statusBadge(selectedCase.resolution_status)}</strong>
                  </div>
                </div>

                {selectedCase.case_status && renderAgentActions()}

                <button
                  type="button"
                  className="case-details-toggle"
                  onClick={() => setShowDetails((v) => !v)}
                >
                  {showDetails ? 'Hide Details' : 'View Details'}
                </button>

                {showDetails && (
                  <>
                {needsSummary && (
                  <div className="case-detail-section full">
                    <span className="case-detail-label">
                      AI CASE SUMMARY
                    </span>

                    {(() => {
                      const summary =
                        summaries[selectedCase.case_id]

                      if (!summary) {
                        return (
                          <p className="case-context-note">
                            Generating summary...
                          </p>
                        )
                      }

                      if (summary.status === 'error') {
                        return (
                          <p className="case-context-note">
                            {summary.message}
                          </p>
                        )
                      }

                      return (
                        <div className="ai-summary">
                          <div className="ai-summary-block">
                            <span>Issue</span>

                            <p>{summary.data.issue}</p>
                          </div>

                          <div className="ai-summary-block">
                            <span>Investigation</span>

                            <p>{summary.data.investigation}</p>
                          </div>

                          <div className="ai-summary-block">
                            <span>Why AI Escalated</span>

                            <p>{summary.data.why_escalated}</p>
                          </div>

                          <div className="ai-summary-block">
                            <span>
                              Recommended Agent Check
                            </span>

                            <p>
                              {summary.data.recommended_agent_check}
                            </p>
                          </div>
                        </div>
                      )
                    })()}
                  </div>
                )}

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
                  </>
                )}
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  )
}
