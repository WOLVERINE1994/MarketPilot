"use client";
import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { MessageSquare, Send, Sparkles } from "lucide-react";

type ChatMessage = { role: "user" | "assistant"; content: string };
const starters = ["Why is the recommendation WAIT?", "Compare the current CE and PE setups", "What evidence would change the decision?"];

export function ChatPanel() {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([{ role: "assistant", content: "Ask me about the current CRUDEOILM candles, the WAIT reasons, or what evidence to watch next. I use MarketPilot current snapshot and will not override its safety gates." }]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const conversationEnd = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    void fetch("/api/marketpilot/chat", { cache: "no-store" }).then(response => response.json()).then(body => {
      if (active) setConfigured(body.configured === true);
    }).catch(() => { if (active) setConfigured(false); });
    return () => { active = false; };
  }, []);
  useEffect(() => { conversationEnd.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [messages, busy]);

  async function ask(question: string) {
    const content = question.trim();
    if (!content || busy || !configured) return;
    const next = [...messages, { role: "user" as const, content }];
    setMessages(next);
    setDraft("");
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/marketpilot/chat", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: next.slice(-10) }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "Chat request failed.");
      setMessages(previous => [...previous, { role: "assistant" as const, content: String(body.text) }].slice(-30));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Chat request failed.");
    } finally { setBusy(false); }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void ask(draft);
  }

  return <section className="mp-panel mp-chat" aria-labelledby="mp-chat-title">
    <div className="mp-panel-heading">
      <div><h2 id="mp-chat-title"><MessageSquare size={16}/> MarketPilot assistant</h2><p>Ask about the candles, CE/PE, or current blockers.</p></div>
      <span className={`mp-tag ${configured ? "mp-chat-ready" : ""}`}>{configured ? "OPENAI READY" : "SETUP REQUIRED"}</span>
    </div>
    {configured === false && <div className="mp-chat-setup" role="status"><strong>OpenAI key not available to this app</strong><p>Codex’s sign-in is separate from your local app. Add your OpenAI API key to the project’s <code>.env.local</code> as <code>OPENAI_API_KEY=&quot;…&quot;</code>, then restart MarketPilot. The key stays on the server and is never sent to your browser.</p></div>}
    <div className="mp-chat-messages" aria-live="polite" aria-relevant="additions text">
      {messages.map((message, index) => <article className={`mp-chat-message ${message.role}`} key={`${index}-${message.role}`}><strong>{message.role === "assistant" ? "PILOT" : "YOU"}</strong><p>{message.content}</p></article>)}
      {busy && <div className="mp-chat-thinking"><Sparkles size={14}/> Reading the latest MarketPilot snapshot…</div>}
      <div ref={conversationEnd}/>
    </div>
    {error && <p className="mp-chat-error" role="alert">{error}</p>}
    <div className="mp-chat-starters">{starters.map(question => <button key={question} type="button" disabled={!configured || busy} onClick={() => void ask(question)}>{question}</button>)}</div>
    <form className="mp-chat-form" onSubmit={submit}>
      <label className="mp-sr-only" htmlFor="mp-chat-input">Ask MarketPilot</label>
      <textarea id="mp-chat-input" rows={2} maxLength={1600} placeholder={configured ? "Ask how the current setup is developing…" : "Configure the OpenAI API key to start chatting"} value={draft} onChange={event => setDraft(event.target.value)} disabled={!configured || busy} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void ask(draft); } }}/>
      <button className="mp-chat-send" type="submit" aria-label="Send message" disabled={!configured || busy || !draft.trim()}><Send size={16}/></button>
    </form>
    <p className="mp-chat-privacy">Only your question and a sanitized snapshot of up to 50 recent candles, live context, and current risk gates are sent to OpenAI. No broker token or login credential is included. Guidance can be wrong; no trade outcome is guaranteed.</p>
  </section>;
}
