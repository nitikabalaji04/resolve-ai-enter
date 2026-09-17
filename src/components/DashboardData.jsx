import { useEffect, useState } from 'react'
import {
  Clock3,
  Check,
  AlertTriangle,
  ShieldCheck,
} from 'lucide-react'
import {
  fetchSupportCases,
  computeStats,
  recentStatus,
  titleFrom,
} from '../utils/supportCases'

// Derives the workflow activity from the most recent real case only.
function activityItems(rows) {
  const latest = rows[0]

  if (!latest) return []

  const items = [
    { title: 'Policy checked', detail: `Case ${latest.case_id}` },
  ]

  const decision = latest.decision

  items.push({
    title: 'AI decision generated',
    detail: decision
      ? `${decision.charAt(0).toUpperCase()}${decision.slice(1)} — ${
          latest.reason || 'Reason recorded'
        }`
      : 'Decision recorded',
  })

  if (latest.action_status === 'completed') {
    items.push({
      title: 'Automated action executed',
      detail: `${latest.action} — completed`,
    })
  } else if (latest.resolution_status === 'escalated') {
    items.push({
      title: 'Escalated to human review',
      detail: `Case ${latest.case_id}`,
    })
  }

  return items
}

export default function DashboardData({ onViewAll }) {
  const [stats, setStats] = useState(null)
  const [recent, setRecent] = useState([])
  const [activity, setActivity] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false

    const load = async () => {
      try {
        const rows = await fetchSupportCases()

        if (!cancelled) {
          setStats(computeStats(rows))
          setRecent(rows.slice(0, 4))
          setActivity(activityItems(rows))
          setLoading(false)
        }
      } catch (err) {
        if (!cancelled) {
          setError(
            err?.message || 'Could not load dashboard data.'
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

  return (
    <>
      {error && (
        <div className="dashboard-error-banner">
          <AlertTriangle size={15} />

          <span>
            Could not load dashboard data: {error}
          </span>
        </div>
      )}

      <div className="stats-grid">
        <div className="stat-card">
          <div className="stat-icon">
            <Clock3 size={18} />
          </div>

          <div>
            <span>Active Cases</span>
            <strong>
              {loading ? '…' : error ? '—' : stats.active}
            </strong>
          </div>
        </div>

        <div className="stat-card">
          <div className="stat-icon">
            <Check size={18} />
          </div>

          <div>
            <span>Resolved Cases</span>
            <strong>
              {loading ? '…' : error ? '—' : stats.resolved}
            </strong>
          </div>
        </div>

        <div className="stat-card">
          <div className="stat-icon">
            <AlertTriangle size={18} />
          </div>

          <div>
            <span>Escalated Cases</span>
            <strong>
              {loading ? '…' : error ? '—' : stats.escalated}
            </strong>
          </div>
        </div>

        <div className="stat-card">
          <div className="stat-icon">
            <ShieldCheck size={18} />
          </div>

          <div>
            <span>Resolution Rate</span>
            <strong>
              {loading ? '…' : error ? '—' : `${stats.rate}%`}
            </strong>
          </div>
        </div>
      </div>

      <div className="dashboard-grid">
        <div className="panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">CASE MANAGEMENT</p>
              <h3>Recent Cases</h3>
            </div>

            <button
              type="button"
              className="panel-link"
              onClick={onViewAll}
            >
              View all
            </button>
          </div>

          <div className="case-list">
            {loading && (
              <p className="dashboard-note">Loading cases...</p>
            )}

            {!loading && error && (
              <p className="dashboard-note">
                Recent cases unavailable.
              </p>
            )}

            {!loading && !error && recent.length === 0 && (
              <p className="dashboard-note">
                No cases yet.
              </p>
            )}

            {!loading &&
              !error &&
              recent.map((c) => {
                const status = recentStatus(c)

                return (
                  <div key={c.case_id} className="case-row">
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
          </div>
        </div>

        <div className="panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">AI ACTIVITY</p>
              <h3>Autonomous Workflow</h3>
            </div>
          </div>

          <div className="activity-list">
            {loading && (
              <p className="dashboard-note">Loading activity...</p>
            )}

            {!loading && error && (
              <p className="dashboard-note">
                Activity unavailable.
              </p>
            )}

            {!loading && !error && activity.length === 0 && (
              <p className="dashboard-note">
                No activity yet.
              </p>
            )}

            {!loading &&
              !error &&
              activity.map((item, index) => (
                <div key={index} className="activity-item">
                  <span className="activity-line" />

                  <div>
                    <strong>{item.title}</strong>

                    <p>{item.detail}</p>
                  </div>
                </div>
              ))}
          </div>
        </div>
      </div>
    </>
  )
}
