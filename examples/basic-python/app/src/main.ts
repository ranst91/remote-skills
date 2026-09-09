import "./style.css";

type ChatMessage = { role: "assistant" | "user"; content: string };

function element<T extends HTMLElement>(id: string): T {
  const value = document.querySelector<T>(`#${id}`);
  if (!value) throw new Error(`Missing interface element: ${id}`);
  return value;
}

const form = element<HTMLFormElement>("chat-form");
const input = element<HTMLTextAreaElement>("message");
const send = element<HTMLButtonElement>("send");
const reset = element<HTMLButtonElement>("reset");
const sample = element<HTMLButtonElement>("sample");
const conversation = element<HTMLDivElement>("conversation");
const emptyState = element<HTMLParagraphElement>("empty-state");
const alert = element<HTMLDivElement>("alert");

let history: ChatMessage[] = [];
let pending: AbortController | undefined;
let generation = 0;

function renderMessage(message: ChatMessage): void {
  emptyState.hidden = true;
  const article = document.createElement("article");
  article.className = `message ${message.role}`;
  const author = document.createElement("p");
  author.className = "author";
  author.textContent = message.role === "user" ? "You" : "Agent";
  const body = document.createElement("p");
  body.textContent = message.content;
  article.append(author, body);
  conversation.append(article);
  conversation.scrollTop = conversation.scrollHeight;
}

function setPending(active: boolean): void {
  input.disabled = active;
  send.disabled = active;
  sample.disabled = active;
  send.textContent = active ? "Thinking…" : "Send";
  form.setAttribute("aria-busy", String(active));
}

function showError(message: string): void {
  alert.textContent = message;
  alert.hidden = false;
}

async function submit(): Promise<void> {
  const content = input.value.trim();
  if (!content || pending) return;
  alert.hidden = true;
  history.push({ role: "user", content });
  renderMessage(history.at(-1) as ChatMessage);
  input.value = "";
  pending = new AbortController();
  const requestGeneration = generation;
  setPending(true);
  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: history }),
      signal: pending.signal,
    });
    const body: unknown = await response.json();
    if (requestGeneration !== generation) return;
    if (
      !response.ok ||
      body === null ||
      typeof body !== "object" ||
      !("message" in body) ||
      typeof body.message !== "string"
    ) {
      throw new Error();
    }
    const message: ChatMessage = { role: "assistant", content: body.message };
    history.push(message);
    renderMessage(message);
  } catch (error) {
    if (
      requestGeneration === generation &&
      !(error instanceof DOMException && error.name === "AbortError")
    ) {
      showError("The agent could not complete your message. Please try again.");
    }
  } finally {
    if (requestGeneration === generation) {
      pending = undefined;
      setPending(false);
      input.focus();
    }
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  void submit();
});

input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    form.requestSubmit();
  }
});

sample.addEventListener("click", () => {
  input.value = "Hello!";
  input.focus();
});

reset.addEventListener("click", () => {
  generation += 1;
  pending?.abort();
  pending = undefined;
  history = [];
  conversation.replaceChildren(emptyState);
  emptyState.hidden = false;
  alert.hidden = true;
  setPending(false);
  input.value = "";
  input.focus();
});

input.focus();
