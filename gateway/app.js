require('dotenv').config({ path: '../.env' }); // Assumes .env is in parent folder
const express = require('express');
const mongoose = require('mongoose');
const axios = require('axios');
const path = require('path');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// Env Configuration
const EVOLUTION_API_URL = process.env.SERVER_URL || 'http://localhost:8080';
const EVOLUTION_API_KEY = process.env.AUTHENTICATION_API_KEY || 'my-super-secret-global-api-key-123';

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Session config
app.use(session({
    secret: 'whatsapp-saas-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false } // false for localhost
}));

// Passing user session to locals for EJS templates
app.use((req, res, next) => {
    res.locals.user = req.session.user || null;
    next();
});

// Mongoose Models
const UserSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    role: { type: String, enum: ['admin', 'customer'], default: 'customer' },
    credits: { type: Number, default: 100 },
    instanceName: String,
    isActive: { type: Boolean, default: true },
    apiKey: { type: String, unique: true, sparse: true },
    webhookUrl: { type: String, default: '' }
});
let User;
try { User = mongoose.model('User'); } catch(e) { User = mongoose.model('User', UserSchema); }

const MessageLogSchema = new mongoose.Schema({
    instanceName: String,
    remoteJid: String,
    messageId: String,
    status: String,
    content: String,
    timestamp: { type: Date, default: Date.now }
});
let MessageLog;
try { MessageLog = mongoose.model('MessageLog'); } catch(e) { MessageLog = mongoose.model('MessageLog', MessageLogSchema); }

// MongoDB Connection & Default Admin
if(process.env.MONGODB_URI) {
    mongoose.connect(process.env.MONGODB_URI)
        .then(async () => {
            console.log('✅ Connected to MongoDB Atlas');
            try { await mongoose.connection.collection('users').dropIndex('email_1'); } catch(e) {} // Clean up old legacy index
            // Seed default admin
            try {
                const adminExists = await User.findOne({ username: 'admin' });
                if (!adminExists) {
                    const hashedPassword = await bcrypt.hash('admin123', 10);
                    await User.create({
                        username: 'admin',
                        password: hashedPassword,
                        role: 'admin',
                        isActive: true
                    });
                    console.log('✅ Default Admin created: admin / admin123');
                }
            } catch(e) { console.error('Error seeding admin', e) }
        })
        .catch(err => console.error('❌ MongoDB connection error:', err));
} else {
    console.warn('⚠️ MONGODB_URI missing in .env. Skipping MongoDB Atlas connection.');
}

// Auth Middleware
function isAuthenticated(req, res, next) {
    if (req.session.user) return next();
    res.redirect('/login');
}
function isAdmin(req, res, next) {
    if (req.session.user && req.session.user.role === 'admin') return next();
    res.status(403).send("Forbidden");
}
function isCustomer(req, res, next) {
    if (req.session.user && req.session.user.role === 'customer') return next();
    res.status(403).send("Forbidden");
}

// --- ROUTES ---

// 1. Root redirect
app.get('/', isAuthenticated, (req, res) => {
    if (req.session.user.role === 'admin') return res.redirect('/admin');
    return res.redirect('/customer');
});

// 2. Auth Routes
app.get('/login', (req, res) => {
    if (req.session.user) return res.redirect('/');
    res.render('login', { error: null });
});

app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const user = await User.findOne({ username });
        if (!user || !user.isActive) {
            return res.render('login', { error: 'Invalid or inactive user' });
        }
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.render('login', { error: 'Invalid password' });
        }
        
        // Ensure legacy customers get an API Key
        if (!user.apiKey && user.role === 'customer') {
            user.apiKey = 'sk_live_' + crypto.randomBytes(24).toString('hex');
            await user.save();
        }

        req.session.user = { id: user._id, username: user.username, role: user.role, instanceName: user.instanceName };
        if (user.role === 'admin') res.redirect('/admin');
        else res.redirect('/customer');
    } catch (e) {
        res.render('login', { error: 'Login error' });
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
});

// 3. Admin Routes (Admin Dashboard)
app.get('/admin', isAuthenticated, isAdmin, async (req, res) => {
    try {
        let customers = [];
        let stats = { totalUsers: 0, activeInstances: 0, totalMessages: 0 };
        if (mongoose.connection.readyState === 1) {
            customers = await User.find({ role: 'customer' });
            stats.totalUsers = await User.countDocuments();
            stats.activeInstances = await User.countDocuments({ instanceName: { $exists: true, $ne: null }});
            stats.totalMessages = await MessageLog.countDocuments();
        }
        res.render('admin', { customers, stats });
    } catch (e) {
        res.status(500).send("Admin View Error");
    }
});

// Admin: Make a new Customer
app.post('/admin/user/create', isAuthenticated, isAdmin, async (req, res) => {
    try {
        const { username, password, credits } = req.body;
        if (!username || !password) return res.send("Username and password required. <a href='/admin'>Go back</a>");
        
        // Check if user already exists
        const existing = await User.findOne({ username });
        if (existing) return res.send("Username already exists in the system. <a href='/admin'>Go back</a>");

        const hashedPassword = await bcrypt.hash(password, 10);
        
        // Auto-generate instance name or base it on username
        const instanceName = `inst_${username.replace(/[^a-zA-Z0-9]/g, '')}_${Date.now()}`;
        const apiKey = 'sk_live_' + crypto.randomBytes(24).toString('hex');

        await User.create({
            username,
            password: hashedPassword,
            role: 'customer',
            credits: parseInt(credits) || 0,
            instanceName,
            isActive: true,
            apiKey
        });

        // Request evolution API to generate the instance
        try {
            await axios.post(`${EVOLUTION_API_URL}/instance/create`, {
                instanceName: instanceName,
                qrcode: true,
                integration: "WHATSAPP-BAILEYS"
            }, { headers: { 'apikey': EVOLUTION_API_KEY } });
        } catch(apiErr) {
            console.error("Evolution API instance creation failed, but DB user was created:", apiErr.message);
        }

        res.redirect('/admin');
    } catch (e) {
        console.error(e);
        res.status(500).send("Create User Error: " + e.message);
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

app.post('/admin/user/edit', isAuthenticated, isAdmin, async (req, res) => {
    try {
        const { userId, credits, isActive } = req.body;
        await User.findByIdAndUpdate(userId, { 
            credits: parseInt(credits) || 0,
            isActive: isActive === 'on' 
        });
        res.redirect('/admin');
    } catch (e) {
        res.status(500).send("Edit User Error");
    }
});


// 4. Customer Routes
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
        }

        res.render('customer', { user, recentMessages, qrCodeBase64, instanceState });
    } catch (e) {
        res.status(500).send("Customer View Error");
    }
});

// Update Webhook URL
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

// 5. Send Message API (For testing by Customer)
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

        // Deduct credit
        user.credits -= 1;
        await user.save();

        res.json({ success: true, data: response.data });
    } catch (error) {
        console.error("SendMessage Error:", error.response?.data || error.message);
        res.status(500).json({ success: false, error: 'Failed to send message' });
    }
});

// 5.5. Stateless Public API (For Zapier / Make.com / APIs)
async function isApiAuthorized(req, res, next) {
    const apiKey = req.headers['x-api-key'];
    if (!apiKey) return res.status(401).json({ success: false, error: 'Missing x-api-key header' });
    
    try {
        const user = await User.findOne({ apiKey });
        if (!user || user.role !== 'customer') return res.status(401).json({ success: false, error: 'Invalid API Key' });
        if (!user.isActive) return res.status(403).json({ success: false, error: 'Account is inactive' });
        req.apiUser = user;
        next();
    } catch(e) {
        res.status(500).json({ success: false, error: 'Server error' });
    }
}

app.post('/v1/messages/send', isApiAuthorized, async (req, res) => {
    const user = req.apiUser;
    if (user.credits <= 0) return res.status(403).json({ success: false, error: 'Insufficient credits' });

    const { number, text } = req.body;
    if (!number || !text) return res.status(400).json({ success: false, error: 'Missing "number" or "text"' });

    try {
        const response = await axios.post(`${EVOLUTION_API_URL}/message/sendText/${user.instanceName}`, {
            number,
            options: { delay: 1200, presence: "composing" },
            text
        }, { headers: { 'apikey': EVOLUTION_API_KEY } });

        user.credits -= 1;
        await user.save();

        res.json({ success: true, message: 'Message queued successfully', creditsRemaining: user.credits });
    } catch(error) {
        console.error("API SendMessage Error:", error.response?.data || error.message);
        res.status(500).json({ success: false, error: 'Failed to send message via Evolution API' });
    }
});

// 6. Webhook
app.post('/webhook/whatsapp', async (req, res) => {
    try {
        const event = req.body;
        const { event: eventType, instance, data } = event;

        if (eventType === 'messages.upsert') {
            const content = data.message?.conversation || data.message?.extendedTextMessage?.text || 'Media/Unsupported Type';
            
            if (process.env.MONGODB_URI) {
                await MessageLog.create({
                    instanceName: instance,
                    remoteJid: data.key?.remoteJid,
                    messageId: data.key?.id,
                    status: 'received',
                    content: content
                });

                // Look up customer and forward payload if webhookUrl exists
                try {
                    const customer = await User.findOne({ instanceName: instance });
                    if (customer && customer.webhookUrl) {
                        await axios.post(customer.webhookUrl, {
                            event: 'message.received',
                            instance: instance,
                            sender: data.key?.remoteJid,
                            message: content,
                            raw: data
                        });
                    }
                } catch (fwErr) {
                    console.error("Webhook forwarding failed:", fwErr.message);
                }
            }
        }
        res.status(200).send('Webhook processed');
    } catch (error) {
         res.status(500).send('Error processing webhook');
    }
});

app.listen(PORT, () => {
    console.log(`🚀 decisionmakers.in Gateway running on http://localhost:${PORT}`);
});
