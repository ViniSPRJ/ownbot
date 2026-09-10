import type { Page } from "playwright";

/**
 * The page's own publication instant, taken from its markup rather than from its prose.
 *
 * A reader sees `07/09/2026 09h00`, and the readable text is `innerText`, so that is all the server
 * ever gets to certify a date with — which is why real articles came back "data não verificada".
 * The publisher also emits a machine-readable one, and that value is not model-supplied: it is in the
 * document this browser fetched on this run, and it is zoned. Schema.org first, then OpenGraph, then
 * JSON-LD. `dateModified` is never a publication date, so it is not consulted.
 *
 * Ambiguity answers `null`. Two candidate timestamps is a page that has not told us when it was
 * published, not a coin to flip, and a wrong date on a briefing costs more than a missing one.
 */
export async function pagePublicationTime(
  target: Page,
): Promise<string | null> {
  return target.evaluate(() => {
    const ZONED =
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;
    const clean = (value: string | null): string | null => {
      const trimmed = value?.trim() ?? "";
      return ZONED.test(trimmed) && Number.isFinite(Date.parse(trimmed))
        ? trimmed
        : null;
    };
    /** One agreed value, or none. A set of two is silence, not a choice. */
    const agreed = (values: Set<string>): string | null =>
      values.size === 1 ? (values.values().next().value ?? null) : null;
    const fromMarkup = (selector: string, attribute: string) => {
      const found = new Set<string>();
      for (const node of document.querySelectorAll(selector)) {
        const value = clean(node.getAttribute(attribute));
        if (value) found.add(value);
      }
      return agreed(found);
    };
    const markup =
      fromMarkup("meta[itemprop='datePublished']", "content") ??
      fromMarkup("time[itemprop='datePublished']", "datetime") ??
      fromMarkup("meta[property='article:published_time']", "content") ??
      fromMarkup("meta[name='publication_date']", "content");
    if (markup) return markup;

    const fromJsonLd = new Set<string>();
    for (const block of document.querySelectorAll(
      "script[type='application/ld+json']",
    )) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(block.textContent ?? "");
      } catch {
        continue; // Malformed JSON-LD is common and says nothing about the date.
      }
      const queue: unknown[] = [parsed];
      while (queue.length > 0) {
        const node = queue.shift();
        if (Array.isArray(node)) {
          queue.push(...node);
          continue;
        }
        if (!node || typeof node !== "object") continue;
        for (const [key, value] of Object.entries(node)) {
          if (key !== "datePublished") {
            if (value && typeof value === "object") queue.push(value);
            continue;
          }
          for (const candidate of Array.isArray(value) ? value : [value]) {
            const stamp = clean(
              typeof candidate === "string" ? candidate : null,
            );
            if (stamp) fromJsonLd.add(stamp);
          }
        }
      }
    }
    return agreed(fromJsonLd);
  });
}

/**
 * The same answer, but never at the cost of the page text.
 *
 * Reading the date runs script in the page, and that can fail for reasons that have nothing to do
 * with the date: the document navigated while the extract was being taken, the frame detached, the
 * target is a PDF viewer. `/read` and `/navigate` had already produced the text the Bot asked for by
 * the time this runs, and letting a failure here turn that into a 502 loses the answer and leaves
 * the transcript saying the read failed when it did not.
 *
 * `null` is the value the schema already defines for a page that did not declare a publication time
 * unambiguously, and it is the honest answer here too: this run did not obtain one. It certifies
 * nothing either way, so the editorial guard still falls back to the text scan.
 */
export async function publicationTimeOrNull(
  target: Page,
): Promise<string | null> {
  try {
    return await pagePublicationTime(target);
  } catch {
    return null;
  }
}
