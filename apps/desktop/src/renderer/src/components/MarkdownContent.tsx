import { Check, Copy } from "@phosphor-icons/react";
import { marked, type Token, type Tokens } from "marked";
import { createElement, Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { Key, ReactNode } from "react";
import { useTranslation } from "react-i18next";

export function MarkdownContent(props: {
  readonly source: string;
  readonly codeBlockControls?: boolean | undefined;
  readonly onInternalLink?: ((id: string) => void) | undefined;
}) {
  const tokens = useMemo(() => marked.lexer(props.source, { gfm: true }), [props.source]);
  return (
    <>{renderMarkdownTokens(tokens, props.codeBlockControls === true, props.onInternalLink)}</>
  );
}

function renderMarkdownTokens(
  tokens: readonly Token[],
  codeBlockControls: boolean,
  onInternalLink: ((id: string) => void) | undefined,
): ReactNode[] {
  return tokens.map((token, index) =>
    renderMarkdownToken(token, index, codeBlockControls, onInternalLink),
  );
}

function renderMarkdownToken(
  token: Token,
  key: Key,
  codeBlockControls: boolean,
  onInternalLink: ((id: string) => void) | undefined,
): ReactNode {
  switch (token.type) {
    case "heading": {
      const heading = token as Tokens.Heading;
      return createElement(
        `h${Math.min(6, Math.max(1, heading.depth))}`,
        { key },
        renderMarkdownTokens(heading.tokens, codeBlockControls, onInternalLink),
      );
    }
    case "paragraph": {
      const paragraph = token as Tokens.Paragraph;
      return (
        <p key={key}>{renderMarkdownTokens(paragraph.tokens, codeBlockControls, onInternalLink)}</p>
      );
    }
    case "text": {
      const text = token as Tokens.Text;
      return text.tokens ? (
        <Fragment key={key}>
          {renderMarkdownTokens(text.tokens, codeBlockControls, onInternalLink)}
        </Fragment>
      ) : (
        <Fragment key={key}>{text.text}</Fragment>
      );
    }
    case "escape":
      return <Fragment key={key}>{(token as Tokens.Escape).text}</Fragment>;
    case "strong": {
      const strong = token as Tokens.Strong;
      return (
        <strong key={key}>
          {renderMarkdownTokens(strong.tokens, codeBlockControls, onInternalLink)}
        </strong>
      );
    }
    case "em": {
      const emphasis = token as Tokens.Em;
      return (
        <em key={key}>
          {renderMarkdownTokens(emphasis.tokens, codeBlockControls, onInternalLink)}
        </em>
      );
    }
    case "del": {
      const deleted = token as Tokens.Del;
      return (
        <del key={key}>
          {renderMarkdownTokens(deleted.tokens, codeBlockControls, onInternalLink)}
        </del>
      );
    }
    case "codespan":
      return <code key={key}>{(token as Tokens.Codespan).text}</code>;
    case "code": {
      const code = token as Tokens.Code;
      const language = code.lang?.trim().split(/\s+/, 1)[0];
      if (codeBlockControls) {
        return <MarkdownCodeBlock code={code.text} key={key} language={language} />;
      }
      return (
        <pre key={key}>
          <code className={language ? `language-${language}` : undefined}>{code.text}</code>
        </pre>
      );
    }
    case "blockquote": {
      const quote = token as Tokens.Blockquote;
      return (
        <blockquote key={key}>
          {renderMarkdownTokens(quote.tokens, codeBlockControls, onInternalLink)}
        </blockquote>
      );
    }
    case "list": {
      const list = token as Tokens.List;
      const children = list.items.map((item, index) => (
        <li key={index}>
          {item.task ? <input type="checkbox" checked={item.checked === true} readOnly /> : null}
          {renderMarkdownTokens(item.tokens, codeBlockControls, onInternalLink)}
        </li>
      ));
      return createElement(
        list.ordered ? "ol" : "ul",
        { key, ...(list.ordered && list.start !== "" ? { start: list.start } : {}) },
        children,
      );
    }
    case "table": {
      const table = token as Tokens.Table;
      return (
        <table key={key}>
          <thead>
            <tr>
              {table.header.map((cell, index) => (
                <th key={index} style={{ textAlign: cell.align ?? undefined }}>
                  {renderMarkdownTokens(cell.tokens, codeBlockControls, onInternalLink)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {row.map((cell, cellIndex) => (
                  <td key={cellIndex} style={{ textAlign: cell.align ?? undefined }}>
                    {renderMarkdownTokens(cell.tokens, codeBlockControls, onInternalLink)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      );
    }
    case "link": {
      const link = token as Tokens.Link;
      const children = renderMarkdownTokens(link.tokens, codeBlockControls, onInternalLink);
      return isExternalLink(link.href) ? (
        <a key={key} href={link.href} target="_blank" rel="noreferrer">
          {children}
        </a>
      ) : onInternalLink === undefined ? (
        <span key={key}>{children}</span>
      ) : (
        <a
          key={key}
          href={link.href}
          onClick={(event) => {
            event.preventDefault();
            onInternalLink(link.href);
          }}
        >
          {children}
        </a>
      );
    }
    case "image":
      return (
        <span className="markdown-image-placeholder" key={key}>
          [Image: {(token as Tokens.Image).text}]
        </span>
      );
    case "br":
      return <br key={key} />;
    case "hr":
      return <hr key={key} />;
    case "checkbox":
      return (
        <input key={key} type="checkbox" checked={(token as Tokens.Checkbox).checked} readOnly />
      );
    case "space":
    case "def":
    case "html":
      return null;
    default:
      return "tokens" in token && Array.isArray(token.tokens) ? (
        <Fragment key={key}>
          {renderMarkdownTokens(token.tokens as Token[], codeBlockControls, onInternalLink)}
        </Fragment>
      ) : null;
  }
}

function MarkdownCodeBlock(props: {
  readonly code: string;
  readonly language?: string | undefined;
}) {
  const { t } = useTranslation("common");
  const [copied, setCopied] = useState(false);
  const resetTimerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
    },
    [],
  );

  const copyCode = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(props.code);
      setCopied(true);
      if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
      resetTimerRef.current = window.setTimeout(() => setCopied(false), 1_800);
    } catch {
      setCopied(false);
    }
  };

  const actionLabel = copied ? t("actions.copied") : t("actions.copy");
  return (
    <div className="markdown-code-block">
      <div className="markdown-code-toolbar">
        <span>{props.language ?? "text"}</span>
        <button
          type="button"
          aria-label={actionLabel}
          title={actionLabel}
          onClick={() => void copyCode()}
        >
          {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
          {actionLabel}
        </button>
      </div>
      <pre>
        <code className={props.language ? `language-${props.language}` : undefined}>
          {props.code}
        </code>
      </pre>
    </div>
  );
}

function isExternalLink(href: string): boolean {
  return href.startsWith("https://") || href.startsWith("http://");
}
