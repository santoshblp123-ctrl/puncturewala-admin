# PunctureWala 24x7 — Admin Dashboard 🖥️

Dedicated Admin Dashboard and Management Portal for **PunctureWala 24x7** On-Demand Roadside Assistance Service.

## 🚀 Key Features:
- 📋 **Order Management**: Accept / Reject breakdown service requests.
- 🚗 **Progressive Ride Lifecycle**: Start Ride ➔ Arrived on-site ➔ Customer OTP Verification ➔ Complete Service.
- 📍 **Live Van & Mechanic Tracking**: Real-time GPS van movement and customer breakdown mapping.
- 🏪 **Permanent Workshop Settings**: Configure workshop name, phone, address, timings, and GPS coordinates.
- 📞 **Dynamic Call Banner**: Update customer hotline numbers and emergency promos in real time.
- 💰 **Rate Card & Inventory Management**: Set vehicle puncture rates and track tyre inventory.

## 💻 Hostinger & Production Deployment:
- **Single Port Unified Architecture**: Fully compatible with Hostinger Node.js environments (`process.env.PORT`).
- **Web Routes**:
  - `/admin` or `/` : Admin Dashboard
  - `/api/*` : Live SSE & REST Relay API

## 💻 Local Setup:
```bash
npm install
npm start
```
- Unified Access: `http://localhost:3000/admin` (or `http://localhost:3001`)
