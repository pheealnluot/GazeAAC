// webview_preload.js
// This script runs in the context of guest pages inside the Electron `<webview>` tag.
// It exposes no APIs to the page window for security, but intercepts DOM video events and communicates with GazeAAC.

const { ipcRenderer } = require('electron');

let lastVideoEl = null;
let cleanupListeners = null;

// Attach event listeners to the video element to notify the host immediately of playback events
function setupVideoListeners(video) {
  if (!video) return null;

  const reportStatus = (overridePlaying = null, overrideEnded = null) => {
    try {
      ipcRenderer.sendToHost('video-status', {
        isPlaying: overridePlaying !== null ? overridePlaying : (!video.paused && !video.ended),
        currentTime: video.currentTime,
        duration: video.duration || 0,
        ended: overrideEnded !== null ? overrideEnded : video.ended,
        documentTitle: document.title,
        url: window.location.href
      });
    } catch (e) {
      // Host might be unloading or re-routing
    }
  };

  const handlePlay = () => reportStatus(true, false);
  const handlePause = () => reportStatus(false, false);
  const handleEnded = () => reportStatus(false, true);

  video.addEventListener('play', handlePlay);
  video.addEventListener('pause', handlePause);
  video.addEventListener('ended', handleEnded);

  return () => {
    try {
      video.removeEventListener('play', handlePlay);
      video.removeEventListener('pause', handlePause);
      video.removeEventListener('ended', handleEnded);
    } catch (_) {}
  };
}

let shouldPauseVideo = false;

// Watchdog interval to detect the video element on the page and report status
setInterval(() => {
  const video = document.querySelector('video');
  
  if (video !== lastVideoEl) {
    if (cleanupListeners) cleanupListeners();
    lastVideoEl = video;
    if (video) {
      cleanupListeners = setupVideoListeners(video);
    }
  }

  // Periodic fallback check to update the current playtime and status
  if (video) {
    if (shouldPauseVideo && !video.paused) {
      try {
        video.pause();
      } catch (_) {}
    }
    try {
      ipcRenderer.sendToHost('video-status', {
        isPlaying: !video.paused && !video.ended,
        currentTime: video.currentTime,
        duration: video.duration || 0,
        ended: video.ended,
        documentTitle: document.title,
        url: window.location.href
      });
    } catch (e) {
      // Host might be unloading
    }
  }
}, 500);

// Receive control commands from GazeAAC host renderer
ipcRenderer.on('control-video', (event, command) => {
  if (command === 'pause') {
    shouldPauseVideo = true;
    const video = document.querySelector('video');
    if (video) {
      try {
        video.pause();
      } catch (e) {
        console.error('[WebviewPreload] Failed to pause video:', e);
      }
    }
  } else if (command === 'play') {
    shouldPauseVideo = false;
    const video = document.querySelector('video');
    if (video) {
      try {
        video.play().catch(err => {
          console.warn('[WebviewPreload] Programmatic play blocked:', err);
        });
      } catch (e) {
        console.error('[WebviewPreload] Failed to play video:', e);
      }
    }
  }
});
