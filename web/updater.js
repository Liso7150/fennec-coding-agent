// Auto-update checker for fennec-coding-agent (PWA)
// Checks GitHub releases and notifies user when updates are available

const GITHUB_REPO = 'Liso7150/fennec-coding-agent';
const CURRENT_VERSION = '4'; // Match service worker cache version

async function checkForUpdates(experimental = false) {
  console.log('[update] Checking for updates...');
  
  try {
    if (experimental) {
      // Check master branch for latest commit
      const url = `https://api.github.com/repos/${GITHUB_REPO}/commits/master`;
      const resp = await fetch(url, { headers: { 'User-Agent': 'fennec-updater' } });
      
      if (!resp.ok) {
        if (resp.status === 404) return { status: 'up-to-date' };
        throw new Error(`GitHub API: ${resp.status}`);
      }
      
      const data = await resp.json();
      const sha = data.sha || '';
      const shortSha = sha.slice(0, 7);
      
      return {
        status: 'available',
        version: `dev-${shortSha}`,
        experimental: true,
        message: `New experimental build available: dev-${shortSha}`,
      };
    } else {
      // Check latest release
      const url = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
      const resp = await fetch(url, { headers: { 'User-Agent': 'fennec-updater' } });
      
      if (!resp.ok) {
        if (resp.status === 404) return { status: 'up-to-date' };
        throw new Error(`GitHub API: ${resp.status}`);
      }
      
      const data = await resp.json();
      const tag = data.tag_name || '';
      const version = tag.replace(/^v/, '');
      
      // For PWA, we check if service worker cache version changed
      // The actual update happens via service worker skipWaiting
      if (version <= CURRENT_VERSION) {
        return { status: 'up-to-date', version: CURRENT_VERSION };
      }
      
      return {
        status: 'available',
        version: version,
        experimental: false,
        message: `New version available: ${version} (current: ${CURRENT_VERSION})`,
      };
    }
  } catch (error) {
    console.error('[update] Check failed:', error);
    return { status: 'error', error: error.message };
  }
}

// Notify user of available update
function showUpdateNotification(message) {
  // Check if we have a notification system
  if (typeof showToast === 'function') {
    showToast(message, { duration: 5000, action: { label: 'Refresh', onClick: () => location.reload() } });
  } else if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
    new Notification('Fennec Update', { body: message, icon: './icons/icon-192.png' });
  } else {
    console.log('[update]', message);
  }
}

// Background update check (runs periodically)
async function backgroundUpdateCheck() {
  const result = await checkForUpdates(false);
  
  if (result.status === 'available') {
    showUpdateNotification(result.message);
    
    // If service worker has updated, prompt user to refresh
    if ('serviceWorker' in navigator) {
      const registration = await navigator.serviceWorker.getRegistration();
      if (registration && registration.waiting) {
        // New service worker is waiting, prompt user to refresh
        if (confirm('A new version is available. Refresh to update?')) {
          registration.waiting.postMessage({ type: 'SKIP_WAITING' });
        }
      }
    }
  }
}

// Check for updates on load and periodically
if (typeof window !== 'undefined') {
  // Initial check after 5 seconds
  setTimeout(backgroundUpdateCheck, 5000);
  
  // Check every hour
  setInterval(backgroundUpdateCheck, 60 * 60 * 1000);
  
  // Listen for service worker updates
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', event => {
      if (event.data && event.data.type === 'UPDATE_AVAILABLE') {
        showUpdateNotification(event.data.message || 'Update available');
      }
    });
  }
}

// Export for manual checks
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { checkForUpdates, backgroundUpdateCheck };
}
