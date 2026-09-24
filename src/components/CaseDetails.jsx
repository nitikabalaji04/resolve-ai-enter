import { Fragment, useEffect, useRef, useState } from 'react'
import { supabase } from '../integrations/supabase/client'
import {
  ArrowRight,
  Brain,
  ChevronDown,
  ChevronLeft,
  ChevronUp,
  History,
  Inbox,
  ShieldCheck,
} from 'lucide-react'
import CaseExecutionTrace from './CaseExecutionTrace'
import CaseStatusBadge from './CaseStatusBadge'
import { formatDate } from '../utils/supportCases'
import { fetchCaseTrace, normalizeTrace } from '../utils/executionTrace'

// Dedicated, read-only-first Case Details view.
//
// It shows only the most important information for one case and keeps the full
// execution trace behind an expandable section. Nothing here changes the
// backend, the stored trace or the recorded case data: the human agent actions
// reuse the existing case-management update path.

const ACTION_LABELS = {
  refund_shipping_fee: 'Refund Shipping Fee',
  product_refund: 'Product Refund',
  human_review: 'Human Review',
  no_action: 'No Action',
}

function actionLabel(value) {
  return ACTION_LABELS[value] || value || '—'
}

function display(value) {
  if (value === null || value === undefined || value === '') return '—'

  return value
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
// server-side.
async function requestCaseSummary(payload) {
  const { data, error } = await supabase.functions.invoke('case-summary', {
    body: { case: payload },
  })

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

function AiCaseSummary({ state }) {
  if (!state) {
    return <p className="case-context-note">Generating summary...</p>
  }

  if (state.status === 'error') {
    return <p className="case-context-note">{state.message}</p>
  }

  return (
    <div className="ai-summary">
      <div className="ai-summary-block">
        <span>Issue</span>
        <p>{state.data.issue}</p>
      </div>

      <div className="ai-summary-block">
        <span>Investigation</span>
        <p>{state.data.investigation}</p>
      </div>

      <div className="ai-summary-block">
        <span>Why AI Escalated</span>
        <p>{state.data.why_escalated}</p>
      </div>

      <div className="ai-summary-block">
        <span>Recommended Agent Check</span>
        <p>{state.data.recommended_agent_check}</p>
      </div>
    </div>
  )
}

function Card({ title, children, full = false, aside = null }) {
  return (
    <section className={`panel case-details-card ${full ? 'full' : ''}`}>
      <div className="case-details-card-head">
        <span className="case-detail-label">{title}</span>

        {aside}
      </div>

      {children}
    </section>
  )
}

function Facts({ items }) {
  return (
    <div className="case-details-facts">
      {items.map((item) => (
        <div key={item.label}>
          <span>{item.label}</span>

          <strong>{display(item.value)}</strong>
        </div>
      ))}
    </div>
  )
}

function ExecutionFlow({ flow }) {
  return (
    <div className="case-flow">
      {flow.map((step, index) => {
        const Icon = step.icon

        return (
          <Fragment key={step.key}>
            <div className={`case-flow-step ${step.statusClass}`}>
              <div className="case-flow-icon">
                <Icon size={15} />
              </div>

              <strong>{step.label}</strong>

              <span className="case-flow-status">{step.statusLabel}</span>

              {step.value && (
                <span className="case-flow-value">{step.value}</span>
              )}

              {step.detail && (
                <span className="case-flow-detail">{step.detail}</span>
              )}
            </div>

            {index < flow.length - 1 && (
              <ArrowRight size={14} className="case-flow-arrow" />
            )}
          </Fragment>
        )
      })}
    </div>
  )
}

export default function CaseDetails({ caseRecord, user, onBack, onCaseUpdated }) {
  const [contextState, setContextState] = useState({
    caseId: null,
    customer: null,
    order: null,
    tickets: [],
    policy: null,
    error: null,
  })
  const [loadedTrace, setLoadedTrace] = useState(null)
  const [summaries, setSummaries] = useState({})
  const summaryInFlight = useRef(new Set())
  const [noteDraft, setNoteDraft] = useState(caseRecord?.agent_note || '')
  const [actionLoading, setActionLoading] = useState(false)
  const [actionError, setActionError] = useState(null)
  const [actionNotice, setActionNotice] = useState(null)
  const [showTrace, setShowTrace] = useState(false)
  const [showHistory, setShowHistory] = useState(false)

  const caseId = caseRecord?.case_id ?? null

  useEffect(() => {
    let cancelled = false

    const load = async () => {
      try {
        const data = await fetchCustomerContext(
          caseRecord?.customer_id,
          caseRecord?.order_id,
          caseRecord?.action
        )

        if (!cancelled) {
          setContextState({ caseId, ...data, error: null })
        }
      } catch (err) {
        if (!cancelled) {
          setContextState({
            caseId,
            customer: null,
            order: null,
            tickets: [],
            policy: null,
            error: err?.message || 'Could not load case context.',
          })
        }
      }
    }

    load()

    return () => {
      cancelled = true
    }
  }, [caseRecord, caseId])

  // One selected case -> one trace fetch. The utility caches the resolved trace
  // and shares in-flight requests, so the expandable trace panel below reads the
  // same stored trace without a second request.
  useEffect(() => {
    let cancelled = false

    const load = async () => {
      const result = await fetchCaseTrace(caseId)

      if (cancelled) return

      if (result.status === 'failed') {
        setLoadedTrace({
          caseId,
          status: 'error',
          trace: null,
          error: result.error,
        })

        return
      }

      const trace =
        result.status === 'found' ? normalizeTrace(result.trace) : null

      setLoadedTrace({
        caseId,
        status: trace ? 'ready' : 'empty',
        trace,
        error: null,
      })
    }

    load()

    return () => {
      cancelled = true
    }
  }, [caseId])

  const caseContext =
    caseRecord && contextState.caseId === caseRecord.case_id
      ? contextState
      : null

  const traceState =
    loadedTrace !== null && loadedTrace.caseId === caseId
      ? loadedTrace
      : { caseId, status: 'loading', trace: null, error: null }

  const trace = traceState.status === 'ready' ? traceState.trace : null

  const needsSummary = caseRecord?.resolution_status === 'escalated'

  // The AI case summary is generated once per escalated case, on demand, and is
  // never re-requested by re-renders.
  useEffect(() => {
    if (!needsSummary || !caseRecord) return
    if (caseContext === null) return
    if (summaries[caseId]) return
    if (summaryInFlight.current.has(caseId)) return

    summaryInFlight.current.add(caseId)

    let cancelled = false

    const load = async () => {
      try {
        const data = await requestCaseSummary(
          buildSummaryPayload(caseRecord, caseContext)
        )

        if (!cancelled) {
          setSummaries((prev) => ({ ...prev, [caseId]: { status: 'ready', data } }))
        }
      } catch (err) {
        if (!cancelled) {
          setSummaries((prev) => ({
            ...prev,
            [caseId]: {
              status: 'error',
              message: err?.message || 'AI summary unavailable.',
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
  }, [needsSummary, caseRecord, caseContext, summaries, caseId])

  const runAction = async (patch, successMessage) => {
    if (!user || !caseRecord) return

    setActionLoading(true)
    setActionError(null)
    setActionNotice(null)

    try {
      const updated = await updateSupportCase(caseRecord.case_id, patch)

      setActionNotice(successMessage)
      onCaseUpdated?.(updated)
    } catch (err) {
      setActionError(err?.message || 'Could not update the case.')
    } finally {
      setActionLoading(false)
    }
  }

  const startReview = () =>
    runAction({ case_status: 'in_review' }, 'Review started.')

  const resolveCase = () =>
    runAction(
      {
        case_status: 'human_resolved',
        agent_id: user?.id,
        agent_email: user?.email,
        agent_note: noteDraft || caseRecord?.agent_note || null,
        resolved_at: new Date().toISOString(),
      },
      'Case resolved.'
    )

  const keepEscalated = () =>
    runAction(
      {
        case_status: 'escalated',
        agent_note: noteDraft || caseRecord?.agent_note || null,
      },
      'Case kept escalated.'
    )

  const saveNote = () =>
    runAction({ agent_note: noteDraft || null }, 'Note saved.')

  if (!caseRecord) {
    return (
      <div className="dashboard-page case-management-page">
        <div className="case-state-box">
          <Inbox size={20} />

          <strong>No case selected</strong>

          <p>Open a case from the Case Management list.</p>
        </div>

        <button type="button" className="case-back-btn" onClick={onBack}>
          <ChevronLeft size={14} />
          <span>Back to Cases</span>
        </button>
      </div>
    )
  }

  const customerName =
    caseContext?.customer?.name || caseRecord.customer_id || '—'

  const order = caseContext?.order || null

  const ticketHistory = caseContext?.tickets || []

  const traceNote =
    traceState.status === 'loading'
      ? 'Loading execution trace...'
      : traceState.status === 'error'
        ? `Execution trace unavailable: ${traceState.error}`
        : traceState.status === 'empty'
          ? 'Not recorded for this case.'
          : null

  // Loading/error is worth flagging on every trace-derived card; the "no trace"
  // case is explained once, in the investigation summary and the trace section.
  const traceAlert =
    traceState.status === 'loading' || traceState.status === 'error'
      ? traceNote
      : null

  const gateStep = trace
    ? trace.decisionChain.find((step) => step.stage === 'decision_gate')
    : null

  const caseStatusValue = caseRecord.case_status || null

  // Human-agent handling is only offered for cases that carry a recorded
  // case_status (escalated / in_review / human_resolved). Older escalated rows
  // without that state keep their recorded escalation information but get no
  // action controls — the same rule the previous Case Management screen used.
  const hasHandlingState = Boolean(caseStatusValue)

  const citedEvidence = trace
    ? trace.evidence.citedIds
    : Array.isArray(caseRecord.evidence)
      ? caseRecord.evidence.filter((id) => typeof id === 'string')
      : []

  return (
    <div className="dashboard-page case-management-page case-details-page">
      <button type="button" className="case-back-btn" onClick={onBack}>
        <ChevronLeft size={14} />
        <span>Back to Cases</span>
      </button>

      <div className="page-heading">
        <div>
          <p className="eyebrow">CASE DETAILS</p>

          <h1>{caseRecord.case_id}</h1>

          <p>
            {customerName} · Order {caseRecord.order_id || '—'} ·{' '}
            {formatDate(caseRecord.created_at)}
          </p>
        </div>

        <div className="case-heading-actions">
          {caseStatusValue && (
            <span className="case-status investigating">
              {String(caseStatusValue).replace(/_/g, ' ')}
            </span>
          )}

          <CaseStatusBadge value={caseRecord.resolution_status} />
        </div>
      </div>

      <div className="case-details-grid">
        <Card title="CUSTOMER & ORDER">
          {caseContext === null ? (
            <p className="case-context-note">
              {contextState.error
                ? `Could not load context: ${contextState.error}`
                : 'Loading customer context...'}
            </p>
          ) : (
            <Facts
              items={[
                { label: 'Customer', value: customerName },
                { label: 'Customer ID', value: caseRecord.customer_id },
                { label: 'Order', value: caseRecord.order_id ? `#${caseRecord.order_id}` : null },
                { label: 'Product', value: order?.product },
                { label: 'Amount', value: order?.amount },
                { label: 'Delivery status', value: order?.status },
                { label: 'Payment status', value: order?.payment_status },
                { label: 'Refund status', value: order?.refund_status },
              ]}
            />
          )}
        </Card>

        <Card title="CUSTOMER ISSUE">
          <p className="case-details-message">
            {caseRecord.customer_message || 'No customer message recorded.'}
          </p>

          <Facts
            items={[
              { label: 'Intent', value: caseRecord.intent },
              { label: 'Recorded', value: formatDate(caseRecord.created_at) },
            ]}
          />
        </Card>

        <Card title="AI DECISION & ACTION">
          <div className="case-details-decision">
            <span className="case-status resolved">
              {String(caseRecord.decision || '—').toUpperCase()}
            </span>

            <ArrowRight size={14} className="case-flow-arrow" />

            <span className="case-status">
              {actionLabel(caseRecord.action)}
            </span>
          </div>

          <p className="case-details-text">{caseRecord.reason || '—'}</p>

          <Facts
            items={[
              { label: 'Action status', value: caseRecord.action_status },
              { label: 'Verification', value: caseRecord.verification_status },
            ]}
          />
        </Card>

        <Card title="INVESTIGATION SUMMARY">
          {traceNote && <p className="case-context-note">{traceNote}</p>}

          <Facts
            items={[
              { label: 'Intent', value: trace?.overview.intent || caseRecord.intent },
              { label: 'Urgency', value: trace?.overview.urgency },
              { label: 'Confidence', value: trace?.overview.confidence },
              { label: 'Source', value: trace?.overview.source },
            ]}
          />

          <div className="case-details-domains">
            <span>Planned domains</span>

            {!trace || trace.overview.domains.length === 0 ? (
              <em>—</em>
            ) : (
              trace.overview.domains.map((domain) => (
                <span key={domain.value} className="trace-chip">
                  {domain.label}
                </span>
              ))
            )}
          </div>
        </Card>

        <Card title="EVIDENCE SUMMARY">
          {traceAlert && <p className="case-context-note">{traceAlert}</p>}

          <Facts
            items={[
              { label: 'Evidence count', value: trace?.evidence.collected },
              { label: 'Agents reporting', value: trace?.evidence.agentsReporting },
              { label: 'Cited by decision', value: citedEvidence.length },
            ]}
          />

          <p className="case-details-text">
            {citedEvidence.length === 0
              ? 'No evidence ids cited.'
              : citedEvidence.join(', ')}
          </p>
        </Card>

        <Card title="INVESTIGATION HEALTH">
          {traceAlert && <p className="case-context-note">{traceAlert}</p>}

          <Facts
            items={[
              { label: 'Conflict status', value: trace?.health.conflictStatus },
              { label: 'Uncertainty status', value: trace?.health.uncertaintyStatus },
              {
                label: 'Re-investigation',
                value:
                  trace?.health.requiresReinvestigation === null ||
                  trace?.health.requiresReinvestigation === undefined
                    ? null
                    : trace.health.requiresReinvestigation
                      ? 'Required'
                      : 'Not required',
              },
              {
                label: 'Rounds performed',
                value: trace?.health.performed ? trace.health.rounds : trace ? 0 : null,
              },
            ]}
          />
        </Card>

        <Card title="DECISION GATE">
          {traceAlert && <p className="case-context-note">{traceAlert}</p>}

          {gateStep && gateStep.present ? (
            <>
              <div className="case-details-decision">
                <span className={`trace-stage-status ${gateStep.statusClass}`}>
                  {gateStep.value}
                </span>
              </div>

              <p className="case-details-text">
                {gateStep.reason || 'No gate reason recorded.'}
              </p>
            </>
          ) : (
            <p className="case-details-text">—</p>
          )}
        </Card>

        <Card title="EXECUTION SUMMARY" full>
          {traceNote ? (
            <p className="case-context-note">{traceNote}</p>
          ) : (
            <ExecutionFlow flow={trace.flow} />
          )}
        </Card>

        <Card title="FINAL OUTCOME" full>
          <Facts
            items={[
              { label: 'Outcome', value: caseRecord.resolution_status },
              { label: 'Action status', value: caseRecord.action_status },
              { label: 'Verification', value: caseRecord.verification_status },
              { label: 'Case status', value: caseStatusValue },
            ]}
          />

          {caseRecord.escalation_reason && (
            <p className="case-details-text">
              <strong>Escalation reason: </strong>
              {caseRecord.escalation_reason}
            </p>
          )}

          {caseRecord.case_status === 'human_resolved' && (
            <p className="case-details-text">
              <strong>Resolved by: </strong>
              {caseRecord.agent_email || '—'} · {formatDate(caseRecord.resolved_at)}
            </p>
          )}
        </Card>

        <Card title="POLICY CONTEXT" full>
          {caseContext === null ? (
            <p className="case-context-note">Loading policy context...</p>
          ) : !caseContext.policy ? (
            <p className="case-context-note">Policy not found</p>
          ) : (
            <Facts
              items={[
                { label: 'Policy', value: caseContext.policy.title },
                { label: 'Policy type', value: caseContext.policy.policy_type },
                { label: 'Action', value: caseContext.policy.action },
              ]}
            />
          )}
        </Card>

        {ticketHistory.length > 0 && (
          <Card
            title="SUPPORT HISTORY"
            full
            aside={
              <button
                type="button"
                className="case-secondary-toggle"
                onClick={() => setShowHistory((v) => !v)}
              >
                {showHistory ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                <span>
                  {showHistory
                    ? 'Hide Support History'
                    : `View Support History (${ticketHistory.length})`}
                </span>
              </button>
            }
          >
            {showHistory && (
              <div className="case-ticket-list">
                {ticketHistory.map((ticket) => (
                  <div key={ticket.ticket_id} className="case-ticket-item">
                    <div className="case-ticket-top">
                      <strong>{ticket.subject || ticket.ticket_id}</strong>

                      <span className={`case-ticket-status ${ticket.status || ''}`}>
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
          </Card>
        )}

        {hasHandlingState && (
          <Card
            title="HUMAN REVIEW"
            full
            aside={
              <span className="case-status escalated">
                {caseStatusValue === 'human_resolved'
                  ? 'HUMAN RESOLVED'
                  : caseStatusValue === 'in_review'
                    ? 'IN REVIEW'
                    : 'REQUIRED'}
              </span>
            }
          >
            {needsSummary && (
              <div className="case-details-summary">
                <span className="case-context-field-label">AI CASE SUMMARY</span>

                <AiCaseSummary state={summaries[caseRecord.case_id]} />
              </div>
            )}

            {user ? (
              caseStatusValue === 'human_resolved' ? (
                <div className="agent-case-status">
                  <div className="agent-case-status-row">
                    <span>Case Status</span>
                    <strong>Human Resolved</strong>
                  </div>

                  <div className="agent-case-status-row">
                    <span>Resolved By</span>
                    <strong>{caseRecord.agent_email || '—'}</strong>
                  </div>

                  <div className="agent-case-status-row">
                    <span>Resolved At</span>
                    <strong>{formatDate(caseRecord.resolved_at)}</strong>
                  </div>

                  {caseRecord.agent_note && (
                    <div className="agent-case-note">
                      <span>Agent Note</span>
                      <p>{caseRecord.agent_note}</p>
                    </div>
                  )}
                </div>
              ) : (
                <>
                  <div className="agent-case-status">
                    <div className="agent-case-status-row">
                      <span>Case Status</span>
                      <strong>
                        {caseStatusValue === 'in_review' ? 'In Review' : 'Escalated'}
                      </strong>
                    </div>
                  </div>

                  {actionError && (
                    <div className="agent-action-message error">{actionError}</div>
                  )}

                  {actionNotice && (
                    <div className="agent-action-message notice">
                      {actionNotice}
                    </div>
                  )}

                  <div className="agent-action-row">
                    {caseStatusValue !== 'in_review' && (
                      <button
                        type="button"
                        className="agent-action-btn primary"
                        onClick={startReview}
                        disabled={actionLoading}
                      >
                        {actionLoading ? 'Please wait...' : 'Start Review'}
                      </button>
                    )}

                    {caseStatusValue === 'in_review' && (
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
                </>
              )
            ) : (
              <p className="case-context-note">
                Sign in as an approved support agent to handle this case.
              </p>
            )}
          </Card>
        )}

        {needsSummary && !hasHandlingState && (
          <Card title="AI CASE SUMMARY" full>
            <AiCaseSummary state={summaries[caseRecord.case_id]} />
          </Card>
        )}

        <Card
          title="EXECUTION TRACE"
          full
          aside={
            <button
              type="button"
              className="case-secondary-toggle"
              onClick={() => setShowTrace((v) => !v)}
            >
              {showTrace ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
              <span>
                {showTrace ? 'Hide Execution Trace' : 'View Execution Trace'}
              </span>
            </button>
          }
        >
          <p className="case-details-text">
            The stored stage-by-stage execution record for this case. Read-only —
            agents are not re-run.
          </p>

          {showTrace ? (
            <CaseExecutionTrace caseId={caseRecord.case_id} />
          ) : (
            <div className="case-details-inline">
              {traceNote ? (
                <>
                  <ShieldCheck size={14} />
                  <span>{traceNote}</span>
                </>
              ) : (
                <>
                  <History size={14} />
                  <span>
                    {`${trace.stages.length} stages recorded · ${trace.totalDuration.label} total`}
                  </span>
                </>
              )}
            </div>
          )}
        </Card>
      </div>

      <div className="case-details-foot">
        <Brain size={13} />
        <span>
          Recorded by ResolveAI. Case data and execution traces are read-only.
        </span>
      </div>
    </div>
  )
}
