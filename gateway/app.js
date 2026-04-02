const express = require('express');
const mongoose = require('mongoose');
const session = require('express-session');
const axios = require('axios');
const path = require('path');
const bcrypt = require('bcryptjs');
require('dotenv').config();

const app = express();

// Configuration
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;
const EVOLUTION_API_URL = process.env.SERVER_URL || 'http://evolution-api:8080';
const EVOLUTION_API_KEY = process.env.AUTHENTICATION_API_KEY || 'my-super-secret-global-api-key-123';

// Models
const userSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    role: { type: String, enum: ['admin', 'customer'], default: 'customer' },
    credits: { type: Number, default: 0 },
    instanceName: { type: String },
    isActive: { type: Boolean, default: true },
    apiKey: { type: String, unique: true },
    webhookUrl: { type: String, default: '' }
});

const messageLogSchema = new mongoose.Schema({
    instanceName: String,
    remoteJid: String,
    content: String,
    status: { type: String, default: 'received' },
    timestamp: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);
const MessageLog = mongoose.model('MessageLog', messageLogSchema);

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.set('view engine', 'ejs');

app.use(session({
    secret: 'whatsapp-saas-secret-key-99',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false }
}));

// Auth Middlewares
const isAuthenticated = (req, res, next) => {
    if (req.session.user) return next();
    res.redirect('/login');
};

const isAdmin = (req, res, next) => {
    if (req.session.user && req.session.user.role === 'admin') return next();
    res.redirect('/customer');
};

const isCustomer = (req, res, next) => {
    if (req.session.user && req.session.user.role === 'customer') return next();
    res.redirect('/admin');
};

// 1. Auth Routes
app.get('/login', (req, res) => {
    res.render('login', { error: null });
});

app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const user = await User.findOne({ username });
        if (user && await bcrypt.compare(password, user.password)) {
            req.session.user = { id: user._id, username: user.username, role: user.role };
            return res.redirect(user.role === 'admin' ? '/admin' : '/customer');
        }
        res.render('login', { error: 'Invalid username or password' });
    } catch (e) {
        res.render('login', { error: 'Server error' });
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
});

// 2. Public API - Message Send
app.post('/v1/messages/send', async (req, res) => {
    const apiKey = req.headers['x-api-key'];
    if (!apiKey) return res.status(401).json({ success: false, error: 'Missing API Key' });

    try {
        const user = await User.findOne({ apiKey, isActive: true });
        if (!user) return res.status(401).json({ success: false, error: 'Invalid or inactive API Key' });
        if (user.credits <= 0) return res.status(403).json({ success: false, error: 'Insufficient credits' });

        const { number, text } = req.body;
        if (!number || !text) return res.status(400).json({ success: false, error: 'Missing "number" or "text"' });

        const response = await axios.post(`${EVOLUTION_API_URL}/message/sendText/${user.instanceName}`, {
            number,
            options: { delay: 1200, presence: "composing" },
            text
        }, { headers: { 'apikey': EVOLUTION_API_KEY } });

        user.credits -= 1;
        await user.save();
        res.json({ success: true, data: response.data });
    } catch (error) {
        console.error("Public API Send Error:", error.response?.data || error.message);
        res.status(500).json({ success: false, error: 'Failed to send message via Evolution API' });
    }
});

// 3. Webhook Receiver
app.post('/webhook/whatsapp', async (req, res) => {
    const payload = req.body;
    const instanceName = payload.instance;

    if (payload.event === 'messages.upsert') {
        try {
            const user = await User.findOne({ instanceName });
            if (user) {
                const messageData = payload.data;
                const messageContent = messageData.message?.conversation || messageData.message?.extendedTextMessage?.text || 'Media Message';
                const remoteJid = messageData.key?.remoteJid;

                await MessageLog.create({
                    instanceName,
                    remoteJid,
                    content: messageContent,
                    status: 'received'
                });

                if (user.webhookUrl) {
                    axios.post(user.webhookUrl, {
                        event: 'message.received',
                        instance: instanceName,
                        sender: remoteJid,
                        message: messageContent,
                        raw: messageData
                    }).catch(e => console.error(`Webhook forwarding failed for ${user.username}:`, e.message));
                }
            }
        } catch (e) {
            console.error("Webhook processing error:", e.message);
        }
    }
    res.status(200).send('OK');
});

// 4. Admin Routes
app.get('/admin', isAuthenticated, isAdmin, async (req, res) => {
    try {
        const customers = await User.find({ role: 'customer' });
        const stats = {
            totalUsers: await User.countDocuments({ role: 'customer' }),
            activeInstances: await User.countDocuments({ role: 'customer', isActive: true }),
            totalMessages: await MessageLog.countDocuments()
        };
        res.render('admin', { user: req.session.user, customers, stats });
    } catch (e) {
        res.status(500).send("Admin View Error");
    }
});

app.post('/admin/user/create', isAuthenticated, isAdmin, async (req, res) => {
    try {
        const { username, password, credits } = req.body;
        const hashedPassword = await bcrypt.hash(password, 10);
        const instanceName = `inst_${username}_${Date.now()}`;
        const apiKey = `sk_live_${require('crypto').randomBytes(16).toString('hex')}`;

        await User.create({
            username,
            password: hashedPassword,
            role: 'customer',
            credits: parseInt(credits) || 0,
            instanceName,
            isActive: true,
            apiKey
        });

        try {
            await axios.post(`${EVOLUTION_API_URL}/instance/create`, {
                instanceName: instanceName,
                qrcode: true,
                integration: "WHATSAPP-BAILEYS"
            }, { headers: { 'apikey': EVOLUTION_API_KEY } });
        } catch(apiErr) {
            console.error("Evolution API instance creation failed:", apiErr.response?.data || apiErr.message);
        }

        res.redirect('/admin');
    } catch (e) {
        res.status(500).send("Create User Error");
    }
});

app.post('/admin/user/delete', isAuthenticated, isAdmin, async (req, res) => {
    try {
        await User.findByIdAndDelete(req.body.userId);
        res.redirect('/admin');
    } catch (e) {
        res.status(500).send("Delete User Error");
    }
});

app.get('/customer', isAuthenticated, isCustomer, async (req, res) => {
    try {
        const user = await User.findById(req.session.user.id);
        let recentMessages = [];
        let qrCodeBase64 = null;
        let instanceState = "UNKNOWN";

        if (user.instanceName) {
            recentMessages = await MessageLog.find({ instanceName: user.instanceName })
                                             .sort({ timestamp: -1 })
                                             .limit(10);
            try {
                const statusRes = await axios.get(`${EVOLUTION_API_URL}/instance/connectionState/${user.instanceName}`, {
                    headers: { 'apikey': EVOLUTION_API_KEY }
                });
                instanceState = statusRes.data?.instance?.state || 'UNKNOWN';

                // Handle qr state, connecting state, OR close state by requesting a new connection
                if (instanceState === 'connecting' || statusRes.data?.state === 'qr' || instanceState === 'close' || instanceState === 'UNKNOWN') {
                    try {
                        const qrRes = await axios.get(`${EVOLUTION_API_URL}/instance/connect/${user.instanceName}`, {
                            headers: { 'apikey': EVOLUTION_API_KEY }
                        });
                        if (qrRes.data?.base64) qrCodeBase64 = qrRes.data.base64;
                    } catch(qError) { /* Silent fail */ }
                }
            } catch(stErr) {
                console.error(`Check status Error [${user.instanceName}]:`, stErr.response?.data || stErr.message);
                if (stErr.response?.status === 404) {
                    console.log(`Auto-creating missing instance: ${user.instanceName}`);
                    try {
                        await axios.post(`${EVOLUTION_API_URL}/instance/create`, {
                            instanceName: user.instanceName,
                            qrcode: true,
                            integration: "WHATSAPP-BAILEYS"
                        }, { headers: { 'apikey': EVOLUTION_API_KEY } });
                        instanceState = "connecting";
                    } catch(cErr) { console.error("Auto-creation failed:", cErr.message); }
                }
            }
        }
        res.render('customer', { user, recentMessages, qrCodeBase64, instanceState });
    } catch (e) {
        res.status(500).send("Customer View Error");
    }
});

app.post('/customer/webhook', isAuthenticated, isCustomer, async (req, res) => {
    try {
        const user = await User.findById(req.session.user.id);
        user.webhookUrl = req.body.webhookUrl || '';
        await user.save();
        res.redirect('/customer');
    } catch (e) {
        res.status(500).send("Save Webhook Error");
    }
});

app.post('/api/sendmessage', isAuthenticated, isCustomer, async (req, res) => {
    try {
        const user = await User.findById(req.session.user.id);
        if (user.credits <= 0) return res.status(403).json({ success: false, error: 'Insufficient credits' });
        const { number, text } = req.body;
        const response = await axios.post(`${EVOLUTION_API_URL}/message/sendText/${user.instanceName}`, {
            number,
            options: { delay: 1200, presence: "composing" },
            text
        }, { headers: { 'apikey': EVOLUTION_API_KEY } });
        user.credits -= 1;
        await user.save();
        res.json({ success: true, data: response.data });
    } catch (error) {
        console.error("SendMessage Error:", error.response?.data || error.message);
        res.status(500).json({ success: false, error: 'Failed to send message' });
    }
});

// Database connection & Startup
mongoose.connect(MONGODB_URI)
    .then(() => {
        console.log('✅ Connected to MongoDB Atlas');
        app.listen(PORT, () => {
            console.log(`🚀 decisionmakers.in Gateway running on production server`);
        });
    })
    .catch(err => console.error('❌ MongoDB Connection Error:', err));
