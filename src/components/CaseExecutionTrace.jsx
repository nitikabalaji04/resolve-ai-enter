import { useEffect, useState } from 'react'
import { ArrowDown, Inbox, RefreshCw, ShieldCheck } from 'lucide-react'
import {
  fetchCaseTrace,
  formatTimestamp,
  normalizeTrace,
} from '../utils/executionTrace'

// Read-only observability panel for ONE selected case.
//
// It fetches exactly one stored execution trace for the selected case and
// renders the stages, evidence summary, investigation health, decision chain and
// timeline exactly as they were recorded. It never re-runs agents, never calls
// the LLM, never executes actions, never writes anything and never reconstructs
// history from current database state.

// A selection with no loaded result yet renders as loading; with no case
// selected at all it renders as empty. Nothing is written to state for these
// derived cases.
const EMPTY_TRACE_VIEW = {
  trace: null,
  storedAt: null,
  error: null,
}

// One row per recorded stage: icon, name, real status, real duration and the
// readable summary built from the stored summary fields. Shared with the
// Investigations page so both views read the same stored trace.
export function TraceStageRow({ stage }) {
  const Icon = stage.icon

  return (
    <div className="trace-stage">
      <div className={`trace-stage-icon ${stage.statusClass}`}>
        <Icon size={14} />
      </div>

      <div className="trace-stage-content">
        <div className="trace-stage-head">
          <strong>{stage.label}</strong>

          <div className="trace-stage-meta">
            <span className={`trace-stage-status ${stage.statusClass}`}>
              {stage.statusLabel}
            </span>

            <span className="trace-stage-duration">{stage.duration}</span>
          </div>
        </div>

        {stage.summaryFields.length > 0 && (
          <div className="trace-stage-summary">
            {stage.summaryFields.map((field) => (
              <span key={`${stage.key}-${field.label}`}>
                <em>{field.label}</em>
                {field.value}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function SectionTitle({ children }) {
  return <span className="trace-section-title">{children}</span>
}

export default function CaseExecutionTrace({ caseId }) {
  const [loaded, setLoaded] = useState(null)
  const [reloadKey, setReloadKey] = useState(0)

  // The rendered state is derived from the loaded result for the CURRENT
  // selection: a selection without a result yet is loading (or empty when no
  // case is selected). This keeps the effect free of synchronous state writes.
  const isCurrent =
    loaded !== null && loaded.caseId === caseId && loaded.reloadKey === reloadKey

  const state = isCurrent
    ? loaded
    : {
        ...EMPTY_TRACE_VIEW,
        status: caseId ? 'loading' : 'empty',
      }

  useEffect(() => {
    if (!caseId) return undefined

    let cancelled = false

    // One selected case -> one trace fetch. The utility caches the resolved
    // trace and shares in-flight requests, so unrelated re-renders and repeated
    // selections never issue extra requests.
    fetchCaseTrace(caseId).then((result) => {
      if (cancelled) return

      if (result.status === 'failed') {
        setLoaded({
          caseId,
          reloadKey,
          status: 'error',
          trace: null,
          storedAt: null,
          error: result.error,
        })

        return
      }

      const trace =
        result.status === 'found' ? normalizeTrace(result.trace) : null

      setLoaded({
        caseId,
        reloadKey,
        status: trace ? 'ready' : 'empty',
        trace,
        storedAt: result.storedAt,
        error: null,
      })
    })

    return () => {
      cancelled = true
    }
  }, [caseId, reloadKey])

  if (state.status === 'loading') {
    return (
      <div className="trace-panel">
        <div className="case-state-box">
          <RefreshCw size={18} className="case-spin" />

          <p>Loading execution trace...</p>
        </div>
      </div>
    )
  }

  if (state.status === 'error') {
    return (
      <div className="trace-panel">
        <div className="case-error-banner">
          <ShieldCheck size={16} />

          <div>
            <strong>Execution trace unavailable</strong>

            <p>{state.error}</p>
          </div>

          <button type="button" onClick={() => setReloadKey((v) => v + 1)}>
            Try again
          </button>
        </div>
      </div>
    )
  }

  if (state.status === 'empty' || !state.trace) {
    return (
      <div className="trace-panel">
        <div className="trace-header">
          <div>
            <p className="eyebrow">EXECUTION TRACE</p>

            <h4>{caseId ? `CASE ${caseId}` : 'No case selected'}</h4>
          </div>
        </div>

        <div className="trace-empty">
          <Inbox size={20} />

          <strong>No recorded execution for this case.</strong>

          <p>
            ResolveAI stores an execution trace when a case is investigated.
            This case has no stored trace, so no timeline is shown.
          </p>
        </div>
      </div>
    )
  }

  const { trace, storedAt } = state
  const { overview, evidence, health, decisionChain } = trace

  return (
    <div className="trace-panel">
      <div className="trace-header">
        <div>
          <p className="eyebrow">EXECUTION TRACE</p>

          <h4>{`CASE ${trace.caseId || caseId}`}</h4>

          <div className="trace-meta">
            {trace.traceVersion !== null && (
              <span>{`TRACE v${trace.traceVersion}`}</span>
            )}

            <span>{`Recorded: ${formatTimestamp(storedAt)}`}</span>

            <span>{`Total duration: ${trace.totalDuration.label}`}</span>

            <span>{`${trace.stages.length} stages`}</span>
          </div>
        </div>

        <div className="trace-replay-banner">
          <ShieldCheck size={13} />

          <span>Historical execution · Read-only</span>
        </div>
      </div>

      <div className="trace-section">
        <SectionTitle>INVESTIGATION OVERVIEW</SectionTitle>

        <div className="trace-facts">
          <div>
            <span>Intent</span>
            <strong>{overview.intent || '—'}</strong>
          </div>

          <div>
            <span>Urgency</span>
            <strong>{overview.urgency || '—'}</strong>
          </div>

          <div>
            <span>Confidence</span>
            <strong>{overview.confidence ?? '—'}</strong>
          </div>

          <div>
            <span>Source</span>
            <strong>{overview.source || '—'}</strong>
          </div>
        </div>

        <div className="trace-domains">
          <span>Planned domains</span>

          {overview.domains.length === 0 ? (
            <em>—</em>
          ) : (
            overview.domains.map((domain) => (
              <span key={domain.value} className="trace-chip">
                {domain.label}
              </span>
            ))
          )}
        </div>
      </div>

      <div className="trace-section">
        <SectionTitle>AGENT EXECUTION</SectionTitle>

        {trace.agentStages.length === 0 ? (
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
      </div>

      <div className="trace-section">
        <SectionTitle>EVIDENCE</SectionTitle>

        <div className="trace-evidence">
          <div className="trace-facts">
            <div>
              <span>Evidence collected</span>
              <strong>{evidence.collected ?? '—'}</strong>
            </div>

            <div>
              <span>Agents reporting</span>
              <strong>{evidence.agentsReporting ?? '—'}</strong>
            </div>
          </div>

          <div className="trace-evidence-block">
            <span>Agent finding counts</span>

            {evidence.agentFindings.length === 0 ? (
              <em>—</em>
            ) : (
              evidence.agentFindings.map((item) => (
                <div key={item.key} className="trace-evidence-row">
                  <span>{item.label}</span>

                  <strong>{item.findingCount ?? '—'}</strong>
                </div>
              ))
            )}
          </div>

          <div className="trace-evidence-block">
            <span>Evidence cited by decision</span>

            <p className="trace-evidence-ids">
              {evidence.citedIds.length === 0
                ? 'No evidence ids cited.'
                : evidence.citedIds.join(', ')}
            </p>
          </div>

          <p className="case-context-note">
            Only persisted evidence information is shown. Individual findings,
            sources and confidence values are not stored with the trace.
          </p>
        </div>
      </div>

      <div className="trace-section">
        <SectionTitle>INVESTIGATION HEALTH</SectionTitle>

        <div className="trace-facts">
          <div>
            <span>Conflict status</span>
            <strong>{health.conflictStatus || '—'}</strong>
          </div>

          <div>
            <span>Uncertainty status</span>
            <strong>{health.uncertaintyStatus || '—'}</strong>
          </div>

          <div>
            <span>Re-investigation required</span>
            <strong>
              {health.requiresReinvestigation === null
                ? '—'
                : health.requiresReinvestigation
                  ? 'Yes'
                  : 'No'}
            </strong>
          </div>
        </div>

        {health.performed ? (
          <div className="trace-rounds">
            <span>Re-investigation performed</span>

            {health.roundsDetail.map((round) => (
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
        ) : (
          <p className="case-context-note">
            No re-investigation round was performed for this case.
          </p>
        )}
      </div>

      <div className="trace-section">
        <SectionTitle>DECISION CHAIN</SectionTitle>

        <div className="trace-decision-chain">
          {decisionChain.map((step, index) => {
            const Icon = step.icon

            return (
              <div key={step.key} className="trace-chain-block">
                <div className={`trace-chain-step ${step.statusClass}`}>
                  <div className="trace-chain-head">
                    <div className="trace-chain-icon">
                      <Icon size={14} />
                    </div>

                    <span>{step.label}</span>
                  </div>

                  <strong>{step.value}</strong>

                  {step.details.map((detail) => (
                    <span key={`${step.key}-${detail}`}>{detail}</span>
                  ))}

                  {step.reason && (
                    <span className="trace-chain-reason">
                      {`Reason: ${step.reason}`}
                    </span>
                  )}
                </div>

                {index < decisionChain.length - 1 && (
                  <ArrowDown size={14} className="trace-chain-arrow" />
                )}
              </div>
            )
          })}
        </div>
      </div>

      <div className="trace-section">
        <SectionTitle>EXECUTION TIMELINE</SectionTitle>

        <div className="trace-timeline">
          {trace.stages.map((stage) => (
            <div key={stage.key} className="trace-timeline-item">
              <span className={`trace-timeline-dot ${stage.statusClass}`} />

              <TraceStageRow stage={stage} />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
