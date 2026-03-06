// IP Rate Limiting System with VPN/Internal Subnet Detection
// Targets Carrier Grade NAT (CGNAT) 100.64.0.0/10 and other VPN/internal ranges

/**
 * CIDR Block Configuration
 * Allows configuration via environment variables with defaults for common VPN/internal subnets
 */
function getBlockedSubnets(): string[] {
  const envSubnets = process.env.RATELIMIT_SUBNETS;
  if (envSubnets) {
    return envSubnets.split(",").map((s) => s.trim());
  }
  // Default: CGNAT range (RFC 6598) - 100.64.0.0/10
  // Common VPN internal ranges
  return [
    "100.64.0.0/10", // CGNAT (RFC 6598)
    "10.0.0.0/8", // RFC 1918 private
    "172.16.0.0/12", // RFC 1918 private
    "192.168.0.0/16", // RFC 1918 private
    "fc00::/7", // IPv6 unique local
  ];
}

/**
 * Parse CIDR notation into network address and prefix length
 */
function parseCidr(cidr: string): { network: bigint; mask: bigint; isV6: boolean } | null {
  const [ipStr, prefixStr] = cidr.split("/");
  if (!ipStr || !prefixStr) return null;

  const prefix = parseInt(prefixStr, 10);
  if (!Number.isFinite(prefix) || prefix < 0) return null;

  // IPv6
  if (ipStr.includes(":")) {
    if (prefix > 128) return null;
    const ip = parseIPv6(ipStr);
    if (ip === null) return null;
    const mask = prefix === 0 ? 0n : (~0n << (128n - BigInt(prefix))) & ((1n << 128n) - 1n);
    return { network: ip & mask, mask, isV6: true };
  }

  // IPv4
  if (prefix > 32) return null;
  const ip = parseIPv4(ipStr);
  if (ip === null) return null;
  const mask = prefix === 0 ? 0n : (~0n << (32n - BigInt(prefix))) & 0xffffffffn;
  return { network: ip & mask, mask, isV6: false };
}

/**
 * Parse IPv4 address string to bigint
 */
function parseIPv4(ip: string): bigint | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;

  let result = 0n;
  for (const part of parts) {
    const num = parseInt(part, 10);
    if (!Number.isFinite(num) || num < 0 || num > 255) return null;
    result = (result << 8n) | BigInt(num);
  }
  return result;
}

/**
 * Parse IPv6 address string to bigint
 */
function parseIPv6(ip: string): bigint | null {
  // Handle :: abbreviation
  const parts = ip.split(":");
  const emptyIndex = parts.findIndex((p) => p === "");

  // Expand :: to full 8 groups
  const expanded: string[] = [];
  if (emptyIndex !== -1 && parts.length < 8) {
    const missing = 8 - parts.length + 1;
    for (let i = 0; i < parts.length; i++) {
      if (parts[i] === "" && i === emptyIndex) {
        for (let j = 0; j < missing; j++) {
          expanded.push("0");
        }
      } else if (parts[i] !== "") {
        expanded.push(parts[i]);
      }
    }
  } else {
    expanded.push(...parts.filter((p) => p !== ""));
  }

  if (expanded.length !== 8) return null;

  let result = 0n;
  for (const part of expanded) {
    const num = parseInt(part, 16);
    if (!Number.isFinite(num) || num < 0 || num > 0xffff) return null;
    result = (result << 16n) | BigInt(num);
  }
  return result;
}

/**
 * Check if an IP address is within a CIDR block
 */
function ipInCidr(ip: string, cidr: string): boolean {
  const cidrInfo = parseCidr(cidr);
  if (!cidrInfo) return false;

  const { network, mask, isV6 } = cidrInfo;

  // Parse the IP to check
  const ipNum = isV6 ? parseIPv6(ip) : parseIPv4(ip);
  if (ipNum === null) return false;

  return (ipNum & mask) === network;
}

/**
 * Check if an IP is in any of the blocked subnets
 */
export function isVpnOrInternalIp(ip: string): boolean {
  // Skip invalid IPs
  if (!ip || ip === "unknown" || ip === "127.0.0.1" || ip === "::1") {
    return false;
  }

  const subnets = getBlockedSubnets();
  for (const subnet of subnets) {
    try {
      if (ipInCidr(ip, subnet)) {
        return true;
      }
    } catch {
      // Invalid subnet format, skip
    }
  }
  return false;
}

/**
 * Rate Limiter Configuration for VPN/Internal IPs
 */
export interface VpnRateLimitConfig {
  // Much stricter limits for VPN/internal IPs
  vpnWindowMs: number;
  vpnMaxRequests: number;
  // Standard limits for regular IPs (passed through to existing rate limiter)
  standardWindowMs: number;
  standardMaxRequests: number;
}

export function getVpnRateLimitConfig(): VpnRateLimitConfig {
  return {
    vpnWindowMs: parsePositiveInt(process.env.VPN_RATELIMIT_WINDOW_MS, 60_000),
    vpnMaxRequests: parsePositiveInt(process.env.VPN_RATELIMIT_MAX_REQ, 5),
    standardWindowMs: 60_000,
    standardMaxRequests: 60,
  };
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Extended rate limiter that applies stricter limits to VPN/internal IPs
 */
export class VpnAwareRateLimiter {
  private windows = new Map<string, number[]>();
  private lastSweep = 0;
  private config: VpnRateLimitConfig;

  constructor(config?: Partial<VpnRateLimitConfig>) {
    this.config = { ...getVpnRateLimitConfig(), ...config };
  }

  /**
   * Check if a request should be rate limited
   * Returns true if the request should be blocked
   */
  isRateLimited(ip: string, isVpn: boolean): boolean {
    const now = Date.now();
    const key = isVpn ? `vpn:${ip}` : `std:${ip}`;
    const windowMs = isVpn ? this.config.vpnWindowMs : this.config.standardWindowMs;
    const maxRequests = isVpn ? this.config.vpnMaxRequests : this.config.standardMaxRequests;

    // Periodic cleanup of old entries
    if (now - this.lastSweep >= windowMs) {
      this.sweep(now, windowMs);
    }

    const existing = this.windows.get(key) ?? [];
    const recent = existing.filter((timestamp) => now - timestamp <= windowMs);

    if (recent.length >= maxRequests) {
      this.windows.set(key, recent);
      return true;
    }

    recent.push(now);
    this.windows.set(key, recent);
    return false;
  }

  /**
   * Get current request count for an IP
   */
  getRequestCount(ip: string, isVpn: boolean): number {
    const now = Date.now();
    const key = isVpn ? `vpn:${ip}` : `std:${ip}`;
    const windowMs = isVpn ? this.config.vpnWindowMs : this.config.standardWindowMs;

    const existing = this.windows.get(key) ?? [];
    return existing.filter((timestamp) => now - timestamp <= windowMs).length;
  }

  /**
   * Clean up old entries to prevent memory leaks
   */
  private sweep(now: number, windowMs: number): void {
    for (const [key, timestamps] of this.windows) {
      const recent = timestamps.filter((timestamp) => now - timestamp <= windowMs);
      if (recent.length === 0) {
        this.windows.delete(key);
      } else {
        this.windows.set(key, recent);
      }
    }
    this.lastSweep = now;
  }

  /**
   * Get stats for monitoring
   */
  getStats(): { totalEntries: number; vpnEntries: number; standardEntries: number } {
    let vpnEntries = 0;
    let standardEntries = 0;
    for (const key of this.windows.keys()) {
      if (key.startsWith("vpn:")) {
        vpnEntries++;
      } else {
        standardEntries++;
      }
    }
    return {
      totalEntries: this.windows.size,
      vpnEntries,
      standardEntries,
    };
  }

  /**
   * Clear all rate limit data
   */
  clear(): void {
    this.windows.clear();
    this.lastSweep = 0;
  }
}

/**
 * Middleware-style rate limit check that can be used in fetch handlers
 * Returns a Response if rate limited, null if allowed
 */
export function checkVpnRateLimit(
  ip: string,
  limiter: VpnAwareRateLimiter,
  log?: (level: string, component: string, message: string, meta?: Record<string, unknown>) => void,
): Response | null {
  const isVpn = isVpnOrInternalIp(ip);
  const isLimited = limiter.isRateLimited(ip, isVpn);

  if (isLimited) {
    const count = limiter.getRequestCount(ip, isVpn);
    if (log) {
      log("WARN", "ratelimit", `Rate limited ${isVpn ? "VPN/internal" : "regular"} IP`, {
        ip,
        isVpn,
        count,
      });
    }
    return new Response(
      JSON.stringify({
        error: "Too Many Requests",
        retryAfter: Math.ceil(getVpnRateLimitConfig().vpnWindowMs / 1000),
      }),
      {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": String(Math.ceil(getVpnRateLimitConfig().vpnWindowMs / 1000)),
          "Cache-Control": "no-store",
        },
      },
    );
  }

  return null;
}
