// Shared copy and helpers for the English agent-facing pages (/market, /records).

export const MARKET_LABELS = {
  brand: 'BF Market',
  brandHome: 'BF Market home',
  primaryNavigation: 'Primary navigation',
  footerNavigation: 'Footer navigation',
  homeHref: '/market',
  ctaHref: '/market#services',
  getStarted: 'Browse services',
};

export const MARKET_NAV = [
  { itemKey: 'market', text: 'Services', to: '/market' },
  { itemKey: 'records', text: 'Records', to: '/records' },
  { itemKey: 'skill', text: 'Instructions', to: '/skill.md' },
];

// Mirrors src/skill.ts agentPrompt(); keep both copies identical.
export function agentPrompt(origin) {
  return `Read ${String(origin).replace(/\/+$/, '')}/skill.md and use BF Market to find and pay for a service with x402, then read the result.`;
}

export function mcpConfig(origin) {
  return JSON.stringify(
    {
      mcpServers: {
        'bf-market': { type: 'http', url: `${String(origin).replace(/\/+$/, '')}/mcp` },
      },
    },
    null,
    2,
  );
}

export function formatUsdt(value) {
  if (value === undefined || value === null || String(value).trim() === '') return '0';
  try {
    const base = 1000000n;
    const n = BigInt(String(value));
    const whole = n / base;
    const frac = (n % base).toString().padStart(6, '0').replace(/0+$/, '');
    return frac ? `${whole.toLocaleString('en-US')}.${frac}` : `${whole.toLocaleString('en-US')}.00`;
  } catch {
    return '0';
  }
}

export function shortAddress(value) {
  const s = String(value || '');
  return s.length > 18 ? `${s.slice(0, 8)}…${s.slice(-6)}` : s;
}

export function explorerAddress(base, address) {
  const root = String(base || '').replace(/\/+$/, '');
  if (!root || !address) return null;
  return `${root}/address/${address}`;
}

export function serviceIdFromResource(resource) {
  const match = /\/api\/services\/([^/]+)\/call$/.exec(String(resource || ''));
  return match ? decodeURIComponent(match[1]) : String(resource || '');
}

export const RECEIPT_STATUS = {
  required: 'Awaiting payment',
  verified: 'Verified',
  settling: 'Settling',
  settled: 'Settled',
  delivered: 'Delivered',
  failed: 'Failed',
};

export function receiptStatusLabel(status) {
  return RECEIPT_STATUS[status] ?? 'Unknown';
}

export function formatTime(value) {
  const d = new Date(Number(value));
  if (Number.isNaN(d.getTime())) return 'Time unavailable';
  return d.toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}
