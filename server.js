/**
 * PunctureWala 24x7 — Real-Time Relay Server
 * Connects Customer App (port 3000) ↔ Admin Dashboard (port 3001)
 * Server runs on port 3002
 *
 * Features:
 *  - POST /api/book       → Customer submits booking + GPS location
 *  - GET  /api/orders     → Admin fetches all orders
 *  - GET  /api/events     → SSE stream → Admin gets live push notifications
 *  - POST /api/van-status → Admin toggles van free/busy → Customer sees update
 *  - GET  /api/van-status → Customer polls van availability
 */

const http = require('http');
const url  = require('url');
const fs   = require('fs');
const nodePath = require('path');

const PORT = process.env.PORT || 3000;
const CUSTOMER_PORT = 3000;
const ADMIN_PORT = 3001;
const RELAY_PORT = 3002;

// Persistent disk storage
const DATA_DIR = nodePath.join(__dirname, 'data');
const ORDERS_FILE = nodePath.join(DATA_DIR, 'orders.json');
const USERS_FILE = nodePath.join(DATA_DIR, 'users.json');

function saveOrdersToDisk() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2), 'utf8');
  } catch(e) {}
}

// In-memory store (starts completely clean, loads from disk if present)
let orders = [];
let users = [];

function saveUsersToDisk() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf8');
  } catch(e) {}
}

function loadUsersFromDisk() {
  try {
    if (fs.existsSync(USERS_FILE)) {
      const raw = fs.readFileSync(USERS_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) users = parsed;
    }
  } catch(e) {}
}
loadUsersFromDisk();

function loadOrdersFromDisk() {
  try {
    if (fs.existsSync(ORDERS_FILE)) {
      const raw = fs.readFileSync(ORDERS_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        orders = parsed;
      }
    }
  } catch(e) {}
}
loadOrdersFromDisk();
let vanStatus       = { free: true, busyMinutes: 0 };
let adminClients    = []; // SSE connections from Admin
let customerClients = {}; // SSE connections from Customer { orderId: [res,...] }
let mechanicLocs    = {}; // Latest mechanic location per orderId
let otpStore        = {}; // OTP per orderId { otp, verified }
orders.forEach(o => {
  if (o.otp) otpStore[o.id] = { otp: o.otp, verified: false, createdAt: Date.now() };
});
let mechanicContact = {
  name: 'SANTOSH (ऑन-ड्यूटी)',
  phone: '9876543210',
  tagline: 'सीधे कॉल करें • 10-15 मिनट में ऑन-साइट पहुँचेगा'
};
let shopLocation = {
  name: 'रमेश टायर & पंचर वर्क्स (मेन वर्कशॉप)',
  address: 'NH-205 हाईवे, बिलासपुर (HP)',
  landmark: '31°19\'48.8"N 76°52\'23.9"E',
  phone: '9876543210',
  timings: '24×7 खुला है (Always Open)',
  lat: 31.3302174,
  lng: 76.8732986,
  distanceKm: 2.1
};
let savedVehicleModels = [
  'Maruti Swift', 'Hyundai Creta', 'Hero Splendor', 'Mahindra Thar',
  'Mahindra Scorpio', 'Honda Activa', 'Bajaj Pulsar', 'Maruti Baleno',
  'Toyota Innova', 'Tata Nexon', 'Hyundai i20', 'Royal Enfield Classic 350'
];
let feedbackList    = [];
let orderCounter    = 1000;

// ── Utility ────────────────────────────────────────────────────────────────
function genOrderId() { return 'PW-' + (++orderCounter); }

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function json(res, data, status = 200) {
  cors(res);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise(resolve => {
    let chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(JSON.parse(raw));
      }
      catch { resolve({}); }
    });
  });
}

// ── Push event to all Admin SSE clients ────────────────────────────────────
function pushToAdmin(eventName, data) {
  const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
  adminClients = adminClients.filter(client => {
    try {
      client.write(payload);
      return true;
    } catch {
      return false;
    }
  });
  console.log(`[PUSH] '${eventName}' pushed to ${adminClients.length} client(s)`);
}

// ── HTTP Server ─────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const parsed  = url.parse(req.url, true);
  const path    = parsed.pathname;
  const method  = req.method;

  // CORS preflight
  if (method === 'OPTIONS') { cors(res); res.writeHead(204); res.end(); return; }

  // ── POST /api/book ──────────────────────────────────────────────────────
  if (path === '/api/book' && method === 'POST') {
    const body = await readBody(req);
    const orderId = genOrderId();
    const otp = String(Math.floor(1000 + Math.random() * 9000));
    otpStore[orderId] = { otp, verified: false, createdAt: Date.now() };

    const order = {
      id:          orderId,
      otp:         otp,
      customer:    body.customer    || 'अज्ञात ग्राहक',
      phone:       body.phone       || 'N/A',
      service:       body.service       || 'पंचर रिपेयर',
      vehicle:       body.vehicle       || 'car',
      vehicleModel:  body.vehicleModel  || '',
      vehicleNumber: body.vehicleNumber || 'नहीं बताया',
      distanceKm:    body.distanceKm    || 0,
      distance:    body.distanceKm  || 0,   // alias for admin
      amount:      body.amount      || 0,
      vip:         body.vip         || false,
      address:     body.address     || 'लोकेशन अज्ञात',
      lat:         body.lat         || null,
      lng:         body.lng         || null,
      status:      'pending',
      bookedAt:    new Date().toLocaleTimeString('hi-IN', { hour: '2-digit', minute: '2-digit' }),
      time:        new Date().toLocaleTimeString('hi-IN', { hour: '2-digit', minute: '2-digit' }),
      timestamp:   Date.now(),
    };
    orders.unshift(order);
    saveOrdersToDisk();

    // Link and increment user total orders
    const custPhone = String(body.phone || '').trim();
    const custName = String(body.customer || '').trim();
    const cleanPhone = custPhone.replace(/\D/g, '').slice(-10);
    let matchingUser = users.find(u => {
      const uPhone = String(u.phone || '').replace(/\D/g, '').slice(-10);
      return (cleanPhone && uPhone && uPhone === cleanPhone) || (custName && custName !== 'अज्ञात ग्राहक' && u.name === custName);
    });
    if (matchingUser) {
      matchingUser.totalOrders = (matchingUser.totalOrders || 0) + 1;
      saveUsersToDisk();
      pushToAdmin('all-users', users);
    }

    // Save new vehicle model if not already in list
    if (order.vehicleModel && order.vehicleModel.trim()) {
      const cleanModel = order.vehicleModel.trim();
      const exists = savedVehicleModels.some(m => m.toLowerCase() === cleanModel.toLowerCase());
      if (!exists) {
        savedVehicleModels.unshift(cleanModel);
        console.log(`[SAVED NEW MODEL] ${cleanModel}`);
      }
    }

    // 🔔 Push real-time alert to Admin
    pushToAdmin('new-order', order);
    pushToAdmin('all-orders', orders);

    console.log(`[NEW ORDER] ${order.id} | ${order.customer} | ${order.service} | ₹${order.amount} | OTP:${order.otp} | Lat:${order.lat} Lng:${order.lng}`);
    return json(res, { success: true, orderId: order.id, order, otp });
  }

  // ── POST /api/generate-otp  (Mechanic arrived → generate OTP for customer) ─
  if (path === '/api/generate-otp' && method === 'POST') {
    const body = await readBody(req);
    const { orderId } = body;
    if (!orderId) return json(res, { error: 'orderId required' }, 400);

    const existingOtp = (otpStore[orderId] && !otpStore[orderId].verified) ? otpStore[orderId].otp : null;
    const otp = existingOtp || String(Math.floor(1000 + Math.random() * 9000));
    otpStore[orderId] = { otp, verified: false, createdAt: Date.now() };

    const ord = orders.find(o => o.id === orderId);
    if (ord) ord.otp = otp;

    // Send OTP to customer via SSE
    const clients = customerClients[orderId] || [];
    const payload = `event: otp-generated\ndata: ${JSON.stringify({ orderId, otp })}\n\n`;
    customerClients[orderId] = clients.filter(c => {
      try { c.write(payload); return true; } catch { return false; }
    });
    console.log(`[OTP] ${orderId} → ${otp}`);
    return json(res, { success: true, otp });
  }

  // ── POST /api/verify-otp  (Mechanic enters OTP from customer) ───────────
  if (path === '/api/verify-otp' && method === 'POST') {
    const body = await readBody(req);
    const orderId = String(body.orderId || '').trim();
    const otp = String(body.otp || '').trim();

    if (!orderId || !otp) {
      return json(res, { success: false, verified: false, error: 'Order ID और 4-अंकों का OTP आवश्यक हैं' });
    }

    const order = orders.find(o => o.id === orderId);
    let stored = otpStore[orderId];
    if (!stored && order && order.otp) {
      stored = { otp: String(order.otp).trim(), verified: false, createdAt: Date.now() };
      otpStore[orderId] = stored;
    }
    if (!stored && order) {
      const fallbackOtp = String(Math.floor(1000 + Math.random() * 9000));
      order.otp = fallbackOtp;
      stored = { otp: fallbackOtp, verified: false, createdAt: Date.now() };
      otpStore[orderId] = stored;
    }

    const expectedOtp = stored ? String(stored.otp).trim() : (order && order.otp ? String(order.otp).trim() : '');

    // Allow matching stored OTP, order.otp, or universal test code '1234'
    const isCorrect = (expectedOtp && otp === expectedOtp) || (order && String(order.otp).trim() === otp) || otp === '1234';

    if (isCorrect) {
      if (stored) stored.verified = true;
      if (order) {
        order.status = 'active';
        order.otpVerified = true;
        // 🛻 Place mechanic vehicle directly at customer location (On-Site)
        const onSiteLoc = {
          lat: (order.lat || 31.3302174) + 0.00012,
          lng: (order.lng || 76.8732986) + 0.00015,
          orderId: order.id,
          onSite: true,
          status: 'active',
          customer: order.customer
        };
        mechanicLocs[orderId] = onSiteLoc;
        saveOrdersToDisk();
      }
      pushToAdmin('otp-verified', { orderId, order });
      if (order) pushToAdmin('order-updated', order);
      // Notify customer
      const clients = customerClients[orderId] || [];
      const okPayload = `event: otp-verified\ndata: ${JSON.stringify({ orderId })}\n\n`;
      const locPayload = `event: mechanic-location\ndata: ${JSON.stringify(mechanicLocs[orderId] || {})}\n\n`;
      const workPayload = `event: work-started\ndata: ${JSON.stringify({ orderId, status: 'active' })}\n\n`;
      clients.forEach(c => {
        try {
          c.write(okPayload);
          c.write(locPayload);
          c.write(workPayload);
          return true;
        } catch { return false; }
      });
      console.log(`[OTP VERIFIED] ${orderId} — Van placed at customer location`);
      return json(res, { success: true, verified: true, order });
    } else {
      console.log(`[OTP WRONG] ${orderId} entered:${otp} expected:${expectedOtp}`);
      return json(res, {
        success: false,
        verified: false,
        error: 'गलत OTP दर्ज किया गया है! कृपया ग्राहक की स्क्रीन देखकर सही OTP डालें।'
      });
    }
  }

  // ── POST /api/clear-orders  (Admin clears all orders) ──────────────────
  if (path === '/api/clear-orders' && (method === 'POST' || method === 'GET')) {
    orders = [];
    mechanicLocs = {};
    saveOrdersToDisk();
    pushToAdmin('orders-cleared', {});
    console.log('[CLEAR] All orders cleared by admin');
    return json(res, { success: true, orders: [] });
  }

  // ── POST /api/delete-order  (Admin deletes single order permanently) ───
  if (path === '/api/delete-order' && method === 'POST') {
    const body = await readBody(req);
    const orderId = body.orderId || body.id;
    orders = orders.filter(o => o.id !== orderId);
    delete mechanicLocs[orderId];
    delete otpStore[orderId];
    saveOrdersToDisk();
    pushToAdmin('order-deleted', { orderId });
    console.log(`[DELETE] Order ${orderId} deleted permanently`);
    return json(res, { success: true, orderId });
  }

  // ── POST /api/user-login (Track registered / logged-in users) ─────────────
  if (path === '/api/user-login' && method === 'POST') {
    const body = await readBody(req);
    const email = String(body.email || '').trim().toLowerCase();
    const phone = String(body.phone || '').trim();
    const uid = String(body.uid || '').trim();
    const name = String(body.name || '').trim() || (email ? email.split('@')[0] : 'ग्राहक');
    const photoURL = String(body.photoURL || body.picture || '').trim();
    const provider = String(body.provider || (email ? 'google' : 'phone')).trim();
    const device = String(body.device || 'Android App').trim();

    let existing = null;
    if (uid) {
      existing = users.find(u => u.uid === uid);
    }
    if (!existing && email) {
      existing = users.find(u => u.email && u.email.toLowerCase() === email);
    }
    if (!existing && phone) {
      existing = users.find(u => u.phone && u.phone === phone);
    }

    const now = Date.now();
    if (existing) {
      existing.lastLogin = now;
      existing.loginCount = (existing.loginCount || 1) + 1;
      if (name && name !== 'ग्राहक') existing.name = name;
      if (photoURL) existing.photoURL = photoURL;
      if (phone && !existing.phone) existing.phone = phone;
      if (email && !existing.email) existing.email = email;
      existing.provider = provider || existing.provider;
      existing.device = device || existing.device;
    } else {
      const newUser = {
        id: 'USR-' + (1001 + users.length),
        uid: uid || ('usr_' + now),
        name,
        email,
        phone,
        photoURL,
        provider,
        firstLogin: now,
        lastLogin: now,
        loginCount: 1,
        totalOrders: 0,
        device
      };
      users.unshift(newUser);
      existing = newUser;
    }

    saveUsersToDisk();
    pushToAdmin('all-users', users);
    console.log(`[USER LOGIN] ${existing.name} (${existing.provider}) - Total users: ${users.length}`);
    return json(res, { success: true, user: existing, totalUsers: users.length });
  }

  // ── GET /api/users (Admin gets all logged-in users) ───────────────────────
  if (path === '/api/users' && method === 'GET') {
    return json(res, {
      success: true,
      users,
      total: users.length,
      googleUsers: users.filter(u => u.provider === 'google').length,
      phoneUsers: users.filter(u => u.provider === 'phone').length
    });
  }

  // ── POST /api/delete-user (Admin removes a user) ──────────────────────────
  if (path === '/api/delete-user' && method === 'POST') {
    const body = await readBody(req);
    const userId = body.id || body.userId || body.uid;
    if (userId) {
      users = users.filter(u => u.id !== userId && u.uid !== userId);
      saveUsersToDisk();
      pushToAdmin('all-users', users);
      console.log(`[DELETE USER] User ${userId} removed`);
    }
    return json(res, { success: true, users, total: users.length });
  }

  // ── POST /api/feedback  (Customer submits star rating & feedback) ───────
  if (path === '/api/feedback' && method === 'POST') {
    const body = await readBody(req);
    const feedback = {
      id: 'FB-' + Date.now().toString().slice(-4),
      orderId: body.orderId || 'PW-????',
      rating: body.rating || 5,
      tags: body.tags || [],
      comment: body.comment || '',
      customer: body.customer || 'ग्राहक',
      time: new Date().toLocaleTimeString('hi-IN', { hour: '2-digit', minute: '2-digit' }),
      timestamp: Date.now()
    };
    feedbackList.unshift(feedback);
    console.log(`[CUSTOMER FEEDBACK] ${feedback.orderId} → ${feedback.rating}★ | ${feedback.customer} | "${feedback.comment}"`);
    pushToAdmin('customer-feedback', feedback);
    return json(res, { success: true, feedback });
  }

  if (path === '/api/feedback' && method === 'GET') {
    return json(res, feedbackList);
  }

  // ── GET/POST /api/vehicle-models ───────────────────────────────────────
  if (path === '/api/vehicle-models') {
    if (method === 'GET') {
      return json(res, savedVehicleModels);
    }
    if (method === 'POST') {
      const body = await readBody(req);
      if (body.model && body.model.trim()) {
        const clean = body.model.trim();
        if (!savedVehicleModels.some(m => m.toLowerCase() === clean.toLowerCase())) {
          savedVehicleModels.unshift(clean);
        }
      }
      return json(res, { success: true, models: savedVehicleModels });
    }
  }

  // ── GET /api/orders ─────────────────────────────────────────────────────
  if (path === '/api/orders' && method === 'GET') {
    return json(res, orders);
  }

  // ── POST /api/mechanic-location  (Admin sends mechanic GPS) ────────────
  if (path === '/api/mechanic-location' && method === 'POST') {
    const body = await readBody(req);
    const { orderId, lat, lng } = body;
    if (!orderId) return json(res, { error: 'orderId required' }, 400);

    const isFirstUpdate = !mechanicLocs[orderId];
    mechanicLocs[orderId] = { lat, lng, ts: Date.now() };

    const clients = customerClients[orderId] || [];

    // On first location update → notify customer mechanic is on the way
    if (isFirstUpdate) {
      const startedPayload = `event: mechanic-started\ndata: ${JSON.stringify({ orderId, lat, lng })}\n\n`;
      clients.forEach(c => { try { c.write(startedPayload); } catch {} });
      console.log(`[MECHANIC STARTED] ${orderId} — notifying customers`);
    }

    // Push live location update
    const payload = `event: mechanic-location\ndata: ${JSON.stringify({ lat, lng, orderId })}\n\n`;
    customerClients[orderId] = clients.filter(c => {
      try { c.write(payload); return true; } catch { return false; }
    });
    console.log(`[MECHANIC LOC] ${orderId} → ${lat}, ${lng} | Customers watching: ${(customerClients[orderId]||[]).length}`);
    return json(res, { success: true });
  }

  // ── POST /api/mechanic-started  (Admin explicitly signals on-the-way) ──
  if (path === '/api/mechanic-started' && method === 'POST') {
    const body = await readBody(req);
    const { orderId } = body;
    const clients = customerClients[orderId] || [];
    const payload = `event: mechanic-started\ndata: ${JSON.stringify({ orderId })}\n\n`;
    customerClients[orderId] = clients.filter(c => {
      try { c.write(payload); return true; } catch { return false; }
    });
    console.log(`[ON THE WAY] ${orderId} — ${clients.length} customers notified`);
    return json(res, { success: true });
  }

  // ── GET /api/track/:orderId  (Customer SSE for mechanic location) ───────
  if (path.startsWith('/api/track/') && method === 'GET') {
    const orderId = path.replace('/api/track/', '');
    cors(res);
    res.writeHead(200, {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
    });
    res.write(`event: connected\ndata: {"orderId":"${orderId}"}\n\n`);

    const existingOrder = orders.find(o => o.id === orderId);

    // If order is active (काम चालू है) -> send mechanic location right at customer location
    if (existingOrder && existingOrder.status === 'active') {
      const onSiteLoc = {
        lat: (existingOrder.lat || 31.3302174) + 0.00012,
        lng: (existingOrder.lng || 76.8732986) + 0.00015,
        orderId: existingOrder.id,
        onSite: true,
        status: 'active',
        customer: existingOrder.customer
      };
      mechanicLocs[orderId] = onSiteLoc;
      res.write(`event: mechanic-location\ndata: ${JSON.stringify(onSiteLoc)}\n\n`);
      res.write(`event: work-started\ndata: ${JSON.stringify({ orderId, status: 'active', customer: existingOrder.customer })}\n\n`);
    } else if (mechanicLocs[orderId]) {
      res.write(`event: mechanic-location\ndata: ${JSON.stringify(mechanicLocs[orderId])}\n\n`);
    }

    // Send active OTP to customer ONLY when arrived or active (not while pending or on the way)
    if (otpStore[orderId] && !otpStore[orderId].verified && existingOrder && (existingOrder.status === 'arrived' || existingOrder.status === 'active')) {
      res.write(`event: otp-generated\ndata: ${JSON.stringify({ orderId, otp: otpStore[orderId].otp })}\n\n`);
    }

    if (existingOrder && existingOrder.status === 'accepted') {
      res.write(`event: order-accepted\ndata: ${JSON.stringify({ orderId: existingOrder.id, status: 'accepted' })}\n\n`);
    }

    if (existingOrder && existingOrder.status === 'onway') {
      res.write(`event: mechanic-started\ndata: ${JSON.stringify({ orderId: existingOrder.id, status: 'onway' })}\n\n`);
    }

    if (existingOrder && existingOrder.status === 'arrived') {
      const currentOtp = otpStore[orderId] ? otpStore[orderId].otp : (existingOrder.otp || '1234');
      res.write(`event: mechanic-arrived\ndata: ${JSON.stringify({ orderId: existingOrder.id, status: 'arrived', otp: currentOtp })}\n\n`);
    }

    // If order is already cancelled, notify immediately on connect
    if (existingOrder && existingOrder.status === 'cancelled') {
      res.write(`event: order-cancelled\ndata: ${JSON.stringify({
        orderId: existingOrder.id,
        status: 'cancelled',
        reason: existingOrder.cancelReason || 'एडमिन द्वारा ऑर्डर रद्द कर दिया गया'
      })}\n\n`);
    }

    // If order is already done, notify immediately on connect
    if (existingOrder && existingOrder.status === 'done') {
      res.write(`event: order-completed\ndata: ${JSON.stringify({
        orderId: existingOrder.id,
        status: 'done',
        customer: existingOrder.customer,
        service: existingOrder.service,
        amount: existingOrder.amount,
        time: existingOrder.time
      })}\n\n`);
    }

    if (!customerClients[orderId]) customerClients[orderId] = [];
    customerClients[orderId].push(res);
    console.log(`[TRACK SSE] Customer watching order ${orderId}. Total: ${customerClients[orderId].length}`);

    req.on('close', () => {
      customerClients[orderId] = (customerClients[orderId] || []).filter(c => c !== res);
      console.log(`[TRACK SSE] Customer disconnected from ${orderId}`);
    });
    return;
  }

  // ── POST /api/order-status ──────────────────────────────────────────────
  if (path === '/api/order-status' && method === 'POST') {
    const body  = await readBody(req);
    let order = orders.find(o => o.id === body.id);
    if (!order) {
      order = {
        id: body.id,
        customer: body.customer || 'अमित शर्मा',
        phone: body.phone || '98765-XXXXX',
        service: body.service || 'पंचर रिपेयर (कार)',
        vehicle: body.vehicle || 'car',
        vehicleNumber: body.vehicleNumber || 'नहीं बताया',
        amount: body.amount || 317,
        status: body.status || 'cancelled',
        cancelReason: body.reason || '',
        time: new Date().toLocaleTimeString('hi-IN', { hour: '2-digit', minute: '2-digit' }),
        timestamp: Date.now()
      };
      orders.unshift(order);
    saveOrdersToDisk();

    // Link and increment user total orders
    const custPhone = String(body.phone || '').trim();
    const custName = String(body.customer || '').trim();
    const cleanPhone = custPhone.replace(/\D/g, '').slice(-10);
    let matchingUser = users.find(u => {
      const uPhone = String(u.phone || '').replace(/\D/g, '').slice(-10);
      return (cleanPhone && uPhone && uPhone === cleanPhone) || (custName && custName !== 'अज्ञात ग्राहक' && u.name === custName);
    });
    if (matchingUser) {
      matchingUser.totalOrders = (matchingUser.totalOrders || 0) + 1;
      saveUsersToDisk();
      pushToAdmin('all-users', users);
    }
    } else {
      order.status = body.status;
      if (body.reason) order.cancelReason = body.reason;
      if (body.status === 'pending' || body.status === 'accepted') {
        order.otpVerified = false;
        if (otpStore[order.id]) otpStore[order.id].verified = false;
      }
    }

    saveOrdersToDisk();

    // Real-time update to all Admin dashboards
    pushToAdmin('order-updated', order);

    // Real-time update to Customer listening on track SSE
    const clients = customerClients[order.id] || [];
    if (order.status === 'cancelled') {
      const cancelPayload = `event: order-cancelled\ndata: ${JSON.stringify({
        orderId: order.id,
        status: 'cancelled',
        reason: order.cancelReason || 'एडमिन द्वारा ऑर्डर रद्द कर दिया गया'
      })}\n\n`;
      clients.forEach(c => { try { c.write(cancelPayload); } catch {} });
      console.log(`[ORDER CANCELLED] ${order.id} | Reason: ${order.cancelReason} | Notified ${clients.length} customer(s)`);
    } else {
      const statusPayload = `event: order-status-update\ndata: ${JSON.stringify({
        orderId: order.id,
        status: order.status
      })}\n\n`;
      clients.forEach(c => { try { c.write(statusPayload); } catch {} });

      // 1. If accepted (बुकिंग स्वीकार की)
      if (order.status === 'accepted') {
        const acceptPayload = `event: order-accepted\ndata: ${JSON.stringify({
          orderId: order.id,
          status: 'accepted',
          customer: order.customer
        })}\n\n`;
        clients.forEach(c => { try { c.write(acceptPayload); } catch {} });
        console.log(`[ORDER ACCEPTED] ${order.id} | Notified ${clients.length} customer(s)`);
      }

      // 2. If onway (राइड शुरू हुई / रास्ते में है)
      if (order.status === 'onway') {
        const onwayPayload = `event: mechanic-started\ndata: ${JSON.stringify({
          orderId: order.id,
          status: 'onway',
          customer: order.customer
        })}\n\n`;
        clients.forEach(c => { try { c.write(onwayPayload); } catch {} });
        console.log(`[RIDE STARTED / ONWAY] ${order.id} | Notified ${clients.length} customer(s)`);
      }

      // 3. If arrived (ग्राहक के पास पहुँच गए) -> Trigger OTP on customer screen!
      if (order.status === 'arrived') {
        if (!otpStore[order.id]) {
          const genOtp = order.otp || String(Math.floor(1000 + Math.random() * 9000));
          otpStore[order.id] = { otp: genOtp, verified: false, createdAt: Date.now() };
          order.otp = genOtp;
        }
        const currentOtp = otpStore[order.id].otp;
        const arrivedPayload = `event: mechanic-arrived\ndata: ${JSON.stringify({
          orderId: order.id,
          status: 'arrived',
          otp: currentOtp
        })}\n\n`;
        const otpPayload = `event: otp-generated\ndata: ${JSON.stringify({
          orderId: order.id,
          otp: currentOtp
        })}\n\n`;
        clients.forEach(c => { try { c.write(arrivedPayload); c.write(otpPayload); } catch {} });
        console.log(`[MECHANIC ARRIVED] ${order.id} | OTP sent to customer: ${currentOtp}`);
      }

      // 4. If done (काम पूरा हुआ) -> Trigger celebration animation & feedback flow on customer app
      if (order.status === 'done') {
        const donePayload = `event: order-completed\ndata: ${JSON.stringify({
          orderId: order.id,
          status: 'done',
          customer: order.customer,
          service: order.service,
          amount: order.amount,
          time: order.time
        })}\n\n`;
        clients.forEach(c => { try { c.write(donePayload); } catch {} });
        console.log(`[ORDER COMPLETED] ${order.id} | Notified ${clients.length} customer(s) to celebrate & review`);
      }

      // If active (काम चालू है) -> Place mechanic van at customer's location
      if (order.status === 'active') {
        const onSiteLoc = {
          lat: (order.lat || 31.3302174) + 0.00012,
          lng: (order.lng || 76.8732986) + 0.00015,
          orderId: order.id,
          onSite: true,
          status: 'active',
          customer: order.customer
        };
        mechanicLocs[order.id] = onSiteLoc;
        const locPayload = `event: mechanic-location\ndata: ${JSON.stringify(onSiteLoc)}\n\n`;
        const workPayload = `event: work-started\ndata: ${JSON.stringify({ orderId: order.id, status: 'active', customer: order.customer })}\n\n`;
        clients.forEach(c => { try { c.write(locPayload); c.write(workPayload); } catch {} });
      }
    }

    console.log(`[STATUS] ${order.id} → ${body.status}`);
    return json(res, { success: true, order });
  }

  // ── GET /api/events  (SSE — Admin & Customer listen here) ────────────────
  if (path === '/api/events' && method === 'GET') {
    cors(res);
    res.writeHead(200, {
      'Content-Type':      'text/event-stream; charset=utf-8',
      'Cache-Control':     'no-cache, no-transform',
      'Connection':        'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`event: connected\ndata: {"msg":"Connected to PunctureWala Live Server"}\n\n`);
    adminClients.push(res);
    console.log(`[SSE] Client connected. Total live clients: ${adminClients.length}`);

    // Send current orders on connect
    res.write(`event: all-orders\ndata: ${JSON.stringify(orders)}\n\n`);
    res.write(`event: mechanic-contact-updated\ndata: ${JSON.stringify(mechanicContact)}\n\n`);
    res.write(`event: van-status\ndata: ${JSON.stringify(vanStatus)}\n\n`);
    res.write(`event: shop-location-updated\ndata: ${JSON.stringify(shopLocation)}\n\n`);

    req.on('close', () => {
      adminClients = adminClients.filter(c => c !== res);
      console.log(`[SSE] Admin disconnected. Remaining: ${adminClients.length}`);
    });
    return; // keep connection alive
  }

  // ── GET/POST /api/mechanic-contact ──────────────────────────────────────
  if (path === '/api/mechanic-contact') {
    if (method === 'GET') return json(res, mechanicContact);
    if (method === 'POST') {
      const body = await readBody(req);
      mechanicContact = { ...mechanicContact, ...body };
      pushToAdmin('mechanic-contact-updated', mechanicContact);
      console.log(`[MECHANIC CONTACT UPDATED] Phone: ${mechanicContact.phone} Name: ${mechanicContact.name}`);
      return json(res, { success: true, mechanicContact });
    }
  }

  // ── GET/POST /api/van-status ─────────────────────────────────────────────
  if (path === '/api/van-status') {
    if (method === 'GET')  return json(res, vanStatus);
    if (method === 'POST') {
      const body = await readBody(req);
      vanStatus  = { ...vanStatus, ...body };
      pushToAdmin('van-status', vanStatus);
      console.log(`[VAN STATUS] free=${vanStatus.free}`);
      return json(res, { success: true, vanStatus });
    }
  }

  // ── GET/POST /api/shop-location ──────────────────────────────────────────
  if (path === '/api/shop-location') {
    if (method === 'GET') return json(res, shopLocation);
    if (method === 'POST') {
      const body = await readBody(req);
      shopLocation = { ...shopLocation, ...body };
      pushToAdmin('shop-location-updated', shopLocation);
      console.log(`[SHOP LOCATION UPDATED] Name: ${shopLocation.name} Address: ${shopLocation.address}`);
      return json(res, { success: true, shopLocation });
    }
  }

  // ── API 404 ──────────────────────────────────────────────────────────────
  if (path.startsWith('/api/')) {
    return json(res, { error: 'API endpoint not found' }, 404);
  }

  // ── Static Files & Admin/Customer Routing (Unified for Hostinger) ────────
  return handleStaticRequest(req, res, path);
});

const MIME_TYPES = {
  '.html':        'text/html; charset=utf-8',
  '.js':          'application/javascript; charset=utf-8',
  '.css':         'text/css; charset=utf-8',
  '.json':        'application/json; charset=utf-8',
  '.png':         'image/png',
  '.jpg':         'image/jpeg',
  '.jpeg':        'image/jpeg',
  '.gif':         'image/gif',
  '.svg':         'image/svg+xml',
  '.ico':         'image/x-icon',
  '.apk':         'application/vnd.android.package-archive',
  '.webmanifest': 'application/manifest+json',
  '.txt':         'text/plain; charset=utf-8',
};

function sendFile(res, filePath) {
  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }

    const ext = nodePath.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    cors(res);
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*'
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

function handleStaticRequest(req, res, pathname) {
  let decoded = '/';
  try {
    decoded = decodeURIComponent(pathname || '/');
  } catch (e) {
    decoded = pathname || '/';
  }

  // Route: /admin or /admin/ or /admin/index.html
  if (decoded === '/admin' || decoded === '/admin/' || decoded === '/admin/index.html') {
    const adminIndex = nodePath.join(__dirname, 'admin', 'index.html');
    if (fs.existsSync(adminIndex)) {
      return sendFile(res, adminIndex);
    }
    const rootIndex = nodePath.join(__dirname, 'index.html');
    if (fs.existsSync(rootIndex)) {
      return sendFile(res, rootIndex);
    }
  }

  // Route: /admin/*
  if (decoded.startsWith('/admin/')) {
    const sub = decoded.slice(7);
    const safeSub = nodePath.normalize(sub).replace(/^(\.\.[\/\\])+/, '');
    const inAdmin = nodePath.join(__dirname, 'admin', safeSub);
    if (fs.existsSync(inAdmin) && fs.statSync(inAdmin).isFile()) {
      return sendFile(res, inAdmin);
    }
    const inRoot = nodePath.join(__dirname, safeSub);
    if (fs.existsSync(inRoot) && fs.statSync(inRoot).isFile()) {
      return sendFile(res, inRoot);
    }
  }

  // Route: / or /index.html
  if (decoded === '/' || decoded === '/index.html') {
    const rootIndex = nodePath.join(__dirname, 'index.html');
    if (fs.existsSync(rootIndex)) {
      return sendFile(res, rootIndex);
    }
    const adminIndex = nodePath.join(__dirname, 'admin', 'index.html');
    if (fs.existsSync(adminIndex)) {
      return sendFile(res, adminIndex);
    }
  }

  // Static files in root or admin directory
  const safePath = nodePath.normalize(decoded).replace(/^(\.\.[\/\\])+/, '');
  const candidateRoot = nodePath.join(__dirname, safePath);
  if (fs.existsSync(candidateRoot) && fs.statSync(candidateRoot).isFile()) {
    return sendFile(res, candidateRoot);
  }
  const candidateAdmin = nodePath.join(__dirname, 'admin', safePath);
  if (fs.existsSync(candidateAdmin) && fs.statSync(candidateAdmin).isFile()) {
    return sendFile(res, candidateAdmin);
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('404 Not Found');
}

// Start Main Unified Server (process.env.PORT on Hostinger or 3000 locally)
server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  ╔════════════════════════════════════════════════════════════╗');
  console.log('  ║              PunctureWala 24x7 — Unified Server            ║');
  console.log('  ╠════════════════════════════════════════════════════════════╣');
  console.log(`  ║  🚀 Server Active    : http://localhost:${PORT}                ║`);
  console.log(`  ║  📱 Customer App     : http://localhost:${PORT}/               ║`);
  console.log(`  ║  🖥️  Admin Dashboard  : http://localhost:${PORT}/admin          ║`);
  console.log(`  ║  ⚡ API & SSE Relay  : http://localhost:${PORT}/api/*          ║`);
  console.log('  ╚════════════════════════════════════════════════════════════╝');
  console.log('');
});

// Backward-compatibility listeners for local development only
if (!process.env.PORT) {
  try {
    const adminServer = http.createServer((req, res) => {
      const p = url.parse(req.url).pathname;
      if (p.startsWith('/api/')) {
        server.emit('request', req, res);
      } else {
        const adminIndex = nodePath.join(__dirname, 'admin', 'index.html');
        if ((p === '/' || p === '/index.html') && fs.existsSync(adminIndex)) {
          sendFile(res, adminIndex);
        } else {
          handleStaticRequest(req, res, p.startsWith('/admin') ? p : '/admin' + p);
        }
      }
    });
    adminServer.on('error', (e) => console.log('  (Port 3001 fallback skipped:', e.message, ')'));
    adminServer.listen(3001, () => console.log('  🖥️  Admin Panel also on http://localhost:3001'));
  } catch (e) {}

  try {
    const relayServer = http.createServer((req, res) => {
      server.emit('request', req, res);
    });
    relayServer.on('error', (e) => console.log('  (Port 3002 fallback skipped:', e.message, ')'));
    relayServer.listen(3002, () => console.log('  ⚡ API Relay also on http://localhost:3002'));
  } catch (e) {}
}
