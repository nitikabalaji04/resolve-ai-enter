import { useState } from 'react'
import { supabase } from '../integrations/supabase/client'
import { Lock, Mail, ShieldCheck, LogIn, UserPlus } from 'lucide-react'

export default function AgentLogin() {
  const [mode, setMode] = useState('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)

  const switchMode = (next) => {
    setMode(next)
    setError(null)
    setNotice(null)
  }

  const handleSubmit = async (event) => {
    event.preventDefault()

    setLoading(true)
    setError(null)
    setNotice(null)

    try {
      if (mode === 'signin') {
        const { error } = await supabase.auth.signInWithPassword({
          email,
          password,
        })

        if (error) throw error
      } else {
        const { error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            emailRedirectTo: `${window.location.origin}/`,
          },
        })

        if (error) throw error

        setNotice(
          'Account created. Only approved support agents can sign in.'
        )
      }
    } catch (err) {
      setError(
        err?.message || 'Authentication failed. Please try again.'
      )
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="agent-login-page">
      <div className="agent-login-card">
        <div className="agent-login-header">
          <div className="agent-login-icon">
            <ShieldCheck size={20} />
          </div>

          <p className="eyebrow">HUMAN AGENT ACCESS</p>

          <h2>
            {mode === 'signin'
              ? 'Sign in to Case Management'
              : 'Create a Human Agent account'}
          </h2>

          <p>
            Case data is restricted to authenticated Human Agents.
            Sign in to view customer, order, support, and policy
            context.
          </p>
        </div>

        {error && (
          <div className="agent-login-message error">
            {error}
          </div>
        )}

        {notice && (
          <div className="agent-login-message notice">
            {notice}
          </div>
        )}

        <form className="agent-login-form" onSubmit={handleSubmit}>
          <label className="agent-login-field">
            <span>EMAIL</span>

            <div className="agent-login-input-wrap">
              <Mail size={15} />

              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="agent@example.com"
                required
                autoComplete="email"
              />
            </div>
          </label>

          <label className="agent-login-field">
            <span>PASSWORD</span>

            <div className="agent-login-input-wrap">
              <Lock size={15} />

              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                required
                minLength={6}
                autoComplete={
                  mode === 'signin'
                    ? 'current-password'
                    : 'new-password'
                }
              />
            </div>
          </label>

          <button
            type="submit"
            className="agent-login-btn"
            disabled={loading}
          >
            {loading ? (
              <span>Please wait...</span>
            ) : mode === 'signin' ? (
              <>
                <LogIn size={15} />
                <span>Sign in</span>
              </>
            ) : (
              <>
                <UserPlus size={15} />
                <span>Create account</span>
              </>
            )}
          </button>
        </form>

        <div className="agent-login-toggle">
          {mode === 'signin' ? (
            <>
              <span>New Human Agent?</span>

              <button
                type="button"
                onClick={() => switchMode('signup')}
              >
                Create an account
              </button>
            </>
          ) : (
            <>
              <span>Already have an account?</span>

              <button
                type="button"
                onClick={() => switchMode('signin')}
              >
                Sign in instead
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
