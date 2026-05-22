import { useState, useEffect, useRef } from 'react'
import styles from './Page.module.css'

const SUGGESTIONS = [
  'How do I fix rushing in fast passages?',
  'What\'s the best way to practice hands separately?',
  'How do I bring out the melody over the accompaniment?',
  'What does it mean to play with more expression?',
]

function capitalize(s) { return s ? s[0].toUpperCase() + s.slice(1) : s }

export default function Coach() {
  const [messages, setMessages]   = useState([])
  const [input, setInput]         = useState('')
  const [loading, setLoading]     = useState(false)
  const [take, setTake]           = useState(null)
  const endRef   = useRef(null)
  const inputRef = useRef(null)

  useEffect(() => {
    try {
      const stored = localStorage.getItem('mediant_last_take')
      if (stored) setTake(JSON.parse(stored))
    } catch {}
  }, [])

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, loading])

  async function send(text) {
    const msg = (text ?? input).trim()
    if (!msg || loading) return
    setInput('')
    setMessages(prev => [...prev, { role: 'user', content: msg }])
    setLoading(true)

    try {
      const res = await fetch('/api/coach-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: msg,
          context: take ? {
            pieceTitle:    take.piece_title,
            pieceComposer: take.piece_composer,
            score:         take.score,
            flags:         take.flags ?? [],
          } : {},
          history: messages,
        }),
      })
      const { reply, error } = await res.json()
      if (error) throw new Error(error)
      setMessages(prev => [...prev, { role: 'assistant', content: reply }])
    } catch {
      setMessages(prev => [...prev, { role: 'assistant', content: 'Something went wrong. Please try again.' }])
    } finally {
      setLoading(false)
      inputRef.current?.focus()
    }
  }

  function handleSuggestion(s) {
    setInput(s)
    inputRef.current?.focus()
  }

  const hasContext = take?.piece_title

  return (
    <div className={styles.coachPage}>

      {/* Header */}
      <div className={styles.coachHeader}>
        <div>
          <p className={styles.label}>Coach</p>
          <h1 className={styles.title} style={{ marginBottom: 0 }}>Ask your coach</h1>
        </div>
        {hasContext && (
          <div className={styles.coachContextBadge}>
            <span className={styles.coachContextDot} />
            {take.piece_title}{take.piece_composer ? ` · ${take.piece_composer}` : ''}
            {take.score != null && ` · ${take.score}/100`}
          </div>
        )}
      </div>

      {/* Messages */}
      <div className={styles.coachMessages}>
        {messages.length === 0 && (
          <div className={styles.coachWelcome}>
            <span className={styles.coachWelcomeIcon}>♩</span>
            <p className={styles.coachWelcomeTitle}>Your practice coach is here</p>
            <p className={styles.coachWelcomeSub}>
              {hasContext
                ? `Ask anything about ${take.piece_title}, or about your practice in general.`
                : 'Ask anything about technique, theory, practice strategy, or musical expression.'}
            </p>
            <div className={styles.coachSuggestions}>
              {SUGGESTIONS.map(s => (
                <button
                  key={s}
                  className={styles.coachSuggestionChip}
                  onClick={() => handleSuggestion(s)}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m, i) => (
          <div key={i} className={m.role === 'user' ? styles.chatMsgUser : styles.chatMsgAI}>
            {m.content}
          </div>
        ))}

        {loading && (
          <div className={styles.chatMsgAI}>
            <span className={styles.chatTyping}>···</span>
          </div>
        )}

        <div ref={endRef} />
      </div>

      {/* Input bar */}
      <div className={styles.coachInputBar}>
        <input
          ref={inputRef}
          className={styles.coachInput}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
          placeholder="Ask your coach anything…"
          disabled={loading}
        />
        <button
          className={styles.coachSendBtn}
          onClick={() => send()}
          disabled={loading || !input.trim()}
        >↑</button>
      </div>
    </div>
  )
}
