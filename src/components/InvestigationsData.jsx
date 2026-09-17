import { useEffect, useState } from 'react'
import {
  SearchCheck,
  Clock3,
  Check,
  AlertTriangle,
  ShieldCheck,
  UserCheck,
  Package,
  Truck,
  History,
  FileCheck,
  Database,
  Brain,
} from 'lucide-react'
import {
  fetchSupportCases,
  fetchCustomerMap,
  computeStats,
  isActive,
  titleFrom,
  customerName,
  capitalize,
} from '../utils/supportCases'

// The investigation workflow ResolveAI runs for every persisted case.
const STAGES = [
  {
    title: 'Customer Verification',
    description: 'Customer identity confirmed',
    icon: UserCheck,
  },
  {
    title: 'Order Lookup',
    description: 'Order information checked',
    icon: Package,
  },
  {
    title: 'Delivery Check',
    description: 'Delivery status checked',
    icon: Truck,
  },
  {
    title: 'Support History',
    description: 'Support history reviewed',
    icon: History,
  },
  {
    title: 'Policy Check',
    description: 'Shipping refund policy reviewed',
    icon: FileCheck,
  },
  {
    title: 'Evidence Collected',
    description: 'Evidence sufficient for decision',
    icon: Database,
  },
]

function stageLabel(c) {
  if (c.case_status === 'in_review') return 'Human Review'

  if (isActive(c)) return 'Awaiting Human Review'

  if (c.decision) return 'AI Decision'

  return 'AI Review'
}

function rowStatus(c) {
  if (c.case_status === 'in_review') {
    return { label: 'In Review', className: 'case-status investigating' }
  }

  return { label: 'Escalated', className: 'case-status escalated' }
}

// A persisted case has been investigated end-to-end (a decision was
// recorded), so the workflow timeline is always complete for real cases.
function timelineState(selected) {
  const hasDecision = Boolean(selected && selected.decision)

  return {
    completedThrough: hasDecision ? STAGES.length - 1 : -1,
    current: hasDecision ? null : 0,
  }
}

export default function InvestigationsData() {
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
          setError(err?.message || 'Could not load investigations.')
          setLoading(false)
        }
      }
    }

    load()

    return () => {
      cancelled = true
    }
  }, [])

  const stats = computeStats(rows)
  const activeCases = rows.filter(isActive)
  const firstActive = activeCases[0] || null

  const selected =
    rows.find((c) => c.case_id === selectedId) || firstActive || null

  const isSelectedRow = (c) =>
    selectedId
      ? c.case_id === selectedId
      : firstActive !== null && c.case_id === firstActive.case_id

  const currentState = timelineState(selected)

  return (
    <div className="dashboard-page investigations-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">INVESTIGATIONS</p>

          <h1>AI Investigations</h1>

          <p>
            Monitor how ResolveAI investigates customer cases before
            making a decision.
          </p>
        </div>

        <div className="ai-status">
          <span></span>
          AI ENGINE ACTIVE
        </div>
      </div>

      {error && (
        <div className="dashboard-error-banner">
          <AlertTriangle size={15} />

          <span>
            Could not load investigations: {error}
          </span>
        </div>
      )}

      <div className="stats-grid">
        <div className="stat-card">
          <div className="stat-icon">
            <SearchCheck size={18} />
          </div>

          <div>
            <span>Active Investigations</span>
            <strong>
              {loading ? '…' : error ? '—' : stats.active}
            </strong>
          </div>
        </div>

        <div className="stat-card">
          <div className="stat-icon">
            <Clock3 size={18} />
          </div>

          <div>
            <span>Awaiting Review</span>
            <strong>
              {loading ? '…' : error ? '—' : stats.escalated}
            </strong>
          </div>
        </div>

        <div className="stat-card">
          <div className="stat-icon">
            <Check size={18} />
          </div>

          <div>
            <span>Completed</span>
            <strong>
              {loading ? '…' : error ? '—' : stats.resolved}
            </strong>
          </div>
        </div>
      </div>

      <section className="investigation-panel case-queue-panel">
        <div className="panel-header">
          <div>
            <p className="eyebrow">CASE QUEUE</p>
            <h3>Active Investigations</h3>
          </div>

          <span className="active-count">
            {loading ? '…' : `${stats.active} ACTIVE`}
          </span>
        </div>

        <div className="case-table-wrapper">
          <table className="case-table">
            <thead>
              <tr>
                <th>CASE</th>
                <th>CUSTOMER</th>
                <th>ISSUE</th>
                <th>ORDER</th>
                <th>CURRENT STAGE</th>
                <th>STATUS</th>
              </tr>
            </thead>

            <tbody>
              {loading && (
                <tr>
                  <td colSpan="6">
                    <span className="stage-text">
                      Loading cases...
                    </span>
                  </td>
                </tr>
              )}

              {!loading && error && (
                <tr>
                  <td colSpan="6">
                    <span className="stage-text">
                      Active investigations unavailable.
                    </span>
                  </td>
                </tr>
              )}

              {!loading && !error && activeCases.length === 0 && (
                <tr>
                  <td colSpan="6">
                    <span className="stage-text">
                      No active investigations.
                    </span>
                  </td>
                </tr>
              )}

              {!loading &&
                !error &&
                activeCases.map((item) => {
                  const status = rowStatus(item)

                  return (
                    <tr
                      key={item.case_id}
                      className={
                        isSelectedRow(item) ? 'selected-case' : ''
                      }
                      onClick={() => setSelectedId(item.case_id)}
                    >
                      <td>
                        <button
                          className="case-id-button"
                          type="button"
                        >
                          {item.case_id}
                        </button>
                      </td>

                      <td>{customerName(item, customerMap)}</td>

                      <td>{titleFrom(item)}</td>

                      <td>{item.order_id || '—'}</td>

                      <td>
                        <span className="stage-text">
                          {stageLabel(item)}
                        </span>
                      </td>

                      <td>
                        <span
                          className={status.className}
                        >
                          {status.label}
                        </span>
                      </td>
                    </tr>
                  )
                })}
            </tbody>
          </table>
        </div>
      </section>

      <div className="investigation-grid">
        <section className="investigation-panel workflow-panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">INVESTIGATION WORKFLOW</p>

              <h3>
                {selected ? `Case ${selected.case_id}` : 'No case selected'}
              </h3>
            </div>

            {selected ? (
              <span className="live-badge">INVESTIGATION COMPLETE</span>
            ) : (
              <ShieldCheck size={20} />
            )}
          </div>

          {!selected ? (
            <p className="dashboard-note">
              No case selected.
            </p>
          ) : (
            <div className="timeline">
              {STAGES.map((stage, index) => {
                const Icon = stage.icon

                const isCompleted =
                  index <= currentState.completedThrough

                const isCurrent = index === currentState.current

                const status = isCompleted
                  ? 'COMPLETED'
                  : isCurrent
                    ? 'IN PROGRESS'
                    : 'PENDING'

                return (
                  <div
                    key={stage.title}
                    className={`timeline-item ${
                      isCompleted
                        ? 'timeline-complete'
                        : isCurrent
                          ? 'timeline-current'
                          : 'timeline-pending'
                    }`}
                  >
                    <div className="timeline-icon">
                      {isCompleted ? (
                        <Check size={14} />
                      ) : isCurrent ? (
                        <span className="timeline-loader">
                          ...
                        </span>
                      ) : (
                        <Icon size={14} />
                      )}
                    </div>

                    <div className="timeline-content">
                      <div className="timeline-title-row">
                        <strong>
                          {stage.title}
                        </strong>

                        <span className="timeline-status">
                          {status}
                        </span>
                      </div>

                      <p>
                        {stage.description}
                      </p>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </section>

        <section className="investigation-panel evidence-panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">EVIDENCE COLLECTED</p>

              <h3>
                {selected ? `Case ${selected.case_id}` : 'Case Evidence'}
              </h3>
            </div>

            <ShieldCheck size={20} />
          </div>

          {!selected ? (
            <p className="dashboard-note">
              Evidence will appear once a case is selected.
            </p>
          ) : (
            <div className="evidence-list">
              <div className="evidence-item">
                <UserCheck size={18} />

                <div>
                  <strong>
                    Customer verified
                  </strong>

                  <span>
                    {customerName(selected, customerMap)}
                  </span>
                </div>
              </div>

              <div className="evidence-item">
                <Package size={18} />

                <div>
                  <strong>
                    {selected.order_id || 'No order attached'}
                  </strong>

                  <span>
                    Order located
                  </span>
                </div>
              </div>

              <div className="evidence-item">
                <Brain size={18} />

                <div>
                  <strong>
                    {capitalize(selected.decision)}
                  </strong>

                  <span>
                    {selected.reason || 'AI decision recorded'}
                  </span>
                </div>
              </div>

              {isActive(selected) ? (
                <div className="evidence-item">
                  <AlertTriangle size={18} />

                  <div>
                    <strong>
                      Escalated to human review
                    </strong>

                    <span>
                      {selected.escalation_reason ||
                        'Awaiting human decision'}
                    </span>
                  </div>
                </div>
              ) : (
                <div className="evidence-item">
                  <Check size={18} />

                  <div>
                    <strong>
                      Resolution recorded
                    </strong>

                    <span>
                      {selected.resolution_status ||
                        'Handled by ResolveAI'}
                    </span>
                  </div>
                </div>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
