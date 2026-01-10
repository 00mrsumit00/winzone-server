const express = require('express');
const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');
const bodyParser = require('body-parser');
const session = require('express-session');
const cors = require('cors');
const path = require('path');
const cron = require('node-cron');
const crypto = require('crypto');
const pool = require('./db_pool');


// --- CONFIGURATION ---
const PORT = process.env.PORT || 3000;


// --- 🕒 OPERATING HOURS LOGIC (IST) ---
function isShopOpen() {
    // 1. Get current time in India (IST)
    const now = new Date();
    const istString = now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" });
    const istDate = new Date(istString);
    
    const currentHour = istDate.getHours(); // 0 to 23

    // 2. Define Hours (6:00 AM to 11:59 PM)
    // OPEN: 6 <= hour < 24
    if (currentHour >= 6 && currentHour <= 23) {
        return true;
    }
    return false;
}

// --- SETUP APP ---
const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
    secret: 'super_secure_winzone_live_key',
    resave: false,
    saveUninitialized: true,
    cookie: { maxAge: 3600000 } // 1 hour
}));

// --- MIDDLEWARE ---
function requireAdmin(req, res, next) {
    if (req.session.isAdmin) next();
    else res.status(401).json({ success: false, message: 'Unauthorized' });
}

// ==========================================
// 1. RETAILER API (For Electron App)
// ==========================================

// Login
app.post('/api/retailer/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const [rows] = await pool.execute("SELECT * FROM users WHERE username = ?", [username]);
        if (rows.length > 0) {
            const user = rows[0];
            const isMatch = await bcrypt.compare(password, user.password_hash);
            if (isMatch) {
                if (!user.is_active) return res.json({ success: false, message: 'Account Blocked' });
                delete user.password_hash; // Security
                return res.json({ success: true, user: user });
            }
        }
        res.json({ success: false, message: 'Invalid Credentials' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
});

// Submit Ticket
app.post('/api/retailer/submit-ticket', async (req, res) => {
    if (!isShopOpen()) {
        return res.json({ 
            success: false, 
            message: 'Shop is Closed! Operating Hours: 6:00 AM - 12:00 AM' 
        });
    }

    const { username, ticketData } = req.body;
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        // 1. Get User
        const [rows] = await connection.execute("SELECT user_id, balance FROM users WHERE username = ? FOR UPDATE", [username]);
        const user = rows[0];

        // 2. Calc Balance
        const commissionRate = 0.09;
        const deduction = ticketData.totalAmount - (ticketData.totalAmount * commissionRate);
        const newBalance = user.balance - deduction;

        if (newBalance < 0) {
            await connection.rollback();
            return res.json({ success: false, message: 'Insufficient balance!' });
        }

        // 3. Get/Create Draw
        let [drawRows] = await connection.execute("SELECT draw_id FROM draws WHERE end_time = ?", [ticketData.drawEndTime]);
        let draw_id;
        if (drawRows.length > 0) {
            draw_id = drawRows[0].draw_id;
        } else {
            const [insert] = await connection.execute(
                "INSERT INTO draws (end_time, winning_spot, total_collection, total_payout, is_processed) VALUES (?, 'PENDING', 0, 0, 0)",
                [ticketData.drawEndTime]
            );
            draw_id = insert.insertId;
        }

        // 4. Insert Ticket
        const [ticketResult] = await connection.execute(
            "INSERT INTO tickets (draw_id, user_id, bet_details, total_amount) VALUES (?, ?, ?, ?)",
            [draw_id, user.user_id, JSON.stringify(ticketData.betDetails), ticketData.totalAmount]
        );

        // 5. Update Balance
        await connection.execute("UPDATE users SET balance = ? WHERE user_id = ?", [newBalance, user.user_id]);

        await connection.commit();
        res.json({
            success: true,
            message: 'Ticket Confirmed!',
            newBalance: newBalance,
            newTicketId: ticketResult.insertId,
            drawId: draw_id
        });

    } catch (err) {
        await connection.rollback();
        console.error(err);
        res.json({ success: false, message: 'Transaction Failed' });
    } finally {
        connection.release();
    }
});

// Claim Prize
app.post('/api/retailer/claim', async (req, res) => {
    const { ticketId, username } = req.body;
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        const [users] = await connection.execute("SELECT user_id, balance FROM users WHERE username = ? FOR UPDATE", [username]);
        const user = users[0];

        const [rows] = await connection.execute(`
            SELECT t.*, d.winning_spot 
            FROM tickets t JOIN draws d ON t.draw_id = d.draw_id 
            WHERE t.ticket_id = ? AND t.user_id = ?
        `, [ticketId, user.user_id]);

        if (rows.length === 0) {
            await connection.rollback();
            return res.json({ success: false, message: 'Invalid Ticket' });
        }
        const ticket = rows[0];

        if (ticket.is_cancelled || ticket.is_claimed || ticket.winning_spot === 'PENDING') {
            await connection.rollback();
            return res.json({ success: false, message: 'Cannot claim (Cancelled, Claimed, or Pending)' });
        }

        const bets = JSON.parse(ticket.bet_details);
        const winningQty = bets[ticket.winning_spot] || 0;

        if (winningQty === 0) {
            await connection.rollback();
            return res.json({ success: false, message: 'No winning spots' });
        }

        const winAmount = winningQty * 90;
        const newBalance = parseFloat(user.balance) + winAmount;

        await connection.execute("UPDATE users SET balance = ? WHERE user_id = ?", [newBalance, user.user_id]);
        await connection.execute("UPDATE tickets SET is_claimed = 1 WHERE ticket_id = ?", [ticketId]);

        await connection.commit();
        res.json({
            success: true,
            data: { winAmount, ticketId, spot: ticket.winning_spot, qty: winningQty, newBalance }
        });

    } catch (err) {
        await connection.rollback();
        res.json({ success: false, message: 'Server Error' });
    } finally {
        connection.release();
    }
});

// Get Public Results (For History/Top Spots)
app.get('/api/public/results', async (req, res) => {
    try {
        const [rows] = await pool.execute(
            `SELECT winning_spot, end_time FROM draws WHERE winning_spot != 'PENDING' ORDER BY end_time DESC LIMIT 7`
        );
        res.json({ success: true, results: rows });
    } catch (err) {
        res.json({ success: false });
    }
});

// ==========================================
// 2. ADMIN API (Existing Routes)
// ==========================================

// Login
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const [rows] = await pool.execute('SELECT * FROM users WHERE username = ? AND role = "admin"', [username]);
        if (rows.length > 0) {
            const user = rows[0];
            const match = await bcrypt.compare(password, user.password_hash);
            if (match) {
                req.session.isAdmin = true;
                return res.json({ success: true });
            }
        }
        res.json({ success: false, message: 'Invalid credentials' });
    } catch (err) { res.status(500).json({ success: false }); }
});

// Dashboard Stats
app.get('/api/stats', requireAdmin, async (req, res) => {
    try {
        const [users] = await pool.execute('SELECT COUNT(*) as count FROM users WHERE role="retailer"');
        const [sales] = await pool.execute(`SELECT SUM(total_amount) as total FROM tickets WHERE DATE(created_at) = CURDATE()`);
        const [payouts] = await pool.execute(`SELECT SUM(total_payout) as total FROM draws WHERE DATE(end_time) = CURDATE() AND is_processed = 1`);

        const totalSales = parseFloat(sales[0].total || 0);
        const totalPayout = parseFloat(payouts[0].total || 0);

        res.json({
            success: true,
            totalUsers: users[0].count,
            todaySale: totalSales,
            todayProfit: totalSales - totalPayout,
            nextDraw: "Running..."
        });
    } catch (err) { res.status(500).json({ success: false }); }
});

// Add Balance
app.post('/api/add-balance', requireAdmin, async (req, res) => {
    const { userId, amount } = req.body;
    await pool.execute('UPDATE users SET balance = balance + ? WHERE user_id = ?', [amount, userId]);
    res.json({ success: true });
});

// Create User
app.post('/api/create-user', requireAdmin, async (req, res) => {
    const { username, password, store_address, contact_no } = req.body;
    const hash = await bcrypt.hash(password, 10);
    try {
        await pool.execute(
            'INSERT INTO users (username, password_hash, role, balance, is_active, store_address, contact_no) VALUES (?, ?, "retailer", 0, 1, ?, ?)',
            [username, hash, store_address, contact_no]
        );
        res.json({ success: true });
    } catch (e) { res.json({ success: false, message: 'Error' }); }
});

// Settings
app.get('/api/settings', async (req, res) => {
    const [rows] = await pool.execute('SELECT * FROM game_settings WHERE id = 1');
    res.json({ success: true, settings: rows[0] });
});

// Serve Admin Pages
app.get('/admin_dashboard', (req, res) => {
    // ✅ New Path: Looks in 'views' folder (which is NOT public)
    if (req.session.isAdmin) res.sendFile(path.join(__dirname, 'views', 'admin_dashboard.html'));
    else res.redirect('/');
});

// ==========================================
// 3. RESULT SCHEDULER (FIXED TIMEZONE LOGIC)
// ==========================================

async function generateWinningSpot() {
    const connection = await pool.getConnection();
    try {
        // 1. Get Current India Time manually
        const now = new Date();
        const istString = now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" });
        const istDate = new Date(istString);

        // Format as MySQL String: 'YYYY-MM-DD HH:MM:SS'
        const currentIST = istDate.toISOString().slice(0, 19).replace('T', ' ');

        console.log(`🔍 Checking for pending draws before: ${currentIST} (IST)`);

        // 2. Find Pending Draws using Javascript Time
        const [draws] = await connection.execute(
            "SELECT draw_id FROM draws WHERE winning_spot='PENDING' AND end_time <= ? AND is_processed=0 LIMIT 1",
            [currentIST] // <--- We send the exact IST time here
        );

        if (draws.length === 0) {
            connection.release();
            return;
        }
        const drawId = draws[0].draw_id;
        console.log(`\n--- 🧮 CALCULATING DRAW ${drawId} ---`);

        // 3. Get Settings
        const [settings] = await connection.execute("SELECT * FROM game_settings WHERE id = 1");
        const TARGET_RTP = settings[0]?.target_percent || 90;

        // 4. Get Tickets
        const [tickets] = await connection.execute("SELECT bet_details, total_amount FROM tickets WHERE draw_id=?", [drawId]);
        let spotBets = { "A0": 0, "B1": 0, "C2": 0, "D3": 0, "E4": 0, "F5": 0, "G6": 0, "H7": 0, "I8": 0, "J9": 0 };
        let collection = 0;

        tickets.forEach(t => {
            collection += parseFloat(t.total_amount);
            const d = JSON.parse(t.bet_details);
            for (let s in d) spotBets[s] += d[s] * 10;
        });

        // 5. Pick Winner (Logic remains same)
        let bestSpot = '';
        let minDiff = Infinity;
        let payout = 0;

        if (collection === 0) {
            const keys = Object.keys(spotBets);
            bestSpot = keys[Math.floor(Math.random() * keys.length)];
        } else {
            for (let spot in spotBets) {
                let p = spotBets[spot] * 9;
                let rtp = (p / collection) * 100;
                let diff = Math.abs(rtp - TARGET_RTP);
                if (diff < minDiff) { minDiff = diff; bestSpot = spot; payout = p; }
            }
        }

        // 6. Save Result
        await connection.execute(
            "UPDATE draws SET winning_spot=?, total_collection=?, total_payout=?, is_processed=1 WHERE draw_id=?",
            [bestSpot, collection, payout, drawId]
        );
        console.log(`✅ Result: ${bestSpot} | Collection: ${collection} | Payout: ${payout}`);

    } catch (e) {
        console.error("Algo Error:", e);
    } finally {
        connection.release();
    }
}

// Check every 10 SECONDS (More frequent checks)
setInterval(() => {
    if (isShopOpen()) {
        generateWinningSpot();
    }
}, 10000);

// --- ROUTES ---

// 1. Root Route: Redirects to Login Page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// 2. Dashboard Route (Secure)
app.get('/admin_dashboard', (req, res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');

    if (req.session.isAdmin) {
        // Pointing to 'views' folder (if you moved it) or 'public' (if you didn't)
        // Since we just fixed it in 'views', let's use that:
        res.sendFile(path.join(__dirname, 'views', 'admin_dashboard.html'));
    } else {
        res.redirect('/');
    }
});

// --- SESSION CHECK API (For Client-Side) ---
app.get('/api/check-session', (req, res) => {
    res.json({ loggedIn: !!req.session.isAdmin });
});

// --- LOGOUT ROUTE ---
app.post('/api/logout', (req, res) => {
    req.session.destroy((err) => {
        res.clearCookie('connect.sid'); // Clear the session cookie
        res.json({ success: true });
    });
});

// --- 🆕 MISSING ROUTE 1: GET ALL USERS ---
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
        console.error(err);
        res.status(500).json({ success: false });
    }
});

// --- 🆕 MISSING ROUTE 2: GET DRAW HISTORY ---
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

// --- 🆕 MISSING ROUTE 3: TOGGLE USER STATUS (Block/Unblock) ---
app.post('/api/toggle-user', requireAdmin, async (req, res) => {
    const { userId, status } = req.body;
    try {
        await pool.execute('UPDATE users SET is_active = ? WHERE user_id = ?', [status, userId]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false });
    }
});

// --- START SERVER ---
app.listen(PORT, () => {
    console.log(`🚀 Live Server running on port ${PORT}`);
});
