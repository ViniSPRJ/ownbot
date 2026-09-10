import { z } from "zod";
import type { GrantedTool } from "../plugins/tools";

const evidenceInput = z.object({
  url: z.string().url(), title: z.string().min(5).max(300),
  kind: z.enum(["news", "opinion"]), author: z.string().min(2).max(160),
  excerpt: z.string().min(120).max(2000),
  useAs: z.enum(["current", "context"]),
});
const normal = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
function canonical(value: string) {
  try { const url = new URL(value); url.hash = ""; return url.toString(); } catch { return ""; }
}
type Source = { url: string; title: string; text: string; publishedAt: number | null };
type Evidence = z.infer<typeof evidenceInput> & { publishedAt: number | null; freshness: "current" | "old" | "unverified" };
export class NewsEditorialError extends Error {
  constructor(readonly draft: string, readonly resultMessageId: string | undefined, issues: string[]) {
    super(`editorial_coverage_incomplete: ${issues.join("; ")}`);
    this.name = "NewsEditorialError";
  }
}

/** No model-supplied date is trusted. Only an explicitly labelled, zoned ISO publication date
 * in the returned body is machine-certifiable here. Human/relative dates remain unverified. */
function publicationTime(text: string): number | null {
  const dates = [...text.matchAll(/^[ \t]*(?:Published|Published at|Publicado em|Data de publicação|datePublished)[ \t]*:[ \t]*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2}))[ \t\r]*$/gim)]
    .map(m => Date.parse(m[1]!)).filter(Number.isFinite);
  return dates.length === 1 ? dates[0]! : null;
}

const ZONED_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;
/** A timestamp the browser read out of the page's own markup, carried as a structured field.
 *
 * The text scan above cannot certify almost any real article: `computer_read` returns live
 * `innerText`, so `<time itemprop="datePublished" datetime="...">` never reaches it, and what a
 * reader sees instead is `07/09/2026 09h00` — which no honest certifier should accept. The
 * publisher's own zoned metadata is a different kind of claim: it came from the served document on
 * this run, not from the model, and it is a complete zoned instant. Same trust rule, new channel.
 * Unzoned, human, malformed or absent stays unverified exactly as before. */
function structuredPublicationTime(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!ZONED_ISO.test(trimmed)) return null;
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

export function createNewsEvidence(now = Date.now()) {
  const sources = new Map<string, Source>();
  const evidence = new Map<string, Evidence>();
  function capture(tool: string, answer: string) {
    if (tool !== "computer_navigate" && tool !== "computer_read") return;
    try {
      const value = JSON.parse(answer);
      if (value?.ok !== true || typeof value.url !== "string" || typeof value.text !== "string" || value.text.length < 120) return;
      if (/security verification|subscribe to (?:read|continue)|assine para continuar lendo|acesso exclusivo para assinantes/i.test(value.text)) return;
      const url = canonical(value.url); if (!url) return;
      sources.set(url, { url, title: typeof value.title === "string" ? value.title : "", text: value.text.slice(0, 100_000), publishedAt: structuredPublicationTime(value.publishedAt) ?? publicationTime(value.text) });
    } catch { /* Refusals, stale refs and unreadable responses are not article evidence. */ }
  }
  function assess(cited?: Set<string>): string[] {
    const entries = [...evidence.values()]; const issues: string[] = [];
    const covered = cited ? entries.filter(item => cited.has(item.url)) : entries;
    if (!covered.some(e => e.kind === "opinion" && new URL(e.url).hostname === "valor.globo.com")) issues.push("coluna de opinião do Valor sem trecho e autoria verificados");
    // FT reporting only: the subscription does not cover FT columnists, so an opinion column there
    // is a paywall shell, never evidence. Any verified FT article satisfies the FT requirement.
    if (!covered.some(e => /(^|\.)ft\.com$/.test(new URL(e.url).hostname))) issues.push("matéria do FT sem trecho e autoria verificados");
    for (const item of entries) if (item.useAs === "current" && item.freshness !== "current") issues.push(`${item.url}: ${item.freshness === "old" ? "fonte com mais de 24h usada como atual" : "data de publicação não verificada para uso como atual"}`);
    return issues;
  }
  const tool: GrantedTool = {
    name: "news_record_evidence", ref: "routine/news_record_evidence",
    description: "Register each source before writing this News briefing. Requires its actual returned article URL, title, author and a literal 120+ character excerpt from computer_read/navigate (not a homepage or snapshot link). The server verifies the excerpt and labels publication time; never invent dates. Human/relative dates are unverified and may only be context. Valor opinion requires an actual /opiniao/coluna/ article. FT counts as news reporting only: FT opinion columns are outside the subscription, do not open them. This is a local record, not a web request.",
    parameters: evidenceInput,
    async execute(args) {
      const parsed = evidenceInput.safeParse(args);
      if (!parsed.success) return "Refused. Provide url, title, kind, author, literal excerpt and useAs (current/context).";
      const input = parsed.data, url = canonical(input.url), source = sources.get(url);
      if (!source || normal(input.excerpt).length < 120 || !normal(source.text).includes(normal(input.excerpt)) || !normal(source.text).includes(normal(input.author)) || !normal(`${source.title}\n${source.text}`).includes(normal(input.title)))
        return "Refused. The article body, literal excerpt, title or author was not verified in this run's browser responses. A click/homepage link is not a read article.";
      const parsedUrl = new URL(url);
      // FT section pages can contain titles, bylines and snippets but are not read articles.
      if (/(^|\.)ft\.com$/.test(parsedUrl.hostname) && !/^\/content\/[^/]+\/?$/.test(parsedUrl.pathname))
        return "Refused. This FT URL is not an article. Open and read the actual /content/ article.";
      if (input.kind === "opinion" && parsedUrl.hostname === "valor.globo.com" && !/^\/opiniao\/coluna\/[^/]+/.test(parsedUrl.pathname))
        return "Refused. This Valor URL is not an opinion column. Open and read the actual /opiniao/coluna/ article before claiming opinion coverage.";
      if (input.kind === "opinion" && /(^|\.)ft\.com$/.test(parsedUrl.hostname) && (!parsedUrl.pathname.startsWith("/content/") || !/\bopinion\b/i.test(source.text)))
        return "Refused. An FT opinion article body was not verified.";
      const freshness = source.publishedAt === null || source.publishedAt > now ? "unverified" : now - source.publishedAt > 24 * 60 * 60 * 1000 ? "old" : "current";
      evidence.set(url, {...input, url, publishedAt: source.publishedAt, freshness});
      return JSON.stringify({registered:true,url,freshness,permittedUse:freshness === "current" ? "current or context" : "context only; never describe as news verified within 24h",coverageIssues:assess()});
    },
  };
  return {
    capture, tool,
    finalise(report: string, resultMessageId?: string): string {
      // Trailing prose/markdown punctuation is not part of the address. Without this a backtick or
      // an asterisk around a link survives into `canonical`, which percent-encodes it (`…%60`), so a
      // URL the Bot really did read and register reads as an invented citation.
      const citations = [...report.matchAll(/https?:\/\/[^\s<>"\])]+/g)].map(m => canonical(m[0].replace(/[.,;:!?'"`*[\]()<>]+$/, "")));
      const issues = assess(new Set(citations));
      for (const url of new Set(citations)) if (!evidence.has(url)) issues.push(`${url}: citação sem registro de evidência nesta execução`);
      if (citations.length === 0) issues.push("relatório sem citações registradas");
      const entries = [...evidence.values()];
      const table = entries.map(e => `- ${e.kind === "opinion" ? "Opinião" : "Notícia"}: ${e.title} — ${e.author}; ${e.url}; ${e.publishedAt === null ? "data de publicação não verificada" : new Date(e.publishedAt).toISOString()}; ${e.freshness === "current" ? "publicação na janela de 24h" : e.freshness === "old" ? "CONTEXTO ANTIGO: fora de 24h" : "DATA NÃO VERIFICADA: somente contexto"}.`).join("\n");
      const qualification = entries.some(e => e.freshness !== "current") ? "\nFontes com DATA NÃO VERIFICADA ou CONTEXTO ANTIGO não são notícias confirmadas nas últimas 24 horas, independentemente da redação do rascunho.\n" : "";
      const labelled = `${issues.length ? "# Briefing incompleto — validação editorial pendente" : "# Briefing — registro de evidências"}\n\n${qualification}${issues.length ? issues.map(issue => `- ${issue}`).join("\n") + "\n\n" : ""}${table}\n\n---\n\n${issues.length ? "Rascunho preservado, sem aprovação editorial:\n\n" : ""}${report}`;
      if (issues.length) throw new NewsEditorialError(labelled, resultMessageId, issues);
      return labelled;
    },
  };
}
