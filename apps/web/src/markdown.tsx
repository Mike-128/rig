import DOMPurify from "dompurify";
import { marked } from "marked";
import { memo, useMemo } from "react";

marked.setOptions({ gfm: true, breaks: false });

// Model output can quote web pages and files, so it is untrusted HTML: sanitize everything, and
// open links outside the app rather than navigating the window that holds the approve buttons.
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

/** Renders model markdown. Raw HTML in the source is shown as text, never as markup. */
export const Markdown = memo(function Markdown({ text, className }: { text: string; className?: string }) {
  const html = useMemo(() => {
    const escaped = text.replace(/<(?=[a-zA-Z/!])/g, "&lt;");
    const raw = marked.parse(escaped, { async: false }) as string;
    return DOMPurify.sanitize(raw, { ALLOWED_URI_REGEXP: /^(?:https?|mailto):/i });
  }, [text]);
  return <div className={`md ${className ?? ""}`} dangerouslySetInnerHTML={{ __html: html }} />;
});
