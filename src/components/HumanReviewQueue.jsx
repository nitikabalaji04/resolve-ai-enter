import { useEffect, useState } from 'react'
import {
  AlertTriangle,
  Clock3,
  Check,
  Brain,
  Inbox,
  UserRound,
  Package,
  MessageCircle,
  ShieldCheck,
} from 'lucide-react'
import {
  fetchSupportCases,
  fetchCustomerMap,
  isActive,
  isEscalated,
  recentStatus,
  titleFrom,
  customerName,
  capitalize,
  formatDate,
  sameDayLocal,
} from '../utils/supportCases'

function reviewedTodayCount(rows) {
  const today = new Date()

  return rows.filter(
    (c) =>
      c.case_status === 'human_resolved' &&
      c.resolved_at &&
      sameDayLocal(c.resolved_at, today)
  ).length
}

function humanReviewLabel(c) {
  if (c.case_status === 'in_review') return 'IN REVIEW'

  return 'REQUIRED'
}

export default function HumanReviewQueue() {
  const [rows, setRows] = useState([])
  const [customerMap, setCustomerMap] = useState({})
  const [selectedId, setSelectedId] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false

    const load = async () => {
      try {
        const [cases, customers] = await Promise.all([
          fetchSupportCases(),
          fetchCustomerMap(),
        ])

        if (!cancelled) {
          setRows(cases)
          setCustomerMap(customers)
          setLoading(false)
        }
      } catch (err) {
        if (!cancelled) {
          setError(err?.message || 'Could not load the review queue.')
          setLoading(false)
        }
      }
    }

    load()

    return () => {
      cancelled = true
    }
  }, [])

  const queue = rows.filter(isActive)
  const escalated = rows.filter(isEscalated).length
  const reviewedToday = reviewedTodayCount(rows)
  const firstInQueue = queue[0] || null

  const selected =
    rows.find((c) => c.case_id === selectedId) || firstInQueue || null

  const isSelectedRow = (c) =>
    selectedId
      ? c.case_id === selectedId
      : firstInQueue !== null && c.case_id === firstInQueue.case_id

  return (
    <div className="dashboard-page agent-dashboard-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">
            HUMAN AGENT DASHBOARD
          </p>

          <h1>
            Human Review Queue
          </h1>

          <p>
            Review cases that require human attention after AI
            investigation.
          </p>
        </div>

        <div className="ai-status">
          <span></span>
          AI HANDOFF READY
        </div>
      </div>

      {error && (
        <div className="dashboard-error-banner">
          <AlertTriangle size={15} />

          <span>
            Could not load the review queue: {error}
          </span>
        </div>
      )}

      <div className="stats-grid">
        <div className="stat-card">
          <div className="stat-icon">
            <AlertTriangle size={18} />
          </div>

          <div>
            <span>Escalated Cases</span>
            <strong>
              {loading ? '…' : error ? '—' : escalated}
            </strong>
          </div>
        </div>

        <div className="stat-card">
          <div className="stat-icon">
            <Clock3 size={18} />
          </div>

          <div>
            <span>Pending Review</span>
            <strong>
              {loading ? '…' : error ? '—' : queue.length}
            </strong>
          </div>
        </div>

        <div className="stat-card">
          <div className="stat-icon">
            <Check size={18} />
          </div>

          <div>
            <span>Reviewed Today</span>
            <strong>
              {loading ? '…' : error ? '—' : reviewedToday}
            </strong>
          </div>
        </div>
      </div>

      <div className="agent-workspace">
        <section className="panel agent-case-panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">
                ESCALATED CASES
              </p>

              <h3>
                Review Queue
              </h3>
            </div>

            <span className="live-badge">
              {loading ? '…' : `${queue.length} PENDING`}
            </span>
          </div>

          {loading && (
            <p className="dashboard-note">
              Loading queue...
            </p>
          )}

          {!loading && error && (
            <p className="dashboard-note">
              Queue unavailable.
            </p>
          )}

          {!loading && !error && queue.length === 0 && (
            <div className="empty-state">
              <Inbox size={28} />

              <strong>
                No cases awaiting human review
              </strong>

              <p>
                Every case has been handled by ResolveAI or resolved by
                a human agent.
              </p>
            </div>
          )}

          {!loading &&
            !error &&
            queue.map((c) => {
              const status = recentStatus(c)

              return (
                <div
                  key={c.case_id}
                  className={`case-row queue-case-row ${
                    isSelectedRow(c) ? 'selected' : ''
                  }`}
                  onClick={() => setSelectedId(c.case_id)}
                >
                  <div className="case-info">
                    <strong>{c.case_id}</strong>

                    <span>{titleFrom(c)}</span>
                  </div>

                  <span className={status.className}>
                    {status.label}
                  </span>
                </div>
              )
            })}
        </section>

        <section className="panel ai-handoff-panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">
                AI HANDOFF
              </p>

              <h3>
                {selected
                  ? `Case ${selected.case_id}`
                  : 'Investigation Summary'}
              </h3>
            </div>

            <div className="ai-handoff-icon">
              <Brain size={19} />
            </div>
          </div>

          {!selected ? (
            <p className="dashboard-note">
              Select a case to view its investigation summary.
            </p>
          ) : (
            <>
              <div className="agent-case-grid">
                <div className="agent-info-card">
                  <UserRound size={17} />

                  <div>
                    <span>Customer</span>
                    <strong>{customerName(selected, customerMap)}</strong>
                  </div>
                </div>

                <div className="agent-info-card">
                  <Package size={17} />

                  <div>
                    <span>Order</span>
                    <strong>{selected.order_id || '—'}</strong>
                  </div>
                </div>

                <div className="agent-info-card">
                  <MessageCircle size={17} />

                  <div>
                    <span>Issue</span>
                    <strong>{titleFrom(selected)}</strong>
                  </div>
                </div>

                <div className="agent-info-card">
                  <Clock3 size={17} />

                  <div>
                    <span>Case Status</span>
                    <strong>
                      {capitalize(selected.case_status || selected.resolution_status)}
                    </strong>
                  </div>
                </div>
              </div>

              <div className="ai-handoff-status">
                <Check size={15} />

                {capitalize(selected.decision)} — {selected.reason || 'Reason recorded'}
              </div>

              <p className="ai-handoff-description">
                {selected.customer_message ||
                  'No customer message recorded for this case.'}
              </p>

              <div className="ai-findings">
                <div>
                  <span>Customer verified</span>
                  <strong>{selected.customer_id ? 'YES' : '—'}</strong>
                </div>

                <div>
                  <span>Order located</span>
                  <strong>{selected.order_id ? 'YES' : '—'}</strong>
                </div>

                <div>
                  <span>AI decision</span>
                  <strong>{capitalize(selected.decision)}</strong>
                </div>

                <div>
                  <span>Resolution</span>
                  <strong>{capitalize(selected.resolution_status)}</strong>
                </div>
              </div>
            </>
          )}
        </section>
      </div>

      <div className="agent-lower-grid">
        <section className="panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">
                EVIDENCE CONSIDERED
              </p>

              <h3>
                Investigation Evidence
              </h3>
            </div>

            <ShieldCheck size={19} />
          </div>

          {!selected ? (
            <p className="dashboard-note">
              Evidence will appear once a case is selected.
            </p>
          ) : (
            <div className="agent-evidence-list">
              <div className="agent-evidence-row">
                <Check size={15} />

                <div>
                  <strong>Customer identity verified</strong>
                  <span>
                    {customerName(selected, customerMap)}
                  </span>
                </div>
              </div>

              <div className="agent-evidence-row">
                <Check size={15} />

                <div>
                  <strong>
                    Order {selected.order_id || 'record'} located
                  </strong>
                  <span>
                    {selected.order_id
                      ? 'Order information retrieved successfully.'
                      : 'No order attached to this case.'}
                  </span>
                </div>
              </div>

              <div className="agent-evidence-row warning">
                <AlertTriangle size={15} />

                <div>
                  <strong>Escalated to human review</strong>
                  <span>
                    {selected.escalation_reason || 'Awaiting human decision.'}
                  </span>
                </div>
              </div>

              <div className="agent-evidence-row">
                <Check size={15} />

                <div>
                  <strong>AI decision recorded</strong>
                  <span>
                    {capitalize(selected.decision)} — {selected.reason || 'Reason recorded'}
                  </span>
                </div>
              </div>

              <div className="agent-evidence-row">
                <Check size={15} />

                <div>
                  <strong>Case created</strong>
                  <span>{formatDate(selected.created_at)}</span>
                </div>
              </div>
            </div>
          )}
        </section>

        <section className="panel recommendation-panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">
                AI RECOMMENDATION
              </p>

              <h3>
                Human Review Required
              </h3>
            </div>

            <AlertTriangle size={19} />
          </div>

          {!selected ? (
            <p className="dashboard-note">
              Recommendation will appear once a case is selected.
            </p>
          ) : (
            <>
              <div className="recommendation-box">
                <strong>
                  Recommended Action
                </strong>

                <p>
                  {selected.reason ||
                    'Human judgment required for this case.'}
                </p>
              </div>

              <div className="escalation-reason">
                <span>
                  ESCALATION REASON
                </span>

                <p>
                  {selected.escalation_reason ||
                    'No escalation reason recorded.'}
                </p>
              </div>

              <div className="human-status">
                <div>
                  <span>AI Decision</span>
                  <strong>{capitalize(selected.decision)}</strong>
                </div>

                <div>
                  <span>Human Review</span>
                  <strong>{humanReviewLabel(selected)}</strong>
                </div>

                <div>
                  <span>Action</span>
                  <strong>{capitalize(selected.action)}</strong>
                </div>
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  )
}
