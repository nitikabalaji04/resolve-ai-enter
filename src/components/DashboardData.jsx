import { useEffect, useState } from 'react'
import {
  Activity,
  AlertTriangle,
  Check,
  Clock3,
  FolderOpen,
  GitBranch,
  RotateCcw,
  ShieldCheck,
  UserRound,
  XCircle,
} from 'lucide-react'
import {
  fetchSupportCases,
  computeStats,
  titleFrom,
  formatDate,
} from '../utils/supportCases'
import { buildAgentObservability, fetchTraceScan } from '../utils/executionTrace'
import CaseStatusBadge from './CaseStatusBadge'

// Main Dashboard: the executive overview of what is recorded across ResolveAI.
//
// Two read-only reads only: the support case rows and the stored execution
// traces. Every number is a count of real records — no rates, no projections,
// no simulated activity and no claims that anything is currently running.

const ACTION_LABELS = {
  refund_shipping_fee: 'Refund shipping fee',
  product_refund: 'Product refund',
  human_review: 'Human review',
  no_action: 'No action',
}

function actionLabel(value) {
  return ACTION_LABELS[value] || value || '—'
}

function countBy(rows, predicate) {
  return rows.filter(predicate).length
}

function KpiCard({ icon: Icon, label, value, note }) {
  return (
    <div className="stat-card">
      <div className="stat-icon">
        <Icon size={18} />
      </div>

      <div>
        <span>{label}</span>

        <strong>{value}</strong>

        {note && <small>{note}</small>}
      </div>
    </div>
  )
}

// A single bordered strip of recorded counts — the executive "at a glance" row.
function MetricStrip({ cells }) {
  return (
    <div className="exec-strip">
      {cells.map((cell) => (
        <div key={cell.key} className={`exec-strip-cell is-${cell.tone}`}>
          <span>{cell.label}</span>

          <strong>{cell.value}</strong>

          {cell.note && <small>{cell.note}</small>}
        </div>
      ))}
    </div>
  )
}

function SummaryTiles({ tiles }) {
  return (
    <div className="investigation-indicators">
      {tiles.map((tile) => (
        <div
          key={tile.key}
          className={`investigation-indicator is-${tile.tone}`}
        >
          <span>{tile.label}</span>

          <strong>{tile.value}</strong>

          {tile.note && <small className="exec-tile-note">{tile.note}</small>}
        </div>
      ))}
    </div>
  )
}

export default function DashboardData({
  onViewAll,
  onOpenCaseDetails,
  onOpenAgentDashboard,
}) {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [loadedMetrics, setLoadedMetrics] = useState(null)

  useEffect(() => {
    let cancelled = false

    const load = async () => {
      try {
        const cases = await fetchSupportCases()

        if (!cancelled) {
          setRows(cases)
          setLoading(false)
        }
      } catch (err) {
        if (!cancelled) {
          setError(err?.message || 'Could not load dashboard data.')
          setLoading(false)
        }
      }
    }

    load()

    return () => {
      cancelled = true
    }
  }, [])

  // Recorded AI outcomes and investigation health come from the stored traces.
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
  const tracesObserved = metricsReady ? metrics.tracesObserved : null

  const caseValue = (value) => (loading ? '…' : error ? '—' : value)
  const traceValue = (value) =>
    metricsState.status === 'loading' ? '…' : metricsReady ? value : '—'

  const stats = computeStats(rows)

  const notApproved = countBy(rows, (c) => c.resolution_status === 'not_approved')

  const automatedActions = countBy(
    rows,
    (c) => c.action === 'refund_shipping_fee' || c.action === 'product_refund'
  )
  const humanReviewActions = countBy(rows, (c) => c.action === 'human_review')
  const noActionCases = countBy(rows, (c) => c.action === 'no_action')

  const pendingReview = countBy(rows, (c) => c.case_status === 'escalated')
  const inReview = countBy(rows, (c) => c.case_status === 'in_review')
  const humanResolved = countBy(rows, (c) => c.case_status === 'human_resolved')

  const recent = rows.slice(0, 6)

  const outcomeTones = {
    APPROVE: 'ok',
    DENY: 'danger',
    INFORM: 'info',
    ESCALATE: 'warn',
    BLOCKED: 'muted',
  }

  const traceScopeNote = metricsReady
    ? `Recorded across all ${tracesObserved} stored execution traces.`
    : ''

  return (
    <>
      {error && (
        <div className="dashboard-error-banner">
          <AlertTriangle size={15} />

          <span>Could not load dashboard data: {error}</span>
        </div>
      )}

      {metricsState.status === 'error' && (
        <div className="dashboard-error-banner">
          <AlertTriangle size={15} />

          <span>Could not load stored traces: {loadedMetrics.error}</span>
        </div>
      )}

      {/* 1. Top-level case metrics -------------------------------------------- */}
      <div className="exec-kpi-grid">
        <KpiCard
          icon={FolderOpen}
          label="Total Cases"
          value={caseValue(stats.total)}
          note="all recorded cases"
        />

        <KpiCard
          icon={Check}
          label="Resolved"
          value={caseValue(stats.resolved)}
          note="resolved or human resolved"
        />

        <KpiCard
          icon={AlertTriangle}
          label="Escalated"
          value={caseValue(stats.escalated)}
          note="escalated, not human resolved"
        />

        <KpiCard
          icon={XCircle}
          label="Not Approved"
          value={caseValue(notApproved)}
          note="resolution_status = not_approved"
        />

        <KpiCard
          icon={GitBranch}
          label="Blocked by Gate"
          value={traceValue(metrics?.health.gateBlocks)}
          note={
            metricsReady ? `of ${tracesObserved} traced cases` : 'decision gate'
          }
        />
      </div>

      {/* 2. AI outcome overview ----------------------------------------------- */}
      <section className="panel">
        <div className="panel-header">
          <div>
            <p className="eyebrow">AI OUTCOMES</p>

            <h3>Recorded Decision Agent Results</h3>
          </div>

          <span className="panel-badge">
            {metricsReady ? `${tracesObserved} TRACES` : '—'}
          </span>
        </div>

        <div className="exec-panel-body">
          {!metricsReady ? (
            <p className="dashboard-note">
              {metricsState.status === 'loading'
                ? 'Loading recorded outcomes...'
                : 'No stored execution traces yet, so no recorded outcomes are available.'}
            </p>
          ) : (
            <>
              <MetricStrip
                cells={metrics.decisionOutcomes.map((outcome) => ({
                  key: outcome.key,
                  label: outcome.key,
                  value: outcome.count,
                  tone: outcomeTones[outcome.key] || 'muted',
                  note:
                    typeof outcome.percent === 'number'
                      ? `${outcome.percent}% of traced`
                      : 'no traced cases',
                }))}
              />

              <p className="exec-note">
                {traceScopeNote}
                {metrics.performance.undecidedTraces > 0
                  ? ` ${metrics.performance.undecidedTraces} trace(s) recorded no decision: the decision agent did not produce one, and they are not counted as any outcome.`
                  : ' Every traced case recorded a decision.'}
              </p>
            </>
          )}
        </div>
      </section>

      {/* 3. Investigation health ---------------------------------------------- */}
      <section className="panel">
        <div className="panel-header">
          <div>
            <p className="eyebrow">INVESTIGATION HEALTH</p>

            <h3>Recorded Investigation Signals</h3>
          </div>

          <ShieldCheck size={19} />
        </div>

        <div className="exec-panel-body">
          {!metricsReady ? (
            <p className="dashboard-note">
              {metricsState.status === 'loading'
                ? 'Loading investigation health...'
                : 'No stored execution traces yet, so no investigation health is available.'}
            </p>
          ) : (
            <>
              <MetricStrip
                cells={[
                  {
                    key: 'conflicts',
                    label: 'Conflicts Detected',
                    value: metrics.health.conflicts,
                    tone: metrics.health.conflicts > 0 ? 'warn' : 'ok',
                  },
                  {
                    key: 'uncertainty',
                    label: 'Uncertainty Detected',
                    value: metrics.health.uncertainties,
                    tone: metrics.health.uncertainties > 0 ? 'warn' : 'ok',
                  },
                  {
                    key: 'reinvestigations',
                    label: 'Re-Investigations',
                    value: metrics.health.reinvestigations,
                    tone: metrics.health.reinvestigations > 0 ? 'info' : 'ok',
                  },
                  {
                    key: 'gateBlocks',
                    label: 'Gate Blocks',
                    value: metrics.health.gateBlocks,
                    tone: metrics.health.gateBlocks > 0 ? 'warn' : 'ok',
                  },
                ]}
              />

              <p className="exec-note">{traceScopeNote}</p>
            </>
          )}
        </div>
      </section>

      {/* 4. Automation summary ------------------------------------------------ */}
      <section className="panel">
        <div className="panel-header">
          <div>
            <p className="eyebrow">AI RESOLUTION / AUTOMATION</p>

            <h3>Recorded Case Outcomes</h3>
          </div>

          <Activity size={19} />
        </div>

        <div className="exec-panel-body">
          {loading || error ? (
            <p className="dashboard-note">
              {error ? 'Outcome summary unavailable.' : 'Loading outcomes...'}
            </p>
          ) : (
            <>
              <SummaryTiles
                tiles={[
                  {
                    key: 'automated',
                    label: 'Automated Actions',
                    value: automatedActions,
                    tone: 'ok',
                    note: 'action: refund_shipping_fee · product_refund',
                  },
                  {
                    key: 'human',
                    label: 'Escalated to Human',
                    value: humanReviewActions,
                    tone: 'warn',
                    note: 'action: human_review',
                  },
                  {
                    key: 'none',
                    label: 'Inform / No Action',
                    value: noActionCases,
                    tone: 'info',
                    note: 'action: no_action',
                  },
                ]}
              />

              <p className="exec-note">
                {`Counts cover all ${stats.total} recorded cases (action field). No resolution rate is shown: the stored fields do not support one reliably.`}
              </p>
            </>
          )}
        </div>
      </section>

      {/* 5. Recent case activity ---------------------------------------------- */}
      <section className="panel">
        <div className="panel-header">
          <div>
            <p className="eyebrow">RECENT CASES</p>

            <h3>Latest Recorded Cases</h3>
          </div>

          <button type="button" className="panel-link" onClick={onViewAll}>
            View all
          </button>
        </div>

        <div className="case-table-wrapper">
          <table className="case-table">
            <thead>
              <tr>
                <th>CASE</th>
                <th>ISSUE / INTENT</th>
                <th>STATUS</th>
                <th>OUTCOME</th>
                <th>TIME</th>
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
                    <span className="stage-text">Recent cases unavailable.</span>
                  </td>
                </tr>
              )}

              {!loading && !error && recent.length === 0 && (
                <tr>
                  <td colSpan="5">
                    <span className="stage-text">No cases recorded yet.</span>
                  </td>
                </tr>
              )}

              {!loading &&
                !error &&
                recent.map((c) => (
                  <tr
                    key={c.case_id}
                    className="investigation-table-row"
                    onClick={() => onOpenCaseDetails?.(c.case_id)}
                  >
                    <td>
                      <button className="case-id-button" type="button">
                        {c.case_id}
                      </button>
                    </td>

                    <td>
                      <span className="investigation-cell-stack">
                        <strong>{c.intent || '—'}</strong>

                        <small>{titleFrom(c)}</small>
                      </span>
                    </td>

                    <td>
                      <CaseStatusBadge value={c.resolution_status} />
                    </td>

                    <td>
                      <span className="investigation-cell-stack">
                        <strong>
                          {String(c.decision || '—').toUpperCase()}
                        </strong>

                        <small>{actionLabel(c.action)}</small>
                      </span>
                    </td>

                    <td>{formatDate(c.created_at)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* 6 + 7. Executive summary and human review ---------------------------- */}
      <div className="exec-split">
        <section className="panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">EXECUTIVE SUMMARY</p>

              <h3>Investigation Overview</h3>
            </div>

            <RotateCcw size={19} />
          </div>

          <div className="exec-panel-body">
            <SummaryTiles
              tiles={[
                {
                  key: 'investigated',
                  label: 'Investigations Recorded',
                  value: traceValue(tracesObserved),
                  tone: 'info',
                  note: 'stored traces',
                },
                {
                  key: 'reinvestigated',
                  label: 'Re-Investigated',
                  value: traceValue(metrics?.health.reinvestigations),
                  tone: 'info',
                  note: 'traces with rounds',
                },
                {
                  key: 'blocked',
                  label: 'Blocked by Gate',
                  value: traceValue(metrics?.health.gateBlocks),
                  tone: 'warn',
                  note: 'decision gate BLOCK',
                },
                {
                  key: 'humanReview',
                  label: 'Awaiting Human Review',
                  value: caseValue(pendingReview),
                  tone: 'warn',
                  note: 'case_status = escalated',
                },
              ]}
            />
          </div>
        </section>

        <section className="panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">HUMAN REVIEW</p>

              <h3>Review Summary</h3>
            </div>

            <UserRound size={19} />
          </div>

          <div className="exec-panel-body">
            <SummaryTiles
              tiles={[
                {
                  key: 'pending',
                  label: 'Pending Review',
                  value: caseValue(pendingReview),
                  tone: pendingReview > 0 ? 'warn' : 'ok',
                  note: 'case_status = escalated',
                },
                {
                  key: 'inReview',
                  label: 'In Review',
                  value: caseValue(inReview),
                  tone: inReview > 0 ? 'info' : 'ok',
                  note: 'case_status = in_review',
                },
                {
                  key: 'resolved',
                  label: 'Human Resolved',
                  value: caseValue(humanResolved),
                  tone: humanResolved > 0 ? 'ok' : 'muted',
                  note: 'case_status = human_resolved',
                },
              ]}
            />

            <button
              type="button"
              className="exec-action"
              onClick={onOpenAgentDashboard}
            >
              <UserRound size={13} />

              <span>View Agent Dashboard</span>
            </button>
          </div>
        </section>
      </div>

      <div className="exec-foot">
        <Clock3 size={13} />

        <span>
          Every figure above is a count of recorded rows. Nothing on this page
          is live or projected.
        </span>
      </div>
    </>
  )
}
