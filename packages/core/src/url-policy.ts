import { lookup } from 'node:dns/promises';
import net from 'node:net';
import { invalid } from './errors.js';

/**
 * Which Git URLs a project may be imported or synced from. Without this, `file:///…/.data/storage/repos/<id>.git`
 * copied another project's (or organization's) code into a new project, and `http://127.0.0.1:…` / cloud metadata
 * addresses let the server be used to reach its own internal services (SSRF).
 *
 * Allowed: https, http and ssh to public hosts and to private LAN addresses (company Git servers live there), or only
 * to the hosts in `allowedHosts` when an operator lists them. Refused: every other scheme (file, ext, …), loopback,
 * link-local/metadata and unspecified addresses in any notation (IPv4-mapped/NAT64 IPv6, decimal IPv4) — also when a
 * public-looking name resolves to them. `allowLocal` exists for tests and single-machine setups only.
 */
export const GIT_PROTOCOLS = ['https:', 'http:', 'ssh:'] as const;

const BLOCKED = new net.BlockList();
BLOCKED.addSubnet('127.0.0.0', 8, 'ipv4');
BLOCKED.addSubnet('0.0.0.0', 8, 'ipv4');
BLOCKED.addSubnet('169.254.0.0', 16, 'ipv4');
BLOCKED.addAddress('::1', 'ipv6');
BLOCKED.addAddress('::', 'ipv6');
BLOCKED.addSubnet('fe80::', 10, 'ipv6');
// IPv4-mapped and NAT64 forms of the IPv4 ranges above ("::ffff:7f00:1" is 127.0.0.1).
BLOCKED.addSubnet('::ffff:127.0.0.0', 104, 'ipv6');
BLOCKED.addSubnet('::ffff:0.0.0.0', 104, 'ipv6');
BLOCKED.addSubnet('::ffff:169.254.0.0', 112, 'ipv6');
BLOCKED.addSubnet('64:ff9b::7f00:0', 104, 'ipv6');
BLOCKED.addSubnet('64:ff9b::a9fe:0', 112, 'ipv6');

export interface GitUrlPolicy {
  allowLocal?: boolean;
  /** Operator allow-list (GIT_IMPORT_ALLOWED_HOSTS): exact host names or parent domains. Empty = any allowed host. */
  allowedHosts?: string[];
  resolve?: (host: string) => Promise<string[]>;
}

/** Validates the URL and returns the addresses its host resolved to (empty for IP literals and allowLocal). */
export async function assertImportableGitUrl(raw: string, opts: GitUrlPolicy = {}): Promise<string[]> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw invalid('Git adresi geçersiz');
  }
  if (opts.allowLocal) return [];
  if (!(GIT_PROTOCOLS as readonly string[]).includes(url.protocol)) throw invalid(`Git adresi yalnızca https, http veya ssh olabilir (${url.protocol.replace(':', '')} kabul edilmez)`);
  // WHATWG URL already normalises decimal/hex/octal IPv4 ("http://2130706433" → 127.0.0.1).
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) throw invalid('Git adresinde sunucu yok');
  const allowed = (opts.allowedHosts ?? []).map((h) => h.trim().toLowerCase()).filter(Boolean);
  if (allowed.length && !allowed.some((a) => host === a || host.endsWith(`.${a.replace(/^\./, '')}`))) throw invalid(`Bu Git sunucusu izinli listede değil (${host}). İzinli sunucular: ${allowed.join(', ')}`);
  if (host === 'localhost' || host.endsWith('.localhost') || host === 'metadata.google.internal') throw invalid('Git adresi bu sunucunun kendisini veya iç servislerini gösteremez');
  if (net.isIP(host)) {
    if (blockedAddress(host)) throw invalid('Git adresi bu sunucunun kendisini veya iç servislerini gösteremez');
    return [];
  }
  const addresses = await (opts.resolve ?? resolveAll)(host).catch(() => [] as string[]);
  for (const a of addresses) if (blockedAddress(a)) throw invalid('Git adresi bu sunucunun kendisini veya iç servislerini gösteremez');
  return addresses;
}

/**
 * Git `-c` settings for fetching from `raw`, after validating it again right before the fetch: http(s) connections
 * are pinned to the address just checked (no DNS rebinding between check and connect) and redirects are refused (a
 * redirect could point at an internal host). SSH is pinned the same way: ssh connects to the checked address
 * (`HostName`) while host keys are still verified under the real name (`HostKeyAlias`), and no ssh_config proxy can
 * route the connection elsewhere.
 */
export async function gitTransportConfig(raw: string, opts: GitUrlPolicy = {}): Promise<string[]> {
  const addresses = await assertImportableGitUrl(raw, opts);
  if (opts.allowLocal) return [];
  const url = new URL(raw);
  if (url.protocol === 'ssh:') {
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const ip = net.isIP(host) ? host : addresses[0];
    // Names and addresses are plain [a-z0-9.:-] after URL parsing and validation: safe inside git's shell command.
    if (!ip || !/^[A-Za-z0-9.:-]+$/.test(host) || !/^[A-Fa-f0-9.:]+$/.test(ip)) return [];
    return ['-c', `core.sshCommand=ssh -o HostName=${ip} -o HostKeyAlias=${host} -o CheckHostIP=no -o ProxyCommand=none -o ProxyJump=none -o BatchMode=yes`];
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return [];
  const args = ['-c', 'http.followRedirects=false'];
  const ip = addresses[0];
  if (ip) args.push('-c', `http.curloptResolve=${url.hostname}:${url.port || (url.protocol === 'https:' ? 443 : 80)}:${net.isIPv6(ip) ? `[${ip}]` : ip}`);
  return args;
}

/** The value for git's GIT_ALLOW_PROTOCOL, so a redirect or submodule cannot switch to file:// or ext::. */
export function gitAllowProtocol(allowLocal = false): string {
  return allowLocal ? 'https:http:ssh:git:file' : 'https:http:ssh';
}

async function resolveAll(host: string): Promise<string[]> {
  return (await lookup(host, { all: true, verbatim: true })).map((r) => r.address);
}

/** Loopback, unspecified and link-local (incl. 169.254.169.254 cloud metadata) in any notation; unparseable = blocked. */
export function blockedAddress(address: string): boolean {
  const a = address.trim().toLowerCase();
  const type = net.isIPv4(a) ? 'ipv4' : net.isIPv6(a) ? 'ipv6' : null;
  if (!type) return true;
  return BLOCKED.check(a, type);
}
