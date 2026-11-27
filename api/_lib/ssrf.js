import net from 'node:net';
import dns from 'node:dns/promises';

/**
 * Checks whether an IP address belongs to private, loopback, link-local,
 * multicast, carrier-grade NAT, or reserved address spaces.
 */
export function isPrivateOrReservedIp(ip) {
  if (typeof ip !== 'string') return true;
  let cleanIp = ip.trim();
  if (cleanIp.startsWith('::ffff:')) {
    cleanIp = cleanIp.slice(7);
  }
  const ipType = net.isIP(cleanIp);
  if (ipType === 4) {
    const parts = cleanIp.split('.').map(Number);
    if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) return true;
    const [a, b, c] = parts;
    if (a === 0) return true; // Current network (0.0.0.0/8)
    if (a === 10) return true; // Private network (10.0.0.0/8)
    if (a === 127) return true; // Loopback (127.0.0.0/8)
    if (a === 100 && b >= 64 && b <= 127) return true; // Carrier-grade NAT (100.64.0.0/10)
    if (a === 169 && b === 254) return true; // Link-local / Cloud metadata (169.254.0.0/16)
    if (a === 172 && b >= 16 && b <= 31) return true; // Private network (172.16.0.0/12)
    if (a === 192 && b === 168) return true; // Private network (192.168.0.0/16)
    if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // IETF protocol & TEST-NET-1
    if (a === 198 && (b === 18 || b === 19)) return true; // Benchmarking (198.18.0.0/15)
    if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
    if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
    if (a >= 224) return true; // Multicast (224.0.0.0/4) and reserved (240.0.0.0/4)
    return false;
  }
  if (ipType === 6) {
    const lower = cleanIp.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return true; // Link-local
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // Unique local (fc00::/7)
    if (lower.startsWith('ff')) return true; // Multicast
    return false;
  }
  return true;
}

/**
 * Validates that a URL is strictly http: or https:, does not target private or local domains,
 * and does not resolve to private or reserved IP ranges.
 */
export async function validatePublicUrl(urlString) {
  let parsed;
  try {
    parsed = new URL(urlString);
  } catch {
    throw new Error('Invalid URL format.');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Prohibited protocol: only http: and https: URLs are permitted.');
  }

  // Credentials in the URL are never meaningful for an article and would be forwarded to whatever
  // host the name resolves to.
  if (parsed.username || parsed.password) {
    throw new Error('Prohibited URL: credentials in the address are not allowed.');
  }

  const hostname = parsed.hostname.toLowerCase();
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname.endsWith('.lan') ||
    hostname.endsWith('.home.arpa')
  ) {
    throw new Error('Prohibited hostname: local and internal domain names are forbidden.');
  }

  // If the hostname is a raw IP address
  if (net.isIP(hostname)) {
    if (isPrivateOrReservedIp(hostname)) {
      throw new Error('Prohibited address: private and reserved IP addresses are forbidden.');
    }
    return parsed;
  }

  // Resolve hostname through DNS to verify destination IP is public
  try {
    const lookupResult = await dns.lookup(hostname, { all: true });
    if (!lookupResult || lookupResult.length === 0) {
      throw new Error(`DNS resolution returned no addresses for ${hostname}`);
    }
    for (const entry of lookupResult) {
      if (isPrivateOrReservedIp(entry.address)) {
        throw new Error('Prohibited address: domain resolves to a private or reserved network address.');
      }
    }
  } catch (err) {
    if (err.message.includes('Prohibited')) throw err;
    throw new Error(`DNS resolution failed for ${hostname}: ${err.message}`);
  }

  return parsed;
}
