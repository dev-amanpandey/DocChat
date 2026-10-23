import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import ReactMarkdown from 'react-markdown';
import './styles.css';

const API_BASE = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000/api/v1').replace(/\/$/, '');
const INSUFFICIENT = 'The documents do not contain enough information to answer this question.';
const starters = [
  ['✦', 'Summarize my document', 'Give me a concise summary of this document.'],
  ['⌕', 'Find key insights', 'What are the key insights and takeaways?'],
  ['▤', 'Explain a section', 'Explain the most important section in simple terms.'],
];

async function api(path, { token, ...options } = {}) {
  const headers = new Headers(options.headers || {});
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const response = await fetch(`${API_BASE}${path}`, { ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data?.error?.message || `Request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function formatBytes(size = 0) {
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
function shortDate(value) {
  if (!value) return 'Recently added';
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(value));
}
function scoreText(score) {
  if (typeof score !== 'number' || !Number.isFinite(score)) return null;
  const percent = score <= 1 ? score * 100 : score;
  return `${Math.round(Math.max(0, Math.min(100, percent)))}% match`;
}

function readTheme() {
  const saved = localStorage.getItem('docchat_theme');
  if (saved === 'dark' || saved === 'light') return saved;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function ThemeToggle({ theme, onToggle }) {
  const nextTheme = theme === 'dark' ? 'light' : 'dark';
  return <button className="theme-toggle" type="button" onClick={onToggle} aria-label={`Switch to ${nextTheme} mode`} title={`Switch to ${nextTheme} mode`}>
    {theme === 'dark' ? <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M16.7 12.7A7 7 0 0 1 7.3 3.3a7.1 7.1 0 1 0 9.4 9.4Z" /></svg> : <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="3.2" /><path d="M10 1.8v2m0 12.4v2M1.8 10h2m12.4 0h2M4.2 4.2l1.4 1.4m8.8 8.8 1.4 1.4m0-11.6-1.4 1.4m-8.8 8.8-1.4 1.4" /></svg>}
  </button>;
}

function Login({ onLogin, notice, theme, onToggleTheme }) {
  const [mode, setMode] = useState('login');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event) {
    event.preventDefault(); setBusy(true); setError('');
    const form = new FormData(event.currentTarget);
    try {
      if (mode === 'register') {
        await api('/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: form.get('name'), email: form.get('email'), password: form.get('password') }) });
      }
      const result = await api('/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: form.get('email'), password: form.get('password') }) });
      onLogin(result.token);
    } catch (err) { setError(err.message || 'Could not connect to DocChat.'); }
    finally { setBusy(false); }
  }
  return <main className="auth-shell"><form className="auth-card" onSubmit={submit}>
    <div className="auth-card-head"><Brand large /><ThemeToggle theme={theme} onToggle={onToggleTheme} /></div><p className="eyebrow">YOUR DOCUMENTS, IN CONVERSATION</p><h1>{mode === 'login' ? 'Welcome back' : 'Create your account'}</h1>
    <p className="muted">{mode === 'login' ? 'Sign in to pick up where you left off.' : 'Sign up to start chatting with your files.'}</p>
    {notice && <div className="notice error" role="alert">{notice}</div>}
    {mode === 'register' && <label>Your name<input name="name" autoComplete="name" required maxLength="100" /></label>}
    <label>Email address<input type="email" name="email" autoComplete="email" required /></label>
    <label>Password<input type="password" name="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} minLength="8" required /></label>
    {error && <div className="notice error" role="alert">{error}</div>}
    <button className="primary full" disabled={busy}>{busy ? 'Connecting…' : mode === 'login' ? 'Sign in' : 'Create account'} <span>→</span></button>
    <p className="auth-switch">{mode === 'login' ? 'New to DocChat?' : 'Already have an account?'} <button type="button" className="text-button" onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError(''); }}>{mode === 'login' ? 'Create an account' : 'Sign in'}</button></p>
  </form></main>;
}

function Brand({ large = false }) { return <div className={`brand ${large ? 'brand-large' : ''}`}><span className="brand-mark">D<span>✦</span></span><span>docchat</span></div>; }
function DocumentIcon() { return <span className="file-icon" aria-hidden="true">PDF</span>; }

function App() {
  const [theme, setTheme] = useState(readTheme);
  const [token, setToken] = useState(() => localStorage.getItem('docchat_token'));
  const [authNotice, setAuthNotice] = useState('');
  const [user, setUser] = useState(null);
  const [documents, setDocuments] = useState([]);
  const [selectedDocument, setSelectedDocument] = useState('');
  const [chats, setChats] = useState([]);
  const [activeChat, setActiveChat] = useState(null);
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [notice, setNotice] = useState(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [docFilter, setDocFilter] = useState('');
  const [docError, setDocError] = useState('');
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deletingId, setDeletingId] = useState('');
  const fileRef = useRef(null);
  const bottomRef = useRef(null);
  const deleteCancelRef = useRef(null);
  const deleteConfirmRef = useRef(null);
  const deletingRef = useRef(new Set());
  const pollTimer = useRef(null);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('docchat_theme', theme);
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#101722' : '#f8faff');
  }, [theme]);
  function toggleTheme() { setTheme((current) => current === 'dark' ? 'light' : 'dark'); }

  function signOut() { localStorage.removeItem('docchat_token'); setToken(null); setUser(null); setDocuments([]); setChats([]); setActiveChat(null); setAuthNotice(''); }
  function handleAuth(tokenValue) { localStorage.setItem('docchat_token', tokenValue); setAuthNotice(''); setToken(tokenValue); }
  function authError(error) { if (error.status === 401) { localStorage.removeItem('docchat_token'); setToken(null); setUser(null); setDocuments([]); setChats([]); setActiveChat(null); setAuthNotice('Your session expired. Sign in again to continue.'); return true; } return false; }

  async function loadDocuments({ quiet = false } = {}) {
    try {
      const result = await api('/documents?limit=100', { token });
      setDocuments(Array.isArray(result.documents) ? result.documents : []);
      setDocError('');
    } catch (error) { if (!authError(error) && !quiet) setDocError(error.message); }
  }

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    api('/auth/me', { token }).then((result) => { if (!cancelled) setUser(result.user); }).catch((error) => { if (!cancelled) authError(error); });
    loadDocuments();
    return () => { cancelled = true; clearInterval(pollTimer.current); };
  }, [token]);
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [activeChat?.messages?.length, busy]);
  useEffect(() => {
    if (!deleteTarget) return;
    deleteCancelRef.current?.focus();
    function onKeyDown(event) {
      if (event.key === 'Escape') { setDeleteTarget(null); return; }
      if (event.key === 'Tab') {
        const first = deleteCancelRef.current;
        const last = deleteConfirmRef.current;
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [deleteTarget]);
  useEffect(() => {
    if (!documents.some((doc) => ['uploaded', 'processing'].includes(doc.status) || ['pending', 'processing'].includes(doc.embeddingStatus))) return;
    pollTimer.current = setInterval(() => loadDocuments({ quiet: true }), 3500);
    return () => clearInterval(pollTimer.current);
  }, [documents, token]);

  function newChat() { setActiveChat(null); setQuestion(''); setNotice(null); setSidebarOpen(false); }
  function selectChat(chat) { setActiveChat(chat); setNotice(null); setSidebarOpen(false); }
  async function deleteDocument() {
    const target = deleteTarget;
    if (!target || deletingRef.current.size > 0 || deletingRef.current.has(target.id)) return;
    deletingRef.current.add(target.id);
    setDeletingId(target.id);
    setDeleteTarget(null);
    setNotice(null);
    try {
      await api(`/documents/${encodeURIComponent(target.id)}`, { method: 'DELETE', token });
      setDocuments((current) => current.filter((doc) => doc.id !== target.id));
      setChats((current) => current.map((chat) => ({
        ...chat,
        messages: chat.messages.map((message) => message.sources
          ? { ...message, sources: message.sources.filter((source) => source.documentId !== target.id) }
          : message),
      })));
      if (selectedDocument === target.id) {
        setSelectedDocument('');
        setQuestion('');
        setActiveChat(null);
      }
      setNotice({ type: 'success', text: `${target.originalName} was deleted.` });
    } catch (error) {
      if (!authError(error)) setNotice({ type: 'error', text: `Could not delete ${target.originalName}. ${error.message || 'Please try again.'}` });
    } finally {
      deletingRef.current.delete(target.id);
      setDeletingId((current) => current === target.id ? '' : current);
    }
  }
  async function uploadFile(event) {
    const file = event.target.files?.[0]; event.target.value = '';
    if (!file) return;
    if (file.size > 20 * 1024 * 1024) { setNotice({ type: 'error', text: 'This file is larger than the 20 MB upload limit.' }); return; }
    setUploading(true); setNotice({ type: 'info', text: `Uploading ${file.name}…` });
    const form = new FormData(); form.append('file', file);
    try {
      const result = await api('/documents/upload', { method: 'POST', token, body: form });
      await loadDocuments();
      if (result.document?.id) setSelectedDocument(result.document.id);
      setNotice({ type: 'success', text: `${file.name} uploaded. It will be ready to chat with after processing.` });
    } catch (error) { if (!authError(error)) setNotice({ type: 'error', text: error.message || 'Upload failed. Please try again.' }); }
    finally { setUploading(false); }
  }
  function createChat(message) { return { id: crypto.randomUUID(), title: message.slice(0, 48) + (message.length > 48 ? '…' : ''), messages: [], createdAt: new Date().toISOString() }; }
  async function sendMessage(raw = question) {
    const text = raw.trim(); if (!text || busy) return;
    const eligibleDocs = documents.filter((doc) => doc.status === 'ready' && doc.embeddingStatus === 'ready');
    const chosen = documents.find((doc) => doc.id === selectedDocument);
    if (selectedDocument && chosen && !eligibleDocs.some((doc) => doc.id === selectedDocument)) { setNotice({ type: 'error', text: chosen.status === 'failed' ? 'This document could not be processed. Upload it again or choose another file.' : 'This document is still processing. You can ask as soon as it is ready.' }); return; }
    if (!eligibleDocs.length) { setNotice({ type: 'error', text: 'Upload a document and wait until processing finishes before asking a question.' }); return; }
    let chat = activeChat;
    if (!chat) { chat = createChat(text); setChats((current) => [chat, ...current]); setActiveChat(chat); }
    const userMessage = { role: 'user', content: text };
    const messages = [...chat.messages, userMessage];
    setChats((current) => current.map((item) => item.id === chat.id ? { ...item, messages } : item));
    setActiveChat({ ...chat, messages }); setQuestion(''); setBusy(true); setNotice(null);
    try {
      const data = await api('/ai/ask', { method: 'POST', token, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: text, ...(selectedDocument ? { documentId: selectedDocument } : {}), limit: 5 }) });
      const answer = typeof data.answer === 'string' && data.answer.trim() ? data.answer : 'The assistant returned an empty response. Please try again.';
      const assistantMessage = { role: 'assistant', content: answer, sources: Array.isArray(data.sources) ? data.sources : [] };
      const updated = [...messages, assistantMessage];
      setChats((current) => current.map((item) => item.id === chat.id ? { ...item, messages: updated } : item));
      setActiveChat({ ...chat, messages: updated });
      if (answer === INSUFFICIENT && assistantMessage.sources.length === 0) setNotice({ type: 'info', text: 'No matching passages were found in the selected documents. Try a question about their contents.' });
    } catch (error) { if (!authError(error)) setNotice({ type: 'error', text: error.message || 'Could not reach DocChat. Check your connection and try again.' }); }
    finally { setBusy(false); }
  }
  function onComposerKey(event) { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendMessage(); } }

  if (!token) return <Login onLogin={handleAuth} notice={authNotice} theme={theme} onToggleTheme={toggleTheme} />;
  const readyDocs = documents.filter((doc) => doc.status === 'ready' && doc.embeddingStatus === 'ready');
  const visibleDocs = documents.filter((doc) => doc.originalName.toLowerCase().includes(docFilter.toLowerCase()));
  const activeMessages = activeChat?.messages || [];
  const activeDocument = documents.find((doc) => doc.id === selectedDocument);

  return <div className="app-shell">
    <aside className={`sidebar ${sidebarOpen ? 'sidebar-open' : ''}`}>
      <div className="sidebar-top"><Brand /><button className="icon-button close-sidebar" onClick={() => setSidebarOpen(false)} aria-label="Close sidebar">×</button></div>
      <button className="primary new-chat" onClick={newChat}><span>＋</span> New chat <kbd>⌘ K</kbd></button>
      <div className="sidebar-search"><span>⌕</span><input aria-label="Search documents" placeholder="Search documents" value={docFilter} onChange={(event) => setDocFilter(event.target.value)} /><kbd>⌘ F</kbd></div>
      <div className="side-section"><div className="section-heading"><span>YOUR LIBRARY</span><button className="quiet-button" onClick={() => fileRef.current?.click()} aria-label="Upload a document">＋</button></div>
        <button className="side-link upload-link" onClick={() => fileRef.current?.click()} disabled={uploading}><span className="line-icon">↑</span>{uploading ? 'Uploading…' : 'Upload a document'}</button>
        <div className="section-heading documents-heading"><span>DOCUMENTS <b>{documents.length}</b></span></div>
        {docError && <p className="inline-error">{docError}</p>}
        <div className="document-list">{visibleDocs.map((doc) => <div key={doc.id} className={`document-row ${selectedDocument === doc.id ? 'selected' : ''}`}>
          <button className="document-select" disabled={deletingId === doc.id} onClick={() => { setSelectedDocument(doc.id === selectedDocument ? '' : doc.id); setNotice(null); }} title={doc.originalName} aria-label={`Select ${doc.originalName}`}>
            <DocumentIcon /><span className="document-name">{doc.originalName}<small>{doc.status === 'failed' ? 'Processing failed' : doc.status !== 'ready' ? 'Extracting text…' : doc.embeddingStatus !== 'ready' ? 'Indexing for chat…' : `${doc.pageCount ?? '—'} pages · ${formatBytes(doc.size)}`}</small></span>
            <span className={`status-dot status-${doc.status === 'failed' ? 'error' : doc.status === 'ready' && doc.embeddingStatus === 'ready' ? 'ready' : 'pending'}`} aria-label={doc.status === 'ready' && doc.embeddingStatus === 'ready' ? 'Ready' : 'Processing'} />
          </button>
          <button className="delete-document" disabled={Boolean(deletingId)} onClick={() => setDeleteTarget(doc)} aria-label={`Delete ${doc.originalName}`} title={`Delete ${doc.originalName}`}>
            {deletingId === doc.id ? <span className="delete-spinner" aria-hidden="true" /> : <svg aria-hidden="true" viewBox="0 0 20 20" fill="none"><path d="M4.5 6h11M8 6V4.5h4V6m-6.5 0 .7 9.1c.1.8.7 1.4 1.5 1.4h4.6c.8 0 1.4-.6 1.5-1.4l.7-9.1M8.2 8.8v4.8m3.6-4.8v4.8" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" /></svg>}
          </button>
        </div>)}
        {!visibleDocs.length && <p className="empty-docs">{documents.length ? 'No documents match your search.' : 'Your uploaded files will appear here.'}</p>}
      </div>
      </div>
      <div className="side-section history-section"><div className="section-heading"><span>RECENT CHATS</span></div>
        {chats.map((chat) => <button key={chat.id} className={`chat-row ${activeChat?.id === chat.id ? 'selected' : ''}`} onClick={() => selectChat(chat)}><span className="line-icon">◷</span><span>{chat.title}</span></button>)}
        {!chats.length && <p className="empty-docs">Your conversations will appear here.</p>}
      </div>
      <div className="profile"><div className="avatar">{user?.name?.[0]?.toUpperCase() || user?.email?.[0]?.toUpperCase() || 'U'}</div><div className="profile-copy"><strong>{user?.name || 'Your account'}</strong><span>{user?.email || 'Signed in'}</span></div><button className="icon-button signout" onClick={signOut} title="Sign out" aria-label="Sign out">↗</button></div>
      <input ref={fileRef} type="file" accept=".pdf,.docx,.txt,.md,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown" hidden onChange={uploadFile} />
    </aside>

    <main className="main-panel">
      <header className="topbar"><div className="topbar-left"><button className="icon-button menu-button" onClick={() => setSidebarOpen(true)} aria-label="Open menu">☰</button><span className="workspace-label">Workspace</span><span className="crumb-sep">/</span><span className="crumb-current">Chat</span></div>
        <div className="topbar-right"><span className="secure-label"><span>●</span> Private workspace</span><ThemeToggle theme={theme} onToggle={toggleTheme} /><button className="avatar mini-avatar" onClick={signOut} title="Sign out">{user?.name?.[0]?.toUpperCase() || 'U'}</button></div>
      </header>
      {notice && <div className={`notice notice-${notice.type}`} role={notice.type === 'error' ? 'alert' : 'status'}><span>{notice.type === 'success' ? '✓' : notice.type === 'error' ? '!' : 'i'}</span>{notice.text}<button className="icon-button notice-close" onClick={() => setNotice(null)} aria-label="Dismiss message">×</button></div>}
      <section className="conversation" aria-live="polite">
        {!activeMessages.length ? <div className="welcome"><div className="welcome-icon"><span className="sparkle">✦</span><span className="small-sparkle">✧</span></div><p className="eyebrow">YOUR AI DOCUMENT ASSISTANT</p><h1>Make sense of<br /><span>what you’re reading.</span></h1><p className="welcome-copy">Ask questions, find the details that matter, and get clear answers from your documents.</p>
          <div className="starter-grid">{starters.map(([icon, title, prompt]) => <button className="starter-card" key={title} disabled={!readyDocs.length} onClick={() => sendMessage(prompt)}><span className="starter-icon">{icon}</span><span><strong>{title}</strong><small>{prompt}</small></span><span className="starter-arrow">↗</span></button>)}</div>
          {!documents.length && <button className="upload-prompt" onClick={() => fileRef.current?.click()}><span className="upload-prompt-icon">↑</span><span><strong>Start by adding a document</strong><small>PDF, DOCX, TXT or Markdown · up to 20 MB</small></span><span className="starter-arrow">→</span></button>}
          {documents.length > 0 && !readyDocs.length && <div className="ready-hint">Your document is being prepared. You can start chatting when its status turns green.</div>}
        </div> : <div className="message-list">{activeMessages.map((message, index) => <article className={`message message-${message.role}`} key={`${index}-${message.role}`}>
          {message.role === 'assistant' && <div className="assistant-mark"><span>✦</span></div>}
          <div className="message-body"><div className="message-label">{message.role === 'assistant' ? 'DocChat' : 'You'}<span>{message.role === 'assistant' && message.sources?.length ? ` · ${message.sources.length} ${message.sources.length === 1 ? 'source' : 'sources'}` : ''}</span></div>
            {message.role === 'assistant' ? <div className="markdown"><ReactMarkdown>{message.content}</ReactMarkdown></div> : <div className="user-bubble">{message.content}</div>}
            {message.role === 'assistant' && message.sources?.length > 0 && <div className="sources"><div className="sources-heading"><span>▤</span> Sources <span className="source-count">{message.sources.length}</span></div><div className="source-grid">{message.sources.map((source, sourceIndex) => <div className="source-card" key={source.chunkId || `${source.filename}-${sourceIndex}`}><div className="source-meta"><DocumentIcon /><strong title={source.filename}>{source.filename || 'Document'}</strong>{source.pageNumber != null && <span className="page-badge">Page {source.pageNumber}</span>}</div><p>{source.excerpt || 'Relevant passage from the source document.'}</p>{scoreText(source.score) && <span className="match-score">{scoreText(source.score)}</span>}</div>)}</div></div>}
          </div>
        </article>)}{busy && <div className="message message-assistant"><div className="assistant-mark"><span>✦</span></div><div className="message-body"><div className="message-label">DocChat <span>· searching your documents</span></div><div className="thinking"><span /><span /><span /><em>Putting the answer together…</em></div></div></div>}<div ref={bottomRef} /></div>}
      </section>
      <footer className="composer-area"><div className="composer-wrap">
        <div className="composer-context"><span className={`context-dot ${activeDocument && activeDocument.embeddingStatus !== 'ready' ? 'dot-pending' : ''}`} />{activeDocument ? <><span>Chatting with</span><strong title={activeDocument.originalName}>{activeDocument.originalName}</strong><button className="clear-selection" onClick={() => setSelectedDocument('')} aria-label="Chat with all ready documents">×</button></> : <><span>Searching across</span><strong>{readyDocs.length} ready {readyDocs.length === 1 ? 'document' : 'documents'}</strong></>}</div>
        <div className="composer"><textarea rows="1" aria-label="Ask your documents a question" placeholder={readyDocs.length ? 'Ask anything about your documents…' : 'Upload a document to get started…'} value={question} onChange={(event) => setQuestion(event.target.value)} onKeyDown={onComposerKey} disabled={!readyDocs.length || busy} /><div className="composer-actions"><button className="attach-button" onClick={() => fileRef.current?.click()} title="Upload a document" aria-label="Upload a document">＋</button><span className="key-hint">↵ to send</span><button className="send-button" disabled={!question.trim() || busy || !readyDocs.length} onClick={() => sendMessage()} aria-label="Send message">↑</button></div></div>
        <div className="composer-footnote">DocChat answers from your documents and shows where each answer came from.</div>
      </div></footer>
    </main>
    {sidebarOpen && <button className="scrim" aria-label="Close menu" onClick={() => setSidebarOpen(false)} />}
    {deleteTarget && <div className="dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setDeleteTarget(null); }}>
      <section className="delete-dialog" role="alertdialog" aria-modal="true" aria-labelledby="delete-dialog-title" aria-describedby="delete-dialog-copy">
        <div className="delete-dialog-icon"><svg aria-hidden="true" viewBox="0 0 20 20" fill="none"><path d="M4.5 6h11M8 6V4.5h4V6m-6.5 0 .7 9.1c.1.8.7 1.4 1.5 1.4h4.6c.8 0 1.4-.6 1.5-1.4l.7-9.1M8.2 8.8v4.8m3.6-4.8v4.8" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" /></svg></div>
        <h2 id="delete-dialog-title">Delete this document?</h2>
        <p id="delete-dialog-copy">You’re about to permanently delete</p>
        <div className="delete-filename" title={deleteTarget.originalName}>{deleteTarget.originalName}</div>
        <p className="delete-dialog-note">This also removes its indexed passages. This action can’t be undone.</p>
        <div className="delete-dialog-actions"><button ref={deleteCancelRef} className="cancel-delete" onClick={() => setDeleteTarget(null)}>Cancel</button><button ref={deleteConfirmRef} className="confirm-delete" disabled={Boolean(deletingId)} onClick={deleteDocument}>{deletingId === deleteTarget.id ? 'Deleting…' : 'Delete document'}</button></div>
      </section>
    </div>}
  </div>;
}

createRoot(document.getElementById('root')).render(<React.StrictMode><App /></React.StrictMode>);
