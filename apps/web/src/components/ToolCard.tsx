import { diffLines } from "diff";
import { useEffect, useRef, useState } from "react";
import type { Session } from "@rig/core/types";
import { desktop } from "../desktop";
import type { ToolItem } from "../events";

const str = (v: unknown) => (typeof v === "string" ? v : "");

/** One line that says what the call did, in the words a person would use. */
export function toolTitle(t: Pick<ToolItem, "name" | "input">): { verb: string; target: string } {
  const i = (t.input ?? {}) as Record<string, unknown>;
  switch (t.name) {
    case "file_read": {
      const range = i.offset || i.limit ? ` (lines ${i.offset ?? 1}${i.limit ? `–${Number(i.offset ?? 1) + Number(i.limit) - 1}` : "+"})` : "";
      return { verb: "Read", target: `${str(i.path)}${range}` };
    }
    case "file_edit":
      return { verb: "Edit", target: str(i.path) };
    case "file_write":
      return { verb: "Write", target: str(i.path) };
    case "glob":
      return { verb: "Find", target: `${str(i.pattern)}${i.path ? ` in ${str(i.path)}` : ""}` };
    case "grep":
      return { verb: "Search", target: `/${str(i.pattern)}/${i.path ? ` in ${str(i.path)}` : ""}${i.glob ? ` (${str(i.glob)})` : ""}` };
    case "shell":
      return { verb: "Run", target: str(i.command) };
    case "web_fetch":
      return { verb: "Fetch", target: str(i.url) };
    case "document_create":
      return { verb: "Create", target: `${str(i.filename)}.${str(i.format)}` };
    case "todo_write":
      return { verb: "Plan", target: "" };
    case "task":
      return { verb: "Sub-agent", target: str(i.description) };
    case "agent_message":
      return i.conversation ? { verb: "Reply", target: "in conversation" } : { verb: "Ask", target: str(i.agent) };
    case "load_skill":
      return { verb: "Skill", target: `${str(i.name)}${i.file ? ` › ${str(i.file)}` : ""}` };
    default:
      return { verb: t.name.replace(/^mcp__([^_]+)__/, "$1 › "), target: "" };
  }
}

/** A short result note for the header: "12 files", "exit 1", "3 lines". */
function resultNote(t: ToolItem): string {
  if (t.status === "awaiting_approval") return "waiting for you";
  if (t.status === "running") return "running";
  if (t.approval?.decision === "deny") return "declined";
  // Another agent's call: this card holds only the decision; its result is in that conversation.
  if (t.via) return "allowed";
  const out = t.output ?? "";
  if (t.isError) {
    const exit = out.match(/\[exit code (\d+)\]\s*$/);
    return exit ? `exit ${exit[1]}` : "error";
  }
  switch (t.name) {
    case "glob":
      return out.startsWith("No files") ? "no matches" : `${out.split("\n").filter((l) => l && !l.startsWith("[")).length} files`;
    case "grep":
      return out.startsWith("No matches") ? "no matches" : (out.match(/\[(\d+) file\(s\)\]/)?.[1] ?? out.split("\n").length) + (out.includes("file(s)") ? " files" : " lines");
    case "file_read": {
      const m = out.match(/\[lines (\d+)-(\d+) of (\d+)/);
      return m ? `${m[3]} lines, read ${m[1]}–${m[2]}` : `${out.split("\n").length} lines`;
    }
    case "shell":
      return out.match(/\[exit code (\d+)\]\s*$/) ? "done" : "";
    default:
      return t.durationMs && t.durationMs > 1000 ? `${(t.durationMs / 1000).toFixed(1)}s` : "";
  }
}

function DiffView({ before, after }: { before: string; after: string }) {
  const parts = diffLines(before, after);
  return (
    <pre className="diff">
      {parts.flatMap((p, i) =>
        p.value
          .replace(/\n$/, "")
          .split("\n")
          .map((line, j) => (
            <div key={`${i}-${j}`} className={p.added ? "add" : p.removed ? "del" : "ctx"}>
              <span className="sign">{p.added ? "+" : p.removed ? "−" : " "}</span>
              {line}
            </div>
          )),
      )}
    </pre>
  );
}

function LiveOutput({ text }: { text: string }) {
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight });
  }, [text]);
  return (
    <pre ref={ref} className="output live">
      {text}
    </pre>
  );
}

const DOCUMENT_KIND: Record<string, string> = { docx: "Word document", html: "Web page", md: "Markdown", csv: "CSV spreadsheet" };

/** A workspace-relative path as a local path, with the workspace's own separator. */
function localPath(workspace: string, rel: string): string {
  const sep = workspace.includes("\\") ? "\\" : "/";
  return `${workspace.replace(/[\\/]+$/, "")}${sep}${rel.split("/").join(sep)}`;
}

/** A created document, with the way to get it: download in a browser, open in the desktop app. */
function DocumentCard({ path, size, session }: { path: string; size: string; session: Pick<Session, "id" | "workspace"> }) {
  const name = path.split("/").pop() ?? path;
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const href = `/api/sessions/${encodeURIComponent(session.id)}/outputs/${encodeURIComponent(name)}`;
  return (
    <div className="document-card">
      <div className="document-meta">
        <strong className="document-name">{name}</strong>
        <span className="muted small">
          {DOCUMENT_KIND[ext] ?? "File"}, {size}
        </span>
      </div>
      <div className="row tight">
        <a className="btn btn-primary" href={href} download={name}>
          Download
        </a>
        {desktop && (
          <button onClick={() => desktop!.openPath(localPath(session.workspace, path))}>Open</button>
        )}
      </div>
    </div>
  );
}

/** Splits an agent_message result into who answered, the conversation, and the reply itself. */
export function parseConversationResult(output: string | undefined): { agent?: string; conversation?: string; reply?: string } {
  if (!output) return {};
  const m = output.match(/^(.+?) (?:replied|could not answer) \(conversation (sess_[A-Za-z0-9]+)\)(?::|\s)/);
  if (!m) return { conversation: output.match(/conversation "?(sess_[A-Za-z0-9]+)/)?.[1] };
  const body = output.slice(m[0].length).replace(/\n*To reply, call agent_message with conversation "[^"]+"\.\s*$/, "").trim();
  return { agent: m[1], conversation: m[2], reply: body };
}

/** One message to another agent and its reply, with a way into the whole conversation. */
function ConversationCard({ t }: { t: ToolItem }) {
  const i = (t.input ?? {}) as Record<string, unknown>;
  const parsed = parseConversationResult(t.output);
  const conversation = parsed.conversation ?? str(i.conversation);
  const who = parsed.agent ?? (str(i.agent) || "the other agent");
  const state = t.status !== "done" ? t.status : t.isError ? "error" : "ok";
  const [open, setOpen] = useState<boolean | undefined>(undefined);
  const expanded = open ?? (t.status !== "done" || t.isError === true);
  return (
    <div className={`tool conversation ${expanded ? "open" : ""}`}>
      <button className="tool-head" onClick={() => setOpen(!expanded)} title={expanded ? "Collapse" : "Expand"}>
        <span className={`dot ${state}`} />
        <span className="verb">{i.conversation ? "Replied to" : "Asked"}</span>
        <span className="target">{who}</span>
        <span className="note">{t.status === "running" ? "waiting for its reply" : t.isError ? "no reply" : "replied"}</span>
      </button>
      {expanded && (
        <div className="tool-body">
          <div className="exchange">
            <div className="said">
              <span className="who">Message</span>
              <div className="text">{str(i.message)}</div>
            </div>
            {t.status === "running" && t.progress && <LiveOutput text={t.progress} />}
            {t.status === "done" && (
              <div className={`said reply ${t.isError ? "err" : ""}`}>
                <span className="who">{t.isError ? "Problem" : `${who} replied`}</span>
                <div className="text">{parsed.reply ?? t.output}</div>
              </div>
            )}
          </div>
          {conversation && (
            <a className="btn" href={`#/s/${conversation}`}>
              Open the conversation
            </a>
          )}
        </div>
      )}
    </div>
  );
}

export function ToolCard({ t, session }: { t: ToolItem; session?: Pick<Session, "id" | "workspace"> }) {
  const i = (t.input ?? {}) as Record<string, unknown>;
  const showsDiff = t.name === "file_edit" || t.name === "file_write";
  const [open, setOpen] = useState<boolean | undefined>(undefined);
  // Edits and anything waiting on the user start open; reads and searches stay out of the way.
  const expanded = open ?? (showsDiff || t.status === "awaiting_approval" || (t.status === "running" && (t.name === "shell" || t.name === "task")) || t.isError === true);
  const { verb, target } = toolTitle(t);
  const note = resultNote(t);
  const state = t.status !== "done" ? t.status : t.isError ? "error" : "ok";

  const created = t.name === "document_create" && t.status === "done" && !t.isError ? (t.output ?? "").match(/^Created (outputs\/.+) \(([^)]+)\)\./) : null;
  if (created && session) {
    return (
      <div className="tool-document">
        <DocumentCard path={created[1]} size={created[2]} session={session} />
      </div>
    );
  }

  if (t.name === "agent_message") return <ConversationCard t={t} />;

  if (t.name === "todo_write") {
    const todos = (i.todos as { content: string; status: string }[] | undefined) ?? [];
    return (
      <div className="tool compact">
        <span className={`dot ${state}`} />
        <span className="verb">Updated plan</span>
        <span className="muted">
          {todos.filter((x) => x.status === "completed").length}/{todos.length} done
        </span>
      </div>
    );
  }

  return (
    <div className={`tool ${expanded ? "open" : ""}`}>
      <button className="tool-head" onClick={() => setOpen(!expanded)} title={expanded ? "Collapse" : "Expand"}>
        <span className={`dot ${state}`} />
        {t.via && <span className="pill" title="Asked by another agent, in a conversation this session started">{t.via.agent}</span>}
        <span className="verb">{verb}</span>
        <span className="target mono">{target}</span>
        {note && <span className="note">{note}</span>}
        {t.approval?.decision === "always" && t.approval.rule && <span className="pill">always: {t.approval.rule}</span>}
      </button>
      {expanded && (
        <div className="tool-body">
          {t.name === "file_edit" && <DiffView before={str(i.old_string)} after={str(i.new_string)} />}
          {t.name === "file_write" && <DiffView before="" after={str(i.content).split("\n").slice(0, 400).join("\n")} />}
          {t.name === "task" && <pre className="output">{str(i.prompt)}</pre>}
          {t.status === "running" && t.progress && <LiveOutput text={t.progress} />}
          {t.via && (
            <p className="muted small">
              {t.via.agent} is asking, in a conversation this session's agent started. <a href={`#/s/${t.via.conversation}`}>Open the conversation</a>
            </p>
          )}
          {t.output !== undefined && !(showsDiff && !t.isError) && <pre className={`output ${t.isError ? "err" : ""}`}>{t.output}</pre>}
          {!showsDiff && t.name !== "task" && t.output === undefined && !t.progress && t.status !== "running" && (
            <pre className="output muted">{JSON.stringify(t.input, null, 2)}</pre>
          )}
        </div>
      )}
    </div>
  );
}
