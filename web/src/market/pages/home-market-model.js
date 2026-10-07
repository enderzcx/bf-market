export function extractAgentPrompt(markdown) {
  const match = String(markdown).match(/> ```\s*\r?\n> ([^\r\n]+)\r?\n> ```/);
  return match?.[1] ?? null;
}

export function formatAtomicUsdt(amount) {
  try {
    const value = BigInt(amount);
    const negative = value < 0n;
    const absolute = negative ? -value : value;
    const whole = absolute / 1_000_000n;
    const fraction = (absolute % 1_000_000n).toString().padStart(6, '0');
    return `${negative ? '-' : ''}${whole}.${fraction}`;
  } catch {
    return null;
  }
}

export function getServicePrice(service) {
  if (service?.pricing === 'exact' && service.price != null) return String(service.price);
  if (service?.pricing === 'metered' && service.quoteMax != null) {
    return String(service.quoteMax);
  }
  return null;
}

export function agentPromptForOrigin(origin) {
  return `Read ${String(origin).replace(/\/+$/, '')}/skill.md and use BF Market to find and pay for a service with x402, then read the result.`;
}
