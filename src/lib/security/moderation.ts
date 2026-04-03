import Filter from "bad-words";

const filter = new Filter();

const piiPatterns = {
  email: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  phone: /\b(?:\+?91[-\s]?)?[6-9]\d{9}\b/,
  aadhaar: /\b[2-9]\d{3}\s?\d{4}\s?\d{4}\b/
};

export function detectPii(text: string) {
  const matched: string[] = [];

  if (piiPatterns.email.test(text)) matched.push("EMAIL");
  if (piiPatterns.phone.test(text)) matched.push("PHONE");
  if (piiPatterns.aadhaar.test(text)) matched.push("AADHAAR");

  return {
    containsPii: matched.length > 0,
    matched
  };
}

export function classifyToxicity(text: string) {
  try {
    const isToxic = filter.isProfane(text);
    return {
      isToxic,
      reason: isToxic ? "TOXICITY_DETECTED" : null
    };
  } catch {
    return {
      isToxic: false,
      reason: null
    };
  }
}
