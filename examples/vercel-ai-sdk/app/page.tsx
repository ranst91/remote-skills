"use client";

import { useChat } from "@ai-sdk/react";
import { useEffect, useRef, useState } from "react";

export default function Chat() {
  const { messages, sendMessage, status, error, stop, setMessages, clearError } = useChat();
  const [input, setInput] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const busy = status === "submitted" || status === "streaming";
  useEffect(() => {
    if (!busy) inputRef.current?.focus();
  }, [busy]);
  function send(text: string) {
    if (!text.trim() || busy) return;
    clearError();
    setInput("");
    void sendMessage({ text: text.trim() });
  }
  return (
    <main className="shell">
      <header className="intro">
        <p className="eyebrow">Remote Skills · Vercel AI SDK</p>
        <h1>Ask with context.</h1>
        <p className="lede">
          Start a conversation. The agent can discover and load a relevant remote skill as it
          answers.
        </p>
      </header>
      <section className="chat" aria-label="Chat with the skill-enabled agent">
        <div id="conversation" className="conversation" role="log" aria-live="polite">
          {messages.length === 0 && (
            <p className="empty-state">
              Try a greeting to see the remote greeting skill in action.
            </p>
          )}
          {messages.map((message) => (
            <article key={message.id} className={`message ${message.role}`}>
              <p className="author">{message.role === "user" ? "You" : "Agent"}</p>
              {message.parts.map((part, index) => {
                if (part.type === "text")
                  return (
                    // biome-ignore lint/suspicious/noArrayIndexKey: AI SDK appends text parts without IDs; their positions stay stable while streaming.
                    <p key={`text-${index}`}>{part.text}</p>
                  );
                if (part.type === "tool-skill" || part.type === "tool-readFile")
                  return (
                    <details key={part.toolCallId}>
                      <summary>
                        {part.type === "tool-skill" ? "Skill loading" : "Skill file read"} ·{" "}
                        {part.state}
                      </summary>
                      <pre>{JSON.stringify(part, null, 2)}</pre>
                    </details>
                  );
                return null;
              })}
            </article>
          ))}
          {status === "submitted" && <p role="status">Thinking…</p>}
        </div>
        {error && (
          <p className="alert" role="alert">
            The agent could not complete your message. Please try again.
          </p>
        )}
        <form
          className="composer"
          onSubmit={(event) => {
            event.preventDefault();
            send(input);
          }}
          aria-busy={busy}
        >
          <label htmlFor="message">Your message</label>
          <textarea
            id="message"
            ref={inputRef}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                send(input);
              }
            }}
            rows={2}
            placeholder="Say hello…"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            disabled={busy}
            required
          />
          <div className="actions">
            <button className="quiet" type="button" disabled={busy} onClick={() => send("Hello!")}>
              Try “Hello!”
            </button>
            <div className="primary-actions">
              <button
                className="quiet"
                type="button"
                onClick={async () => {
                  await stop();
                  setMessages([]);
                  clearError();
                  inputRef.current?.focus();
                }}
              >
                Reset
              </button>
              {busy ? (
                <button className="quiet" type="button" onClick={() => void stop()}>
                  Stop
                </button>
              ) : (
                <button className="send" type="submit">
                  Send
                </button>
              )}
            </div>
          </div>
        </form>
      </section>
    </main>
  );
}
