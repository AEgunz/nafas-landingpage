const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const { WebSocketServer } = require('ws');
const { DatabaseSync } = require('node:sqlite');

const app = express();
const PORT = process.env.PORT || 3000;

// Create HTTP server for Express & WebSockets
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

function broadcastNewOrder(orderData) {
  const payload = JSON.stringify({ type: 'NEW_ORDER', order: orderData });
  wss.clients.forEach(client => {
    if (client.readyState === 1 /* OPEN */) {
      client.send(payload);
    }
  });
}

function broadcastStockUpdate() {
  const stockInfo = getStockInfo();
  const payload = JSON.stringify({ type: 'STOCK_UPDATE', stock: stockInfo });
  wss.clients.forEach(client => {
    if (client.readyState === 1 /* OPEN */) {
      client.send(payload);
    }
  });
}

wss.on('connection', (ws) => {
  console.log('⚡ Admin connected to WebSockets');
  ws.send(JSON.stringify({ type: 'CONNECTED', message: 'Connected to real-time stream' }));
});

const fs = require('fs');

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files
app.use('/assets', express.static(path.join(__dirname, 'public', 'assets')));
app.use('/assets', express.static(path.join(__dirname, 'assets')));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));

const isVercel = Boolean(process.env.VERCEL || process.env.NOW_BUILD || process.env.AWS_LAMBDA_FUNCTION_NAME);

// Determine SQLite DB path safely (Vercel Serverless read-only filesystem workaround)
function initDatabase() {
  const localDbPath = path.join(__dirname, 'database.db');
  const tmpDbPath = path.join('/tmp', 'database.db');

  let dbFile = localDbPath;
  if (isVercel) {
    if (!fs.existsSync(tmpDbPath) && fs.existsSync(localDbPath)) {
      try { fs.copyFileSync(localDbPath, tmpDbPath); } catch (e) {}
    }
    dbFile = tmpDbPath;
  }

  // 1. Try node:sqlite (Node 22+)
  try {
    const { DatabaseSync } = require('node:sqlite');
    return new DatabaseSync(dbFile);
  } catch (e1) {
    console.log('node:sqlite not available, attempting better-sqlite3 fallback:', e1.message);
  }

  // 2. Fallback to better-sqlite3
  try {
    const BetterSqlite = require('better-sqlite3');
    return new BetterSqlite(dbFile);
  } catch (e2) {
    console.error('better-sqlite3 failed:', e2.message);
  }

  throw new Error('No SQLite driver available on this Node runtime environment.');
}

const db = initDatabase();

// Helper function to hash password
function hashPassword(password) {
  return crypto.createHash('sha256').update(password + '_nasal_salt').digest('hex');
}

// Active session tokens
const validTokens = new Set();

// Initialize Database Tables
db.exec(`
  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
    city TEXT NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 1,
    address TEXT DEFAULT '',
    price REAL NOT NULL DEFAULT 199.0,
    status TEXT DEFAULT 'جديد',
    notes TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS packs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 1,
    price REAL NOT NULL DEFAULT 199.0,
    old_price REAL DEFAULT 0.0,
    badge TEXT DEFAULT '',
    sort_order INTEGER DEFAULT 0,
    active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS stock (
    id INTEGER PRIMARY KEY,
    total_stock INTEGER NOT NULL DEFAULT 100,
    remaining_stock INTEGER NOT NULL DEFAULT 30,
    auto_decrement INTEGER DEFAULT 1,
    low_stock_threshold INTEGER DEFAULT 10,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Add old_price column if missing
try {
  db.exec('ALTER TABLE packs ADD COLUMN old_price REAL DEFAULT 0.0');
} catch (e) {}

// Set default admin password
const getPasswordStmt = db.prepare('SELECT value FROM settings WHERE key = ?');
const defaultPasswordRow = getPasswordStmt.get('admin_password');
if (!defaultPasswordRow) {
  const defaultHash = hashPassword('admin123');
  const insertStmt = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
  insertStmt.run('admin_password', defaultHash);
  console.log('Default admin password set to: admin123');
}

// Pre-populate default product packs/pricing if empty
const checkPacksStmt = db.prepare('SELECT COUNT(*) as count FROM packs');
if (checkPacksStmt.get().count === 0) {
  const insertPack = db.prepare(`
    INSERT INTO packs (name, quantity, price, old_price, badge, sort_order, active)
    VALUES (?, ?, ?, ?, ?, ?, 1)
  `);
  insertPack.run('1 Starter Kit', 1, 199.0, 299.0, '', 1);
  insertPack.run('2 Starter Kits', 2, 350.0, 499.0, '🔥 الأكثر طلباً', 2);
  insertPack.run('3 Starter Kits', 3, 490.0, 699.0, '🎁 أفضل قيمة', 3);
  console.log('Default product packs initialized.');
}

// Initialize Stock level if empty
const checkStockStmt = db.prepare('SELECT COUNT(*) as count FROM stock');
if (checkStockStmt.get().count === 0) {
  db.exec('INSERT INTO stock (id, total_stock, remaining_stock, auto_decrement, low_stock_threshold) VALUES (1, 100, 30, 1, 10)');
  console.log('Default stock initialized: 30 / 100.');
}

function getStockInfo() {
  let stock = null;
  try {
    stock = db.prepare('SELECT * FROM stock WHERE id = 1').get();
  } catch (e) {}

  if (!stock) {
    stock = { total_stock: 100, remaining_stock: 30, auto_decrement: 1, low_stock_threshold: 10 };
    try {
      db.prepare('INSERT OR IGNORE INTO stock (id, total_stock, remaining_stock, auto_decrement, low_stock_threshold) VALUES (1, 100, 30, 1, 10)').run();
    } catch (e) {}
  }

  return {
    total_stock: stock.total_stock,
    remaining_stock: stock.remaining_stock,
    auto_decrement: Boolean(stock.auto_decrement),
    low_stock_threshold: stock.low_stock_threshold,
    is_low: stock.remaining_stock <= stock.low_stock_threshold,
    is_out_of_stock: stock.remaining_stock <= 0
  };
}

// Authentication Middleware for Admin Routes
function authenticateAdmin(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token || !validTokens.has(token)) {
    return res.status(401).json({ success: false, message: 'غير مسموح. يرجى تسجيل الدخول.' });
  }
  next();
}

// ==================== PUBLIC API ENDPOINTS ====================

// Get Public Stock Status
app.get('/api/stock', (req, res) => {
  try {
    const stock = getStockInfo();
    res.json({ success: true, stock });
  } catch (error) {
    console.error('Error fetching stock:', error);
    res.status(500).json({ success: false, message: 'خطأ في جلب بيانات المخزون.' });
  }
});

// Get Active Packs / Offers
app.get('/api/packs', (req, res) => {
  try {
    const packs = db.prepare('SELECT * FROM packs WHERE active = 1 ORDER BY sort_order ASC, id ASC').all();
    res.json({ success: true, packs });
  } catch (error) {
    console.error('Error fetching public packs:', error);
    res.status(500).json({ success: false, message: 'خطأ أثناء جلب عروض الأسعار.' });
  }
});

// Submit a new order
app.post('/api/orders', (req, res) => {
  try {
    const { name, phone, city, qty, quantity, pack_id, address } = req.body;

    const orderQty = parseInt(qty || quantity || 1, 10);
    const clientName = (name || '').trim();
    const clientPhone = (phone || '').trim();
    const clientCity = (city || '').trim();
    const clientAddress = (address || '').trim();

    if (!clientName || !clientPhone || !clientCity) {
      return res.status(400).json({
        success: false,
        message: 'يرجى ملء جميع الحقول الإجبارية (الاسم، الهاتف، المدينة).'
      });
    }

    let price = 0;
    if (pack_id) {
      const selectedPack = db.prepare('SELECT * FROM packs WHERE id = ?').get(pack_id);
      if (selectedPack) {
        price = selectedPack.price;
      }
    }

    if (!price) {
      const matchingPack = db.prepare('SELECT * FROM packs WHERE quantity = ? AND active = 1 LIMIT 1').get(orderQty);
      if (matchingPack) {
        price = matchingPack.price;
      } else {
        if (orderQty === 1) price = 199;
        else if (orderQty === 2) price = 350;
        else if (orderQty === 3) price = 490;
        else price = 490 + (orderQty - 3) * 140;
      }
    }

    const insertStmt = db.prepare(`
      INSERT INTO orders (name, phone, city, quantity, address, price, status, notes)
      VALUES (?, ?, ?, ?, ?, ?, 'جديد', '')
    `);

    const result = insertStmt.run(clientName, clientPhone, clientCity, orderQty, clientAddress, price);

    // Auto decrement stock
    const stockRow = db.prepare('SELECT * FROM stock WHERE id = 1').get();
    if (stockRow && stockRow.auto_decrement) {
      const newRemaining = Math.max(0, stockRow.remaining_stock - orderQty);
      db.prepare('UPDATE stock SET remaining_stock = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1').run(newRemaining);
      broadcastStockUpdate();
    }

    const createdOrder = {
      id: result.lastInsertRowid,
      name: clientName,
      phone: clientPhone,
      city: clientCity,
      quantity: orderQty,
      address: clientAddress,
      price: price,
      status: 'جديد',
      notes: '',
      created_at: new Date().toISOString()
    };

    broadcastNewOrder(createdOrder);

    res.status(201).json({
      success: true,
      orderId: result.lastInsertRowid,
      message: 'تم استلام طلبك بنجاح! سنتصل بك قريباً لتأكيد التوصيل.',
      order: createdOrder
    });
  } catch (error) {
    console.error('Error creating order:', error);
    res.status(500).json({ success: false, message: 'حدث خطأ في الخادم أثناء إضافة الطلب.' });
  }
});

// ==================== ADMIN STOCK API ====================

app.get('/api/admin/stock', authenticateAdmin, (req, res) => {
  try {
    const stock = getStockInfo();
    res.json({ success: true, stock });
  } catch (error) {
    console.error('Error fetching admin stock:', error);
    res.status(500).json({ success: false, message: 'خطأ في جلب بيانات المخزون.' });
  }
});

app.patch('/api/admin/stock', authenticateAdmin, (req, res) => {
  try {
    const { total_stock, remaining_stock, auto_decrement, low_stock_threshold } = req.body;

    const current = getStockInfo();

    const newTotal = Number.isNaN(parseInt(total_stock, 10)) ? current.total_stock : parseInt(total_stock, 10);
    const newRemaining = Number.isNaN(parseInt(remaining_stock, 10)) ? current.remaining_stock : parseInt(remaining_stock, 10);
    const newAuto = auto_decrement !== undefined ? (auto_decrement ? 1 : 0) : (current.auto_decrement ? 1 : 0);
    const newThreshold = Number.isNaN(parseInt(low_stock_threshold, 10)) ? current.low_stock_threshold : parseInt(low_stock_threshold, 10);

    db.prepare(`
      INSERT INTO stock (id, total_stock, remaining_stock, auto_decrement, low_stock_threshold, updated_at)
      VALUES (1, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET
        total_stock = excluded.total_stock,
        remaining_stock = excluded.remaining_stock,
        auto_decrement = excluded.auto_decrement,
        low_stock_threshold = excluded.low_stock_threshold,
        updated_at = CURRENT_TIMESTAMP
    `).run(newTotal, newRemaining, newAuto, newThreshold);

    broadcastStockUpdate();

    res.json({ success: true, message: 'تم تحديث إعدادات المخزون بنجاح.', stock: getStockInfo() });
  } catch (error) {
    console.error('Error updating stock:', error);
    res.status(500).json({ success: false, message: 'خطأ أثناء تحديث المخزون.' });
  }
});

// ==================== ADMIN PACKS API ====================

// Get all packs (Admin)
app.get('/api/admin/packs', authenticateAdmin, (req, res) => {
  try {
    const packs = db.prepare('SELECT * FROM packs ORDER BY sort_order ASC, id ASC').all();
    res.json({ success: true, packs });
  } catch (error) {
    console.error('Error fetching admin packs:', error);
    res.status(500).json({ success: false, message: 'خطأ أثناء جلب قائمة الباقات.' });
  }
});

// Add new pack (Admin)
app.post('/api/admin/packs', authenticateAdmin, (req, res) => {
  try {
    const { name, quantity, price, old_price, badge, sort_order } = req.body;

    if (!name || price === undefined || price === null) {
      return res.status(400).json({ success: false, message: 'يرجى كتابة اسم الباقة وتحديد الثمن.' });
    }

    const qtyVal = parseInt(quantity || 1, 10);
    const priceVal = parseFloat(price);
    const oldPriceVal = parseFloat(old_price || 0);
    const orderVal = parseInt(sort_order || 0, 10);

    const stmt = db.prepare(`
      INSERT INTO packs (name, quantity, price, old_price, badge, sort_order, active)
      VALUES (?, ?, ?, ?, ?, ?, 1)
    `);

    const result = stmt.run(name.trim(), qtyVal, priceVal, oldPriceVal, (badge || '').trim(), orderVal);

    res.status(201).json({ success: true, message: 'تم إضافة الباقة بنجاح.', id: result.lastInsertRowid });
  } catch (error) {
    console.error('Error adding pack:', error);
    res.status(500).json({ success: false, message: 'خطأ أثناء إضافة الباقة.' });
  }
});

// Update pack (Admin)
app.patch('/api/admin/packs/:id', authenticateAdmin, (req, res) => {
  try {
    const { id } = req.params;
    const { name, quantity, price, old_price, badge, sort_order, active } = req.body;

    const existing = db.prepare('SELECT * FROM packs WHERE id = ?').get(id);
    if (!existing) {
      return res.status(404).json({ success: false, message: 'الباقة غير موجودة.' });
    }

    const updatedName = name !== undefined ? name.trim() : existing.name;
    const updatedQty = quantity !== undefined ? parseInt(quantity, 10) : existing.quantity;
    const updatedPrice = price !== undefined ? parseFloat(price) : existing.price;
    const updatedOldPrice = old_price !== undefined ? parseFloat(old_price) : existing.old_price;
    const updatedBadge = badge !== undefined ? badge.trim() : existing.badge;
    const updatedOrder = sort_order !== undefined ? parseInt(sort_order, 10) : existing.sort_order;
    const updatedActive = active !== undefined ? (active ? 1 : 0) : existing.active;

    const stmt = db.prepare(`
      UPDATE packs
      SET name = ?, quantity = ?, price = ?, old_price = ?, badge = ?, sort_order = ?, active = ?
      WHERE id = ?
    `);

    stmt.run(updatedName, updatedQty, updatedPrice, updatedOldPrice, updatedBadge, updatedOrder, updatedActive, id);

    res.json({ success: true, message: 'تم تحديث بيانات الباقة بنجاح.' });
  } catch (error) {
    console.error('Error updating pack:', error);
    res.status(500).json({ success: false, message: 'خطأ أثناء تحديث الباقة.' });
  }
});

// Delete pack (Admin)
app.delete('/api/admin/packs/:id', authenticateAdmin, (req, res) => {
  try {
    const { id } = req.params;
    const stmt = db.prepare('DELETE FROM packs WHERE id = ?');
    const result = stmt.run(id);

    if (result.changes === 0) {
      return res.status(404).json({ success: false, message: 'الباقة غير موجودة.' });
    }

    res.json({ success: true, message: 'تم حذف الباقة بنجاح.' });
  } catch (error) {
    console.error('Error deleting pack:', error);
    res.status(500).json({ success: false, message: 'خطأ أثناء حذف الباقة.' });
  }
});

// ==================== OTHER ADMIN API ENDPOINTS ====================

// Admin Login
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (!password) {
    return res.status(400).json({ success: false, message: 'يرجى إدخال كلمة المرور.' });
  }

  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('admin_password');
  const storedHash = row ? row.value : hashPassword('admin123');
  const inputHash = hashPassword(password);

  if (inputHash === storedHash) {
    const token = crypto.randomBytes(32).toString('hex');
    validTokens.add(token);
    res.json({ success: true, token, message: 'تم تسجيل الدخول بنجاح.' });
  } else {
    res.status(401).json({ success: false, message: 'كلمة المرور غير صحيحة.' });
  }
});

// Admin Logout
app.post('/api/admin/logout', authenticateAdmin, (req, res) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (token) validTokens.delete(token);
  res.json({ success: true, message: 'تم تسجيل الخروج بنجاح.' });
});

// Check Admin Token Validity
app.get('/api/admin/check-auth', authenticateAdmin, (req, res) => {
  res.json({ success: true, message: 'جلسة صالحة.' });
});

// Get Dashboard Statistics
app.get('/api/admin/stats', authenticateAdmin, (req, res) => {
  try {
    const totalRow = db.prepare('SELECT COUNT(*) as count FROM orders').get();
    const newRow = db.prepare("SELECT COUNT(*) as count FROM orders WHERE status = 'جديد'").get();
    const confirmedRow = db.prepare("SELECT COUNT(*) as count FROM orders WHERE status = 'تم التأكيد'").get();
    const shippedRow = db.prepare("SELECT COUNT(*) as count FROM orders WHERE status = 'تم الشحن'").get();
    const deliveredRow = db.prepare("SELECT COUNT(*) as count FROM orders WHERE status = 'تم التسليم'").get();
    const cancelledRow = db.prepare("SELECT COUNT(*) as count FROM orders WHERE status = 'ملغى'").get();

    const revenueRow = db.prepare("SELECT SUM(price) as total FROM orders WHERE status != 'ملغى'").get();
    const todayRow = db.prepare("SELECT COUNT(*) as count FROM orders WHERE date(created_at) = date('now')").get();

    res.json({
      success: true,
      stats: {
        totalOrders: totalRow.count || 0,
        newOrders: newRow.count || 0,
        confirmedOrders: confirmedRow.count || 0,
        shippedOrders: shippedRow.count || 0,
        deliveredOrders: deliveredRow.count || 0,
        cancelledOrders: cancelledRow.count || 0,
        todayOrders: todayRow.count || 0,
        totalRevenue: revenueRow.total || 0
      }
    });
  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({ success: false, message: 'خطأ أثناء جلب الإحصائيات.' });
  }
});

// Get Orders
app.get('/api/admin/orders', authenticateAdmin, (req, res) => {
  try {
    const { status, search } = req.query;

    let sql = 'SELECT * FROM orders WHERE 1=1';
    const params = [];

    if (status && status !== 'الكل') {
      sql += ' AND status = ?';
      params.push(status);
    }

    if (search && search.trim() !== '') {
      sql += ' AND (name LIKE ? OR phone LIKE ? OR city LIKE ? OR address LIKE ?)';
      const term = `%${search.trim()}%`;
      params.push(term, term, term, term);
    }

    sql += ' ORDER BY id DESC';

    const stmt = db.prepare(sql);
    const orders = stmt.all(...params);

    res.json({ success: true, orders });
  } catch (error) {
    console.error('Error fetching orders:', error);
    res.status(500).json({ success: false, message: 'خطأ أثناء جلب الطلبات.' });
  }
});

// Add Order Manually
app.post('/api/admin/orders', authenticateAdmin, (req, res) => {
  try {
    const { name, phone, city, quantity, address, price, status, notes } = req.body;

    if (!name || !phone || !city) {
      return res.status(400).json({ success: false, message: 'يرجى إدخال الاسم والهاتف والمدينة.' });
    }

    const qtyVal = parseInt(quantity || 1, 10);
    const priceVal = parseFloat(price) || 199;
    const statusVal = status || 'جديد';

    const insertStmt = db.prepare(`
      INSERT INTO orders (name, phone, city, quantity, address, price, status, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = insertStmt.run(name.trim(), phone.trim(), city.trim(), qtyVal, (address || '').trim(), priceVal, statusVal, (notes || '').trim());

    // Auto decrement stock
    const stockRow = db.prepare('SELECT * FROM stock WHERE id = 1').get();
    if (stockRow && stockRow.auto_decrement) {
      const newRemaining = Math.max(0, stockRow.remaining_stock - qtyVal);
      db.prepare('UPDATE stock SET remaining_stock = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1').run(newRemaining);
      broadcastStockUpdate();
    }

    const createdOrder = {
      id: result.lastInsertRowid,
      name: name.trim(),
      phone: phone.trim(),
      city: city.trim(),
      quantity: qtyVal,
      address: (address || '').trim(),
      price: priceVal,
      status: statusVal,
      notes: (notes || '').trim(),
      created_at: new Date().toISOString()
    };

    broadcastNewOrder(createdOrder);

    res.status(201).json({ success: true, message: 'تمت إضافة الطلب يدوياً بنجاح.', id: result.lastInsertRowid });
  } catch (error) {
    console.error('Error adding manual order:', error);
    res.status(500).json({ success: false, message: 'خطأ أثناء إضافة الطلب.' });
  }
});

// Update Order
app.patch('/api/admin/orders/:id', authenticateAdmin, (req, res) => {
  try {
    const { id } = req.params;
    const { status, notes, name, phone, city, quantity, address, price } = req.body;

    const existing = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
    if (!existing) {
      return res.status(404).json({ success: false, message: 'الطلب غير موجود.' });
    }

    const updatedStatus = status !== undefined ? status : existing.status;
    const updatedNotes = notes !== undefined ? notes : existing.notes;
    const updatedName = name !== undefined ? name : existing.name;
    const updatedPhone = phone !== undefined ? phone : existing.phone;
    const updatedCity = city !== undefined ? city : existing.city;
    const updatedQuantity = quantity !== undefined ? parseInt(quantity, 10) : existing.quantity;
    const updatedAddress = address !== undefined ? address : existing.address;
    const updatedPrice = price !== undefined ? parseFloat(price) : existing.price;

    const updateStmt = db.prepare(`
      UPDATE orders
      SET status = ?, notes = ?, name = ?, phone = ?, city = ?, quantity = ?, address = ?, price = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `);

    updateStmt.run(updatedStatus, updatedNotes, updatedName, updatedPhone, updatedCity, updatedQuantity, updatedAddress, updatedPrice, id);

    res.json({ success: true, message: 'تم تحديث الطلب بنجاح.' });
  } catch (error) {
    console.error('Error updating order:', error);
    res.status(500).json({ success: false, message: 'خطأ أثناء تحديث الطلب.' });
  }
});

// Delete Order
app.delete('/api/admin/orders/:id', authenticateAdmin, (req, res) => {
  try {
    const { id } = req.params;
    const deleteStmt = db.prepare('DELETE FROM orders WHERE id = ?');
    const result = deleteStmt.run(id);

    if (result.changes === 0) {
      return res.status(404).json({ success: false, message: 'الطلب غير موجود.' });
    }

    res.json({ success: true, message: 'تم حذف الطلب بنجاح.' });
  } catch (error) {
    console.error('Error deleting order:', error);
    res.status(500).json({ success: false, message: 'خطأ أثناء حذف الطلب.' });
  }
});

// Change Password
app.post('/api/admin/change-password', authenticateAdmin, (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword || newPassword.length < 6) {
      return res.status(400).json({ success: false, message: 'كلمة المرور الجديدة يجب أن تتكون من 6 أحرف على الأقل.' });
    }

    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('admin_password');
    const storedHash = row ? row.value : hashPassword('admin123');

    if (hashPassword(currentPassword) !== storedHash) {
      return res.status(400).json({ success: false, message: 'كلمة المرور الحالية غير صحيحة.' });
    }

    const updateStmt = db.prepare('UPDATE settings SET value = ? WHERE key = ?');
    updateStmt.run(hashPassword(newPassword), 'admin_password');

    res.json({ success: true, message: 'تم تغيير كلمة المرور بنجاح.' });
  } catch (error) {
    console.error('Error changing password:', error);
    res.status(500).json({ success: false, message: 'خطأ أثناء تغيير كلمة المرور.' });
  }
});

// Export CSV
app.get('/api/admin/export-csv', authenticateAdmin, (req, res) => {
  try {
    const orders = db.prepare('SELECT * FROM orders ORDER BY id DESC').all();

    let csv = '\uFEFF';
    csv += 'رقم الطلب,التاريخ,اسم الزبون,الهاتف,المدينة,العنوان,الكمية,الثمن (درهم),الحالة,ملاحظات\n';

    orders.forEach(o => {
      const escape = (str) => `"${(str || '').toString().replace(/"/g, '""')}"`;
      csv += `${o.id},${escape(o.created_at)},${escape(o.phone)},${escape(o.name)},${escape(o.city)},${escape(o.address)},${o.quantity},${o.price},${escape(o.status)},${escape(o.notes)}\n`;
    });

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="nasal_landing_orders.csv"');
    res.status(200).send(csv);
  } catch (error) {
    console.error('Error exporting CSV:', error);
    res.status(500).send('خطأ أثناء تصدير الملف.');
  }
});

// HTML Route for Admin
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

// Fallback route
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Start Server
if (!isVercel) {
  server.listen(PORT, () => {
    console.log(`====================================================`);
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`🛒 Landing Page: http://localhost:${PORT}`);
    console.log(`📊 Admin Dashboard: http://localhost:${PORT}/admin`);
    console.log(`⚡ WebSockets: ws://localhost:${PORT}`);
    console.log(`🔑 Default Admin Password: admin123`);
    console.log(`====================================================`);
  });
}

module.exports = app;
