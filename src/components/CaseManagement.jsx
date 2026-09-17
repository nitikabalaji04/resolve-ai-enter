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

export default function CaseManagement() {
  const [cases, setCases] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [filter, setFilter] = useState('all')
  const [selectedId, setSelectedId] = useState(null)

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
