import { expect, test } from "bun:test";
import type { Page } from "playwright";
import {
  pagePublicationTime,
  publicationTimeOrNull,
} from "../src/publication-time";

/**
 * The date is read by script running in the page, so the test runs the very function that is sent
 * there, against a document stub. What it must never do is cost the caller the page text: `/read`
 * and `/navigate` have already produced the answer the Bot asked for by the time this runs.
 */
type Element = {
  getAttribute: (name: string) => string | null;
  textContent: string | null;
};

const element = (
  attributes: Record<string, string>,
  textContent: string | null = null,
): Element => ({
  getAttribute: (name) => attributes[name] ?? null,
  textContent,
});

/** A page that answers only the selectors the extractor asks for. */
const pageOf = (nodes: Record<string, Element[]>): Page =>
  ({
    evaluate: async (fn: () => string | null) => {
      // Restored by presence, not by value: this process may also be running app tests against a
      // real DOM, and putting `undefined` back where there had been no property at all would take
      // their `document` away. A stub that borrows a global has to give back the same absence.
      const global = globalThis as Record<string, unknown>;
      const had = "document" in global;
      const previous = global.document;
      global.document = {
        querySelectorAll: (selector: string) => nodes[selector] ?? [],
      };
      try {
        return fn();
      } finally {
        if (had) global.document = previous;
        else delete global.document;
      }
    },
  }) as unknown as Page;

const failing = (): Page =>
  ({
    evaluate: async () => {
      throw new Error(
        "Execution context was destroyed, most likely because of a navigation.",
      );
    },
  }) as unknown as Page;

test("a page that failed to answer costs the read its date, never its text", async () => {
  await expect(pagePublicationTime(failing())).rejects.toThrow();
  // The same failure, seen by the endpoint: absent, which is what the schema already means by null.
  expect(await publicationTimeOrNull(failing())).toBeNull();
});

test("a zoned instant the publisher declared is carried through", async () => {
  expect(
    await publicationTimeOrNull(
      pageOf({
        "meta[itemprop='datePublished']": [
          element({ content: "2026-09-07T09:00:00-03:00" }),
        ],
      }),
    ),
  ).toBe("2026-09-07T09:00:00-03:00");
  expect(
    await publicationTimeOrNull(
      pageOf({
        "script[type='application/ld+json']": [
          element(
            {},
            JSON.stringify({
              "@graph": [
                {
                  "@type": "NewsArticle",
                  datePublished: "2026-09-07T12:00:00Z",
                  dateModified: "2026-09-08T12:00:00Z",
                },
              ],
            }),
          ),
        ],
      }),
    ),
  ).toBe("2026-09-07T12:00:00Z");
});

test("what the page did not say unambiguously stays unsaid", async () => {
  const cases: Record<string, Element[]>[] = [
    {},
    // Two candidates is silence, not a coin to flip.
    {
      "meta[itemprop='datePublished']": [
        element({ content: "2026-09-07T09:00:00-03:00" }),
        element({ content: "2026-09-06T09:00:00-03:00" }),
      ],
    },
    // Human and unzoned forms certify nothing.
    {
      "meta[property='article:published_time']": [
        element({ content: "07/09/2026 09h00" }),
      ],
    },
    {
      "meta[property='article:published_time']": [
        element({ content: "2026-09-07T09:00:00" }),
      ],
    },
    // A modification date is not a publication date.
    {
      "script[type='application/ld+json']": [
        element({}, JSON.stringify({ dateModified: "2026-09-08T12:00:00Z" })),
      ],
    },
    // Malformed JSON-LD is common and says nothing either way.
    { "script[type='application/ld+json']": [element({}, "{not json")] },
  ];
  for (const nodes of cases) {
    expect(await publicationTimeOrNull(pageOf(nodes))).toBeNull();
  }
});
