const { app, BrowserWindow, Tray, Menu, Notification, nativeImage } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');

let mainWindow = null;
let tray = null;
let serverProcess = null;

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

// Ensure backend server is running
function startServerIfNeeded() {
  http.get('http://localhost:3000/api/admin/check-auth', (res) => {
    console.log('Backend server is already running.');
  }).on('error', () => {
    console.log('Starting internal backend server process...');
    serverProcess = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
      cwd: __dirname,
      stdio: 'inherit'
    });
  });
}

function createWindow() {
  const icon = getAppIcon();

  mainWindow = new BrowserWindow({
    width: 1300,
    height: 850,
    minWidth: 900,
    minHeight: 600,
    title: 'نَفَس - لوحة إدارة الطلبات',
    icon: icon.isEmpty() ? undefined : icon,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  mainWindow.loadURL('http://localhost:3000/admin');

  // Minimize to tray on close
  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
      showTrayNotification('التطبيق يعمل في الخلفية', 'سيصلك تنبيه صوني وفوري بمجرد وصول أي طلب جديد.');
    }
    return false;
  });
}

function createTray() {
  try {
    const icon = getAppIcon();
    tray = new Tray(icon);

    const contextMenu = Menu.buildFromTemplate([
      { label: 'فتح لوحة التحكم', click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } } },
      { label: 'فتح الموقع للزبائن', click: () => { require('electron').shell.openExternal('http://localhost:3000'); } },
      { type: 'separator' },
      { label: 'إغلاق التطبيق نهائياً', click: () => { app.isQuitting = true; app.quit(); } }
    ]);

    tray.setToolTip('نَفَس - متابعة الطلبات المباشرة');
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

function showTrayNotification(title, body) {
  try {
    if (Notification.isSupported()) {
      const icon = getAppIcon();
      new Notification({
        title,
        body,
        icon: icon.isEmpty() ? undefined : icon
      }).show();
    }
  } catch (err) {
    console.error('Notification error:', err);
  }
}

app.whenReady().then(() => {
  startServerIfNeeded();

  setTimeout(() => {
    createWindow();
    createTray();
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
