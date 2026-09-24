const STATUS_CLASS = {
  resolved: 'case-status resolved',
  escalated: 'case-status escalated',
  not_approved: 'case-status escalated',
  in_review: 'case-status investigating',
  human_resolved: 'case-status resolved',
}

// Shared case status pill used by the Case Management list and the dedicated
// case details view, so both read the same recorded value.
export default function CaseStatusBadge({ value }) {
  if (!value) {
    return <span className="case-status">—</span>
  }

  return (
    <span className={STATUS_CLASS[value] || 'case-status'}>
      {String(value).replace(/_/g, ' ')}
    </span>
  )
}
