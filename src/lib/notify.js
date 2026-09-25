/** Browser Notification helpers for in-app price alerts. */

const SW_URL = '/alerts-sw.js';

export function notificationsSupported() {
  return typeof window !== 'undefined' && 'Notification' in window;
}

/** 'granted' | 'denied' | 'default' | 'unsupported' */
export function notificationPermission() {
  return notificationsSupported() ? Notification.permission : 'unsupported';
}

export async function registerAlertsWorker() {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
  try {
    return await navigator.serviceWorker.register(SW_URL, { scope: '/' });
  } catch {
    return null;
  }
}

export async function requestNotificationPermission() {
  if (!notificationsSupported()) return 'unsupported';
  let result = Notification.permission;
  if (result !== 'granted') {
    try {
      result = await Notification.requestPermission();
    } catch {
      result = Notification.permission;
    }
  }
  if (result === 'granted') await registerAlertsWorker();
  return result;
}

/** Show a system notification. Returns true if one was shown. */
export async function showNotification(title, { body, tag } = {}) {
  if (notificationPermission() !== 'granted') return false;
  const opts = { body, tag, icon: '/favicon.png', badge: '/favicon.png', renotify: Boolean(tag) };
  try {
    const reg = await navigator.serviceWorker?.getRegistration?.('/');
    if (reg?.showNotification) {
      await reg.showNotification(title, opts);
      return true;
    }
  } catch {
    /* fall through to the page-level constructor */
  }
  try {
    new Notification(title, opts);
    return true;
  } catch {
    return false;
  }
}
