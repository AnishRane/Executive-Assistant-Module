// BriefMarkdown — the live markdown canvas for any agent-authored
// prose in EA. Used by the Day Brief card and the Meeting Drawer's
// prep brief.
//
// Goal: render every common markdown element with a clear visual
// hierarchy so the agent can pick whichever structure fits the day
// (flat narrative, headed sections, bulleted list, mix). Each style
// is constrained to the existing paper palette so nothing fights the
// surrounding chrome.
//
// Style philosophy:
//   - h1/h2 → primary section dividers with breathing room and a
//             subtle accent underline
//   - h3    → sub-section, smaller, uppercase tracking like our
//             SectionLabel chips elsewhere in the app
//   - p     → 14.5px body, 1.65 leading, 12px bottom margin
//   - lists → tight, indented, custom marker color
//   - blockquote → accent-tinted background with a left rule, used
//                  for "callouts" the agent wants to highlight
//   - hr    → subtle divider for major breaks
//   - code  → mono with warm bg
//
// No raw HTML allowed (react-markdown default). No remote images.

import ReactMarkdown from "react-markdown";

interface BriefMarkdownProps {
  body: string;
}

export function BriefMarkdown({ body }: BriefMarkdownProps) {
  return (
    <div className="text-[14.5px] leading-[1.65] text-[var(--color-ink-soft)]">
      <ReactMarkdown
        components={{
          // Primary section header. Used when the agent wants strong
          // visual breaks between Schedule / People / Conflicts /
          // Actions / Context style sections. Bottom border picks up
          // the accent tint subtly so it reads as a divider, not a
          // page heading.
          h1: ({ children }) => (
            <h2 className="text-[13px] font-semibold tracking-[0.05em] uppercase text-[var(--color-accent)] mt-5 mb-2 pb-1 border-b border-[var(--color-rule-soft)] first:mt-0">
              {children}
            </h2>
          ),
          h2: ({ children }) => (
            <h2 className="text-[13px] font-semibold tracking-[0.05em] uppercase text-[var(--color-accent)] mt-5 mb-2 pb-1 border-b border-[var(--color-rule-soft)] first:mt-0">
              {children}
            </h2>
          ),
          // Sub-section header. Smaller, muted color, no border.
          h3: ({ children }) => (
            <h3 className="text-[11.5px] font-semibold tracking-[0.06em] uppercase text-[var(--color-muted)] mt-4 mb-1 first:mt-0">
              {children}
            </h3>
          ),
          h4: ({ children }) => (
            <h4 className="text-[12px] font-semibold text-[var(--color-ink)] mt-3 mb-1 first:mt-0">
              {children}
            </h4>
          ),
          // Body paragraph. Slightly larger leading than default
          // markdown for a calmer read.
          p: ({ children }) => (
            <p className="m-0 mb-3 last:mb-0 leading-[1.65]">{children}</p>
          ),
          // Inline emphasis. Strong shifts color to ink (the darker
          // body color) so it pops without being heavy. Em stays
          // italic + ink-soft.
          strong: ({ children }) => (
            <strong className="font-semibold text-[var(--color-ink)]">
              {children}
            </strong>
          ),
          em: ({ children }) => (
            <em className="italic text-[var(--color-ink-soft)]">{children}</em>
          ),
          // Lists with proper indent, accent marker color, comfortable
          // line height for multi-line items.
          ul: ({ children }) => (
            <ul className="m-0 mb-3 last:mb-0 pl-5 space-y-1.5 list-none">
              {children}
            </ul>
          ),
          ol: ({ children }) => (
            <ol className="m-0 mb-3 last:mb-0 pl-6 space-y-1.5 list-decimal marker:text-[var(--color-muted)] marker:font-mono marker:text-[12px]">
              {children}
            </ol>
          ),
          li: ({ children, ...props }) => {
            // For ul items: render a custom bullet so we can color it.
            // Detect via parent type would be ideal but react-markdown
            // doesn't expose it; we apply a relative position and a
            // ::before bullet via a sibling span.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const isOrdered = (props as any).ordered;
            if (isOrdered) {
              return <li className="leading-[1.6] pl-1">{children}</li>;
            }
            return (
              <li className="leading-[1.6] relative pl-2 before:content-['•'] before:absolute before:-left-3 before:text-[var(--color-accent)] before:font-bold">
                {children}
              </li>
            );
          },
          // Inline code with monospace, warm bg, tight padding.
          code: ({ children }) => (
            <code className="font-mono text-[12.5px] bg-[var(--color-paper-warm)] text-[var(--color-ink)] px-1.5 py-[1px] rounded">
              {children}
            </code>
          ),
          // Fenced code block. Subtle background, full-width.
          pre: ({ children }) => (
            <pre className="m-0 mb-3 last:mb-0 p-3 bg-[var(--color-paper-warm)] rounded-md overflow-x-auto text-[12.5px] leading-[1.5] font-mono">
              {children}
            </pre>
          ),
          // Accent-styled link.
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[var(--color-accent)] hover:underline font-medium"
            >
              {children}
            </a>
          ),
          // Soft horizontal rule for major breaks.
          hr: () => (
            <hr className="border-0 border-t border-[var(--color-rule-soft)] my-4" />
          ),
          // Blockquote as a soft callout. Useful for "key takeaway"
          // or quoted thread excerpts. Left accent rule, tinted bg,
          // muted italic body.
          blockquote: ({ children }) => (
            <blockquote className="border-l-[3px] border-[var(--color-accent)] bg-[var(--color-paper-warm)] pl-3 pr-3 py-2 my-3 rounded-r-md text-[var(--color-ink-soft)] italic">
              {children}
            </blockquote>
          ),
          // Tables — clean, readable. Useful for attendee lists or
          // time-slotted schedules.
          table: ({ children }) => (
            <div className="my-3 overflow-x-auto">
              <table className="w-full border-collapse text-[13.5px]">
                {children}
              </table>
            </div>
          ),
          thead: ({ children }) => (
            <thead className="border-b border-[var(--color-rule)]">{children}</thead>
          ),
          tr: ({ children }) => (
            <tr className="border-b border-[var(--color-rule-soft)] last:border-b-0">
              {children}
            </tr>
          ),
          th: ({ children }) => (
            <th className="text-left font-semibold py-2 pr-3 text-[var(--color-muted)] text-[11px] uppercase tracking-[0.05em]">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="py-2 pr-3 align-top text-[var(--color-ink-soft)]">
              {children}
            </td>
          ),
        }}
      >
        {body}
      </ReactMarkdown>
    </div>
  );
}
