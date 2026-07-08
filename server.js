require('dotenv').config();
const express = require('express');
const session = require('express-session');
const https = require('https');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

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
            res.on('end', () => resolve(JSON.parse(data)));
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
            path: u.pathname,
            headers: options && options.headers || {}
        };
        https.get(opts, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => resolve(JSON.parse(data)));
        }).on('error', reject);
    });
}

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

app.listen(PORT, () => {
    console.log(`🌐 Velox Host site running on port ${PORT}`);
});
