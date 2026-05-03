require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const express = require('express');
const http = require('http');
const cors = require('cors');
const path = require('path');
const { initDB } = require('../server/config/db');
const { errorHandler, notFound } = require('../server/middlewares/errorMiddleware');
const { getAllowedOrigins, isOriginAllowed, getRequiredEnv } = require('../server/config/security');

// Routes
const authRoutes = require('../server/routes/auth');
const streamRoutes = require('../server/routes/streams');
const giftRoutes = require('../server/routes/gifts');
const walletRoutes = require('../server/routes/wallet');
const adminRoutes = require('../server/routes/admin');
const livekitRoutes = require('../server/routes/livekit');
const messageRoutes = require('../server/routes/messages');
const userRoutes = require('../server/routes/users');

const app = express();
const allowedOrigins = getAllowedOrigins();
const server = http.createServer(app);

  // Relaxed CORS for Vercel deployment
  app.use(cors({
      origin: true,
      credentials: true,
  }));
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

// Serve static files from the public directory
app.use(express.static(path.join(__dirname, '..', 'public')));

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/streams', streamRoutes);
app.use('/api/gifts', giftRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/livekit', livekitRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/users', userRoutes);

// Health check
app.get('/api/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

// Public config for frontend
app.get('/api/config', (req, res) => {
    res.json({
        livekitUrl: process.env.LIVEKIT_URL || null,
        supabaseUrl: process.env.SUPABASE_URL || null,
        supabaseKey: process.env.SUPABASE_KEY || null
    });
});


// Catch-all: serve SPA for any non-API route
app.get(/^(?!\/api).*/, (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// Error Handling Middleware
app.use(notFound);
app.use(errorHandler);

// Removed Socket.io handler for Vercel + Supabase Realtime

// Export the app for Vercel Serverless Functions
module.exports = app;

// Initialize DB then start server
const PORT = process.env.PORT || 3000;

// Start the server only if we're not in a serverless environment (like Vercel)
// or if we're running this file directly.
const isVercel = process.env.VERCEL === '1' || !!process.env.VERCEL;

if (!isVercel) {
    getRequiredEnv('JWT_SECRET');
    initDB();

    server.on('error', (e) => {
        if (e.code === 'EADDRINUSE') {
            console.warn(`\n⚠️  Port ${PORT} is busy, trying ${parseInt(PORT) + 1}...`);
            setTimeout(() => {
                server.close();
                server.listen(parseInt(PORT) + 1);
            }, 1000);
        }
    });

    server.listen(PORT, () => {
        console.log(`\n🚀 TangoLive server running at http://localhost:${PORT}`);
        console.log(`📺 Admin panel: http://localhost:${PORT}/admin.html`);
    });
} else {
    // In Vercel, we still need to initialize the DB on the first cold start
    initDB().catch(err => console.error("DB Init error in Vercel:", err));
}
