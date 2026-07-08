require('dotenv').config();
const express = require('express');
const session = require('express-session');
const https = require('https');
const path = require('path');
const multer = require('multer');
const AdmZip = require('adm-zip');
const { spawn } = require('child_process');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_CODE = 'veloxsummer';
const MAX_BOTS = 3;
const BOTS_DIR = path.join(__dirname, 'bots');

if (!fs.existsSync(BOTS_DIR)) fs.mkdirSync(BOTS_DIR, { recursive: true });

const upload = multer({ dest: '/tmp/uploads' });
const botProcesses = {};
const botsConfig = path.join(BOTS_DIR, 'bots.json');

function loadBots() {
    if (fs.existsSync(botsConfig)) return JSON.parse(fs.readFileSync(botsConfig, 'utf8'));
    return [];
}

function saveBots(bots) {
    fs.writeFileSync(botsConfig, JSON.stringify(bots, null, 2));
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({
    secret: process.env.SESSION_SECRET || 'veloxhost-secret',
    resave: false,
    saveUninitialized: false
}));

const CLIENT_ID = process.env.CLIENT_ID || '';
const CLIENT_SECRET = process.env.CLIENT_SECRET || '';
const REDIRECT_URI = process.env.REDIRECT_URI || 'http://localhost:3000/callback';

function postForm(url, params) {
    return new Promise((resolve, reject) => {
        const postData = params.toString();
        const u = new URL(url);
        const options = {
            hostname: u.hostname,
            path: u.pathname,
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(postData)
            }
        };
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { resolve({}); } });
        });
        req.on('error', reject);
        req.write(postData);
        req.end();
    });
}

function fetchJSON(url, options) {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const opts = {
            hostname: u.hostname,
            path: u.pathname + (u.search || ''),
            headers: options && options.headers || {}
        };
        https.get(opts, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { resolve({}); } });
        }).on('error', reject);
    });
}

// ==================== PUBLIC ROUTES ====================

app.get('/', (req, res) => {
    res.render('index', { user: req.session.user || null });
});

app.get('/login', (req, res) => {
    const url = `https://discord.com/api/oauth2/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=identify%20guilds`;
    res.redirect(url);
});

app.get('/callback', async (req, res) => {
    const code = req.query.code;
    if (!code) return res.redirect('/');
    try {
        const params = new URLSearchParams({
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            grant_type: 'authorization_code',
            code: code,
            redirect_uri: REDIRECT_URI
        });
        const tokenRes = await postForm('https://discord.com/api/oauth2/token', params);
        const user = await fetchJSON('https://discord.com/api/users/@me', {
            headers: { 'Authorization': `Bearer ${tokenRes.access_token}` }
        });
        req.session.user = user;
        req.session.access_token = tokenRes.access_token;
        res.redirect('/dashboard');
    } catch (err) {
        console.error(err);
        res.redirect('/');
    }
});

app.get('/dashboard', (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    res.render('dashboard', { user: req.session.user });
});

app.get('/order', (req, res) => {
    res.render('order', { user: req.session.user || null });
});

app.post('/order', (req, res) => {
    res.render('order-success', { user: req.session.user || null, order: req.body });
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

// ==================== ADMIN ROUTES ====================

app.get('/admin', (req, res) => {
    if (!req.session.isAdmin) return res.render('admin-login', { error: null });
    const bots = loadBots();
    res.render('admin-panel', { bots, botProcesses, MAX_BOTS });
});

app.post('/admin/login', (req, res) => {
    const { code } = req.body;
    if (code === ADMIN_CODE) {
        req.session.isAdmin = true;
        return res.redirect('/admin');
    }
    res.render('admin-login', { error: 'Invalid admin code' });
});

app.get('/admin/logout', (req, res) => {
    req.session.isAdmin = false;
    res.redirect('/');
});

app.post('/admin/upload', upload.single('botfile'), (req, res) => {
    if (!req.session.isAdmin) return res.redirect('/admin');
    const bots = loadBots();
    if (bots.length >= MAX_BOTS) return res.redirect('/admin');

    const { botname, token } = req.body;
    if (!req.file || !botname || !token) return res.redirect('/admin');

    const botId = Date.now().toString();
    const botDir = path.join(BOTS_DIR, botId);

    try {
        fs.mkdirSync(botDir, { recursive: true });
        const zip = new AdmZip(req.file.path);
        zip.extractAllTo(botDir, true);
        fs.unlinkSync(req.file.path);

        const botEntry = { id: botId, name: botname, token, status: 'stopped', createdAt: new Date().toISOString() };
        bots.push(botEntry);
        saveBots(bots);
        res.redirect('/admin');
    } catch (err) {
        console.error(err);
        res.redirect('/admin');
    }
});

app.get('/admin/start/:id', (req, res) => {
    if (!req.session.isAdmin) return res.redirect('/admin');
    const bots = loadBots();
    const bot = bots.find(b => b.id === req.params.id);
    if (!bot) return res.redirect('/admin');

    const botDir = path.join(BOTS_DIR, bot.id);
    const indexFile = findEntryFile(botDir);
    if (!indexFile) return res.redirect('/admin');

    const env = { ...process.env, TOKEN: bot.token };
    const child = spawn('node', [indexFile], { cwd: botDir, env, stdio: 'pipe', shell: true });

    child.stdout.on('data', (data) => console.log(`[${bot.name}] ${data}`));
    child.stderr.on('data', (data) => console.error(`[${bot.name}] ${data}`));
    child.on('exit', () => {
        botProcesses[bot.id] = null;
        const b = loadBots().find(x => x.id === bot.id);
        if (b) { b.status = 'stopped'; saveBots(loadBots().map(x => x.id === bot.id ? b : x)); }
    });

    botProcesses[bot.id] = child;
    bot.status = 'running';
    saveBots(bots.map(b => b.id === bot.id ? bot : b));
    res.redirect('/admin');
});

app.get('/admin/stop/:id', (req, res) => {
    if (!req.session.isAdmin) return res.redirect('/admin');
    const proc = botProcesses[req.params.id];
    if (proc) { proc.kill(); botProcesses[req.params.id] = null; }
    const bots = loadBots();
    const bot = bots.find(b => b.id === req.params.id);
    if (bot) { bot.status = 'stopped'; saveBots(bots); }
    res.redirect('/admin');
});

app.get('/admin/delete/:id', (req, res) => {
    if (!req.session.isAdmin) return res.redirect('/admin');
    const proc = botProcesses[req.params.id];
    if (proc) { proc.kill(); botProcesses[req.params.id] = null; }

    const botDir = path.join(BOTS_DIR, req.params.id);
    if (fs.existsSync(botDir)) fs.rmSync(botDir, { recursive: true, force: true });

    let bots = loadBots();
    bots = bots.filter(b => b.id !== req.params.id);
    saveBots(bots);
    res.redirect('/admin');
});

function findEntryFile(dir) {
    if (fs.existsSync(path.join(dir, 'index.js'))) return 'index.js';
    if (fs.existsSync(path.join(dir, 'bot.js'))) return 'bot.js';
    if (fs.existsSync(path.join(dir, 'main.js'))) return 'main.js';
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.js'));
    return files[0] || null;
}

app.listen(PORT, () => {
    console.log(`Velox Host site running on port ${PORT}`);
});
