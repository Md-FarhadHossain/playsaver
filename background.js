// background.js
// Service worker: handles background auto-sync to Turso.

// ─── API Config ───────────────────────────────────────────────────────────────
const API_URL = 'https://playsaver-backend.vercel.app/api/sync-time';

// 3. The Background Sync (The Service Worker) - set up alarms for 1 minute
chrome.runtime.onInstalled.addListener(() => {
    chrome.alarms.create('tursoSyncAlarm', { periodInMinutes: 1 });
});
chrome.runtime.onStartup.addListener(() => {
    chrome.alarms.create('tursoSyncAlarm', { periodInMinutes: 1 });
});

// Alarm Listener
chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'tursoSyncAlarm') {
        syncToTurso().catch(console.error);
    }
});

// Also trigger immediate sync manually via popup or on initial sign in
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === 'SYNC_NOW') {
        syncToTurso()
            .then(() => sendResponse({ ok: true }))
            .catch((err) => sendResponse({ ok: false, error: err.message }));
        return true; 
    }
    if (message.type === 'SIGNED_IN') {
        syncToTurso().catch(console.error);
    }
});

async function syncToTurso() {
    // Wait for the auth token from storage which Auth.js saves
    let token = null;
    try {
        token = await new Promise((resolve, reject) => {
            chrome.identity.getAuthToken({ interactive: false }, (t) => {
                if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
                else resolve(t);
            });
        });
    } catch (_) {}

    const session = await new Promise((resolve) =>
        chrome.storage.local.get(['access_token', 'user'], resolve)
    );

    const activeToken = token || session.access_token;
    if (!activeToken || !session.user?.id) return; // Not logged in or user ID missing

    // Update token cache universally if a new one was silently fetched
    if (token && token !== session.access_token) {
        chrome.storage.local.set({ access_token: token });
    }

    const data = await new Promise((resolve) =>
        chrome.storage.local.get(['unsyncedMs', 'totalSavedMs'], resolve)
    );

    const pushMs = Math.round(data.unsyncedMs || 0);
    
    if (pushMs === 0) return; // Nothing to sync!

    const res = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            googleToken: activeToken,
            pushMs: pushMs
        })
    });

    if (res.status === 401) {
        // Token expired! Tell Chrome to forget it so we fetch a new one next time.
        chrome.identity.removeCachedAuthToken({ token: activeToken }, () => {});
        throw new Error(`API sync failed: 401. Token invalidated to refresh next minute.`);
    }

    if (!res.ok) {
        throw new Error(`API sync failed: ${res.status}`);
    }
    
    const jsonRes = await res.json();
    
    if (jsonRes.success) {
        const trueTotalMs = jsonRes.totalSavedMs;
        
        // Subtract successful pushed deltas from unsynced and update the exact global totals
        await new Promise((resolve) => {
            chrome.storage.local.get(['unsyncedMs'], (curr) => {
                chrome.storage.local.set({
                    // If buffer accrued more time during the network call, keep the difference!
                    unsyncedMs: Math.max(0, (curr.unsyncedMs || 0) - pushMs),
                    totalSavedMs: trueTotalMs
                }, resolve);
            });
        });
    }
}
