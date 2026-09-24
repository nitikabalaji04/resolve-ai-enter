import { supabase } from '../integrations/supabase/client'
import {
  AlertTriangle,
  Bot,
  Brain,
  Circle,
  Database,
  Flag,
  GitBranch,
  ListTree,
  Play,
  RotateCcw,
  ScanSearch,
  SearchCheck,
  ShieldAlert,
  ShieldCheck,
} from 'lucide-react'

// Read-only access to the execution traces ResolveAI persists for real cases.
//
// This module is intentionally free of React UI: it fetches ONE stored trace for
// ONE selected case (the enterprise dataset is never bulk-fetched) and turns the
// stored structure into display-ready values. It never re-runs agents, never
// calls the LLM, never executes actions and never reconstructs history — it only
// describes the trace exactly as it was recorded.

const TRACE_TABLE = 'case_investigation_traces'
const TRACE_COLUMNS = 'case_id, trace_version, trace, created_at'

// Successful reads are cached per case for the session. A stored trace is an
// immutable historical record (one row per case_id, never overwritten), so
// re-selecting a case reuses the already-fetched trace instead of re-requesting
// it. Misses are never cached, so a case whose trace is written later can still
// be picked up. In-flight requests are shared, so one selection = one request.
const traceCache = new Map()
const traceInFlight = new Map()

// fetchCaseTrace(caseId) -> { status, trace, traceVersion, storedAt, error }
// status: 'found' | 'not_found' | 'failed'
//
// Uses the existing RLS-gated read path: only authenticated support agents can
// see trace rows, so a non-agent simply gets 'not_found' instead of data.
export async function fetchCaseTrace(caseId) {
  if (typeof caseId !== 'string' || caseId.trim() === '') {
    return {
      status: 'not_found',
      trace: null,
      traceVersion: null,
      storedAt: null,
      error: null,
    }
  }

  const key = caseId.trim()

  if (traceCache.has(key)) return traceCache.get(key)
  if (traceInFlight.has(key)) return traceInFlight.get(key)

  const request = (async () => {
    try {
      const { data, error } = await supabase
        .from(TRACE_TABLE)
        .select(TRACE_COLUMNS)
        .eq('case_id', key)
        .maybeSingle()

      if (error) {
        return {
          status: 'failed',
          trace: null,
          traceVersion: null,
          storedAt: null,
          error: error.message || 'Could not load the execution trace.',
        }
      }

      if (!data || typeof data !== 'object' || !data.trace) {
        return {
          status: 'not_found',
          trace: null,
          traceVersion: null,
          storedAt: null,
          error: null,
        }
      }

      const result = {
        status: 'found',
        trace: data.trace,
        traceVersion:
          typeof data.trace_version === 'number' ? data.trace_version : null,
        storedAt: typeof data.created_at === 'string' ? data.created_at : null,
        error: null,
      }

      traceCache.set(key, result)

      return result
    } catch (err) {
      return {
        status: 'failed',
        trace: null,
        traceVersion: null,
        storedAt: null,
        error: err?.message || 'Could not load the execution trace.',
      }
    } finally {
      traceInFlight.delete(key)
    }
  })()

  traceInFlight.set(key, request)

  return request
}

// ---------------------------------------------------------------------------
// Stage presentation
// ---------------------------------------------------------------------------

// Display names for the stages the backend can really record. An unknown stage
// still renders (humanized) — the trace is never trimmed to a fixed list.
const STAGE_LABELS = {
  triage: 'Triage',
  investigation_planner: 'Investigation Planner',
  customer_agent: 'Customer Agent',
  order_agent: 'Order Agent',
  delivery_agent: 'Delivery Agent',
  policy_agent: 'Policy Agent',
  evidence_engine: 'Evidence Engine',
  conflict_uncertainty: 'Conflict & Uncertainty',
  reinvestigation: 'Re-Investigation',
  decision_gate: 'Decision Gate',
  decision_agent: 'Decision Agent',
  decision_authority: 'Decision Authority',
  action_safety: 'Action Safety',
  action_executor: 'Action Executor',
  case_outcome: 'Case Outcome',
}

const STAGE_ICONS = {
  triage: ScanSearch,
  investigation_planner: ListTree,
  customer_agent: Bot,
  order_agent: Bot,
  delivery_agent: Bot,
  policy_agent: Bot,
  evidence_engine: Database,
  conflict_uncertainty: AlertTriangle,
  reinvestigation: RotateCcw,
  decision_gate: GitBranch,
  decision_agent: Brain,
  decision_authority: ShieldCheck,
  action_safety: ShieldAlert,
  action_executor: Play,
  case_outcome: Flag,
}

// The five statuses the backend trace can carry, plus a neutral fallback.
const STATUS_LABELS = {
  completed: 'Completed',
  failed: 'Failed',
  blocked: 'Blocked',
  skipped: 'Skipped',
  started: 'Running',
}

const STATUS_CLASSES = {
  completed: 'trace-status-completed',
  failed: 'trace-status-failed',
  blocked: 'trace-status-blocked',
  skipped: 'trace-status-skipped',
  started: 'trace-status-started',
}

export function humanize(value) {
  if (typeof value !== 'string' || value.trim() === '') return '—'

  return value
    .trim()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^./, (c) => c.toUpperCase())
}

export function stageLabel(stage) {
  if (typeof stage !== 'string' || stage.trim() === '') return 'Unknown stage'

  return STAGE_LABELS[stage] || humanize(stage)
}

export function stageIcon(stage) {
  return STAGE_ICONS[stage] || Circle
}

// An agent stage is a domain agent that really ran. The Decision Agent is part
// of the decision chain, not of the domain investigation.
export function isAgentStage(stage) {
  return (
    typeof stage === 'string' &&
    stage.endsWith('_agent') &&
    stage !== 'decision_agent'
  )
}

// Statuses are shown exactly as recorded — never upgraded to completed.
export function statusLabel(status) {
  return STATUS_LABELS[status] || humanize(status)
}

export function statusClass(status) {
  return STATUS_CLASSES[status] || 'trace-status-unknown'
}

// Real durations only: < 1000 ms as milliseconds, otherwise as seconds with one
// decimal. A duration the backend could not measure stays unknown.
export function formatDuration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return `${Math.round(ms)} ms`

  return `${(ms / 1000).toFixed(1)} s`
}

export function formatTimestamp(value) {
  if (typeof value !== 'string' || value === '') return '—'

  const date = new Date(value)

  if (Number.isNaN(date.getTime())) return '—'

  return date.toLocaleString()
}

// Total trace duration is measured between the real trace timestamps.
export function traceTotalDuration(trace) {
  if (!trace || typeof trace !== 'object') {
    return { ms: null, label: '—' }
  }

  const startedMs = new Date(trace.started_at).getTime()
  const completedMs = new Date(trace.completed_at).getTime()

  if (!Number.isFinite(startedMs) || !Number.isFinite(completedMs)) {
    return { ms: null, label: '—' }
  }

  const ms = Math.max(0, completedMs - startedMs)

  return { ms, label: formatDuration(ms) }
}

// ---------------------------------------------------------------------------
// Stage summaries
// ---------------------------------------------------------------------------

function isPresent(value) {
  if (value === null || value === undefined) return false
  if (typeof value === 'string') return value.trim() !== ''
  if (Array.isArray(value)) return value.length > 0

  return true
}

function list(value) {
  if (!Array.isArray(value)) return ''

  return value.filter((item) => isPresent(item)).join(', ')
}

function percent(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null

  return `${Math.round(value * 100)}%`
}

// Readable summary lines built only from fields the backend really stored.
// Unknown or absent fields are omitted — nothing is inferred.
export function stageSummaryFields(stage, summary) {
  const data = summary && typeof summary === 'object' ? summary : {}
  const fields = []

  const push = (label, value) => {
    if (isPresent(value)) fields.push({ label, value: String(value) })
  }

  if (stage === 'triage') {
    push('Intent', data.intent)
    push('Urgency', data.urgency)
    push('Confidence', data.confidence)
    push('Source', data.source)

    return fields
  }

  if (stage === 'investigation_planner') {
    push('Domains', list(data.domains))

    return fields
  }

  if (stage === 'evidence_engine') {
    push('Evidence', data.evidence_count)
    push('Agents reporting', data.agents)

    return fields
  }

  if (stage === 'conflict_uncertainty') {
    push('Conflict', data.conflict_status)
    push('Uncertainty', data.uncertainty_status)

    if (typeof data.requires_reinvestigation === 'boolean') {
      push(
        'Re-investigation',
        data.requires_reinvestigation ? 'required' : 'not required'
      )
    }

    return fields
  }

  if (stage === 'reinvestigation') {
    push('Rounds', data.rounds)
    push('Reason', data.reason)

    const rounds = Array.isArray(data.rounds_detail) ? data.rounds_detail : []

    for (const round of rounds) {
      if (!round || typeof round !== 'object') continue

      const roundNumber =
        typeof round.round === 'number' ? round.round : null
      const domains = list(round.target_domains)

      if (domains) {
        push(
          roundNumber === null ? 'Target domains' : `Round ${roundNumber}`,
          domains
        )
      }
    }

    return fields
  }

  if (stage === 'decision_gate') {
    push('Gate', data.status)
    push('Reason', data.reason)

    return fields
  }

  if (stage === 'decision_agent') {
    push('Decision', data.decision)
    push('Action', data.action)
    push('Confidence', data.confidence)
    push('Evidence cited', list(data.evidence_ids))
    push('Reason', data.reason)

    return fields
  }

  if (stage === 'decision_authority') {
    push('Authority', data.status)
    push('Decision', data.decision)
    push('Action', data.action)
    push('Reason', data.reason)

    return fields
  }

  if (stage === 'action_safety') {
    push('Safety', data.status)
    push('Reason', data.reason)

    return fields
  }

  if (stage === 'action_executor') {
    push('Action', data.action)
    push('Result', data.status)
    push('Reason', data.reason)

    return fields
  }

  if (stage === 'case_outcome') {
    push('Outcome', data.status)
    push('Decision', data.decision)
    push('Action', data.action)

    return fields
  }

  if (isAgentStage(stage)) {
    push('Findings', data.finding_count)
    push('Agent status', data.status)
    push('Reason', data.reason)

    return fields
  }

  return fields
}

// ---------------------------------------------------------------------------
// Trace sections
// ---------------------------------------------------------------------------

function findStage(stages, name) {
  return stages.find((entry) => entry.stage === name) || null
}

// The final state of a repeated stage (re-investigation re-runs the same stage
// names) — the last occurrence is the one that closed the case.
function findLastStage(stages, name) {
  for (let index = stages.length - 1; index >= 0; index -= 1) {
    if (stages[index].stage === name) return stages[index]
  }

  return null
}

function extractOverview(stages) {
  const triage = findStage(stages, 'triage')
  const planner = findStage(stages, 'investigation_planner')

  const triageData = triage?.summary ?? {}
  const domains = Array.isArray(planner?.summary?.domains)
    ? planner.summary.domains
    : []

  return {
    intent: isPresent(triageData.intent) ? String(triageData.intent) : null,
    urgency: isPresent(triageData.urgency) ? String(triageData.urgency) : null,
    confidence: isPresent(triageData.confidence)
      ? String(triageData.confidence)
      : null,
    source: isPresent(triageData.source) ? String(triageData.source) : null,
    domains: domains.map((domain) => ({
      value: String(domain),
      label: humanize(domain),
    })),
  }
}

// Only persisted evidence information is exposed: the collected count, how many
// agents reported, per-agent finding counts and the evidence ids the decision
// cited. Individual findings, sources and confidences are not stored, so they
// are never shown or guessed.
function extractEvidence(stages) {
  const engine = findLastStage(stages, 'evidence_engine')
  const decisionAgent = findLastStage(stages, 'decision_agent')

  const engineData = engine?.summary ?? {}

  const citedIds = Array.isArray(decisionAgent?.summary?.evidence_ids)
    ? decisionAgent.summary.evidence_ids.filter((id) => isPresent(id))
    : []

  return {
    collected:
      typeof engineData.evidence_count === 'number'
        ? engineData.evidence_count
        : null,
    agentsReporting:
      typeof engineData.agents === 'number' ? engineData.agents : null,
    agentFindings: stages
      .filter((entry) => entry.isAgent)
      .map((entry) => ({
        key: entry.key,
        label: entry.label,
        status: entry.status,
        statusLabel: entry.statusLabel,
        statusClass: entry.statusClass,
        findingCount:
          typeof entry.summary.finding_count === 'number'
            ? entry.summary.finding_count
            : null,
      })),
    citedIds: citedIds.map((id) => String(id)),
  }
}

function extractHealth(stages) {
  const health = findLastStage(stages, 'conflict_uncertainty')
  const reinvestigation = findLastStage(stages, 'reinvestigation')

  const healthData = health?.summary ?? {}
  const reinvestigationData = reinvestigation?.summary ?? {}

  const roundsDetail = Array.isArray(reinvestigationData.rounds_detail)
    ? reinvestigationData.rounds_detail
        .filter((round) => round && typeof round === 'object')
        .map((round, index) => ({
          key: `round-${typeof round.round === 'number' ? round.round : index + 1}`,
          round: typeof round.round === 'number' ? round.round : index + 1,
          targetDomains: Array.isArray(round.target_domains)
            ? round.target_domains.map((domain) => humanize(domain))
            : [],
          result: isPresent(round.result) ? String(round.result) : null,
        }))
    : []

  return {
    conflictStatus: isPresent(healthData.conflict_status)
      ? String(healthData.conflict_status)
      : null,
    uncertaintyStatus: isPresent(healthData.uncertainty_status)
      ? String(healthData.uncertainty_status)
      : null,
    requiresReinvestigation:
      typeof healthData.requires_reinvestigation === 'boolean'
        ? healthData.requires_reinvestigation
        : null,
    performed: roundsDetail.length > 0,
    rounds:
      typeof reinvestigationData.rounds === 'number'
        ? reinvestigationData.rounds
        : null,
    stopReason: isPresent(reinvestigationData.reason)
      ? String(reinvestigationData.reason)
      : null,
    roundsDetail,
  }
}

const CHAIN_STAGES = [
  'decision_gate',
  'decision_agent',
  'decision_authority',
  'action_safety',
  'action_executor',
  'case_outcome',
]

// The decision chain is read from the real recorded stages. A step the trace
// never reached is reported as not reached — authorization and execution are
// never inferred.
function extractDecisionChain(stages) {
  return CHAIN_STAGES.map((stage) => {
    const entry = findLastStage(stages, stage)

    const base = {
      key: stage,
      stage,
      label: stageLabel(stage),
      icon: stageIcon(stage),
      present: Boolean(entry),
      value: 'Not reached',
      details: [],
      reason: null,
      status: 'skipped',
      statusClass: 'trace-status-skipped',
    }

    if (!entry) return base

    const data = entry.summary
    const details = []
    const addDetail = (value) => {
      if (isPresent(value)) details.push(String(value))
    }

    const next = {
      ...base,
      present: true,
      status: entry.status,
      statusClass: entry.statusClass,
      reason: isPresent(data.reason) ? String(data.reason) : null,
    }

    if (stage === 'decision_gate') {
      next.value = isPresent(data.status) ? String(data.status).toUpperCase() : entry.statusLabel
      next.status = String(data.status).toUpperCase() === 'BLOCK' ? 'blocked' : entry.status
      next.statusClass = statusClass(next.status)

      return next
    }

    if (stage === 'decision_agent') {
      if (entry.status !== 'completed') {
        next.value = entry.statusLabel

        return next
      }

      next.value = isPresent(data.decision)
        ? String(data.decision).toUpperCase()
        : entry.statusLabel
      addDetail(isPresent(data.action) ? String(data.action) : null)
      addDetail(percent(data.confidence) ? `${percent(data.confidence)} confidence` : null)

      return { ...next, details }
    }

    if (stage === 'decision_authority') {
      next.value = isPresent(data.status)
        ? String(data.status).toUpperCase()
        : entry.statusLabel
      addDetail(isPresent(data.action) ? String(data.action) : null)

      return { ...next, details }
    }

    if (stage === 'action_safety') {
      next.value = isPresent(data.status)
        ? String(data.status).toUpperCase()
        : entry.statusLabel

      return next
    }

    if (stage === 'action_executor') {
      next.value = entry.status.toUpperCase()
      addDetail(isPresent(data.action) ? String(data.action) : null)
      addDetail(isPresent(data.status) ? `Result: ${data.status}` : null)

      return { ...next, details }
    }

    next.value = isPresent(data.status)
      ? String(data.status).toUpperCase()
      : entry.statusLabel
    addDetail(isPresent(data.decision) ? `Decision: ${data.decision}` : null)
    addDetail(isPresent(data.action) ? `Action: ${data.action}` : null)

    return { ...next, details }
  })
}

// ---------------------------------------------------------------------------
// Compact execution flow (Triage -> Investigation -> Evidence -> Decision -> Action)
// ---------------------------------------------------------------------------

// One compact step per phase, aggregated from the stages that really ran. The
// long stage-by-stage trace stays behind the expandable section; this summary
// only reports what the stored trace says.
const DECISION_PHASE_STAGES = [
  'decision_gate',
  'decision_agent',
  'decision_authority',
  'action_safety',
]

const FLOW_PHASES = [
  {
    key: 'triage',
    label: 'Triage',
    icon: ScanSearch,
    matches: (entry) => entry.stage === 'triage',
  },
  {
    key: 'investigation',
    label: 'Investigation',
    icon: SearchCheck,
    matches: (entry) =>
      entry.stage === 'investigation_planner' || entry.isAgent,
  },
  {
    key: 'evidence',
    label: 'Evidence',
    icon: Database,
    matches: (entry) => entry.stage === 'evidence_engine',
  },
  {
    key: 'decision',
    label: 'Decision',
    icon: Brain,
    matches: (entry) => DECISION_PHASE_STAGES.includes(entry.stage),
  },
  {
    key: 'action',
    label: 'Action',
    icon: Play,
    matches: (entry) => entry.stage === 'action_executor',
  },
]

// Worst recorded status wins, so a phase is never shown as completed when one
// of its stages failed or was blocked.
const STATUS_SEVERITY = {
  failed: 5,
  blocked: 4,
  started: 3,
  completed: 2,
  skipped: 1,
  unknown: 0,
}

function aggregateStatus(entries) {
  if (entries.length === 0) return 'skipped'

  let worst = entries[0].status

  for (const entry of entries) {
    const severity = STATUS_SEVERITY[entry.status] ?? 0
    const worstSeverity = STATUS_SEVERITY[worst] ?? 0

    if (severity > worstSeverity) worst = entry.status
  }

  return worst
}

function flowDetail(key, entries) {
  const data = (name) => entries.find((entry) => entry.stage === name)?.summary ?? {}

  if (key === 'triage') {
    return isPresent(data('triage').intent) ? String(data('triage').intent) : null
  }

  if (key === 'investigation') {
    // Only the agents that really ran are counted; a stage the plan skipped is
    // reported in the full trace view instead.
    const agents = entries.filter(
      (entry) => entry.isAgent && entry.status !== 'skipped'
    )
    const findings = agents.reduce(
      (total, entry) =>
        total +
        (typeof entry.summary.finding_count === 'number'
          ? entry.summary.finding_count
          : 0),
      0
    )

    if (agents.length === 0) return null

    return `${agents.length} agent${agents.length === 1 ? '' : 's'} · ${findings} findings`
  }

  if (key === 'evidence') {
    const count = data('evidence_engine').evidence_count

    return typeof count === 'number'
      ? `${count} evidence item${count === 1 ? '' : 's'}`
      : null
  }

  if (key === 'decision') {
    const parts = []
    const gate = data('decision_gate').status
    const decision = data('decision_agent').decision
    const authority = data('decision_authority').status

    if (isPresent(gate)) parts.push(`Gate: ${gate}`)
    if (isPresent(decision)) parts.push(`Agent: ${decision}`)
    if (isPresent(authority)) parts.push(`Authority: ${authority}`)

    return parts.length > 0 ? parts.join(' · ') : null
  }

  if (key === 'action') {
    const executor = data('action_executor')
    const parts = []

    if (isPresent(executor.action)) parts.push(humanize(executor.action))
    if (isPresent(executor.status)) parts.push(`Result: ${executor.status}`)
    if (parts.length === 0 && isPresent(executor.reason)) {
      parts.push(`Reason: ${executor.reason}`)
    }

    return parts.length > 0 ? parts.join(' · ') : null
  }

  return null
}

function flowValue(key, entries) {
  const data = (name) => entries.find((entry) => entry.stage === name)?.summary ?? {}

  if (key === 'decision') {
    const decision = data('decision_agent').decision

    if (isPresent(decision)) return String(decision).toUpperCase()

    return isPresent(data('decision_gate').status)
      ? String(data('decision_gate').status).toUpperCase()
      : null
  }

  if (key === 'action') {
    return isPresent(data('action_executor').action)
      ? humanize(data('action_executor').action)
      : null
  }

  return null
}

// executionFlow(stages) -> the five compact steps of a stored trace.
export function executionFlow(stages) {
  const list = Array.isArray(stages) ? stages : []

  return FLOW_PHASES.map((phase) => {
    const entries = list.filter((entry) => phase.matches(entry))
    const status = aggregateStatus(entries)

    return {
      key: phase.key,
      label: phase.label,
      icon: phase.icon,
      status,
      statusLabel: statusLabel(status),
      statusClass: statusClass(status),
      value: flowValue(phase.key, entries),
      detail: flowDetail(phase.key, entries),
      recorded: entries.length > 0,
    }
  })
}

// ---------------------------------------------------------------------------
// Investigation health indicators (Conflict / Uncertainty / Re-Investigation)
// ---------------------------------------------------------------------------

// Readable indicator values from the recorded health of a normalized trace.
// Recorded values are never replaced: "none" reads as None, a detected state
// keeps its recorded name, and re-investigation reports what really happened.
export function healthIndicators(trace) {
  const health = trace && typeof trace === 'object' ? trace.health : null

  if (!health) {
    return {
      conflict: { value: '—', tone: 'muted' },
      uncertainty: { value: '—', tone: 'muted' },
      reinvestigation: { value: '—', tone: 'muted' },
    }
  }

  const conflictDetected =
    isPresent(health.conflictStatus) && health.conflictStatus !== 'none'
  const uncertaintyDetected =
    isPresent(health.uncertaintyStatus) && health.uncertaintyStatus !== 'none'

  const reinvestigation =
    health.requiresReinvestigation === null
      ? { value: '—', tone: 'muted' }
      : !health.requiresReinvestigation
        ? { value: 'Not required', tone: 'ok' }
        : health.performed
          ? { value: 'Completed', tone: 'info' }
          : { value: 'Required', tone: 'warn' }

  // Recorded values are only capitalized for display — never replaced.
  return {
    conflict: {
      value: conflictDetected ? humanize(health.conflictStatus) : 'None',
      tone: conflictDetected ? 'warn' : 'ok',
    },
    uncertainty: {
      value: uncertaintyDetected ? humanize(health.uncertaintyStatus) : 'None',
      tone: uncertaintyDetected ? 'warn' : 'ok',
    },
    reinvestigation,
  }
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

// normalizeTrace(trace) -> display-ready view of ONE stored trace, or null when
// the stored trace is not usable. Stage order and repetition are preserved
// exactly as stored (a trace can hold 15–18 stages, and re-investigation re-runs
// the same stage names).
export function normalizeTrace(trace) {
  if (!trace || typeof trace !== 'object' || !Array.isArray(trace.stages)) {
    return null
  }

  const stages = trace.stages.map((entry, index) => {
    const stage =
      entry && typeof entry.stage === 'string' && entry.stage.trim() !== ''
        ? entry.stage
        : 'unknown'

    const status =
      entry && typeof entry.status === 'string' && entry.status.trim() !== ''
        ? entry.status
        : 'unknown'

    return {
      key:
        entry && typeof entry.id === 'string' && entry.id !== ''
          ? entry.id
          : `trace-stage-${index + 1}`,
      stage,
      label: stageLabel(stage),
      icon: stageIcon(stage),
      isAgent: isAgentStage(stage),
      status,
      statusLabel: statusLabel(status),
      statusClass: statusClass(status),
      duration: formatDuration(entry?.duration_ms),
      startedAt: entry?.started_at ?? null,
      completedAt: entry?.completed_at ?? null,
      summary: entry?.summary && typeof entry.summary === 'object' ? entry.summary : {},
      summaryFields: stageSummaryFields(stage, entry?.summary),
    }
  })

  return {
    caseId: typeof trace.case_id === 'string' ? trace.case_id : '',
    traceVersion:
      typeof trace.trace_version === 'number' ? trace.trace_version : null,
    startedAt: trace.started_at ?? null,
    completedAt: trace.completed_at ?? null,
    totalDuration: traceTotalDuration(trace),
    stages,
    agentStages: stages.filter((entry) => entry.isAgent),
    flow: executionFlow(stages),
    overview: extractOverview(stages),
    evidence: extractEvidence(stages),
    health: extractHealth(stages),
    decisionChain: extractDecisionChain(stages),
  }
}
