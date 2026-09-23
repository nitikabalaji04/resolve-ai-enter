import { useEffect, useState } from 'react'
import {
  SearchCheck,
  Clock3,
  Check,
  AlertTriangle,
  ShieldCheck,
  UserCheck,
  Package,
  Brain,
  Inbox,
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
import { fetchCaseTrace, normalizeTrace } from '../utils/executionTrace'
import { TraceStageRow } from './CaseExecutionTrace'

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

// A persisted case has been investigated end-to-end, so a decision is recorded
// for it. The real stage-by-stage execution is read from its stored trace below.

export default function InvestigationsData() {
  const [rows, setRows] = useState([])
  const [customerMap, setCustomerMap] = useState({})
  const [selectedId, setSelectedId] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [loadedTrace, setLoadedTrace] = useState(null)

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

  const selectedCaseId = selected?.case_id || null

  // Derived display state: a selection with no loaded trace yet is loading, and
  // no selection is idle. The effect below never writes state synchronously.
  const traceState =
    loadedTrace !== null && loadedTrace.caseId === selectedCaseId
      ? loadedTrace
      : {
          caseId: selectedCaseId,
          status: selectedCaseId ? 'loading' : 'idle',
          trace: null,
          error: null,
        }

  // The stage list below is the REAL stored execution trace for the selected
  // case: one selected case -> one trace fetch, no bulk reads. The trace is a
  // read-only historical record — agents are never re-run to build it.
  useEffect(() => {
    if (!selectedCaseId) return undefined

    let cancelled = false

    fetchCaseTrace(selectedCaseId).then((result) => {
      if (cancelled) return

      if (result.status === 'failed') {
        setLoadedTrace({
          caseId: selectedCaseId,
          status: 'error',
          trace: null,
          error: result.error,
        })

        return
      }

      const trace =
        result.status === 'found' ? normalizeTrace(result.trace) : null

      setLoadedTrace({
        caseId: selectedCaseId,
        status: trace ? 'ready' : 'empty',
        trace,
        error: null,
      })
    })

    return () => {
      cancelled = true
    }
  }, [selectedCaseId])

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
              <p className="eyebrow">EXECUTION TRACE</p>

              <h3>
                {selected ? `Case ${selected.case_id}` : 'No case selected'}
              </h3>
            </div>

            {!selected ? (
              <ShieldCheck size={20} />
            ) : traceState.status === 'ready' ? (
              <span className="live-badge">
                {`${traceState.trace.stages.length} STAGES RECORDED`}
              </span>
            ) : (
              <span className="live-badge">NO RECORDED TRACE</span>
            )}
          </div>

          {!selected ? (
            <p className="dashboard-note">
              No case selected.
            </p>
          ) : traceState.status === 'loading' ? (
            <p className="dashboard-note">
              Loading execution trace...
            </p>
          ) : traceState.status === 'error' ? (
            <p className="dashboard-note">
              {`Could not load the execution trace: ${traceState.error}`}
            </p>
          ) : traceState.status !== 'ready' || !traceState.trace ? (
            <div className="trace-empty">
              <Inbox size={20} />

              <strong>No recorded execution for this case.</strong>

              <p>
                ResolveAI stores an execution trace when a case is
                investigated. No trace is stored for this case, so no stages
                are shown.
              </p>
            </div>
          ) : (
            <div className="trace-timeline">
              {traceState.trace.stages.map((stage) => (
                <div key={stage.key} className="trace-timeline-item">
                  <span
                    className={`trace-timeline-dot ${stage.statusClass}`}
                  />

                  <TraceStageRow stage={stage} />
                </div>
              ))}
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
