import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

export function normalizePhone(input: string): string {
  const digits = input.replace(/\D/g, '');
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith('91')) return `+${digits}`;
  if (digits.length === 13 && digits.startsWith('91')) return `+${digits.slice(0, 12)}`;
  return input.startsWith('+') ? `+${digits}` : input;
}

export function isIndianMobile(phone: string): boolean {
  return /^\+91[6-9]\d{9}$/.test(phone);
}

export function hashSecret(value: string, pepper: string): string {
  return createHmac('sha256', pepper).update(value).digest('hex');
}

export function secretsMatch(hash: string, value: string, pepper: string): boolean {
  const actual = Buffer.from(hashSecret(value, pepper), 'hex');
  const expected = Buffer.from(hash, 'hex');
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

export function randomOtp(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}

export function hashOtp(code: string): string {
  return hashSecret(code, config.otpPepper);
}

export function otpMatches(hash: string, code: string): boolean {
  return secretsMatch(hash, code, config.otpPepper);
}
