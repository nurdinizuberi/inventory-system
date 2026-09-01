'use client';

import { useEffect, useRef } from 'react';

const ACTIVITY_EVENTS = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll', 'wheel'] as const;

const CONFIG_MINUTES = Number(process.env.NEXT_PUBLIC_SESSION_TIMEOUT_MINUTES ?? 30);
const DEFAULT_TIMEOUT_MS = Number.isFinite(CONFIG_MINUTES) && CONFIG_MINUTES > 0 ? CONFIG_MINUTES * 60_000 : 30 * 60_000;

/**
 * Calls `onIdle()` after `timeoutMs` of user inactivity. The timer resets on
 * mouse/keyboard/touch/scroll activity and only runs while `enabled` is true
 * (i.e. while a user is signed in).
 */
export function useInactivitySignout(
  onIdle: () => void,
  options?: { timeoutMs?: number; enabled?: boolean },
) {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, enabled = true } = options ?? {};
  const onIdleRef = useRef(onIdle);
  onIdleRef.current = onIdle;
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!enabled) return;

    const start = () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => onIdleRef.current(), timeoutMs);
    };

    ACTIVITY_EVENTS.forEach((ev) => window.addEventListener(ev, start, { passive: true }));
    start();

    return () => {
      ACTIVITY_EVENTS.forEach((ev) => window.removeEventListener(ev, start));
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, [timeoutMs, enabled]);
}