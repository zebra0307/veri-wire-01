const maliciousDomains = ["malware.test", "phishing.test", "evil.example"];
const paywalledDomains = ["wsj.com", "ft.com", "economist.com", "nytimes.com"];
const privateSocialDomains = ["facebook.com", "instagram.com", "x.com"];

export type BlockedRule =
  | "DOXXING_PATTERN"
  | "PAYWALLED_CONTENT"
  | "MEDICAL_OR_LEGAL_ADVICE"
  | "POLITICAL_PERSUASION"
  | "PRIVATE_SOCIAL_PROFILE";

export type BlockedResult = {
  blocked: true;
  rule: BlockedRule;
  explanation: string;
};

export type AllowedResult = {
  blocked: false;
};

export function block(rule: BlockedRule, explanation: string): BlockedResult {
  return {
    blocked: true,
    rule,
    explanation
  };
}

export function classifyPromptBlock(text: string): BlockedResult | AllowedResult {
  const lower = text.toLowerCase();

  const hasNameAndContact =
    /(name|person|individual).*(phone|address|contact|location)/i.test(text) ||
    /(phone|address|contact|location).*(name|person|individual)/i.test(text);

  if (hasNameAndContact) {
    return block("DOXXING_PATTERN", "Request combines personal identity with contact/location details.");
  }

  if (/(diagnose|diagnosis|prescription|treatment plan|legal advice|lawyer)/i.test(lower)) {
    return block("MEDICAL_OR_LEGAL_ADVICE", "Request attempts medical diagnosis or legal guidance.");
  }

  return { blocked: false };
}

export function classifyOutputBlock(text: string): BlockedResult | AllowedResult {
  if (/(vote for|support this party|oppose this candidate|campaign)/i.test(text.toLowerCase())) {
    return block("POLITICAL_PERSUASION", "Output includes political persuasion framing.");
  }

  return { blocked: false };
}

export function validateSourceUrl(url: string): BlockedResult | AllowedResult {
  let hostname = "";

  try {
    const parsed = new URL(url);
    hostname = parsed.hostname.toLowerCase();

    if (!["http:", "https:"].includes(parsed.protocol)) {
      return block("PRIVATE_SOCIAL_PROFILE", "Only public http/https sources are allowed.");
    }
  } catch {
    return block("PRIVATE_SOCIAL_PROFILE", "Invalid source URL format.");
  }

  if (maliciousDomains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`))) {
    return block("PRIVATE_SOCIAL_PROFILE", "Source domain is blocked for safety.");
  }

  if (paywalledDomains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`))) {
    return block("PAYWALLED_CONTENT", "Paywalled sources are not allowed in agent processing.");
  }

  if (privateSocialDomains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`))) {
    return block("PRIVATE_SOCIAL_PROFILE", "Private social profiles are outside allowed research scope.");
  }

  return { blocked: false };
}
