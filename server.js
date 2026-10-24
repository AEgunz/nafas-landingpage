const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const fs = require('fs');
const { WebSocketServer } = require('ws');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;
const isVercel = Boolean(process.env.VERCEL || process.env.NOW_BUILD || process.env.AWS_LAMBDA_FUNCTION_NAME);

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

function broadcastStockUpdate(stockInfo) {
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

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files
app.use('/assets', express.static(path.join(__dirname, 'public', 'assets')));
app.use('/assets', express.static(path.join(__dirname, 'assets')));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));

const { neon } = require('@neondatabase/serverless');

// ==================== DATABASE INITIALIZATION ====================

const databaseUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.NEON_DATABASE_URL || process.env.POSTGRES_URL_NON_POOLING;

let neonSql = null;
let sqliteDb = null;

if (databaseUrl) {
  try {
    neonSql = neon(databaseUrl);
    console.log('🐘 Neon Serverless HTTP driver configured!');
  } catch (err) {
    console.error('Failed to configure Neon Serverless driver:', err);
  }
}

if (!neonSql) {
  function initSqlite() {
    const localDbPath = path.join(__dirname, 'database.db');
    const tmpDbPath = path.join('/tmp', 'database.db');

    let dbFile = localDbPath;
    if (isVercel) {
      if (!fs.existsSync(tmpDbPath) && fs.existsSync(localDbPath)) {
        try { fs.copyFileSync(localDbPath, tmpDbPath); } catch (e) {}
      }
      dbFile = tmpDbPath;
    }

    try {
      const { DatabaseSync } = require('node:sqlite');
      return new DatabaseSync(dbFile);
    } catch (e1) {
      try {
        const BetterSqlite = require('better-sqlite3');
        return new BetterSqlite(dbFile);
      } catch (e2) {
        throw new Error('No SQLite driver available.');
      }
    }
  }
  sqliteDb = initSqlite();
}

function formatPgSql(sql) {
  let paramIdx = 1;
  let formatted = sql.replace(/\?/g, () => `$${paramIdx++}`);
  formatted = formatted.replace(/INTEGER PRIMARY KEY AUTOINCREMENT/gi, 'SERIAL PRIMARY KEY');
  formatted = formatted.replace(/DATETIME DEFAULT CURRENT_TIMESTAMP/gi, 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP');
  return formatted;
}

async function dbQuery(sql, params = []) {
  if (neonSql) {
    return await neonSql.query(formatPgSql(sql), params);
  } else {
    return sqliteDb.prepare(sql).all(...params);
  }
}

async function dbGet(sql, params = []) {
  if (neonSql) {
    const rows = await neonSql.query(formatPgSql(sql), params);
    return rows[0] || null;
  } else {
    return sqliteDb.prepare(sql).get(...params) || null;
  }
}

async function dbRun(sql, params = []) {
  if (neonSql) {
    let pgSql = formatPgSql(sql);
    if (pgSql.trim().toUpperCase().startsWith('INSERT') && !pgSql.toUpperCase().includes('RETURNING')) {
      pgSql += ' RETURNING id';
    }
    const rows = await neonSql.query(pgSql, params);
    const lastId = rows && rows[0] ? rows[0].id : null;
    return { lastInsertRowid: lastId, changes: rows ? rows.length : 1 };
  } else {
    const res = sqliteDb.prepare(sql).run(...params);
    return { lastInsertRowid: res.lastInsertRowid, changes: res.changes };
  }
}

async function dbExec(sql) {
  if (neonSql) {
    await neonSql.query(formatPgSql(sql));
  } else {
    sqliteDb.exec(sql);
  }
}

// Helper function to hash password
function hashPassword(password) {
  return crypto.createHash('sha256').update(password + '_nasal_salt').digest('hex');
}

// Stateless HMAC Auth Tokens (for Vercel Serverless Functions persistence)
const AUTH_SECRET = 'nasal_landing_secret_key_2026_x99';

function generateAuthToken() {
  const timestamp = Date.now();
  const payload = `admin_${timestamp}`;
  const signature = crypto.createHmac('sha256', AUTH_SECRET).update(payload).digest('hex');
  return `${payload}.${signature}`;
}

function verifyAuthToken(token) {
  if (!token || typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;

  const [payload, signature] = parts;
  try {
    const expectedSignature = crypto.createHmac('sha256', AUTH_SECRET).update(payload).digest('hex');
    const sigBuf = Buffer.from(signature, 'hex');
    const expBuf = Buffer.from(expectedSignature, 'hex');

    if (sigBuf.length === expBuf.length && crypto.timingSafeEqual(sigBuf, expBuf)) {
      const timestamp = parseInt(payload.replace('admin_', ''), 10);
      if (isNaN(timestamp)) return false;
      const ageMs = Date.now() - timestamp;
      const maxAgeMs = 30 * 24 * 60 * 60 * 1000; // 30 days
      return ageMs >= 0 && ageMs < maxAgeMs;
    }
  } catch (e) {
    return false;
  }
  return false;
}

// Initialize Database Tables
async function initTables() {
  try {
    await dbExec(`
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
    `);

    await dbExec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    await dbExec(`
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
    `);

    await dbExec(`
      CREATE TABLE IF NOT EXISTS stock (
        id INTEGER PRIMARY KEY,
        total_stock INTEGER NOT NULL DEFAULT 100,
        remaining_stock INTEGER NOT NULL DEFAULT 30,
        auto_decrement INTEGER DEFAULT 1,
        low_stock_threshold INTEGER DEFAULT 10,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Set default admin password if empty
    const defaultPasswordRow = await dbGet('SELECT value FROM settings WHERE key = ?', ['admin_password']);
    if (!defaultPasswordRow) {
      const defaultHash = hashPassword('admin123');
      await dbRun('INSERT INTO settings (key, value) VALUES (?, ?)', ['admin_password', defaultHash]);
      console.log('Default admin password set to: admin123');
    }

    // Pre-populate default product packs/pricing if empty
    const checkPacks = await dbGet('SELECT COUNT(*) as count FROM packs');
    if (!checkPacks || parseInt(checkPacks.count, 10) === 0) {
      await dbRun(`
        INSERT INTO packs (name, quantity, price, old_price, badge, sort_order, active)
        VALUES (?, ?, ?, ?, ?, ?, 1)
      `, ['1 Starter Kit', 1, 199.0, 299.0, '', 1]);

      await dbRun(`
        INSERT INTO packs (name, quantity, price, old_price, badge, sort_order, active)
        VALUES (?, ?, ?, ?, ?, ?, 1)
      `, ['2 Starter Kits', 2, 350.0, 499.0, '🔥 الأكثر طلباً', 2]);

      await dbRun(`
        INSERT INTO packs (name, quantity, price, old_price, badge, sort_order, active)
        VALUES (?, ?, ?, ?, ?, ?, 1)
      `, ['3 Starter Kits', 3, 490.0, 699.0, '🎁 أفضل قيمة', 3]);

      console.log('Default product packs initialized.');
    }

    // Initialize Stock level if empty
    const checkStock = await dbGet('SELECT COUNT(*) as count FROM stock');
    if (!checkStock || parseInt(checkStock.count, 10) === 0) {
      await dbRun('INSERT INTO stock (id, total_stock, remaining_stock, auto_decrement, low_stock_threshold) VALUES (1, 100, 30, 1, 10)');
      console.log('Default stock initialized: 30 / 100.');
    }
  } catch (err) {
    console.error('Error initializing tables:', err);
  }
}

initTables();

async function getStockInfo() {
  let stock = null;
  try {
    stock = await dbGet('SELECT * FROM stock WHERE id = 1');
  } catch (e) {}

  if (!stock) {
    stock = { total_stock: 100, remaining_stock: 30, auto_decrement: 1, low_stock_threshold: 10 };
    try {
      await dbRun('INSERT INTO stock (id, total_stock, remaining_stock, auto_decrement, low_stock_threshold) VALUES (1, 100, 30, 1, 10)');
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
  const token = (authHeader && authHeader.split(' ')[1]) || req.query.token;

  if (!token || !verifyAuthToken(token)) {
    return res.status(401).json({ success: false, message: 'غير مسموح. يرجى تسجيل الدخول.' });
  }
  next();
}

// ==================== PUBLIC API ENDPOINTS ====================

// Get Public Stock Status
app.get('/api/stock', async (req, res) => {
  try {
    const stock = await getStockInfo();
    res.json({ success: true, stock });
  } catch (error) {
    console.error('Error fetching stock:', error);
    res.status(500).json({ success: false, message: 'خطأ في جلب بيانات المخزون.' });
  }
});

// Get Active Packs / Offers
app.get('/api/packs', async (req, res) => {
  try {
    const packs = await dbQuery('SELECT * FROM packs WHERE active = 1 ORDER BY sort_order ASC, id ASC');
    res.json({ success: true, packs });
  } catch (error) {
    console.error('Error fetching public packs:', error);
    res.status(500).json({ success: false, message: 'خطأ أثناء جلب عروض الأسعار.' });
  }
});

// Submit a new order
app.post('/api/orders', async (req, res) => {
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
      const selectedPack = await dbGet('SELECT * FROM packs WHERE id = ?', [pack_id]);
      if (selectedPack) {
        price = selectedPack.price;
      }
    }

    if (!price) {
      const matchingPack = await dbGet('SELECT * FROM packs WHERE quantity = ? AND active = 1 LIMIT 1', [orderQty]);
      if (matchingPack) {
        price = matchingPack.price;
      } else {
        if (orderQty === 1) price = 199;
        else if (orderQty === 2) price = 350;
        else if (orderQty === 3) price = 490;
        else price = 490 + (orderQty - 3) * 140;
      }
    }

    const result = await dbRun(`
      INSERT INTO orders (name, phone, city, quantity, address, price, status, notes)
      VALUES (?, ?, ?, ?, ?, ?, 'جديد', '')
    `, [clientName, clientPhone, clientCity, orderQty, clientAddress, price]);

    // Auto decrement stock
    const stockRow = await dbGet('SELECT * FROM stock WHERE id = 1');
    if (stockRow && stockRow.auto_decrement) {
      const newRemaining = Math.max(0, stockRow.remaining_stock - orderQty);
      await dbRun('UPDATE stock SET remaining_stock = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1', [newRemaining]);
      const updatedStock = await getStockInfo();
      broadcastStockUpdate(updatedStock);
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

app.get('/api/admin/stock', authenticateAdmin, async (req, res) => {
  try {
    const stock = await getStockInfo();
    res.json({ success: true, stock });
  } catch (error) {
    console.error('Error fetching admin stock:', error);
    res.status(500).json({ success: false, message: 'خطأ في جلب بيانات المخزون.' });
  }
});

app.patch('/api/admin/stock', authenticateAdmin, async (req, res) => {
  try {
    const { total_stock, remaining_stock, auto_decrement, low_stock_threshold } = req.body;

    const current = await getStockInfo();

    const newTotal = Number.isNaN(parseInt(total_stock, 10)) ? current.total_stock : parseInt(total_stock, 10);
    const newRemaining = Number.isNaN(parseInt(remaining_stock, 10)) ? current.remaining_stock : parseInt(remaining_stock, 10);
    const newAuto = auto_decrement !== undefined ? (auto_decrement ? 1 : 0) : (current.auto_decrement ? 1 : 0);
    const newThreshold = Number.isNaN(parseInt(low_stock_threshold, 10)) ? current.low_stock_threshold : parseInt(low_stock_threshold, 10);

    if (pgPool) {
      await dbRun(`
        INSERT INTO stock (id, total_stock, remaining_stock, auto_decrement, low_stock_threshold, updated_at)
        VALUES (1, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(id) DO UPDATE SET
          total_stock = EXCLUDED.total_stock,
          remaining_stock = EXCLUDED.remaining_stock,
          auto_decrement = EXCLUDED.auto_decrement,
          low_stock_threshold = EXCLUDED.low_stock_threshold,
          updated_at = CURRENT_TIMESTAMP
      `, [newTotal, newRemaining, newAuto, newThreshold]);
    } else {
      await dbRun(`
        INSERT INTO stock (id, total_stock, remaining_stock, auto_decrement, low_stock_threshold, updated_at)
        VALUES (1, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(id) DO UPDATE SET
          total_stock = excluded.total_stock,
          remaining_stock = excluded.remaining_stock,
          auto_decrement = excluded.auto_decrement,
          low_stock_threshold = excluded.low_stock_threshold,
          updated_at = CURRENT_TIMESTAMP
      `, [newTotal, newRemaining, newAuto, newThreshold]);
    }

    const updatedStock = await getStockInfo();
    broadcastStockUpdate(updatedStock);

    res.json({ success: true, message: 'تم تحديث إعدادات المخزون بنجاح.', stock: updatedStock });
  } catch (error) {
    console.error('Error updating stock:', error);
    res.status(500).json({ success: false, message: 'خطأ أثناء تحديث المخزون.' });
  }
});

// ==================== ADMIN PACKS API ====================

// Get all packs (Admin)
app.get('/api/admin/packs', authenticateAdmin, async (req, res) => {
  try {
    const packs = await dbQuery('SELECT * FROM packs ORDER BY sort_order ASC, id ASC');
    res.json({ success: true, packs });
  } catch (error) {
    console.error('Error fetching admin packs:', error);
    res.status(500).json({ success: false, message: 'خطأ أثناء جلب قائمة الباقات.' });
  }
});

// Add new pack (Admin)
app.post('/api/admin/packs', authenticateAdmin, async (req, res) => {
  try {
    const { name, quantity, price, old_price, badge, sort_order } = req.body;

    if (!name || price === undefined || price === null) {
      return res.status(400).json({ success: false, message: 'يرجى كتابة اسم الباقة وتحديد الثمن.' });
    }

    const qtyVal = parseInt(quantity || 1, 10);
    const priceVal = parseFloat(price);
    const oldPriceVal = parseFloat(old_price || 0);
    const orderVal = parseInt(sort_order || 0, 10);

    const result = await dbRun(`
      INSERT INTO packs (name, quantity, price, old_price, badge, sort_order, active)
      VALUES (?, ?, ?, ?, ?, ?, 1)
    `, [name.trim(), qtyVal, priceVal, oldPriceVal, (badge || '').trim(), orderVal]);

    res.status(201).json({ success: true, message: 'تم إضافة الباقة بنجاح.', id: result.lastInsertRowid });
  } catch (error) {
    console.error('Error adding pack:', error);
    res.status(500).json({ success: false, message: 'خطأ أثناء إضافة الباقة.' });
  }
});

// Update pack (Admin)
app.patch('/api/admin/packs/:id', authenticateAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, quantity, price, old_price, badge, sort_order, active } = req.body;

    const existing = await dbGet('SELECT * FROM packs WHERE id = ?', [id]);
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

    await dbRun(`
      UPDATE packs
      SET name = ?, quantity = ?, price = ?, old_price = ?, badge = ?, sort_order = ?, active = ?
      WHERE id = ?
    `, [updatedName, updatedQty, updatedPrice, updatedOldPrice, updatedBadge, updatedOrder, updatedActive, id]);

    res.json({ success: true, message: 'تم تحديث بيانات الباقة بنجاح.' });
  } catch (error) {
    console.error('Error updating pack:', error);
    res.status(500).json({ success: false, message: 'خطأ أثناء تحديث الباقة.' });
  }
});

// Delete pack (Admin)
app.delete('/api/admin/packs/:id', authenticateAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await dbRun('DELETE FROM packs WHERE id = ?', [id]);

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
app.post('/api/admin/login', async (req, res) => {
  try {
    const { password } = req.body;
    if (!password) {
      return res.status(400).json({ success: false, message: 'يرجى إدخال كلمة المرور.' });
    }

    const row = await dbGet('SELECT value FROM settings WHERE key = ?', ['admin_password']);
    const storedHash = row ? row.value : hashPassword('admin123');
    const inputHash = hashPassword(password);

    if (inputHash === storedHash) {
      const token = generateAuthToken();
      res.json({ success: true, token, message: 'تم تسجيل الدخول بنجاح.' });
    } else {
      res.status(401).json({ success: false, message: 'كلمة المرور غير صحيحة.' });
    }
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ success: false, message: 'خطأ في تسجيل الدخول.' });
  }
});

// Admin Logout
app.post('/api/admin/logout', authenticateAdmin, (req, res) => {
  res.json({ success: true, message: 'تم تسجيل الخروج بنجاح.' });
});

// Check Admin Token Validity
app.get('/api/admin/check-auth', authenticateAdmin, (req, res) => {
  res.json({ success: true, message: 'جلسة صالحة.' });
});

// Get Dashboard Statistics
app.get('/api/admin/stats', authenticateAdmin, async (req, res) => {
  try {
    const totalRow = await dbGet('SELECT COUNT(*) as count FROM orders');
    const newRow = await dbGet("SELECT COUNT(*) as count FROM orders WHERE status = 'جديد'");
    const confirmedRow = await dbGet("SELECT COUNT(*) as count FROM orders WHERE status = 'تم التأكيد'");
    const shippedRow = await dbGet("SELECT COUNT(*) as count FROM orders WHERE status = 'تم الشحن'");
    const deliveredRow = await dbGet("SELECT COUNT(*) as count FROM orders WHERE status = 'تم التسليم'");
    const cancelledRow = await dbGet("SELECT COUNT(*) as count FROM orders WHERE status = 'ملغى'");

    const revenueRow = await dbGet("SELECT SUM(price) as total FROM orders WHERE status != 'ملغى'");
    const todayRow = await dbGet("SELECT COUNT(*) as count FROM orders WHERE date(created_at) = CURRENT_DATE");

    res.json({
      success: true,
      stats: {
        totalOrders: parseInt(totalRow?.count || 0, 10),
        newOrders: parseInt(newRow?.count || 0, 10),
        confirmedOrders: parseInt(confirmedRow?.count || 0, 10),
        shippedOrders: parseInt(shippedRow?.count || 0, 10),
        deliveredOrders: parseInt(deliveredRow?.count || 0, 10),
        cancelledOrders: parseInt(cancelledRow?.count || 0, 10),
        todayOrders: parseInt(todayRow?.count || 0, 10),
        totalRevenue: parseFloat(revenueRow?.total || 0)
      }
    });
  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({ success: false, message: 'خطأ أثناء جلب الإحصائيات.' });
  }
});

// Get Orders
app.get('/api/admin/orders', authenticateAdmin, async (req, res) => {
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

    const orders = await dbQuery(sql, params);

    res.json({ success: true, orders });
  } catch (error) {
    console.error('Error fetching orders:', error);
    res.status(500).json({ success: false, message: 'خطأ أثناء جلب الطلبات.' });
  }
});

// Add Order Manually
app.post('/api/admin/orders', authenticateAdmin, async (req, res) => {
  try {
    const { name, phone, city, quantity, address, price, status, notes } = req.body;

    if (!name || !phone || !city) {
      return res.status(400).json({ success: false, message: 'يرجى إدخال الاسم والهاتف والمدينة.' });
    }

    const qtyVal = parseInt(quantity || 1, 10);
    const priceVal = parseFloat(price) || 199;
    const statusVal = status || 'جديد';

    const result = await dbRun(`
      INSERT INTO orders (name, phone, city, quantity, address, price, status, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [name.trim(), phone.trim(), city.trim(), qtyVal, (address || '').trim(), priceVal, statusVal, (notes || '').trim()]);

    // Auto decrement stock
    const stockRow = await dbGet('SELECT * FROM stock WHERE id = 1');
    if (stockRow && stockRow.auto_decrement) {
      const newRemaining = Math.max(0, stockRow.remaining_stock - qtyVal);
      await dbRun('UPDATE stock SET remaining_stock = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1', [newRemaining]);
      const updatedStock = await getStockInfo();
      broadcastStockUpdate(updatedStock);
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
app.patch('/api/admin/orders/:id', authenticateAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { status, notes, name, phone, city, quantity, address, price } = req.body;

    const existing = await dbGet('SELECT * FROM orders WHERE id = ?', [id]);
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

    await dbRun(`
      UPDATE orders
      SET status = ?, notes = ?, name = ?, phone = ?, city = ?, quantity = ?, address = ?, price = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [updatedStatus, updatedNotes, updatedName, updatedPhone, updatedCity, updatedQuantity, updatedAddress, updatedPrice, id]);

    res.json({ success: true, message: 'تم تحديث الطلب بنجاح.' });
  } catch (error) {
    console.error('Error updating order:', error);
    res.status(500).json({ success: false, message: 'خطأ أثناء تحديث الطلب.' });
  }
});

// Delete Order
app.delete('/api/admin/orders/:id', authenticateAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await dbRun('DELETE FROM orders WHERE id = ?', [id]);

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
app.post('/api/admin/change-password', authenticateAdmin, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword || newPassword.length < 6) {
      return res.status(400).json({ success: false, message: 'كلمة المرور الجديدة يجب أن تتكون من 6 أحرف على الأقل.' });
    }

    const row = await dbGet('SELECT value FROM settings WHERE key = ?', ['admin_password']);
    const storedHash = row ? row.value : hashPassword('admin123');

    if (hashPassword(currentPassword) !== storedHash) {
      return res.status(400).json({ success: false, message: 'كلمة المرور الحالية غير صحيحة.' });
    }

    await dbRun('UPDATE settings SET value = ? WHERE key = ?', [hashPassword(newPassword), 'admin_password']);

    res.json({ success: true, message: 'تم تغيير كلمة المرور بنجاح.' });
  } catch (error) {
    console.error('Error changing password:', error);
    res.status(500).json({ success: false, message: 'خطأ أثناء تغيير كلمة المرور.' });
  }
});

// Export CSV
app.get('/api/admin/export-csv', authenticateAdmin, async (req, res) => {
  try {
    const orders = await dbQuery('SELECT * FROM orders ORDER BY id DESC');

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
