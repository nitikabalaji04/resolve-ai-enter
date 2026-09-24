import { useEffect, useState } from 'react'
import { supabase } from '../integrations/supabase/client'
import {
  AlertTriangle,
  ChevronRight,
  Inbox,
  RefreshCw,
} from 'lucide-react'
import CaseDetails from './CaseDetails'
import CaseStatusBadge from './CaseStatusBadge'
import { formatDate } from '../utils/supportCases'

const FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'escalated', label: 'Escalated' },
]

async function fetchCases() {
  const { data, error } = await supabase
    .from('support_cases')
    .select('*')
    .order('created_at', { ascending: false })

  if (error) throw error

  return data || []
}

// Case Management is the case LIST. Selecting a case opens the dedicated Case
// Details view (full-width, beside the existing sidebar) instead of a side
// panel, and "Back to Cases" returns to this list with the filters intact.
export default function CaseManagement({ user }) {
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
      setError(err?.message || 'Could not load cases from the database.')
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
          setError(err?.message || 'Could not load cases from the database.')
          setLoading(false)
        }
      }
    }

    load()

    return () => {
      cancelled = true
    }
  }, [])

  const selectedCase = cases.find((c) => c.case_id === selectedId) || null

  const replaceCaseInList = (updated) => {
    setCases((prev) =>
      prev.map((c) => (c.case_id === updated.case_id ? updated : c))
    )
  }

  // Dedicated details view: one case at a time, full width.
  if (selectedCase) {
    return (
      <CaseDetails
        key={selectedCase.case_id}
        caseRecord={selectedCase}
        user={user}
        onBack={() => setSelectedId(null)}
        onCaseUpdated={replaceCaseInList}
      />
    )
  }

  const filteredCases =
    filter === 'all'
      ? cases
      : cases.filter((c) => c.resolution_status === filter)

  return (
    <div className="dashboard-page case-management-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">HUMAN AGENT</p>

          <h1>Case Management</h1>

          <p>
            Review real support cases saved by ResolveAI from the Enter Cloud
            database. Select a case to open its details.
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

      <section className="panel case-list-panel case-list-panel-full">
        <div className="case-filter-row">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              className={`case-filter-btn ${filter === f.value ? 'active' : ''}`}
              onClick={() => setFilter(f.value)}
            >
              {f.label}

              <span>
                {f.value === 'all'
                  ? cases.length
                  : cases.filter((c) => c.resolution_status === f.value).length}
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
                className="case-list-item"
                onClick={() => setSelectedId(c.case_id)}
              >
                <div className="case-list-top">
                  <strong>{c.case_id}</strong>

                  <div className="case-list-top-right">
                    <CaseStatusBadge value={c.resolution_status} />

                    <ChevronRight size={14} className="case-list-chevron" />
                  </div>
                </div>

                <div className="case-list-meta">
                  <span>
                    Customer {c.customer_id || '—'} · Order {c.order_id || '—'}
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
    </div>
  )
}
