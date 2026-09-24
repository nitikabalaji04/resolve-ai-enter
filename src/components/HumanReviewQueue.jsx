import { useEffect, useState } from 'react'
import {
  Activity,
  AlertTriangle,
  Bot,
  Check,
  ChevronRight,
  Clock3,
  GitBranch,
  Inbox,
  RotateCcw,
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
  formatDate,
  sameDayLocal,
} from '../utils/supportCases'
import { buildAgentObservability, fetchTraceScan } from '../utils/executionTrace'
import CaseStatusBadge from './CaseStatusBadge'

// Agent Dashboard: what the stored execution traces actually recorded.
//
// Every number on this page is aggregated from real trace rows and real case
// rows — no simulated activity, no invented timestamps and no claimed "online"
// state. Nothing here is currently running: the page reports what happened.

function reviewedTodayCount(rows) {
  const today = new Date()

  return rows.filter(
    (c) =>
      c.case_status === 'human_resolved' &&
      c.resolved_at &&
      sameDayLocal(c.resolved_at, today)
  ).length
}

function percentLabel(percent) {
  return typeof percent === 'number' ? `${percent}%` : '—'
}

function StatTile({ icon: Icon, label, value }) {
  return (
    <div className="stat-card">
      <div className="stat-icon">
        <Icon size={18} />
      </div>

      <div>
        <span>{label}</span>
        <strong>{value}</strong>
      </div>
    </div>
  )
}

export default function HumanReviewQueue({ onOpenCaseDetails }) {
  const [rows, setRows] = useState([])
  const [customerMap, setCustomerMap] = useState({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [loadedMetrics, setLoadedMetrics] = useState(null)

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

  // Recorded agent activity comes from the stored execution traces. The metrics
  // are computed from the rows that were really returned, and the page states
  // how many traces that was.
  useEffect(() => {
    let cancelled = false

    const load = async () => {
      const result = await fetchTraceScan()

      if (cancelled) return

      if (result.status === 'failed') {
        setLoadedMetrics({ status: 'error', data: null, error: result.error })

        return
      }

      setLoadedMetrics({
        status: 'ready',
        data: buildAgentObservability(result.rows),
        error: null,
      })
    }

    load()

    return () => {
      cancelled = true
    }
  }, [])

  const metricsState =
    loadedMetrics || { status: 'loading', data: null, error: null }

  const metrics = metricsState.data
  const metricsReady = metricsState.status === 'ready' && metrics !== null

  const queue = rows.filter(isActive)
  const escalated = rows.filter(isEscalated).length
  const reviewedToday = reviewedTodayCount(rows)

  const scopeNote = !metricsReady
    ? 'Recorded metrics unavailable.'
    : metrics.limited
      ? `Recorded across the ${metrics.tracesObserved} most recent stored execution traces.`
      : `Recorded across all ${metrics.tracesObserved} stored execution traces.`

  const metricValue = (value) =>
    metricsState.status === 'loading' ? '…' : metricsReady ? value : '—'

  const openCase = (caseId) => onOpenCaseDetails?.(caseId)

  return (
    <div className="dashboard-page agent-dashboard-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">HUMAN AGENT</p>

          <h1>Agent Dashboard</h1>

          <p>
            Recorded agent activity, decision outcomes and investigation
            health, aggregated from the stored execution traces.
          </p>
        </div>

        <div className="ai-status">
          <span></span>

          {metricsReady
            ? `${metrics.tracesObserved} TRACES OBSERVED`
            : 'LOADING TRACES'}
        </div>
      </div>

      {error && (
        <div className="dashboard-error-banner">
          <AlertTriangle size={15} />

          <span>Could not load the review queue: {error}</span>
        </div>
      )}

      {metricsState.status === 'error' && (
        <div className="dashboard-error-banner">
          <AlertTriangle size={15} />

          <span>Could not load stored traces: {loadedMetrics.error}</span>
        </div>
      )}

      {/* Recorded performance ------------------------------------------------- */}
      <div className="stats-grid">
        <StatTile
          icon={Activity}
          label="Cases Processed"
          value={metricValue(metrics?.performance.casesProcessed)}
        />

        <StatTile
          icon={Check}
          label="Completed Investigations"
          value={metricValue(metrics?.performance.completedInvestigations)}
        />

        <StatTile
          icon={GitBranch}
          label="Blocked Investigations"
          value={metricValue(metrics?.performance.blockedInvestigations)}
        />

        <StatTile
          icon={AlertTriangle}
          label="Escalated Cases"
          value={metricValue(metrics?.performance.escalatedCases)}
        />

        <StatTile
          icon={RotateCcw}
          label="Re-Investigation Cases"
          value={metricValue(metrics?.performance.reinvestigationCases)}
        />

        <StatTile
          icon={Clock3}
          label="Avg Execution Time"
          value={metricValue(metrics?.performance.avgDuration)}
        />
      </div>

      <p className="dashboard-note">{scopeNote}</p>

      {/* Agent status --------------------------------------------------------- */}
      <section className="panel">
        <div className="panel-header">
          <div>
            <p className="eyebrow">AGENT STATUS</p>

            <h3>Pipeline Stages Observed</h3>
          </div>

          <Bot size={19} />
        </div>

        <div className="agent-status-grid">
          {(metrics?.agents || []).length === 0 ? (
            <p className="dashboard-note">
              {metricsState.status === 'loading'
                ? 'Loading agent status...'
                : 'No stored execution traces to report on.'}
            </p>
          ) : (
            metrics.agents.map((agent) => {
              const Icon = agent.icon
              const observed = agent.executions > 0

              return (
                <div
                  key={agent.key}
                  className={`agent-status-card ${observed ? 'observed' : 'idle'}`}
                >
                  <div className="agent-status-head">
                    <div className="agent-status-icon">
                      <Icon size={14} />
                    </div>

                    <strong>{agent.label}</strong>
                  </div>

                  <span
                    className={`agent-status-chip ${observed ? 'observed' : 'idle'}`}
                  >
                    {observed ? 'Observed' : 'No recorded runs'}
                  </span>

                  <div className="agent-status-facts">
                    <span>{`${agent.executions} executions`}</span>
                    <span>{`${agent.completed} completed`}</span>
                    <span>{`${agent.failedBlocked} failed/blocked`}</span>
                  </div>

                  <span className="agent-status-seen">
                    {agent.lastSeen
                      ? `Last recorded ${formatDate(agent.lastSeen)}`
                      : 'No recorded timestamp'}
                  </span>
                </div>
              )
            })
          )}
        </div>
      </section>

      {/* Agent execution table ------------------------------------------------ */}
      <section className="panel">
        <div className="panel-header">
          <div>
            <p className="eyebrow">AGENT PERFORMANCE</p>

            <h3>Agent Execution</h3>
          </div>

          <span className="panel-badge">
            {metricsReady ? `${metrics.tracesObserved} TRACES` : '—'}
          </span>
        </div>

        <div className="case-table-wrapper">
          <table className="case-table">
            <thead>
              <tr>
                <th>AGENT</th>
                <th>EXECUTIONS</th>
                <th>COMPLETED</th>
                <th>FAILED / BLOCKED</th>
                <th>AVG DURATION</th>
              </tr>
            </thead>

            <tbody>
              {(metrics?.agents || []).length === 0 ? (
                <tr>
                  <td colSpan="5">
                    <span className="stage-text">
                      {metricsState.status === 'loading'
                        ? 'Loading agent executions...'
                        : 'No recorded agent executions.'}
                    </span>
                  </td>
                </tr>
              ) : (
                metrics.agents.map((agent) => (
                  <tr key={agent.key}>
                    <td>
                      <span className="investigation-cell-stack">
                        <strong>{agent.label}</strong>
                      </span>
                    </td>

                    <td>{agent.executions}</td>

                    <td>{agent.completed}</td>

                    <td>{agent.failedBlocked}</td>

                    <td>{agent.avgDuration}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Decision outcomes ---------------------------------------------------- */}
      <section className="panel">
        <div className="panel-header">
          <div>
            <p className="eyebrow">DECISION OUTCOMES</p>

            <h3>Recorded Decision Agent Results</h3>
          </div>

          <GitBranch size={19} />
        </div>

        <div className="agent-section-body">
          {(metrics?.decisionOutcomes || []).length === 0 ? (
            <p className="dashboard-note">
              {metricsState.status === 'loading'
                ? 'Loading decision outcomes...'
                : 'No recorded decisions.'}
            </p>
          ) : (
            <>
              <div className="investigation-indicators">
                {metrics.decisionOutcomes.map((outcome) => {
                  const tone =
                    outcome.key === 'APPROVE'
                      ? 'ok'
                      : outcome.key === 'DENY'
                        ? 'danger'
                        : outcome.key === 'INFORM'
                          ? 'info'
                          : 'warn'

                  return (
                    <div
                      key={outcome.key}
                      className={`investigation-indicator is-${tone}`}
                    >
                      <span>{outcome.key}</span>

                      <strong>
                        {`${outcome.count} · ${percentLabel(outcome.percent)}`}
                      </strong>
                    </div>
                  )
                })}
              </div>

              {metrics.performance.undecidedTraces > 0 && (
                <p className="dashboard-note">
                  {`${metrics.performance.undecidedTraces} trace(s) have no recorded decision: the decision agent did not produce one.`}
                </p>
              )}
            </>
          )}
        </div>
      </section>

      {/* Investigation health ------------------------------------------------- */}
      <section className="panel">
        <div className="panel-header">
          <div>
            <p className="eyebrow">INVESTIGATION HEALTH</p>

            <h3>Recorded Investigation Signals</h3>
          </div>

          <ShieldCheck size={19} />
        </div>

        <div className="agent-section-body">
          {!metricsReady ? (
            <p className="dashboard-note">
              {metricsState.status === 'loading'
                ? 'Loading investigation health...'
                : 'No recorded investigation health.'}
            </p>
          ) : (
            <div className="investigation-indicators">
              <div
                className={`investigation-indicator is-${metrics.health.conflicts > 0 ? 'warn' : 'ok'}`}
              >
                <span>Conflicts Detected</span>
                <strong>{metrics.health.conflicts}</strong>
              </div>

              <div
                className={`investigation-indicator is-${metrics.health.uncertainties > 0 ? 'warn' : 'ok'}`}
              >
                <span>Uncertainty Detected</span>
                <strong>{metrics.health.uncertainties}</strong>
              </div>

              <div
                className={`investigation-indicator is-${metrics.health.reinvestigations > 0 ? 'info' : 'ok'}`}
              >
                <span>Re-Investigations</span>
                <strong>{metrics.health.reinvestigations}</strong>
              </div>

              <div
                className={`investigation-indicator is-${metrics.health.gateBlocks > 0 ? 'warn' : 'ok'}`}
              >
                <span>Gate Blocks</span>
                <strong>{metrics.health.gateBlocks}</strong>
              </div>
            </div>
          )}
        </div>
      </section>

      {/* Re-investigation monitoring (only when recorded) ---------------------- */}
      {metricsReady && metrics.reinvestigation.cases > 0 && (
        <section className="panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">RE-INVESTIGATION MONITORING</p>

              <h3>Recorded Re-Investigation Rounds</h3>
            </div>

            <RotateCcw size={19} />
          </div>

          <div className="agent-section-body">
            <div className="trace-facts">
              <div>
                <span>Cases requiring</span>
                <strong>{metrics.reinvestigation.cases}</strong>
              </div>

              <div>
                <span>Total rounds</span>
                <strong>{metrics.reinvestigation.rounds}</strong>
              </div>
            </div>

            <div className="trace-domains">
              <span>Affected domains</span>

              {metrics.reinvestigation.domains.length === 0 ? (
                <em>—</em>
              ) : (
                metrics.reinvestigation.domains.map((domain) => (
                  <span key={domain.domain} className="trace-chip">
                    {`${domain.domain} · ${domain.count}`}
                  </span>
                ))
              )}
            </div>

            <div className="trace-evidence-block">
              <span>Round results</span>

              {metrics.reinvestigation.results.length === 0 ? (
                <em>—</em>
              ) : (
                metrics.reinvestigation.results.map((result) => (
                  <div key={result.result} className="trace-evidence-row">
                    <span>{result.result}</span>

                    <strong>{result.count}</strong>
                  </div>
                ))
              )}
            </div>
          </div>
        </section>
      )}

      {/* Recent agent activity ------------------------------------------------ */}
      <section className="panel">
        <div className="panel-header">
          <div>
            <p className="eyebrow">RECENT AGENT ACTIVITY</p>

            <h3>Newest Recorded Stages</h3>
          </div>

          <span className="panel-badge">
            {metricsReady ? `${metrics.totalActivity} RECORDED` : '—'}
          </span>
        </div>

        <div className="case-table-wrapper">
          <table className="case-table">
            <thead>
              <tr>
                <th>CASE</th>
                <th>AGENT</th>
                <th>STATUS</th>
                <th>DURATION</th>
                <th>TIME</th>
              </tr>
            </thead>

            <tbody>
              {!metricsReady || metrics.recentActivity.length === 0 ? (
                <tr>
                  <td colSpan="5">
                    <span className="stage-text">
                      {metricsState.status === 'loading'
                        ? 'Loading recorded activity...'
                        : 'No recorded stage activity.'}
                    </span>
                  </td>
                </tr>
              ) : (
                metrics.recentActivity.map((item) => (
                  <tr
                    key={item.key}
                    className="investigation-table-row"
                    onClick={() => openCase(item.caseId)}
                  >
                    <td>
                      <button className="case-id-button" type="button">
                        {item.caseId}
                      </button>
                    </td>

                    <td>{item.label}</td>

                    <td>
                      <span
                        className={`trace-stage-status ${item.statusClass}`}
                      >
                        {item.statusLabel}
                      </span>
                    </td>

                    <td>{item.duration}</td>

                    <td>{formatDate(item.timestamp)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Human review queue (preserved, compact) ------------------------------ */}
      <section className="panel">
        <div className="panel-header">
          <div>
            <p className="eyebrow">HUMAN REVIEW QUEUE</p>

            <h3>Cases Awaiting Review</h3>
          </div>

          <span className="panel-badge">
            {loading
              ? '…'
              : `${queue.length} PENDING · ${reviewedToday} REVIEWED TODAY`}
          </span>
        </div>

        {loading && <p className="dashboard-note">Loading queue...</p>}

        {!loading && error && (
          <p className="dashboard-note">Queue unavailable.</p>
        )}

        {!loading && !error && queue.length === 0 && (
          <div className="empty-state">
            <Inbox size={28} />

            <strong>No cases awaiting human review</strong>

            <p>
              Every case has been handled by ResolveAI or resolved by a human
              agent.
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
                className="case-row queue-case-row"
                onClick={() => openCase(c.case_id)}
              >
                <div className="case-info">
                  <strong>{c.case_id}</strong>

                  <span>
                    {`${customerName(c, customerMap)} · ${titleFrom(c)}`}
                  </span>
                </div>

                <div className="agent-queue-right">
                  <CaseStatusBadge value={c.resolution_status} />

                  <span className={status.className}>{status.label}</span>

                  <ChevronRight size={14} className="case-list-chevron" />
                </div>
              </div>
            )
          })}

        {!loading && !error && queue.length > 0 && (
          <p className="dashboard-note">
            {`${escalated} escalated case(s) recorded in total. Select a case to open its details.`}
          </p>
        )}
      </section>
    </div>
  )
}
