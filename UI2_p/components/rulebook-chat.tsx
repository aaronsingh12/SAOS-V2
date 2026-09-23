"use client";

import React, { useState, useEffect, useRef } from "react";
import {
  ChatCircleDots,
  PaperPlaneTilt,
  Trash,
  Copy,
  Check,
  Sparkle,
  BookOpen,
} from "@phosphor-icons/react";

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  matchedRules?: {
    id: string;
    title: string;
    domain: string;
    baseSeverity?: string;
  }[];
};

const SUGGESTED_QUERIES = [
  { label: "What is CMDB-106? (CSDM Owner)", query: "What is CMDB-106 and why do CSDM services require designated owners?" },
  { label: "CMDB-106 Hindi me samjhao", query: "bhai CMDB-106 kya hota hai explain karo simple hindi me" },
  { label: "Explain ITSM-033 SLA Breach", query: "Explain ITSM-033 Contractual SLA breach impact and remediation" },
  { label: "Why is CMDB-058 Orphan CI critical?", query: "Why are CMDB-058 Orphan CIs dangerous for change impact analysis?" },
  { label: "Difference between CMDB & CSDM", query: "ServiceNow me CMDB aur CSDM 4.0 me kya difference hota hai?" },
  { label: "ITOM Discovery Staleness", query: "CMDB-016 discovery stale CIs (>60 days) ka kya risk hai?" },
];

const INITIAL_GREETING: ChatMessage = {
  id: "greeting",
  role: "assistant",
  content: `Welcome to SAOS Rulebook AI Assistant!

I am your autonomous ServiceNow governance guide covering 755 Master Catalog Rules across CMDB, ITSM, CSDM 4.0, ITOM, and Platform Data Quality.

Aap mujhse kisi bhi rule ke bare me English ya Hindi/Hinglish me pooch sakte hain!

What you can ask me:
- What is CMDB-106 and why do CSDM services require designated owners?
- Why are SLA breaches critical in ITSM-033?
- CMDB-058 Orphan CIs ko kaise identify aur fix karein?
- ServiceNow CSDM 4.0 aur CMDB me difference samjhao.

Click one of the quick prompts below or type your question!`,
  timestamp: new Date().toISOString(),
};

const STORAGE_KEY = "saos_rulebook_ai_history_v2";

export function RulebookChat({
  onInspectRule,
}: {
  onInspectRule?: (ruleId: string) => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([INITIAL_GREETING]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Load from local storage
  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed) && parsed.length > 0) {
          setMessages(parsed);
        }
      }
    } catch {
      // ignore
    }
  }, []);

  const saveMessages = (newMsgs: ChatMessage[]) => {
    setMessages(newMsgs);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(newMsgs));
    } catch {
      // ignore
    }
  };

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, loading]);

  const handleSend = async (textToSend?: string) => {
    const query = (textToSend ?? input).trim();
    if (!query || loading) return;

    const userMessage: ChatMessage = {
      id: "msg-" + Date.now(),
      role: "user",
      content: query,
      timestamp: new Date().toISOString(),
    };

    const nextMessages = [...messages, userMessage];
    saveMessages(nextMessages);
    if (!textToSend) setInput("");
    setLoading(true);

    try {
      const payloadMessages = nextMessages.slice(-6).map((m) => ({
        role: m.role,
        content: m.content,
      }));

      const res = await fetch("/api/ai/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: payloadMessages }),
      });

      if (!res.ok) {
        throw new Error(`Chat API error: ${res.status}`);
      }

      const data = await res.json();
      const assistantMessage: ChatMessage = {
        id: "msg-" + Date.now() + "-ai",
        role: "assistant",
        content: data.content || "No explanation available.",
        timestamp: data.timestamp || new Date().toISOString(),
        matchedRules: data.matchedRules,
      };

      saveMessages([...nextMessages, assistantMessage]);
    } catch (err) {
      const fallbackMessage: ChatMessage = {
        id: "msg-" + Date.now() + "-err",
        role: "assistant",
        content: `Error connecting to AI Assistant: ${err instanceof Error ? err.message : "Unknown error"}. Please ensure Ollama is running and selected in Settings.`,
        timestamp: new Date().toISOString(),
      };
      saveMessages([...nextMessages, fallbackMessage]);
    } finally {
      setLoading(false);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  };

  const handleClearHistory = () => {
    if (confirm("Are you sure you want to clear your Rulebook AI chat history?")) {
      saveMessages([INITIAL_GREETING]);
    }
  };

  const handleCopy = (id: string, text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  return (
    <div className="flex flex-col h-full bg-[#f4f8f9] animate-saos-page-enter">
      {/* Top Banner */}
      <div className="border-b-[3px] border-[#0d2f3f] bg-white p-4 sm:px-6 shadow-sm flex flex-wrap items-center justify-between gap-3 shrink-0">
        <div className="flex items-center gap-3">
          <div className="grid size-10 place-items-center border-2 border-[#0d2f3f] bg-[#5edc56] shadow-[2px_2px_0_#0d2f3f]">
            <Sparkle size={22} weight="fill" className="text-[#0d2f3f]" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="font-display text-base sm:text-lg font-black text-[#0d2f3f] uppercase tracking-wide">
                Rulebook AI Assistant
              </h2>
              <span className="border border-[#0d2f3f] bg-[#ffd166] px-1.5 py-0.2 font-mono text-[9px] font-black uppercase shadow-[1px_1px_0_#0d2f3f]">
                AUTONOMOUS COPILOT
              </span>
            </div>
            <p className="font-mono text-[11px] font-semibold text-[#476371]">
              Instant guidance on 755 ServiceNow Master Rules across CMDB, ITSM, CSDM, ITOM &amp; Data Quality
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleClearHistory}
            className="flex items-center gap-1.5 border-2 border-[#0d2f3f] bg-white hover:bg-rose-50 hover:text-rose-700 px-3 py-1.5 font-mono text-[11px] font-black uppercase text-[#0d2f3f] transition-colors shadow-[1px_1px_0_#0d2f3f] brutal-btn cursor-pointer"
            title="Clear Chat History"
          >
            <Trash size={13} weight="bold" />
            <span>Clear Chat</span>
          </button>
        </div>
      </div>

      {/* Chat Messages Area */}
      <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-4 saos-scroll">
        {messages.map((m) => {
          const isUser = m.role === "user";
          return (
            <div
              key={m.id}
              className={`flex ${isUser ? "justify-end" : "justify-start"}`}
            >
              <div
                className={`max-w-3xl border-2 border-[#0d2f3f] p-4 shadow-[3px_3px_0_#0d2f3f] ${
                  isUser
                    ? "bg-[#0d2f3f] text-[#f4f8f9] rounded-tl-lg rounded-bl-lg rounded-br-none"
                    : "bg-white text-[#0d2f3f] rounded-tr-lg rounded-br-lg rounded-bl-none"
                }`}
              >
                {/* Header */}
                <div className="flex items-center justify-between gap-3 border-b border-current/15 pb-1.5 mb-2.5">
                  <div className="flex items-center gap-2">
                    <span
                      className={`size-2 rounded-full ${
                        isUser ? "bg-[#5edc56]" : "bg-cyan-500"
                      }`}
                    />
                    <span className="font-mono text-[10px] font-black uppercase tracking-wider opacity-80">
                      {isUser ? "Operator" : "SAOS Rulebook AI"}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[9px] opacity-60">
                      {new Date(m.timestamp).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                    {!isUser && (
                      <button
                        type="button"
                        onClick={() => handleCopy(m.id, m.content)}
                        className="opacity-70 hover:opacity-100 transition-opacity p-0.5 cursor-pointer"
                        title="Copy message"
                      >
                        {copiedId === m.id ? (
                          <Check size={12} weight="bold" className="text-[#5edc56]" />
                        ) : (
                          <Copy size={12} weight="bold" />
                        )}
                      </button>
                    )}
                  </div>
                </div>

                {/* Formatted Content */}
                <FormattedChatMessage content={m.content} isUser={isUser} />
              </div>
            </div>
          );
        })}

        {loading && (
          <div className="flex justify-start">
            <div className="border-2 border-[#0d2f3f] bg-white p-4 shadow-[3px_3px_0_#0d2f3f] flex items-center gap-3">
              <div className="relative flex h-3 w-3 items-center justify-center">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#5edc56] opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-[#5edc56]" />
              </div>
              <span className="font-mono text-xs font-bold text-[#0d2f3f]">
                Consulting Rulebook catalog &amp; synthesizing explanation...
              </span>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Suggested Prompt Chips */}
      <div className="border-t-2 border-[#0d2f3f] bg-[#eef7fa] px-4 py-2 shrink-0 overflow-x-auto saos-scroll">
        <div className="flex items-center gap-2 min-w-max">
          <span className="font-mono text-[10px] font-black text-[#0d2f3f] uppercase flex items-center gap-1">
            <BookOpen size={12} weight="bold" />
            Quick Prompts:
          </span>
          {SUGGESTED_QUERIES.map((s) => (
            <button
              key={s.label}
              type="button"
              onClick={() => handleSend(s.query)}
              disabled={loading}
              className="border border-[#0d2f3f] bg-white hover:bg-[#5edc56] hover:text-[#0d2f3f] px-2.5 py-1 font-mono text-[10px] font-bold text-[#0d2f3f] shadow-[1px_1px_0_#0d2f3f] transition-all cursor-pointer whitespace-nowrap disabled:opacity-50"
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {/* Input Form */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          handleSend();
        }}
        className="border-t-[3px] border-[#0d2f3f] bg-white p-3 sm:p-4 shrink-0 flex items-center gap-2 sm:gap-3"
      >
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask any question about CMDB, ITSM, CSDM, ITOM, or Data Quality rules (e.g. 'What is CMDB-106?')..."
          disabled={loading}
          className="flex-1 border-2 border-[#0d2f3f] bg-[#f4f8f9] px-3.5 py-2.5 font-sans text-xs sm:text-sm font-semibold text-[#0d2f3f] placeholder:text-[#476371] focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#5edc56] shadow-[inset_1px_1px_0_#0d2f3f]"
        />

        <button
          type="submit"
          disabled={!input.trim() || loading}
          className="border-2 border-[#0d2f3f] bg-[#5edc56] hover:bg-[#4bc744] disabled:opacity-40 disabled:hover:bg-[#5edc56] px-4 py-2.5 font-mono text-xs sm:text-sm font-black uppercase text-[#0d2f3f] shadow-[2px_2px_0_#0d2f3f] brutal-btn flex items-center gap-2 cursor-pointer shrink-0 transition-transform"
        >
          <span>Send</span>
          <PaperPlaneTilt size={16} weight="bold" />
        </button>
      </form>
    </div>
  );
}

function FormattedChatMessage({ content, isUser }: { content: string; isUser: boolean }) {
  if (isUser) {
    return <div className="text-xs sm:text-sm font-medium leading-relaxed whitespace-pre-wrap">{content}</div>;
  }

  // Pre-process and render lines
  const rawLines = content.split("\n");
  const elements: React.ReactNode[] = [];
  let currentList: string[] | null = null;

  const flushList = () => {
    if (!currentList || currentList.length === 0) return;
    const items = [...currentList];
    elements.push(
      <ul key={`list-${elements.length}`} className="my-2 space-y-1.5 pl-0.5">
        {items.map((item, idx) => (
          <li key={idx} className="flex items-start gap-2 text-xs sm:text-sm text-[#0d2f3f]">
            <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-[#16a34a]" />
            <span className="flex-1 leading-relaxed">{renderInline(item)}</span>
          </li>
        ))}
      </ul>
    );
    currentList = null;
  };

  for (let i = 0; i < rawLines.length; i++) {
    let line = rawLines[i].trim();
    if (!line) {
      flushList();
      continue;
    }

    // Horizontal Rule (--- or ***)
    if (/^(\-{3,}|\*{3,}|_{3,})$/.test(line)) {
      flushList();
      elements.push(<hr key={`hr-${i}`} className="my-3 border-[#0d2f3f]/15" />);
      continue;
    }

    // Markdown Heading (#, ##, ###, ####)
    if (/^#{1,4}\s+/.test(line)) {
      flushList();
      const headingText = line.replace(/^#{1,4}\s+/, "").replace(/^\*+|\*+$/g, "").trim();
      elements.push(
        <div
          key={`h-${i}`}
          className="mt-3.5 mb-1.5 first:mt-0 flex items-center gap-2 font-display text-xs sm:text-sm font-black uppercase tracking-wider text-[#0d2f3f]"
        >
          <span className="size-2 bg-[#5edc56] border border-[#0d2f3f] shrink-0" />
          <span>{renderInline(headingText)}</span>
        </div>
      );
      continue;
    }

    // Blockquote (> text)
    if (line.startsWith(">")) {
      flushList();
      const quoteText = line.replace(/^>\s*/, "").trim();
      elements.push(
        <div
          key={`quote-${i}`}
          className="my-2 border-l-4 border-[#ffd166] bg-[#fffbf0] p-2.5 text-xs text-[#0d2f3f] font-semibold shadow-[1px_1px_0_#0d2f3f]"
        >
          {renderInline(quoteText)}
        </div>
      );
      continue;
    }

    // Section title ending in colon or question mark (e.g. "Rule Overview:", "Why It Matters:")
    if (
      (/^(Rule Overview|What It Means|Why It Matters|Business Impact|Target ServiceNow Tables|ServiceNow Tables|Affected Tables|Remediation Strategy|Detection Logic|How to Remediate|Kya karta hai|Kyun zaroori|Kyun important|Kaise fix karein|Note|Tip):?/i.test(
        line
      ) ||
      /\?$/.test(line)) &&
      line.length < 90 &&
      !line.startsWith("-") &&
      !line.startsWith("*")
    ) {
      flushList();
      const cleanHeader = line.replace(/^\*+|\*+$/g, "").trim();
      elements.push(
        <div
          key={`sec-${i}`}
          className="mt-3.5 mb-1 first:mt-0 font-display text-xs sm:text-sm font-black text-[#0d2f3f] flex items-center gap-1.5"
        >
          <span className="size-1.5 bg-[#0d2f3f] shrink-0" />
          <span>{renderInline(cleanHeader)}</span>
        </div>
      );
      continue;
    }

    // Bullet List Item (- , * , • )
    if (/^[-*•]\s+/.test(line)) {
      const itemText = line.replace(/^[-*•]\s+/, "").trim();
      if (!currentList) {
        currentList = [];
      }
      currentList.push(itemText);
      continue;
    }

    // Numbered List Item (1. , 2. )
    if (/^\d+\.\s+/.test(line)) {
      const itemText = line.replace(/^\d+\.\s+/, "").trim();
      if (!currentList) {
        currentList = [];
      }
      currentList.push(itemText);
      continue;
    }

    // Regular Paragraph
    flushList();
    elements.push(
      <p key={`p-${i}`} className="mb-2 leading-relaxed text-xs sm:text-sm text-[#0d2f3f] last:mb-0 font-normal">
        {renderInline(line)}
      </p>
    );
  }

  flushList();

  return <div className="space-y-1">{elements}</div>;
}

function renderInline(text: string): React.ReactNode {
  // Replace ***bold-italic***, **bold**, `code`, [RULE-ID]
  const parts: React.ReactNode[] = [];
  const regex = /(\*\*\*[^*]+\*\*\*|\*\*[^*]+\*\*|`[^`]+`|\[(?:CMDB|ITSM|ITOM|CSDM|DQ|PLT|SEC)[^\]]*\])/g;
  let lastIdx = 0;
  let match;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIdx) {
      parts.push(text.substring(lastIdx, match.index));
    }
    const token = match[0];
    if (token.startsWith("***") && token.endsWith("***")) {
      parts.push(
        <strong key={match.index} className="font-black text-[#0d2f3f]">
          {token.slice(3, -3)}
        </strong>
      );
    } else if (token.startsWith("**") && token.endsWith("**")) {
      parts.push(
        <strong key={match.index} className="font-black text-[#0d2f3f]">
          {token.slice(2, -2)}
        </strong>
      );
    } else if (token.startsWith("`") && token.endsWith("`")) {
      parts.push(
        <code
          key={match.index}
          className="border border-[#0d2f3f] bg-[#eef7fa] px-1.5 py-0.5 font-mono text-[11px] font-black text-[#0d2f3f]"
        >
          {token.slice(1, -1)}
        </code>
      );
    } else if (token.startsWith("[") && token.endsWith("]")) {
      parts.push(
        <span
          key={match.index}
          className="border border-[#0d2f3f] bg-[#5edc56] px-1 py-0.2 font-mono text-[10px] font-black text-[#0d2f3f] shadow-[1px_1px_0_#0d2f3f]"
        >
          {token.slice(1, -1)}
        </span>
      );
    }
    lastIdx = regex.lastIndex;
  }

  if (lastIdx < text.length) {
    parts.push(text.substring(lastIdx));
  }

  return parts.length > 0 ? parts : text;
}
