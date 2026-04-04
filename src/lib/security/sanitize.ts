import sanitizeHtml from "sanitize-html";

export function sanitizeClaimText(input: string) {
  const cleaned = sanitizeHtml(input, {
    allowedTags: [],
    allowedAttributes: {}
  })
    .replace(/\s+/g, " ")
    .trim();

  return cleaned.slice(0, 1000);
}

export function sanitizeSnippet(input: string, maxLength = 300) {
  const cleaned = sanitizeHtml(input, {
    allowedTags: [],
    allowedAttributes: {}
  })
    .replace(/\s+/g, " ")
    .trim();

  return cleaned.slice(0, maxLength);
}

export function sanitizeChatBody(input: string, maxLength = 2000) {
  const cleaned = sanitizeHtml(input, {
    allowedTags: [],
    allowedAttributes: {}
  })
    .replace(/\s+/g, " ")
    .trim();

  return cleaned.slice(0, maxLength);
}
