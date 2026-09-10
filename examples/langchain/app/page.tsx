"use client";

import { useEffect, useRef, useState } from "react";

const paths = [
  { value: "deepagents-ts", label: "DeepAgents · TypeScript" },
  { value: "langchain-ts", label: "LangChain createAgent · TypeScript" },
  { value: "langgraph-ts", label: "LangGraph · native agent subgraph · TypeScript" },
  { value: "deepagents-python", label: "DeepAgents · Python" },
  { value: "langchain-python", label: "LangChain create_agent · Python" },
  { value: "langgraph-python", label: "LangGraph · native agent subgraph · Python" },
] as const;

type AgentPath = (typeof paths)[number]["value"];
type Skill = { name: string; description: string };
type DisplayEvent =
  | { type: "catalog"; skills: Skill[] }
  | { type: "tool-start"; name: string; input: unknown }
  | { type: "tool-end"; name: string; output: unknown }
  | { type: "text"; text: string };
type StreamEvent = DisplayEvent | { type: "error" } | { type: "done" };
type Part = { id: number; event: DisplayEvent };

const MAX_MESSAGE_CHARS = 8_000;
const MAX_EVENT_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_EVENTS = 2_000;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseEvent(line: string): StreamEvent {
  if (new TextEncoder().encode(line).byteLength > MAX_EVENT_BYTES)
    throw new Error("Invalid stream");
  const value: unknown = JSON.parse(line);
  if (!record(value)) throw new Error("Invalid stream");
  if (value.type === "done" || value.type === "error") return { type: value.type };
  if (value.type === "text" && typeof value.text === "string") {
    return { type: "text", text: value.text };
  }
  if (value.type === "catalog" && Array.isArray(value.skills) && value.skills.length <= 100) {
    const skills = value.skills.map((skill: unknown) => {
      if (
        !record(skill) ||
        typeof skill.name !== "string" ||
        typeof skill.description !== "string"
      ) {
        throw new Error("Invalid stream");
      }
      return { name: skill.name, description: skill.description };
    });
    return { type: "catalog", skills };
  }
  if (typeof value.name === "string" && value.name.length <= 160) {
    if (value.type === "tool-start" && Object.hasOwn(value, "input")) {
      return { type: "tool-start", name: value.name, input: value.input };
    }
    if (value.type === "tool-end" && Object.hasOwn(value, "output")) {
      return { type: "tool-end", name: value.name, output: value.output };
    }
  }
  throw new Error("Invalid stream");
}

function detailsText(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? "No details.";
  } catch {
    return "These details could not be displayed.";
  }
}

function EventPart({ event }: { event: DisplayEvent }) {
  if (event.type === "text") return <p className="answer">{event.text}</p>;
  if (event.type === "catalog") {
    return (
      <details className="activity">
        <summary>Available skills · {event.skills.length}</summary>
        {event.skills.length === 0 ? (
          <p>No skills are available from this origin.</p>
        ) : (
          <dl className="catalog">
            {event.skills.map((skill) => (
              <div key={skill.name}>
                <dt>{skill.name}</dt>
                <dd>{skill.description}</dd>
              </div>
            ))}
          </dl>
        )}
      </details>
    );
  }
  return (
    <details className="activity">
      <summary>
        {event.name} · {event.type === "tool-start" ? "Started" : "Finished"}
      </summary>
      <pre>{detailsText(event.type === "tool-start" ? event.input : event.output)}</pre>
    </details>
  );
}

export default function Chat() {
  const [path, setPath] = useState<AgentPath>("deepagents-ts");
  const [input, setInput] = useState("");
  const [question, setQuestion] = useState("");
  const [parts, setParts] = useState<Part[]>([]);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [stopped, setStopped] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const conversationRef = useRef<HTMLDivElement>(null);
  const followLatest = useRef(true);
  const activeRequest = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!busy) inputRef.current?.focus();
  }, [busy]);
  useEffect(() => () => activeRequest.current?.abort(), []);
  useEffect(() => {
    const conversation = conversationRef.current;
    if ((question || parts.length > 0) && followLatest.current && conversation) {
      conversation.scrollTop = conversation.scrollHeight;
    }
  }, [question, parts]);

  function stop() {
    const request = activeRequest.current;
    activeRequest.current = null;
    request?.abort();
    setBusy(false);
    setStopped(true);
  }

  function reset() {
    stop();
    setQuestion("");
    setParts([]);
    setInput("");
    setFailed(false);
    setStopped(false);
    inputRef.current?.focus();
  }

  async function send(text: string) {
    const message = text.trim();
    if (!message || message.length > MAX_MESSAGE_CHARS || activeRequest.current) return;
    const request = new AbortController();
    activeRequest.current = request;
    followLatest.current = true;
    setBusy(true);
    setFailed(false);
    setStopped(false);
    setQuestion(message);
    setParts([]);
    setInput("");
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, path }),
        signal: request.signal,
      });
      if (!response.ok || !response.body) throw new Error("Request failed");
      reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8", { fatal: true });
      let pending = "";
      let bytes = 0;
      let eventCount = 0;
      let complete = false;

      function receive(line: string) {
        if (!line.trim()) return;
        if (++eventCount > MAX_EVENTS) throw new Error("Invalid stream");
        const event = parseEvent(line);
        if (event.type === "error") throw new Error("Request failed");
        if (event.type === "done") {
          complete = true;
          return;
        }
        const id = eventCount;
        if (activeRequest.current !== request) return;
        setParts((current) => {
          const previous = current.at(-1);
          if (event.type === "text" && previous?.event.type === "text") {
            return [
              ...current.slice(0, -1),
              { id: previous.id, event: { type: "text", text: previous.event.text + event.text } },
            ];
          }
          return [...current, { id, event }];
        });
      }

      while (!complete) {
        const chunk = await reader.read();
        if (activeRequest.current !== request) return;
        if (chunk.done) {
          pending += decoder.decode();
          if (pending) receive(pending);
          if (!complete) throw new Error("Incomplete stream");
          break;
        }
        bytes += chunk.value.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) throw new Error("Invalid stream");
        pending += decoder.decode(chunk.value, { stream: true });
        let newline = pending.indexOf("\n");
        while (newline !== -1 && !complete) {
          receive(pending.slice(0, newline));
          pending = pending.slice(newline + 1);
          newline = pending.indexOf("\n");
        }
        if (pending.length > MAX_EVENT_BYTES) throw new Error("Invalid stream");
      }
    } catch {
      if (activeRequest.current === request && !request.signal.aborted) setFailed(true);
    } finally {
      await reader?.cancel().catch(() => undefined);
      reader?.releaseLock();
      if (activeRequest.current === request) {
        activeRequest.current = null;
        setBusy(false);
      }
    }
  }

  return (
    <main className="shell">
      <header className="intro">
        <p className="eyebrow">Remote Skills · LangChain family</p>
        <h1>Ask with context.</h1>
        <p className="lede">
          Choose an agent and say hello. It can discover and load a relevant remote skill as it
          answers.
        </p>
      </header>
      <section className="chat" aria-label="Chat with the skill-enabled agent">
        <div className="path-picker">
          <label htmlFor="agent-path">Agent</label>
          <select
            id="agent-path"
            value={path}
            disabled={busy}
            onChange={(event) => {
              const selected = paths.find((entry) => entry.value === event.target.value);
              if (selected) {
                reset();
                setPath(selected.value);
              }
            }}
          >
            {paths.map((entry) => (
              <option key={entry.value} value={entry.value}>
                {entry.label}
              </option>
            ))}
          </select>
        </div>
        <div
          id="conversation"
          className="conversation"
          ref={conversationRef}
          role="log"
          aria-live="polite"
          onScroll={(event) => {
            const conversation = event.currentTarget;
            followLatest.current =
              conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight < 48;
          }}
        >
          {!question && (
            <p className="empty-state">
              Try a greeting to see the remote greeting skill in action.
            </p>
          )}
          {question && (
            <article className="message user">
              <p className="author">You</p>
              <p>{question}</p>
            </article>
          )}
          {parts.length > 0 && (
            <article className="message assistant">
              <p className="author">Agent</p>
              {parts.map((part) => (
                <EventPart key={part.id} event={part.event} />
              ))}
            </article>
          )}
          {busy && (
            <p className="status" role="status">
              The agent is working…
            </p>
          )}
          {stopped && (
            <p className="status" role="status">
              Stopped. You can start a new question.
            </p>
          )}
        </div>
        {failed && (
          <p className="alert" role="alert">
            The agent could not complete your message. Please try again.
          </p>
        )}
        <form
          className="composer"
          onSubmit={(event) => {
            event.preventDefault();
            void send(input);
          }}
          aria-busy={busy}
        >
          <label htmlFor="message">Your message</label>
          <textarea
            id="message"
            ref={inputRef}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void send(input);
              }
            }}
            rows={2}
            placeholder="Say hello…"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            disabled={busy}
            maxLength={MAX_MESSAGE_CHARS}
            aria-describedby="session-note"
            required
          />
          <div className="actions">
            <button
              className="quiet"
              type="button"
              disabled={busy}
              onClick={() => void send("Hello!")}
            >
              Try “Hello!”
            </button>
            <div className="primary-actions">
              <button className="quiet" type="button" onClick={reset}>
                Reset
              </button>
              {busy && (
                <button className="quiet" type="button" onClick={stop}>
                  Stop
                </button>
              )}
              <button className="send" type="submit" disabled={busy || !input.trim()}>
                Send
              </button>
            </div>
          </div>
          <p id="session-note" className="session-note">
            Each question starts a fresh session. Reset clears this conversation.
          </p>
        </form>
      </section>
    </main>
  );
}
