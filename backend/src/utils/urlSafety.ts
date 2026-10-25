import net from 'node:net';

const PRIVATE_HOST_PATTERNS = [
  /^localhost$/i,
  /\.localhost$/i,
  /\.local$/i,
  /\.internal$/i,
];

function isPrivateIpv4(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isPrivateHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (PRIVATE_HOST_PATTERNS.some((pattern) => pattern.test(host))) return true;
  if (net.isIP(host) === 4) return isPrivateIpv4(host);
  if (net.isIP(host) === 6) {
    return (
      host === '::1' ||
      host === '::' ||
      host.startsWith('fe80:') ||
      host.startsWith('fc') ||
      host.startsWith('fd')
    );
  }
  return false;
}

/**
 * The application URL comes from an external job feed and is therefore untrusted. The runner
 * may only open absolute http(s) pages. Loopback and private-network targets are blocked by
 * default so a hostile listing cannot make the browser talk to local services; local mock
 * forms can be enabled explicitly for testing with JOB_AGENT_ALLOW_LOCAL_URLS=true.
 */
export function assertNavigableApplicationUrl(
  rawUrl: string,
  options: { allowLocal?: boolean } = {},
): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('The application URL is not a valid absolute URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Refusing to open a non-http(s) application URL (${url.protocol}).`);
  }
  if (url.username || url.password) {
    throw new Error('Refusing to open an application URL with embedded credentials.');
  }
  const allowLocal =
    options.allowLocal === true || process.env.JOB_AGENT_ALLOW_LOCAL_URLS === 'true';
  if (!allowLocal && isPrivateHostname(url.hostname)) {
    throw new Error(
      'Refusing to open a loopback/private application URL. Set JOB_AGENT_ALLOW_LOCAL_URLS=true only for local mock forms.',
    );
  }
  return url;
}

/** Boolean form used before making server-side HTTP requests to untrusted listing URLs. */
export function isSafeRemoteUrl(rawUrl: string): boolean {
  try {
    assertNavigableApplicationUrl(rawUrl, { allowLocal: false });
    return true;
  } catch {
    return false;
  }
}
