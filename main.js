const { app, BrowserWindow, Tray, Menu, Notification, nativeImage, shell } = require('electron');
const path = require('path');
const { spawn, exec } = require('child_process');
const http = require('http');
const https = require('https');
const WebSocket = require('ws');

let mainWindow = null;
let tray = null;
let serverProcess = null;

// LIVE PUBLIC VERCEL URL
const PUBLIC_URL = 'https://nafas-landingpage.vercel.app';
const LOCAL_URL = 'http://localhost:3000';

// Helper to safely load app icon
function getAppIcon() {
  try {
    const pngPath = path.join(__dirname, 'assets', 'hero-arabic.png');
    const img = nativeImage.createFromPath(pngPath);
    if (!img.isEmpty()) {
      return img.resize({ width: 32, height: 32 });
    }
  } catch (e) {
    console.log('Icon load fallback:', e);
  }
  return nativeImage.createEmpty();
}

// Ensure local backend server is running in background if needed
function startServerIfNeeded() {
  http.get(`${LOCAL_URL}/api/admin/check-auth`, (res) => {
    console.log('Local backend server is running.');
  }).on('error', () => {
    console.log('Starting internal backend server process...');
    serverProcess = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
      cwd: __dirname,
      stdio: 'inherit'
    });
  });
}

function playNativeWindowsSound() {
  try {
    // Play system notification chime via PowerShell
    exec('powershell -c "[System.Media.SystemSounds]::Asterisk.Play(); [System.Media.SystemSounds]::Hand.Play()"');
  } catch (e) {
    console.error('Error playing native sound:', e);
  }
}

function showTrayNotification(title, body, onClick = null) {
  try {
    if (Notification.isSupported()) {
      const icon = getAppIcon();
      const notif = new Notification({
        title,
        body,
        icon: icon.isEmpty() ? undefined : icon,
        silent: false
      });
      if (onClick) {
        notif.on('click', onClick);
      }
      notif.show();
    }
  } catch (err) {
    console.error('Notification error:', err);
  }
}

// Background polling for new orders (works 24/7 even when window is minimized or closed to tray)
function startBackgroundOrderMonitor() {
  // Local WebSocket listener
  function setupLocalWs() {
    try {
      const ws = new WebSocket('ws://localhost:3000');
      ws.on('message', (data) => {
        try {
          const parsed = JSON.parse(data.toString());
          if (parsed.type === 'NEW_ORDER' && parsed.order) {
            triggerBackgroundAlert(parsed.order);
          }
        } catch (e) {}
      });
      ws.on('close', () => setTimeout(setupLocalWs, 3000));
      ws.on('error', () => ws.close());
    } catch (e) {
      setTimeout(setupLocalWs, 3000);
    }
  }
  setupLocalWs();
}

function triggerBackgroundAlert(order) {
  playNativeWindowsSound();
  showTrayNotification(
    `🔔 طلب جديد وصل! #${order.id}`,
    `الزبون: ${order.name}\nالمدينة: ${order.city}\nالكمية: ${order.quantity} (${order.price} درهم)`,
    () => {
      if (mainWindow) {
        mainWindow.show();
        mainWindow.focus();
      }
    }
  );
}

function createWindow() {
  const icon = getAppIcon();

  mainWindow = new BrowserWindow({
    width: 1300,
    height: 850,
    minWidth: 900,
    minHeight: 600,
    title: 'نَفَس - لوحة إدارة الطلبات المباشرة',
    icon: icon.isEmpty() ? undefined : icon,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false // Prevent background throttling when minimized
    }
  });

  // Load LIVE PUBLIC VERCEL Dashboard by default
  mainWindow.loadURL(`${PUBLIC_URL}/admin`);

  // Minimize to tray on close
  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
      showTrayNotification('التطبيق يعمل في الخلفية 🌐', 'متصل مباشرة بموقع نَفَس العمومي لمتابعة الطلبات المباشرة.');
    }
    return false;
  });
}

function createTray() {
  try {
    const icon = getAppIcon();
    tray = new Tray(icon);

    const contextMenu = Menu.buildFromTemplate([
      {
        label: '📊 فتح لوحة التحكم المباشرة (الموقع الحي)',
        click: () => {
          if (mainWindow) {
            mainWindow.loadURL(`${PUBLIC_URL}/admin`);
            mainWindow.show();
            mainWindow.focus();
          }
        }
      },
      {
        label: '🌐 فتح موقع الزبائن العمومي (Vercel)',
        click: () => { shell.openExternal(PUBLIC_URL); }
      },
      { type: 'separator' },
      {
        label: '🖥️ التبديل للسيرفر المحلي (Localhost)',
        click: () => {
          if (mainWindow) {
            mainWindow.loadURL(`${LOCAL_URL}/admin`);
            mainWindow.show();
            mainWindow.focus();
          }
        }
      },
      { type: 'separator' },
      { label: 'إغلاق التطبيق نهائياً 🚪', click: () => { app.isQuitting = true; app.quit(); } }
    ]);

    tray.setToolTip('نَفَس - متابعة الطلبات المباشرة الحية');
    tray.setContextMenu(contextMenu);

    tray.on('double-click', () => {
      if (mainWindow) {
        mainWindow.show();
        mainWindow.focus();
      }
    });
  } catch (err) {
    console.error('Tray initialization skipped:', err);
  }
}

app.whenReady().then(() => {
  startServerIfNeeded();

  setTimeout(() => {
    createWindow();
    createTray();
    startBackgroundOrderMonitor();
  }, 800);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    } else if (mainWindow) {
      mainWindow.show();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  if (serverProcess) {
    serverProcess.kill();
  }
});
