const express = require('express');
const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');
const bodyParser = require('body-parser');
const session = require('express-session');
const cors = require('cors');
const path = require('path');

// --- CONFIGURATION ---
// const pool = require('./db_pool');

const PORT = 3000;
const DB_CONFIG = {
    host: '127.0.0.1',
    user: 'root',
    password: '',
    database: 'winzone',
    waitForConnections: true,
    connectionLimit: 10
};

// --- SETUP APP ---
const app = express();
// const pool = mysql.createPool(DB_CONFIG);

app.use(cors());
app.use(bodyParser.json());
// Serve static files from 'public' folder (JS, CSS, Login HTML)
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
    secret: 'super_secure_winzone_admin_key_99',
    resave: false,
    saveUninitialized: true,
    cookie: { maxAge: 3600000 } // 1 hour session
}));

// --- MIDDLEWARE ---
function requireAdmin(req, res, next) {
    if (req.session.isAdmin) {
        next();
    } else {
        res.status(401).json({ success: false, message: 'Unauthorized' });
    }
}

// --- AUTH ROUTES ---

// Login
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        // Find admin user
        const [rows] = await pool.execute('SELECT * FROM users WHERE username = ? AND role = "admin"', [username]);
        if (rows.length > 0) {
            const user = rows[0];
            // Verify password
            const match = await bcrypt.compare(password, user.password_hash);
            if (match) {
                req.session.isAdmin = true;
                req.session.adminUser = username;
                req.session.adminId = user.user_id;
                return res.json({ success: true });
            }
        }
        res.json({ success: false, message: 'Invalid credentials' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// Logout
app.post('/api/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            return res.status(500).json({ success: false, message: 'Could not log out' });
        }
        res.clearCookie('connect.sid'); // Clear the session cookie
        res.json({ success: true });
    });
});

// Check Session
app.get('/api/check-session', (req, res) => {
    res.json({ loggedIn: !!req.session.isAdmin });
});

// --- DASHBOARD API ---

// 1. Get Stats (Overview)
app.get('/api/stats', requireAdmin, async (req, res) => {
    try {
        const [users] = await pool.execute('SELECT COUNT(*) as count FROM users WHERE role="retailer"');
        const [sales] = await pool.execute(`SELECT SUM(total_amount) as total FROM tickets WHERE DATE(created_at) = CURDATE()`);
        const [payouts] = await pool.execute(`SELECT SUM(total_payout) as total FROM draws WHERE DATE(end_time) = CURDATE() AND is_processed = 1`);

        const totalSales = parseFloat(sales[0].total || 0);
        const totalPayout = parseFloat(payouts[0].total || 0);
        const profit = totalSales - totalPayout;

        // Next Draw Time Logic
        const DRAW_DURATION = 10;
        const now = new Date();
        const minutes = Math.floor(now.getMinutes() / DRAW_DURATION) * DRAW_DURATION;
        const nextDraw = new Date(now);
        nextDraw.setMinutes(minutes + DRAW_DURATION, 0, 0);

        res.json({
            success: true,
            totalUsers: users[0].count,
            todaySale: totalSales,
            todayProfit: profit,
            nextDraw: nextDraw.toLocaleTimeString()
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false });
    }
});

// --- USER MANAGEMENT API ---

// 2. Get All Retailers
app.get('/api/users', requireAdmin, async (req, res) => {
    try {
        const [rows] = await pool.execute(`
            SELECT user_id, username, balance, role, is_active, created_at 
            FROM users 
            WHERE role="retailer" 
            ORDER BY user_id DESC
        `);
        res.json({ success: true, users: rows });
    } catch (err) {
        res.status(500).json({ success: false });
    }
});

// 3. Add Balance
app.post('/api/add-balance', requireAdmin, async (req, res) => {
    const { userId, amount } = req.body;
    const amountNum = parseFloat(amount);
    if (!amountNum || amountNum === 0) return res.json({ success: false, message: 'Invalid amount' });

    try {
        await pool.execute('UPDATE users SET balance = balance + ? WHERE user_id = ?', [amountNum, userId]);
        res.json({ success: true, message: 'Balance updated successfully' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Database error' });
    }
});

// 4. Create Retailer
app.post('/api/create-user', requireAdmin, async (req, res) => {
    const { username, password, store_address, contact_no } = req.body;
    if (!username || !password) return res.json({ success: false, message: 'Missing fields' });

    try {
        const hash = await bcrypt.hash(password, 10);
        // Ensure your database table 'users' has 'store_address' and 'contact_no' columns
        // If not, run ALTER TABLE users ADD COLUMN store_address TEXT, ADD COLUMN contact_no VARCHAR(20);
        await pool.execute(
            'INSERT INTO users (username, password_hash, role, balance, is_active, store_address, contact_no) VALUES (?, ?, "retailer", 0, 1, ?, ?)',
            [username, hash, store_address, contact_no]
        );
        res.json({ success: true, message: 'User created successfully' });
    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') {
            return res.json({ success: false, message: 'Username already exists' });
        }
        console.error(err);
        res.status(500).json({ success: false, message: 'Database error' });
    }
});

// 5. Toggle User Status
app.post('/api/toggle-user', requireAdmin, async (req, res) => {
    const { userId, status } = req.body;
    try {
        await pool.execute('UPDATE users SET is_active = ? WHERE user_id = ?', [status, userId]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false });
    }
});

// 6. Get Draw History (NEW ROUTE)
app.get('/api/draw-history', requireAdmin, async (req, res) => {
    try {
        const { date } = req.query;
        let query = 'SELECT * FROM draws WHERE is_processed = 1';
        const params = [];

        if (date) {
            query += ' AND DATE(end_time) = ?';
            params.push(date);
        }

        query += ' ORDER BY end_time DESC';

        const [rows] = await pool.execute(query, params);
        res.json({ success: true, results: rows });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false });
    }
});

// 7. Get Retailer Ledger (NEW)
app.get('/api/admin/ledger', requireAdmin, async (req, res) => {
    try {
        const { userId, startDate, endDate } = req.query;

        // Base Query: Get valid tickets for this user
        let sql = `
            SELECT 
                DATE(t.created_at) as sale_date,
                t.total_amount,
                t.bet_details,
                t.is_claimed,
                d.winning_spot
            FROM tickets t
            JOIN draws d ON t.draw_id = d.draw_id
            WHERE t.user_id = ? AND t.is_cancelled = 0
        `;

        const params = [userId];

        // Add Date Filters if provided
        if (startDate && endDate) {
            sql += ` AND DATE(t.created_at) BETWEEN ? AND ?`;
            params.push(startDate, endDate);
        }

        sql += ` ORDER BY t.created_at DESC`;

        const [rows] = await pool.execute(sql, params);

        // Process Data (Group by Date)
        const ledgerMap = {};

        rows.forEach(row => {
            // Format Date as YYYY-MM-DD for grouping
            const dateObj = new Date(row.sale_date);
            const dateKey = dateObj.toISOString().split('T')[0];

            if (!ledgerMap[dateKey]) {
                ledgerMap[dateKey] = { date: dateKey, totalSale: 0, totalWinning: 0 };
            }

            // 1. Add Sales
            ledgerMap[dateKey].totalSale += parseFloat(row.total_amount);

            // 2. Add Winnings (ONLY IF CLAIMED)
            if (row.winning_spot && row.winning_spot !== 'PENDING') {
                if (row.is_claimed === 1) {
                    const bets = JSON.parse(row.bet_details);
                    const winningQty = bets[row.winning_spot] || 0;
                    if (winningQty > 0) {
                        ledgerMap[dateKey].totalWinning += (winningQty * 90);
                    }
                }
            }
        });

        // Convert object to array and sort by date descending
        const ledgerArray = Object.values(ledgerMap).sort((a, b) => new Date(b.date) - new Date(a.date));

        res.json({ success: true, ledger: ledgerArray });

    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Database error' });
    }
});

// --- 8. GAME SETTINGS API ---

// Get Settings
app.get('/api/settings', requireAdmin, async (req, res) => {
    try {
        const [rows] = await pool.execute('SELECT * FROM game_settings WHERE id = 1');
        res.json({ success: true, settings: rows[0] });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false });
    }
});

// Update Settings
app.post('/api/settings', requireAdmin, async (req, res) => {
    const { draw_time, profit_min, profit_max, target_percent } = req.body;
    try {
        await pool.execute(
            'UPDATE game_settings SET draw_time_minutes=?, profit_min=?, profit_max=?, target_percent=? WHERE id=1',
            [draw_time, profit_min, profit_max, target_percent]
        );
        res.json({ success: true, message: 'Settings updated successfully' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Database error' });
    }
});

// --- SERVE PAGES ---

// 1. Root Route (Login)
app.get('/', (req, res) => {
    if (req.session.isAdmin) {
        return res.redirect('/admin_dashboard');
    }
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// 2. Dashboard Route (Protected)
app.get('/admin_dashboard', (req, res) => {
    if (req.session.isAdmin) {
        // Serve from 'views' folder for security
        res.sendFile(path.join(__dirname, 'views', 'admin_dashboard.html'));
    } else {
        res.redirect('/');
    }
});

// 3. Catch-All Redirect
app.use((req, res) => {
    res.redirect('/');
});

// --- START ---
app.listen(PORT, () => {
    console.log(`🚀 Admin Server running at http://localhost:${PORT}`);
});