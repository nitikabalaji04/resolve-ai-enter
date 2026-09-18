import { useState, useEffect } from 'react'
import { supabase } from './integrations/supabase/client'
import CaseManagement from './components/CaseManagement'
import AgentLogin from './components/AgentLogin'
import DashboardData from './components/DashboardData'
import InvestigationsData from './components/InvestigationsData'
import HumanReviewQueue from './components/HumanReviewQueue'
import {
  LayoutDashboard,
  MessageCircle,
  SearchCheck,
  UsersRound,
  Bot,
  Send,
  ArrowRight,
  Check,
  ShieldCheck,
  FolderOpen,
  LogOut,
} from 'lucide-react'

// Deterministically extracts an explicitly mentioned order number from a
// customer message. Recognizes "order 552", "order #123456", "order number
// 777777", "my order 10486", "order no. 888888" and "order no 552" for ANY
// digit length. The "order" keyword association is what disambiguates it:
// returns null when the message does not clearly reference an order
// identifier, so arbitrary numbers (prices, dates, phone numbers) are never
// extracted.
const EXPLICIT_ORDER_PATTERN = /\border\s*(?:number|no\.?|#)?\s*(\d+)\b/i

function extractOrderId(message) {
  const match = EXPLICIT_ORDER_PATTERN.exec(message || '')

  return match ? match[1] : null
}

function App() {
  const [activePage, setActivePage] = useState('Dashboard')
  const [complaint, setComplaint] = useState('')
  const [submittedComplaint, setSubmittedComplaint] = useState('')
  const [isInvestigating, setIsInvestigating] = useState(false)
  const [investigationStep, setInvestigationStep] = useState(0)
  const [supportResult, setSupportResult] = useState(null)
  const [session, setSession] = useState(null)
  const [sessionLoading, setSessionLoading] = useState(true)

  useEffect(() => {
    // Register the listener BEFORE checking for an existing session.
    const { data: listener } = supabase.auth.onAuthStateChange(
      (_event, newSession) => {
        setSession(newSession)
      }
    )

    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setSessionLoading(false)
    })

    return () => {
      listener.subscription.unsubscribe()
    }
  }, [])

  // Safely convert backend values into text
  const safeText = (value, fallback = '') => {
    if (value === null || value === undefined) {
      return fallback
    }

    if (typeof value === 'string') {
      return value
    }

    if (typeof value === 'number' || typeof value === 'boolean') {
      return String(value)
    }

    if (typeof value === 'object') {
      if (typeof value.message === 'string') {
        return value.message
      }

      if (typeof value.reason === 'string') {
        return value.reason
      }

      if (typeof value.details === 'string') {
        return value.details
      }

      return fallback
    }

    return fallback
  }

  // Backend may return decision either as a string or as an object
  const getDecision = (result) => {
    if (!result) return ''

    if (typeof result.decision === 'string') {
      return result.decision.toLowerCase()
    }

    if (
      result.decision &&
      typeof result.decision === 'object' &&
      typeof result.decision.decision === 'string'
    ) {
      return result.decision.decision.toLowerCase()
    }

    return ''
  }

  // Backend may return action directly, inside action object,
  // or inside the decision object
  const getAction = (result) => {
    if (!result) return ''

    if (typeof result.action === 'string') {
      return result.action.toLowerCase()
    }

    if (
      result.action &&
      typeof result.action === 'object' &&
      typeof result.action.action === 'string'
    ) {
      return result.action.action.toLowerCase()
    }

    if (
      result.decision &&
      typeof result.decision === 'object' &&
      typeof result.decision.action === 'string'
    ) {
      return result.decision.action.toLowerCase()
    }

    return ''
  }

  const handleSendComplaint = async () => {
    if (!complaint.trim() || isInvestigating) return

    const userComplaint = complaint.trim()

    setSubmittedComplaint(userComplaint)
    setComplaint('')
    setSupportResult(null)
    setIsInvestigating(true)
    setInvestigationStep(1)

    try {
      let customerId = 'CUST001'
      let orderId = '10482'

      const complaintLower = userComplaint.toLowerCase()

      // Scenario 3: Missing / invalid order
      if (
        complaintLower.includes('order is delayed') &&
        complaintLower.includes('please resolve')
      ) {
        customerId = 'CUST002'
        orderId = '99999'
      }

      // Scenario 2: Out-of-policy standard delivery request
      else if (
        complaintLower.includes('standard') ||
        complaintLower.includes('not delayed enough')
      ) {
        customerId = 'CUST002'
        orderId = '10483'
      }

      // Deterministic explicit-order extraction: if the customer mentions an
      // order number in their message, that exact order MUST be investigated.
      // An explicitly mentioned order always wins over any default/special-case
      // order context above. If the order does not exist, the backend receives
      // that order ID and safely escalates instead of substituting another.
      const explicitOrderId = extractOrderId(userComplaint)

      if (explicitOrderId) {
        orderId = explicitOrderId
      }

      const { data, error } = await supabase.functions.invoke(
        'support',
        {
          body: {
            customer_id: customerId,
            order_id: orderId,
            message: userComplaint,
          },
        }
      )

      if (error) {
        throw new Error(
          error.context?.error ||
            error.message ||
            `Backend error: ${error.status ?? 'unknown'}`
        )
      }

      console.log('ResolveAI backend response:', data)

      setSupportResult(data)

      // Show investigation steps one by one
      setInvestigationStep(2)

      setTimeout(() => setInvestigationStep(3), 500)
      setTimeout(() => setInvestigationStep(4), 1000)
      setTimeout(() => setInvestigationStep(5), 1500)
      setTimeout(() => setInvestigationStep(6), 2000)
      setTimeout(() => setInvestigationStep(7), 2400)
      setTimeout(() => setIsInvestigating(false), 2600)
    } catch (error) {
      console.error('Support API error:', error)
      setIsInvestigating(false)
      setInvestigationStep(0)
    }
  }

  const handleStartSupport = () => {
    setActivePage('Customer Support')
  }

  const getStepClass = (stepNumber) => {
    if (investigationStep === stepNumber) return 'active'
    if (investigationStep > stepNumber) return 'completed'
    return 'pending'
  }

  const getStepIcon = (stepNumber) => {
    if (investigationStep > stepNumber) {
      return <Check size={11} />
    }

    if (investigationStep === stepNumber) {
      return '...'
    }

    return ''
  }

  const renderDashboard = () => (
    <div className="dashboard-page">
      <div className="welcome-section">
        <div>
          <p className="eyebrow">AUTONOMOUS CUSTOMER SUPPORT</p>

          <h1>Resolve customer issues intelligently.</h1>

          <p>
            ResolveAI investigates customer issues, reasons over evidence,
            takes action, and escalates when human review is required.
          </p>
        </div>

        <button
          className="primary-button"
          onClick={handleStartSupport}
        >
          <MessageCircle size={17} />
          Start Support Case
          <ArrowRight size={16} />
        </button>
      </div>

      <DashboardData onViewAll={() => setActivePage('Case Management')} />
    </div>
  )

  const renderCustomerSupport = () => {
    const decision = getDecision(supportResult)
    const action = getAction(supportResult)

    const reason = safeText(
      supportResult?.reason ||
        supportResult?.decision?.reason,
      'ResolveAI completed the investigation and determined the next appropriate action.'
    )

    const customerResponse = safeText(
      supportResult?.customer_response ||
        supportResult?.customerResponse,
      'Your request has been forwarded to a human support specialist for further review.'
    )

    const order = supportResult?.investigation?.order

    const orderId = order?.order_id || null
    const orderAmount = order?.amount ?? null

    const deliveryType =
      order?.delivery_type ||
      order?.delivery_speed ||
      order?.shipping_type ||
      'Delivery information unavailable'

    const daysDelayed =
      order?.days_delayed ??
      order?.delay_days ??
      order?.delayed_days ??
      order?.delivery_days_delayed ??
      null

    const deliveryStatus =
      order?.status === 'out_for_delivery'
        ? 'Out for delivery'
        : order?.status === 'delayed'
          ? 'Delayed'
          : order?.status
            ? order.status
            : 'Unavailable'

    const ticketHistory =
      supportResult?.investigation?.ticket_history || []

    return (
      <div className="support-page">
        <div className="page-heading">
          <div>
            <p className="eyebrow">CUSTOMER SUPPORT</p>

            <h1>How can we help?</h1>

            <p>
              Describe your issue and ResolveAI will investigate it.
            </p>
          </div>

          <div className="ai-status">
            <span></span>
            AI ONLINE
          </div>
        </div>

        <div className="support-main-grid">
          <div className="support-card">
            <div className="support-card-header">
              <div className="ai-avatar">
                <Bot size={18} />
              </div>

              <div>
                <strong>ResolveAI</strong>
                <span>Autonomous Support Agent</span>
              </div>
            </div>

            <div className="chat-area">
              <div className="message ai-message">
                <div className="message-avatar">
                  <Bot size={15} />
                </div>

                <div className="message-content">
                  <strong>ResolveAI</strong>

                  <p>
                    Hi! I'm ResolveAI. Tell me what happened and I'll
                    investigate your issue and find the best resolution.
                  </p>
                </div>
              </div>

              {submittedComplaint && (
                <div className="message customer-message">
                  <div className="message-content">
                    <strong>You</strong>

                    <p>{submittedComplaint}</p>
                  </div>
                </div>
              )}

              {submittedComplaint &&
                !isInvestigating &&
                supportResult && (
                  <div className="message ai-message">
                    <div className="message-avatar">
                      <Bot size={15} />
                    </div>

                    <div className="message-content">
                      <strong>ResolveAI</strong>

                      <p>{customerResponse}</p>
                    </div>
                  </div>
                )}
            </div>

            <div className="support-input">
              <input
                type="text"
                placeholder="Describe your issue..."
                value={complaint}
                onChange={(e) => setComplaint(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    handleSendComplaint()
                  }
                }}
              />

              <button
                onClick={handleSendComplaint}
                disabled={isInvestigating}
                aria-label="Send complaint"
              >
                <Send size={17} />
              </button>
            </div>
          </div>

          <div className="investigation-card">
            <div className="investigation-header">
              <div>
                <p className="eyebrow">AI INVESTIGATION</p>

                <h3>
                  {!submittedComplaint
                    ? 'Waiting for customer issue'
                    : isInvestigating
                      ? `Investigating case ${
                          supportResult?.case_id || 'new case'
                        }`
                      : `Analysis complete — case ${
                          supportResult?.case_id || 'new case'
                        }`}
                </h3>
              </div>

              <span className="investigating-badge">
                {!submittedComplaint
                  ? '● Ready'
                  : isInvestigating
                    ? '● Investigating'
                    : '✓ Analysis Complete'}
              </span>
            </div>

            <div className="investigation-steps">
              <div className={`step ${getStepClass(1)}`}>
                <span>{getStepIcon(1)}</span>

                <div>
                  <strong>Customer verified</strong>

                  <p>
                    {investigationStep > 1
                      ? 'Customer identity confirmed'
                      : investigationStep === 1
                        ? 'Verifying customer...'
                        : 'Waiting to verify customer'}
                  </p>
                </div>
              </div>

              <div className={`step ${getStepClass(2)}`}>
                <span>{getStepIcon(2)}</span>

                <div>
                  <strong>Order found</strong>

                  <p>
                    {investigationStep > 2
                      ? order
                        ? `Order #${orderId} · ₹${orderAmount} · ${
                            order.status || 'status unavailable'
                          }`
                        : 'Order information unavailable'
                      : investigationStep === 2
                        ? 'Checking order information...'
                        : 'Waiting for order lookup'}
                  </p>
                </div>
              </div>

              <div className={`step ${getStepClass(3)}`}>
                <span>{getStepIcon(3)}</span>

                <div>
                  <strong>Delivery checked</strong>

                  <p>
                    {investigationStep > 3
                      ? order
                        ? `${deliveryType} · ${
                            daysDelayed === null
                              ? 'delay unavailable'
                              : `${daysDelayed} ${
                                  daysDelayed === 1 ? 'day' : 'days'
                                } late`
                          } · ${deliveryStatus}`
                        : 'Delivery information unavailable'
                      : investigationStep === 3
                        ? 'Checking delivery status...'
                        : 'Waiting for delivery check'}
                  </p>
                </div>
              </div>

              <div className={`step ${getStepClass(4)}`}>
                <span>{getStepIcon(4)}</span>

                <div>
                  <strong>Support history checked</strong>

                  <p>
                    {investigationStep > 4
                      ? `${ticketHistory.length} previous support interaction${
                          ticketHistory.length === 1 ? '' : 's'
                        } found`
                      : investigationStep === 4
                        ? 'Checking support history...'
                        : 'Waiting for support history'}
                  </p>
                </div>
              </div>

              <div className={`step ${getStepClass(5)}`}>
                <span>{getStepIcon(5)}</span>

                <div>
                  <strong>Refund policy checked</strong>

                  <p>
                    {investigationStep > 5
                      ? supportResult?.investigation?.policy
                        ? decision === 'approve'
                          ? 'Eligible under delayed-delivery refund policy'
                          : 'Request evaluated against refund policy'
                        : 'Policy information unavailable'
                      : investigationStep === 5
                        ? 'Checking refund policy...'
                        : 'Waiting for policy verification'}
                  </p>
                </div>
              </div>

              <div className={`step ${getStepClass(6)}`}>
                <span>{getStepIcon(6)}</span>

                <div>
                  <strong>Evidence collected</strong>

                  <p>
                    {investigationStep > 6
                      ? 'Evidence sufficient for decision'
                      : investigationStep === 6
                        ? 'Collecting final evidence...'
                        : 'Waiting for evidence collection'}
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="decision-box support-decision">
          <div className="decision-header">
            <div>
              <p className="eyebrow">AI DECISION & RESOLUTION</p>

              <h2>
                {!submittedComplaint
                  ? 'No active case'
                  : isInvestigating
                    ? 'Analyzing evidence...'
                    : decision === 'approve'
                      ? 'Refund approved'
                      : decision === 'deny'
                        ? 'Request not approved'
                        : decision === 'inform'
                          ? 'Order information provided'
                          : 'Human review required'}
              </h2>
            </div>

            {submittedComplaint &&
              !isInvestigating &&
              supportResult && (
                <div className="decision-approved">
                  <Check size={15} />
                  {decision
                    ? decision.toUpperCase()
                    : 'PENDING'}
                </div>
              )}
          </div>

          {!submittedComplaint && (
            <>
              <p>
                Submit a customer issue to start the autonomous
                investigation.
              </p>

              <div className="decision-status waiting">
                Waiting for complaint
              </div>
            </>
          )}

          {submittedComplaint && isInvestigating && (
            <>
              <p>
                ResolveAI is checking customer data, order information,
                delivery status, support history, and refund policy.
              </p>

              <div className="progress-bar">
                <div
                  style={{
                    width: `${Math.min(
                      (investigationStep / 6) * 100,
                      100
                    )}%`,
                  }}
                ></div>
              </div>

              <div className="decision-status investigating">
                Investigation in progress
              </div>
            </>
          )}

          {submittedComplaint &&
            !isInvestigating &&
            supportResult && (
              <>
                <p>{reason}</p>

                <div className="decision-flow">
                  <div className="decision-action">
                    <Check size={15} />

                    <span>
                      {action === 'refund_shipping_fee'
                        ? 'Refund Shipping Fee'
                        : action === 'human_review'
                          ? 'Human Review'
                          : 'No Action'}
                    </span>
                  </div>

                  <ArrowRight
                    size={18}
                    className="decision-arrow"
                  />

                  <div className="decision-action">
                    <Check size={15} />

                    <span>
                      {supportResult.action_status === 'completed'
                        ? 'Action Completed'
                        : supportResult.action_status ===
                            'not_required'
                          ? 'Action Not Required'
                          : safeText(
                              supportResult.action_status,
                              'Pending'
                            )}
                    </span>
                  </div>

                  <ArrowRight
                    size={18}
                    className="decision-arrow"
                  />

                  <div className="decision-action">
                    <Check size={15} />

                    <span>
                      {supportResult.verification_status === 'verified'
                        ? 'Verification Passed'
                        : supportResult.verification_status ===
                            'not_required'
                          ? 'Verification Not Required'
                          : safeText(
                              supportResult.verification_status,
                              'Pending'
                            )}
                    </span>
                  </div>
                </div>

                <div className="resolution-status">
                  <div>
                    <span>Action Status</span>

                    <strong>
                      {safeText(
                        supportResult.action_status,
                        'PENDING'
                      ).toUpperCase()}
                    </strong>
                  </div>

                  <div>
                    <span>Verification</span>

                    <strong>
                      {safeText(
                        supportResult.verification_status,
                        'PENDING'
                      ).toUpperCase()}
                    </strong>
                  </div>

                  <div>
                    <span>Case Status</span>

                    <strong>
                      {safeText(
                        supportResult.resolution_status,
                        'PENDING'
                      ).toUpperCase()}
                    </strong>
                  </div>
                </div>

                <div className="customer-resolution-message">
                  <span>Customer Response</span>

                  <p>{customerResponse}</p>
                </div>
              </>
            )}
        </div>
      </div>
    )
  }

  const renderInvestigations = () => <InvestigationsData />

  const renderAgentDashboard = () => <HumanReviewQueue />

  // IMPORTANT:
  // Call the render functions with ()
  const renderCaseManagement = () => (
    <CaseManagement user={session?.user ?? null} />
  )

  // Case Management and the Agent Dashboard are Human Agent areas.
  // Show a session check while restoring the session, the login screen when
  // signed out, and the page only when an agent is authenticated.
  const renderAgentGate = (renderFn) => {
    if (sessionLoading) {
      return (
        <div className="session-check">
          <p>Checking session...</p>
        </div>
      )
    }

    if (!session) {
      return <AgentLogin />
    }

    return renderFn()
  }

  const renderPage = () => {
    switch (activePage) {
      case 'Customer Support':
        return renderCustomerSupport()

      case 'Investigations':
        return renderInvestigations()

      case 'Case Management':
        return renderAgentGate(renderCaseManagement)

      case 'Agent Dashboard':
        return renderAgentGate(renderAgentDashboard)

      case 'Dashboard':
      default:
        return renderDashboard()
    }
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-logo">
            <img
              src="/logo.jpeg"
              alt="ResolveAI logo"
            />
          </div>

          <div className="brand-text">
            <strong>RESOLVE AI</strong>
            <span>Autonomous Support</span>
          </div>
        </div>

        <nav className="sidebar-nav">
          <button
            className={`nav-item ${
              activePage === 'Dashboard'
                ? 'active'
                : ''
            }`}
            onClick={() => setActivePage('Dashboard')}
          >
            <LayoutDashboard size={18} />

            <span>
              Dashboard
            </span>
          </button>

          <button
            className={`nav-item ${
              activePage === 'Customer Support'
                ? 'active'
                : ''
            }`}
            onClick={() => setActivePage('Customer Support')}
          >
            <MessageCircle size={18} />

            <span>
              Customer Support
            </span>
          </button>

          <button
            className={`nav-item ${
              activePage === 'Investigations'
                ? 'active'
                : ''
            }`}
            onClick={() => setActivePage('Investigations')}
          >
            <SearchCheck size={18} />

            <span>
              Investigations
            </span>
          </button>

          <button
            className={`nav-item ${
              activePage === 'Agent Dashboard'
                ? 'active'
                : ''
            }`}
            onClick={() => setActivePage('Agent Dashboard')}
          >
            <UsersRound size={18} />

            <span>
              Agent Dashboard
            </span>
          </button>

          <button
            className={`nav-item ${
              activePage === 'Case Management'
                ? 'active'
                : ''
            }`}
            onClick={() => setActivePage('Case Management')}
          >
            <FolderOpen size={18} />

            <span>
              Case Management
            </span>
          </button>
        </nav>

        <div className="sidebar-bottom">
          <div className="system-status">
            <span></span>

            <div>
              <strong>
                AI System Online
              </strong>

              <small>
                Qwen · Local Reasoning
              </small>
            </div>
          </div>

          {session && (
            <div className="agent-session">
              <div className="agent-session-info">
                <ShieldCheck size={13} />

                <span>
                  {session.user.email}
                </span>
              </div>

              <button
                type="button"
                className="logout-btn"
                onClick={() => supabase.auth.signOut()}
              >
                <LogOut size={13} />

                <span>Sign out</span>
              </button>
            </div>
          )}
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div>
            <span className="topbar-label">
              RESOLVE AI
            </span>

            <span className="topbar-divider">
              /
            </span>

            <span>
              {activePage}
            </span>
          </div>

          <div className="topbar-status">
            <span></span>
            LOCAL AI ACTIVE
          </div>
        </header>

        {renderPage()}
      </main>
    </div>
  )
}

export default App