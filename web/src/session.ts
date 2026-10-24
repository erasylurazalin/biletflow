'use client';

import { useSyncExternalStore } from 'react';
import type { User } from '@/api';

const TOKEN_KEY = 'biletflow.token';
const USER_KEY = 'biletflow.user';

const listeners = new Set<() => void>();

// useSyncExternalStore requires a stable snapshot. Parsing JSON on every read
// would hand back a new object and loop.
let snapshotRaw: string | null = null;
let snapshotUser: User | null = null;
let snapshotReady = false;

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function parseUser(raw: string | null): User | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<User>;
    if (
      typeof parsed.id === 'string' &&
      typeof parsed.email === 'string' &&
      typeof parsed.name === 'string' &&
      (parsed.role === 'attendee' ||
        parsed.role === 'organizer' ||
        parsed.role === 'event_admin' ||
        parsed.role === 'platform_admin')
    ) {
      return {
        id: parsed.id,
        email: parsed.email,
        name: parsed.name,
        role: parsed.role,
        email_verified: parsed.email_verified === true,
      };
    }
  } catch {
    // A bad cache is the same as no cache. /me will replace it.
  }
  return null;
}

function getSnapshot(): User | null {
  const raw = localStorage.getItem(USER_KEY);
  if (snapshotReady && raw === snapshotRaw) return snapshotUser;
  snapshotRaw = raw;
  snapshotUser = parseUser(raw);
  snapshotReady = true;
  return snapshotUser;
}

function getServerSnapshot(): User | null {
  return null;
}

export function useSessionUser(): User | null {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

export function readToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(TOKEN_KEY);
}

export function saveSession(token: string, user: User): void {
  localStorage.setItem(TOKEN_KEY, token);
  const raw = JSON.stringify(user);
  localStorage.setItem(USER_KEY, raw);
  snapshotRaw = raw;
  snapshotUser = user;
  snapshotReady = true;
  emit();
}

export function clearSession(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  snapshotRaw = null;
  snapshotUser = null;
  snapshotReady = true;
  emit();
}
