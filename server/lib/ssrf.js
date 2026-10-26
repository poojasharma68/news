/**
 * SSRF protection. Every outbound request made on behalf of a user-supplied URL must pass
 * assertUrlAllowed() for the URL itself and for every redirect hop, and must connect through
 * guardedLookup() so DNS answers pointing at private infrastructure are refused at connect time
 * (which also defeats DNS rebinding between validation and connection).
 */
import dns from "node:dns";
import net from "node:net";
import { PipelineError } from "./errors.js";

const blockList = new net.BlockList();

const BLOCKED_V4 = [
  ["0.0.0.0", 8], // "this" network
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, cloud metadata (169.254.169.254)
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.88.99.0", 24], // 6to4 relay
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved + broadcast
];

const BLOCKED_V6 = [
  ["::", 128], // unspecified
  ["::1", 128], // loopback
  ["64:ff9b:1::", 48], // local-use NAT64
  ["100::", 64], // discard
  ["2001::", 32], // Teredo
  ["2001:10::", 28], // ORCHID
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["fec0::", 10], // site-local (deprecated)
  ["ff00::", 8], // multicast
];

for (const [address, prefix] of BLOCKED_V4)
  blockList.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of BLOCKED_V6)
  blockList.addSubnet(address, prefix, "ipv6");

const BLOCKED_HOST_SUFFIXES = [
  "localhost",
  "local",
  "internal",
  "intranet",
  "lan",
  "home",
  "corp",
  "home.arpa",
  "onion",
  "test",
  "invalid",
];

/**
 * IPv6 forms that embed an IPv4 address (IPv4-mapped ::ffff:a.b.c.d / ::ffff:hhhh:hhhh, NAT64
 * 64:ff9b::/96). They are not added to the BlockList because Node matches IPv4-mapped rules
 * against every IPv4 address; instead the embedded address is checked as IPv4.
 */
function embeddedIpv4(ip) {
  const lower = ip.toLowerCase();
  const prefix = /^(?:0{0,4}:){0,5}(?:::)?ffff:|^64:ff9b::/.exec(lower);
  if (!prefix) return null;
  const rest = lower.slice(prefix[0].length);
  if (net.isIPv4(rest)) return rest;
  const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(rest);
  if (!hex) return null;
  const high = parseInt(hex[1], 16);
  const low = parseInt(hex[2], 16);
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

export function isBlockedIp(ip) {
  const family = net.isIP(ip);
  if (family === 0) return true;
  if (family === 6) {
    const v4 = embeddedIpv4(ip);
    if (v4) return blockList.check(v4, "ipv4");
  }
  return blockList.check(ip, family === 4 ? "ipv4" : "ipv6");
}

function notAllowed(message) {
  return new PipelineError("URL_NOT_ALLOWED", message);
}

/** Validates scheme, credentials, port and host of a URL. Throws PipelineError when unsafe. */
export function assertUrlAllowed(input) {
  let url;
  try {
    url = new URL(input.toString());
  } catch {
    throw new PipelineError("INVALID_URL", "The URL could not be parsed.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw notAllowed("Only http and https URLs are allowed.");
  if (url.username || url.password)
    throw notAllowed("URLs containing credentials are not allowed.");
  if (url.port && url.port !== "80" && url.port !== "443")
    throw notAllowed("Only standard web ports (80 and 443) are allowed.");

  const host = url.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (!host) throw notAllowed("The URL has no host.");
  if (net.isIP(host)) {
    if (isBlockedIp(host))
      throw notAllowed(
        "Requests to private, loopback or reserved IP addresses are blocked.",
      );
    return url;
  }
  if (!host.includes("."))
    throw notAllowed("Single-label (intranet) host names are not allowed.");
  if (
    BLOCKED_HOST_SUFFIXES.some(
      (suffix) => host === suffix || host.endsWith(`.${suffix}`),
    )
  ) {
    throw notAllowed("Requests to local or internal host names are blocked.");
  }
  return url;
}

/**
 * Drop-in replacement for dns.lookup used by outbound sockets. Refuses to connect when any
 * resolved address is private, loopback, link-local or otherwise reserved.
 */
export function guardedLookup(hostname, options, callback) {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) {
      callback(err, "");
      return;
    }
    const list = addresses;
    if (list.length === 0 || list.some((a) => isBlockedIp(a.address))) {
      const blocked = Object.assign(
        new Error(`${hostname} resolves to a non-public address`),
        { code: "ESSRFBLOCKED" },
      );
      callback(blocked, "");
      return;
    }
    if (options?.all) callback(null, list);
    else callback(null, list[0].address, list[0].family);
  });
}

/** Resolves a host name and confirms every address is public (used for browser request routing). */
export async function assertHostResolvesPublic(hostname) {
  const host = hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host)) {
    if (isBlockedIp(host))
      throw notAllowed(
        "Requests to private or reserved IP addresses are blocked.",
      );
    return;
  }
  const addresses = await dns.promises.lookup(host, { all: true });
  if (addresses.length === 0 || addresses.some((a) => isBlockedIp(a.address))) {
    throw notAllowed(`${hostname} resolves to a non-public address.`);
  }
}
