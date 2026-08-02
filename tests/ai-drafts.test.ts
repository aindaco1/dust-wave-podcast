import { describe, expect, it } from "vitest";

import {
  AI_DRAFT_MODEL,
  parseAiProviderJsonObject,
  safeAiDraftFailureCode
} from "../src/ai-drafts";

describe("Workers AI editorial draft contract", () => {
  it("classifies failures without retaining provider content", () => {
    expect(safeAiDraftFailureCode(
      new TypeError("AI draft named-entity grounding is invalid")
    )).toBe("grounding_named_entity_invalid");
    expect(safeAiDraftFailureCode(
      new TypeError("AI draft provider response is not valid JSON")
    )).toBe("provider_response_invalid_json");
    expect(safeAiDraftFailureCode(
      new Error("provider payload included private text")
    )).toBe("provider_error");
    expect(safeAiDraftFailureCode(
      new TypeError("AI draft show-notes attribution is invalid")
    )).toBe("show_notes_attribution_invalid");
    expect(safeAiDraftFailureCode(
      new TypeError("AI draft show-notes Markdown structure is invalid")
    )).toBe("show_notes_markdown_structure_invalid");
  });

  it("pins a model supported by Workers AI JSON mode", () => {
    expect(AI_DRAFT_MODEL).toBe(
      "@cf/meta/llama-3.1-8b-instruct-fast"
    );
  });

  it("accepts the documented structured response object", () => {
    const response = {
      summary: "Reviewed summary",
      showNotesMarkdown: "## Notes",
      keywords: ["film"]
    };

    expect(parseAiProviderJsonObject({ response })).toEqual(response);
  });

  it("retains bounded compatibility with legacy JSON-string responses", () => {
    expect(parseAiProviderJsonObject({
      response: JSON.stringify({ summary: "Reviewed summary" })
    })).toEqual({ summary: "Reviewed summary" });
  });

  it("rejects arrays and oversized structured responses", () => {
    expect(() => parseAiProviderJsonObject({ response: [] })).toThrow(
      /response is invalid/
    );
    expect(() => parseAiProviderJsonObject(
      { response: { summary: "x".repeat(101) } },
      100
    )).toThrow(/response is invalid/);
  });
});
