import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHmac } from 'node:crypto';
import { promisify } from 'node:util';
import { hash } from './repository.js';

const scrypt = promisify(scryptCallback);
const SESSION_SECONDS = 60 * 60 * 24 * 7;

export async function passwordHash(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 200) {
    throw new Error('Password must be 12 to 200 characters.');
  }
  const salt = randomBytes(16).toString('base64url');
  const key = await scrypt(password, salt, 64);
  return `scrypt-v1:${salt}:${key.toString('base64url')}`;
}

export async function verifyPassword(password, encoded) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 200) return false;
  const [scheme, salt, expected] = String(encoded).split(':');
  if (scheme !== 'scrypt-v1' || !salt || !expected) return false;
  const actual = await scrypt(password, salt, 64);
  const target = Buffer.from(expected, 'base64url');
  return actual.length === target.length && timingSafeEqual(actual, target);
}

export function validUsername(name) {
  return typeof name === 'string' && /^[a-z][a-z0-9_]{2,29}$/i.test(name);
}

export async function issueSession(repo, user, secure) {
  const token = randomBytes(32).toString('base64url');
  await repo.createSession(user.id, hash(token), new Date(Date.now() + SESSION_SECONDS * 1000));
  return { user, cookie: `${secure ? '__Host-ic_session' : 'ic_session'}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_SECONDS}${secure ? '; Secure' : ''}` };
}

export function sessionToken(request) {
  const cookies = request.headers.get('cookie') ?? '';
  const host = cookies.match(/(?:^|;\s*)__Host-ic_session=([^;]+)/);
  const local = cookies.match(/(?:^|;\s*)ic_session=([^;]+)/);
  return host?.[1] ?? (new URL(request.url).protocol === 'https:' ? null : local?.[1] ?? null);
}

export function abuseSubject(request, secret, platformIp) {
  const ip = normalizeAbuseIp(platformIp || request.headers.get('x-nf-client-connection-ip') || 'unknown');
  return createHmac('sha256', secret).update(ip).digest('hex');
}

export function normalizeAbuseIp(value) {
  const ip = String(value).trim().toLowerCase();
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return mapped[1];
  // Privacy extensions rotate the lower 64 bits. A /64 is the normal host network.
  if (ip.includes(':')) {
    const [before = '', after = ''] = ip.split('::');
    const left = before ? before.split(':').filter(Boolean) : [];
    const right = after ? after.split(':').filter(Boolean) : [];
    const groups = [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right]
      .map((part) => Number.parseInt(part || '0', 16).toString(16));
    if (groups.length === 8 && groups.every((part) => /^[0-9a-f]+$/.test(part))) return `${groups.slice(0, 4).join(':')}::/64`;
  }
  return ip || 'unknown';
}

export function accountAbuseSubject(username, secret) {
  return createHmac('sha256', secret).update(String(username).toLowerCase()).digest('hex');
}
