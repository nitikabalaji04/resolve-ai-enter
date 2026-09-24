import { Fragment, useEffect, useState } from 'react'
import {
  Activity,
  AlertTriangle,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Clock3,
  Database,
  ExternalLink,
  GitBranch,
  History,
  Inbox,
  RotateCcw,
  ScanSearch,
  SearchCheck,
} from 'lucide-react'
import {
  fetchSupportCases,
  fetchCustomerMap,
  computeStats,
  isActive,
  isResolved,
  titleFrom,
  customerName,
} from '../utils/supportCases'
import {
  fetchCaseTrace,
  healthIndicators,
  normalizeTrace,
} from '../utils/executionTrace'
import CaseExecutionTrace, { TraceStageRow } from './CaseExecutionTrace'
import CaseStatusBadge from './CaseStatusBadge'

// Investigations: a read-only console for how ResolveAI investigates a case.
//
// Every value below comes from the stored execution trace of the selected case
// (agents, evidence, health, decision gate, execution flow). Nothing is
// simulated: agents are never re-run, no progress is animated and the full
// stage-by-stage trace stays behind "View Execution Trace".

const FILTERS = [
  { value: 'active', label: 'Active' },
  { value: 'all', label: 'All' },
  { value: 'resolved', label: 'Resolved' },
]

function matchesFilter(c, filter) {
  if (filter === 'all') return true
  if (filter === 'active') return isActive(c)

  return isResolved(c)
}

function display(value) {
  if (value === null || value === undefined || value === '') return '—'

  return value
}

function Facts({ items }) {
  return (
    <div className="trace-facts">
      {items.map((item) => (
        <div key={item.label}>
          <span>{item.label}</span>

          <strong>{display(item.value)}</strong>
        </div>
      ))}
    </div>
  )
}

function Indicator({ label, value, tone }) {
  return (
    <div className={`investigation-indicator is-${tone}`}>
      <span>{label}</span>

      <strong>{value}</strong>
    </div>
  )
}

// Compact phase flow: Triage -> Investigation -> Evidence -> Decision -> Action.
// The states are the real ones recorded in the stored trace.
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
              <ChevronRight size={14} className="case-flow-arrow" />
            )}
          </Fragment>
        )
      })}
    </div>
  )
}

export default function InvestigationsData({ onOpenCaseDetails }) {
  const [rows, setRows] = useState([])
  const [customerMap, setCustomerMap] = useState({})
  const [selectedId, setSelectedId] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [loadedTrace, setLoadedTrace] = useState(null)
  const [filter, setFilter] = useState('active')
  const [showTrace, setShowTrace] = useState(false)

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
  const filteredRows = rows.filter((c) => matchesFilter(c, filter))
  const firstVisible = filteredRows[0] || null

  // The workspace follows the list: the selected case is kept while it is
  // visible in the current filter, otherwise the first visible case is used.
  const selected =
    filteredRows.find((c) => c.case_id === selectedId) || firstVisible || null

  const selectedCaseId = selected?.case_id || null

  const isSelectedRow = (c) =>
    selectedCaseId !== null && c.case_id === selectedCaseId

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

  // One selected case -> one trace fetch (the utility caches the resolved trace
  // and shares in-flight requests, so "View Execution Trace" reuses this one).
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

  const trace = traceState.status === 'ready' ? traceState.trace : null

  const traceNote =
    traceState.status === 'loading'
      ? 'Loading execution trace...'
      : traceState.status === 'error'
        ? `Execution trace unavailable: ${traceState.error}`
        : traceState.status === 'empty'
          ? 'No recorded execution for this case.'
          : null

  const gateStep = trace
    ? trace.decisionChain.find((step) => step.stage === 'decision_gate')
    : null

  const gateBlocked = gateStep ? gateStep.value === 'BLOCK' : false

  const tones = healthIndicators(trace)

  return (
    <div className="dashboard-page investigations-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">INVESTIGATIONS</p>

          <h1>AI Investigations</h1>

          <p>
            How ResolveAI investigates a case: agents, evidence, health and
            the decision gate, read from the stored execution trace.
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

          <span>Could not load investigations: {error}</span>
        </div>
      )}

      <div className="stats-grid">
        <div className="stat-card">
          <div className="stat-icon">
            <SearchCheck size={18} />
          </div>

          <div>
            <span>Active Investigations</span>
            <strong>{loading ? '…' : error ? '—' : stats.active}</strong>
          </div>
        </div>

        <div className="stat-card">
          <div className="stat-icon">
            <Clock3 size={18} />
          </div>

          <div>
            <span>Awaiting Review</span>
            <strong>{loading ? '…' : error ? '—' : stats.escalated}</strong>
          </div>
        </div>

        <div className="stat-card">
          <div className="stat-icon">
            <Check size={18} />
          </div>

          <div>
            <span>Completed</span>
            <strong>{loading ? '…' : error ? '—' : stats.resolved}</strong>
          </div>
        </div>
      </div>

      <section className="investigation-panel case-queue-panel">
        <div className="panel-header">
          <div>
            <p className="eyebrow">INVESTIGATION QUEUE</p>

            <h3>Cases</h3>
          </div>

          <div className="investigation-filter-row">
            {FILTERS.map((f) => (
              <button
                key={f.value}
                type="button"
                className={`case-filter-btn ${filter === f.value ? 'active' : ''}`}
                onClick={() => setFilter(f.value)}
              >
                {f.label}

                <span>{rows.filter((c) => matchesFilter(c, f.value)).length}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="case-table-wrapper">
          <table className="case-table">
            <thead>
              <tr>
                <th>CASE</th>
                <th>CUSTOMER / ORDER</th>
                <th>ISSUE / INTENT</th>
                <th>STATUS</th>
                <th aria-label="Open investigation" />
              </tr>
            </thead>

            <tbody>
              {loading && (
                <tr>
                  <td colSpan="5">
                    <span className="stage-text">Loading cases...</span>
                  </td>
                </tr>
              )}

              {!loading && error && (
                <tr>
                  <td colSpan="5">
                    <span className="stage-text">
                      Investigations unavailable.
                    </span>
                  </td>
                </tr>
              )}

              {!loading && !error && filteredRows.length === 0 && (
                <tr>
                  <td colSpan="5">
                    <span className="stage-text">
                      No {filter === 'all' ? '' : `${filter} `}investigations.
                    </span>
                  </td>
                </tr>
              )}

              {!loading &&
                !error &&
                filteredRows.map((item) => (
                  <tr
                    key={item.case_id}
                    className={`investigation-table-row ${
                      isSelectedRow(item) ? 'selected-case' : ''
                    }`}
                    onClick={() => {
                      setSelectedId(item.case_id)
                      setShowTrace(false)
                    }}
                  >
                    <td>
                      <button className="case-id-button" type="button">
                        {item.case_id}
                      </button>
                    </td>

                    <td>
                      <span className="investigation-cell-stack">
                        <strong>
                          {customerName(item, customerMap)}
                        </strong>

                        <small>Order {item.order_id || '—'}</small>
                      </span>
                    </td>

                    <td>
                      <span className="investigation-cell-stack">
                        <strong>{item.intent || '—'}</strong>

                        <small>{titleFrom(item)}</small>
                      </span>
                    </td>

                    <td>
                      <CaseStatusBadge value={item.resolution_status} />
                    </td>

                    <td>
                      <ChevronRight
                        size={14}
                        className="case-list-chevron"
                      />
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </section>

      {!selected ? (
        <section className="investigation-panel investigation-card">
          <div className="case-state-box">
            <Inbox size={20} />

            <strong>No investigation selected</strong>

            <p>Select a case above to inspect its investigation.</p>
          </div>
        </section>
      ) : (
        <div className="investigation-workspace">
          <section className="investigation-panel investigation-card">
            <div className="investigation-card-head">
              <span className="case-detail-label">INVESTIGATION OVERVIEW</span>

              <ScanSearch size={15} />
            </div>

            {traceNote && <p className="case-context-note">{traceNote}</p>}

            <Facts
              items={[
                { label: 'Case', value: selected.case_id },
                { label: 'Intent', value: trace?.overview.intent || selected.intent },
                { label: 'Confidence', value: trace?.overview.confidence },
                { label: 'Urgency', value: trace?.overview.urgency },
              ]}
            />

            <div className="trace-domains">
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
          </section>

          <section className="investigation-panel investigation-card">
            <div className="investigation-card-head">
              <span className="case-detail-label">AGENT EXECUTION</span>

              <span className="investigation-head-meta">
                <Bot size={14} />

                {trace ? `${trace.agentStages.length} AGENT STAGES` : '—'}
              </span>
            </div>

            {traceNote ? (
              <p className="case-context-note">{traceNote}</p>
            ) : trace.agentStages.length === 0 ? (
              <p className="case-context-note">
                No domain agent stage was recorded for this case.
              </p>
            ) : (
              <div className="trace-stages">
                {trace.agentStages.map((stage) => (
                  <TraceStageRow key={stage.key} stage={stage} />
                ))}
              </div>
            )}
          </section>

          <section className="investigation-panel investigation-card">
            <div className="investigation-card-head">
              <span className="case-detail-label">EVIDENCE</span>

              <Database size={15} />
            </div>

            {traceNote && <p className="case-context-note">{traceNote}</p>}

            <Facts
              items={[
                { label: 'Evidence count', value: trace?.evidence.collected },
                { label: 'Agents contributing', value: trace?.evidence.agentsReporting },
                { label: 'Cited by decision', value: trace?.evidence.citedIds.length },
              ]}
            />

            <p className="trace-evidence-ids">
              {!trace || trace.evidence.citedIds.length === 0
                ? 'No evidence ids cited.'
                : trace.evidence.citedIds.join(', ')}
            </p>
          </section>

          <section className="investigation-panel investigation-card">
            <div className="investigation-card-head">
              <span className="case-detail-label">INVESTIGATION HEALTH</span>

              <Activity size={15} />
            </div>

            {traceNote && <p className="case-context-note">{traceNote}</p>}

            <div className="investigation-indicators">
              <Indicator
                label="Conflict"
                value={tones.conflict.value}
                tone={tones.conflict.tone}
              />

              <Indicator
                label="Uncertainty"
                value={tones.uncertainty.value}
                tone={tones.uncertainty.tone}
              />

              <Indicator
                label="Re-investigation"
                value={tones.reinvestigation.value}
                tone={tones.reinvestigation.tone}
              />
            </div>
          </section>

          <section className="investigation-panel investigation-card full">
            <div className="investigation-card-head">
              <span className="case-detail-label">DECISION GATE</span>

              {gateStep && gateStep.present ? (
                <span
                  className={`trace-stage-status ${gateStep.statusClass}`}
                >
                  {gateStep.value}
                </span>
              ) : (
                <GitBranch size={15} />
              )}
            </div>

            {traceNote ? (
              <p className="case-context-note">{traceNote}</p>
            ) : (
              <>
                <p className="investigation-text">
                  {gateBlocked
                    ? 'The gate blocked this case: the decision agent was not asked to decide.'
                    : 'The gate allowed the investigation to proceed to the decision agent.'}
                </p>

                <Facts
                  items={[
                    { label: 'Gate status', value: gateStep?.value },
                    { label: 'Reason', value: gateStep?.reason },
                  ]}
                />
              </>
            )}
          </section>

          {trace && trace.health.performed && (
            <section className="investigation-panel investigation-card full">
              <div className="investigation-card-head">
                <span className="case-detail-label">RE-INVESTIGATION</span>

                <span className="investigation-head-meta">
                  <RotateCcw size={14} />

                  {`${trace.health.rounds ?? trace.health.roundsDetail.length} ROUNDS`}
                </span>
              </div>

              <div className="trace-rounds">
                {trace.health.roundsDetail.map((round) => (
                  <div key={round.key} className="trace-round">
                    <strong>{`Round ${round.round}`}</strong>

                    <span>
                      {round.targetDomains.length > 0
                        ? `Target domains: ${round.targetDomains.join(', ')}`
                        : 'Target domains: —'}
                    </span>

                    {round.result && <span>{`Result: ${round.result}`}</span>}
                  </div>
                ))}
              </div>
            </section>
          )}

          <section className="investigation-panel investigation-card full">
            <div className="investigation-card-head">
              <span className="case-detail-label">EXECUTION FLOW</span>

              <span className="investigation-head-meta">
                {trace ? `${trace.stages.length} STAGES` : '—'}
              </span>
            </div>

            {traceNote ? (
              <p className="case-context-note">{traceNote}</p>
            ) : (
              <ExecutionFlow flow={trace.flow} />
            )}
          </section>

          <section className="investigation-panel investigation-card full">
            <div className="investigation-card-head">
              <span className="case-detail-label">
                CASE DETAILS & FULL TRACE
              </span>

              <History size={15} />
            </div>

            <div className="investigation-actions">
              <button
                type="button"
                className="investigation-btn primary"
                onClick={() => onOpenCaseDetails?.(selectedCaseId)}
              >
                <ExternalLink size={13} />

                <span>View Case Details</span>
              </button>

              <button
                type="button"
                className="investigation-btn"
                onClick={() => setShowTrace((v) => !v)}
              >
                {showTrace ? (
                  <ChevronUp size={13} />
                ) : (
                  <ChevronDown size={13} />
                )}

                <span>
                  {showTrace ? 'Hide Execution Trace' : 'View Execution Trace'}
                </span>
              </button>
            </div>

            {showTrace ? (
              <CaseExecutionTrace caseId={selectedCaseId} />
            ) : (
              <div className="investigation-inline">
                {trace ? (
                  <>
                    <History size={14} />

                    <span>
                      {`${trace.stages.length} stages recorded · ${trace.totalDuration.label} total`}
                    </span>
                  </>
                ) : (
                  <>
                    <Inbox size={14} />

                    <span>{traceNote || 'No recorded execution.'}</span>
                  </>
                )}
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  )
}
