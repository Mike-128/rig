import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { PermissionMode } from "@rig/core/types";
import { api } from "../api";

export interface SlashCommand {
  name: string;
  description: string;
  /** Skills run as a turn; built-ins are handled by the app. */
  kind: "builtin" | "skill";
}

export const BUILTIN_COMMANDS: SlashCommand[] = [
  { name: "clear", description: "Start a new session in this folder", kind: "builtin" },
  { name: "compact", description: "Summarize the conversation to free context", kind: "builtin" },
  { name: "mode", description: "Set the permission mode: default, acceptEdits, plan, auto", kind: "builtin" },
  { name: "agent", description: "Switch this session to another agent", kind: "builtin" },
  { name: "skills", description: "Manage and install skills", kind: "builtin" },
  { name: "help", description: "Keyboard shortcuts and commands", kind: "builtin" },
];

interface Menu {
  kind: "slash" | "at";
  /** Where the trigger character sits in the text. */
  start: number;
  items: { label: string; detail?: string; insert: string }[];
  index: number;
}

export interface ComposerHandle {
  focus(): void;
  insert(text: string): void;
}

interface Props {
  sessionId?: string;
  running: boolean;
  mode: PermissionMode;
  commands: SlashCommand[];
  disabled?: boolean;
  placeholder?: string;
  onSend(text: string): void;
  onStop(): void;
  onCycleMode(): void;
}

const HISTORY_KEY = "rig.composer.history";

function loadHistory(): string[] {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]") as string[];
  } catch {
    return [];
  }
}

export const Composer = forwardRef<ComposerHandle, Props>(function Composer(props, ref) {
  const [value, setValue] = useState("");
  const [menu, setMenu] = useState<Menu | null>(null);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const ta = useRef<HTMLTextAreaElement>(null);
  const fileQuery = useRef(0);

  useImperativeHandle(ref, () => ({
    focus: () => ta.current?.focus(),
    insert: (text) => {
      setValue((v) => (v ? `${v} ${text}` : text));
      ta.current?.focus();
    },
  }));

  // Grow with the content up to a third of the window.
  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, window.innerHeight / 3)}px`;
  }, [value]);

  useEffect(() => {
    ta.current?.focus();
  }, [props.sessionId]);

  function updateMenu(text: string, caret: number) {
    const before = text.slice(0, caret);
    const slash = before.match(/^\/([\w-]*)$/);
    if (slash) {
      const q = slash[1].toLowerCase();
      const items = props.commands
        .filter((c) => c.name.toLowerCase().includes(q))
        .sort((a, b) => Number(!a.name.startsWith(q)) - Number(!b.name.startsWith(q)))
        .slice(0, 12)
        .map((c) => ({ label: `/${c.name}`, detail: `${c.kind === "skill" ? "skill · " : ""}${c.description}`, insert: `/${c.name} ` }));
      setMenu(items.length ? { kind: "slash", start: 0, items, index: 0 } : null);
      return;
    }
    const at = before.match(/(?:^|\s)@([^\s@]*)$/);
    if (at && props.sessionId) {
      const start = caret - at[1].length - 1;
      const id = ++fileQuery.current;
      api<string[]>(`/sessions/${props.sessionId}/files?q=${encodeURIComponent(at[1])}`)
        .then((files) => {
          if (id !== fileQuery.current) return;
          const items = files.slice(0, 12).map((f) => ({ label: f, insert: `@${f} ` }));
          setMenu(items.length ? { kind: "at", start, items, index: 0 } : null);
        })
        .catch(() => setMenu(null));
      return;
    }
    fileQuery.current++;
    setMenu(null);
  }

  function choose(i: number) {
    if (!menu) return;
    const item = menu.items[i];
    const caret = ta.current?.selectionStart ?? value.length;
    const next = value.slice(0, menu.start) + item.insert + value.slice(caret);
    setValue(next);
    setMenu(null);
    requestAnimationFrame(() => {
      const pos = menu.start + item.insert.length;
      ta.current?.setSelectionRange(pos, pos);
      ta.current?.focus();
    });
  }

  function send() {
    const text = value.trim();
    if (!text || props.disabled) return;
    const history = [text, ...loadHistory().filter((h) => h !== text)].slice(0, 100);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
    setHistoryIndex(-1);
    setValue("");
    setMenu(null);
    props.onSend(text);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (menu) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const d = e.key === "ArrowDown" ? 1 : -1;
        setMenu({ ...menu, index: (menu.index + d + menu.items.length) % menu.items.length });
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        // Enter on an exact slash command sends it rather than re-inserting it.
        const exact = menu.kind === "slash" && menu.items[menu.index].insert.trim() === value.trim();
        if (!(e.key === "Enter" && exact)) {
          e.preventDefault();
          choose(menu.index);
          return;
        }
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMenu(null);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
      return;
    }
    if (e.key === "Tab" && e.shiftKey) {
      e.preventDefault();
      props.onCycleMode();
      return;
    }
    if (e.key === "Escape" && props.running) {
      e.preventDefault();
      props.onStop();
      return;
    }
    const el = e.currentTarget;
    if ((e.key === "ArrowUp" || e.key === "ArrowDown") && (!value || historyIndex >= 0) && el.selectionStart === el.selectionEnd) {
      const history = loadHistory();
      const next = e.key === "ArrowUp" ? Math.min(historyIndex + 1, history.length - 1) : historyIndex - 1;
      if (e.key === "ArrowUp" && !history.length) return;
      e.preventDefault();
      setHistoryIndex(next);
      setValue(next >= 0 ? history[next] : "");
    }
  }

  return (
    <div className="composer-wrap">
      {menu && (
        <div className="menu" role="listbox">
          {menu.items.map((it, i) => (
            <div
              key={it.label}
              role="option"
              aria-selected={i === menu.index}
              className={`menu-item ${i === menu.index ? "sel" : ""}`}
              onMouseDown={(e) => {
                e.preventDefault();
                choose(i);
              }}
            >
              <span className="mono">{it.label}</span>
              {it.detail && <span className="muted">{it.detail}</span>}
            </div>
          ))}
        </div>
      )}
      <textarea
        ref={ta}
        rows={1}
        value={value}
        disabled={props.disabled}
        placeholder={props.placeholder}
        onChange={(e) => {
          setValue(e.target.value);
          setHistoryIndex(-1);
          updateMenu(e.target.value, e.target.selectionStart);
        }}
        onKeyDown={onKeyDown}
        onBlur={() => setTimeout(() => setMenu(null), 150)}
      />
      <div className="composer-actions">
        {props.running && (
          <button className="stop" onClick={props.onStop} title="Stop (Esc)">
            ■ Stop
          </button>
        )}
        <button className="primary" disabled={!value.trim() || props.disabled} onClick={send} title={props.running ? "Send now; the agent reads it at its next step" : "Send (Enter)"}>
          {props.running ? "Steer" : "Send"}
        </button>
      </div>
    </div>
  );
});
