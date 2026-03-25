// content.js
let videoElement = null;
let lastVideoTime = -1;
let lastVideoSpeed = 1;

let unrecorded_seconds = 0;
let unrecorded_ms = 0;
let sessionSavedMs = 0;
let isPlayingAtSpeed = false;

// (Ad tracking removed)

let displayMode = 'always';
let shownMiddle = false;
let shownEnd = false;
let forceShowUntil = 0;

let powerSavingOverlayTimeout = 0;

function showPowerSavingOverlay() {
    if (displayMode === 'hidden') return;

    let overlay = document.getElementById('yt-power-saving-overlay');
    if (!overlay) {
        const player = document.querySelector('#movie_player') || document.querySelector('.html5-video-player') || (videoElement ? videoElement.parentElement : null);
        if (!player) return;
        
        overlay = document.createElement('div');
        overlay.id = 'yt-power-saving-overlay';
        player.appendChild(overlay);
    }
    
    // Apply theme class
    overlay.className = '';
    overlay.classList.add(overlayTheme === 'dark' ? 'theme-dark' : 'theme-light');
    
    // Apply position class
    overlay.classList.add(displayMode === 'middle_end' ? 'pos-bottom-center' : 'pos-top-right');
    
    overlay.innerText = 'Saving Time! ⚡';
    
    // Force reflow for animation restart
    void overlay.offsetWidth;
    
    overlay.classList.add('yt-ps-visible');
    
    if (powerSavingOverlayTimeout) clearTimeout(powerSavingOverlayTimeout);
    powerSavingOverlayTimeout = setTimeout(() => {
        if (overlay) overlay.classList.remove('yt-ps-visible');
    }, 2000);
}

// ─── Theme System ────────────────────────────────────────────────────────────
let overlayTheme = 'dark'; // 'dark' | 'light'
const sysDark = window.matchMedia('(prefers-color-scheme: dark)');

function resolveTheme(pref) {
    if (pref === 'light') return 'light';
    if (pref === 'dark')  return 'dark';
    return sysDark.matches ? 'dark' : 'light'; // auto
}

if (chrome.storage && chrome.storage.local) {
    chrome.storage.local.get(['displayMode', 'theme'], (res) => {
        displayMode  = res.displayMode || 'always';
        overlayTheme = resolveTheme(res.theme || 'auto');
    });
    chrome.storage.onChanged.addListener((changes, namespace) => {
        if (namespace !== 'local') return;
        if (changes.displayMode) displayMode = changes.displayMode.newValue;
        if (changes.theme) overlayTheme = resolveTheme(changes.theme.newValue);
        updateOverlay();
    });
}

// Keep 'auto' in sync with system preference changes
sysDark.addEventListener('change', () => {
    chrome.storage.local.get(['theme'], ({ theme }) => {
        if (!theme || theme === 'auto') overlayTheme = resolveTheme('auto');
        updateOverlay();
    });
});
// ─────────────────────────────────────────────────────────────────────────────

function onTimeUpdate() {
    if (!videoElement) return;
    
    const currentTime = videoElement.currentTime;
    const currentSpeed = videoElement.playbackRate;
    
    if (!videoElement.paused && currentSpeed > 1 && !videoElement.seeking) {
        isPlayingAtSpeed = true;
        // Verify we have a previous tick and speed hasn't changed mid-tick
        if (lastVideoTime >= 0 && lastVideoSpeed === currentSpeed) {
            const videoDeltaSec = currentTime - lastVideoTime;
            
            // Cap video delta to 10 seconds to avoid huge jumps (e.g., from tab suspension resumes)
            // Normal video progress delta between timeupdates is ~0.25s
            if (videoDeltaSec > 0 && videoDeltaSec < 10) {
                // mathematically: TimeSaved = RealTimePlayed * (Speed - 1)
                // Since VideoDelta = RealTimePlayed * Speed
                // TimeSaved = (VideoDelta / Speed) * (Speed - 1) = VideoDelta * (1 - 1/Speed)
                const savedSec = videoDeltaSec * (1 - (1 / currentSpeed));
                const savedMs = savedSec * 1000;
                
                unrecorded_seconds += savedSec;
                unrecorded_ms += savedMs;
                sessionSavedMs += savedMs;
            }
        }
    } else {
        isPlayingAtSpeed = false;
    }
    
    lastVideoTime = currentTime;
    lastVideoSpeed = currentSpeed;
}

function onSeeked() {
    if (videoElement) {
        // Reset base tracking time on manual jumps
        lastVideoTime = videoElement.currentTime;
    }
}

function onRateChange() {
    if (videoElement) {
        const newSpeed = videoElement.playbackRate;
        // Only show when initially entering "power saving mode" (crossing from <=1x to >1x)
        if (newSpeed > 1 && lastVideoSpeed <= 1) {
            showPowerSavingOverlay();
        }
        lastVideoSpeed = newSpeed;
        // Start accumulating using the new rate from this specific point in time
        lastVideoTime = videoElement.currentTime; 
    }
}

function attachListeners(v) {
    v.addEventListener('timeupdate', onTimeUpdate);
    v.addEventListener('seeked', onSeeked);
    v.addEventListener('ratechange', onRateChange);
    v.addEventListener('pause', flushBufferToStorage);
}

function detachListeners(v) {
    v.removeEventListener('timeupdate', onTimeUpdate);
    v.removeEventListener('seeked', onSeeked);
    v.removeEventListener('ratechange', onRateChange);
    v.removeEventListener('pause', flushBufferToStorage);
}

// Ensure listeners stay attached. YouTube dynamically swaps <video> DOM elements on navigation.
setInterval(() => {
    const currentVideo = document.querySelector('video');
    if (currentVideo !== videoElement) {
        if (videoElement) detachListeners(videoElement);
        videoElement = currentVideo;
        if (videoElement) {
            attachListeners(videoElement);
            lastVideoTime = videoElement.currentTime;
            lastVideoSpeed = videoElement.playbackRate;
        }
    }
    
    // (Interval save removed from here, now handled by 10s setInterval below)
    
    updateOverlay();
}, 1000);

// Reset session time when navigating to a new video in YouTube SPA
document.addEventListener('yt-navigate-finish', () => {
    sessionSavedMs = 0;
    shownMiddle = false;
    shownEnd = false;
    forceShowUntil = 0;
    
    lastVideoSpeed = 1; // Reset memory so restored speed triggers the ratechange popup
    
    // If the video is already > 1x, show it immediately
    if (videoElement && videoElement.playbackRate > 1) {
        showPowerSavingOverlay();
        lastVideoSpeed = videoElement.playbackRate;
    }
});

// --- Buffer and Flush Architecture ---

function flushBufferToStorage() {
    if (unrecorded_ms <= 0) return;

    const pushMs = unrecorded_ms;

    unrecorded_seconds = 0;
    unrecorded_ms = 0;

    const dateStr = new Date().toLocaleDateString('en-CA');
    
    chrome.storage.local.get([
        'totalSavedMs', 'dailyStats', 'unsyncedMs'
    ], (result) => {
        const dailyStats = result.dailyStats || {};
        dailyStats[dateStr] = (dailyStats[dateStr] || 0) + pushMs;

        chrome.storage.local.set({ 
            unsyncedMs: (result.unsyncedMs || 0) + pushMs,
            totalSavedMs: (result.totalSavedMs || 0) + pushMs,
            dailyStats
        });
    });
}

// 1. Tally to storage every 10 seconds
setInterval(flushBufferToStorage, 10000);

// Use visibilitychange to immediately save buffer to storage 
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
        flushBufferToStorage();
    }
});

// Cache user ID and access_token for failsafe
let cachedUser = null;
let cachedToken = null;
chrome.storage.local.get(['user', 'access_token'], (res) => {
    cachedUser = res.user;
    cachedToken = res.access_token;
});
chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'local') {
        if (changes.user) cachedUser = changes.user.newValue;
        if (changes.access_token) cachedToken = changes.access_token.newValue;
    }
});

// 2. Tab Close Failsafe
const API_URL = 'https://playsaver-backend.vercel.app/api/sync-time';

window.addEventListener('pagehide', executeFailsafeFlush);

function executeFailsafeFlush() {
    if (unrecorded_ms <= 0) return;
    if (!cachedUser || !cachedUser.id || !cachedToken) return;

    const pushMs = Math.round(unrecorded_ms);

    unrecorded_seconds = 0;
    unrecorded_ms = 0;

    const payload = JSON.stringify({
        googleToken: cachedToken,
        pushMs: pushMs
    });

    try {
        // fetch with keepalive ensures reliable delivery on tab close
        fetch(API_URL, {
            method: 'POST',
            keepalive: true,
            headers: { 'Content-Type': 'application/json' },
            body: payload
        });
    } catch (_) {
        // Fallback to sendBeacon if strictly desired
        navigator.sendBeacon(API_URL, new Blob([payload], { type: 'application/json' }));
    }
}

// Overlay DOM logic
function updateOverlay() {
    let overlay = document.getElementById('yt-time-saved-overlay');
    if (!overlay) {
        const player = document.querySelector('#movie_player') || document.querySelector('.html5-video-player') || (videoElement ? videoElement.parentElement : null);
        if (!player) return;
        
        overlay = document.createElement('div');
        overlay.id = 'yt-time-saved-overlay';
        player.appendChild(overlay);
    }
    
    const sessionMins = Math.floor(sessionSavedMs / 60000);
    const sessionSecs = Math.floor((sessionSavedMs % 60000) / 1000);
    
    if (videoElement && videoElement.duration && displayMode === 'middle_end' && sessionSavedMs >= 1000) {
        const ratio = videoElement.currentTime / videoElement.duration;
        const now = Date.now();
        if (!shownMiddle && ratio >= 0.5) {
            shownMiddle = true;
            forceShowUntil = now + 5000;
        } else if (!shownEnd && ratio >= 0.98) {
            shownEnd = true;
            forceShowUntil = now + 5000;
        }
    }
    
    let shouldShow = false;
    if (sessionSavedMs < 1000) {
        shouldShow = false;
    } else if (displayMode === 'hidden') {
        shouldShow = false;
    } else if (displayMode === 'always') {
        shouldShow = isPlayingAtSpeed;
    } else if (displayMode === 'middle_end') {
        shouldShow = Date.now() < forceShowUntil;
    }
    
    // Apply theme class
    overlay.classList.toggle('theme-dark',  overlayTheme === 'dark');
    overlay.classList.toggle('theme-light', overlayTheme === 'light');
    
    // Apply position class
    overlay.classList.toggle('pos-bottom-center', displayMode === 'middle_end');
    overlay.classList.toggle('pos-top-right', displayMode !== 'middle_end');
    
    if (shouldShow) {
        overlay.classList.add('yt-ts-visible');
    } else {
        overlay.classList.remove('yt-ts-visible');
    }
    
    if (sessionMins > 0) {
        overlay.innerText = `+${sessionMins}m ${sessionSecs}s saved`;
    } else {
        overlay.innerText = `+${sessionSecs}s saved`;
    }
}
