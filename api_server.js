const express = require('express');
const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');
const bodyParser = require('body-parser');
const session = require('express-session');
const cors = require('cors');
const path = require('path');
const pool = require('./db_pool'); // Uses your existing db_pool.js

// --- CONFIGURATION ---
const PORT = process.env.PORT || 3000;

// --- 🕒 OPERATING HOURS LOGIC (IST) ---
function isShopOpen() {
    const now = new Date();
    const istString = now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" });
    const istDate = new Date(istString);
    const currentHour = istDate.getHours();
    // Open from 6:00 AM to 11:59 PM
    if (currentHour >= 6 && currentHour <= 23) {
        return true;
    }
    return false;
}

// --- SETUP APP ---
const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public'))); // Serve Login Page

app.use(session({
    secret: 'super_secure_winzone_live_key',
    resave: false,
    saveUninitialized: true,
    cookie: { maxAge: 3600000 }
}));

// --- MIDDLEWARE ---
function requireAdmin(req, res, next) {
    if (req.session.isAdmin) next();
    else res.status(401).json({ success: false, message: 'Unauthorized' });
}

// ==========================================
// 1. RETAILER API (For Electron App)
// ==========================================

// 3.---- Login -----
app.post('/api/retailer/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const [rows] = await pool.execute("SELECT * FROM users WHERE username = ?", [username]);
        if (rows.length > 0) {
            const user = rows[0];
            const isMatch = await bcrypt.compare(password, user.password_hash);
            if (isMatch) {
                if (!user.is_active) return res.json({ success: false, message: 'Account Blocked' });
                delete user.password_hash;
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
        return res.json({ success: false, message: 'Shop is Closed! Hours: 6AM - 12AM' });
    }

    const { username, ticketData } = req.body;
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        // 1. Get User & Lock Row
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

        // 3. Get/Create Draw (Optimistic Creation)
        let [drawRows] = await connection.execute("SELECT draw_id FROM draws WHERE end_time = ?", [ticketData.drawEndTime]);
        let draw_id;

        if (drawRows.length > 0) {
            draw_id = drawRows[0].draw_id;
        } else {
            // If draw doesn't exist, create it pending
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

// --- 4. TICKET HISTORY ---
app.post('/api/retailer/history', async (req, res) => {
    const { username, date } = req.body;
    try {
        const [users] = await pool.execute("SELECT user_id FROM users WHERE username = ?", [username]);
        if (!users.length) return res.json({ success: false, message: 'User not found' });
        const userId = users[0].user_id;

        let sql = `
            SELECT t.ticket_id, t.draw_id, t.bet_details, t.total_amount, t.created_at, d.end_time
            FROM tickets t
            JOIN draws d ON t.draw_id = d.draw_id
            WHERE t.user_id = ? AND t.is_cancelled = 0
        `;
        const params = [userId];

        if (date) {
            sql += ` AND DATE(t.created_at) = ?`;
            params.push(date);
        }
        sql += ` ORDER BY t.created_at DESC`;

        const [rows] = await pool.execute(sql, params);
        res.json({ success: true, tickets: rows });
    } catch (e) {
        console.error(e);
        res.json({ success: false, message: 'Server Error' });
    }
});

// --- 5. CANCEL TICKET ---
app.post('/api/retailer/cancel', async (req, res) => {
    const { ticketId, username } = req.body;
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        // Check User
        const [users] = await connection.execute("SELECT user_id, balance FROM users WHERE username = ? FOR UPDATE", [username]);
        const user = users[0];

        // Check Ticket
        const [tickets] = await connection.execute(`
            SELECT t.*, d.end_time FROM tickets t 
            JOIN draws d ON t.draw_id = d.draw_id
            WHERE t.ticket_id = ? AND t.user_id = ?
        `, [ticketId, user.user_id]);

        if (!tickets.length) { await connection.rollback(); return res.json({ success: false, message: "Ticket not found" }); }
        const ticket = tickets[0];

        if (ticket.is_cancelled) { await connection.rollback(); return res.json({ success: false, message: "Already cancelled" }); }

        // Time Check (Server Side = Secure)
        const [timeRows] = await connection.execute(`SELECT DATE_FORMAT(DATE_ADD(UTC_TIMESTAMP(), INTERVAL '05:30' HOUR_MINUTE), '%Y-%m-%d %H:%i:%s') as ist`);
        const serverTime = new Date(timeRows[0].ist);
        const drawTime = new Date(ticket.end_time);

        if ((drawTime - serverTime) < 60000) { // Less than 1 min
            await connection.rollback();
            return res.json({ success: false, message: "Time over! Cannot cancel." });
        }

        // Refund
        const newBalance = parseFloat(user.balance) + parseFloat(ticket.total_amount);
        await connection.execute("UPDATE users SET balance = ? WHERE user_id = ?", [newBalance, user.user_id]);
        await connection.execute("UPDATE tickets SET is_cancelled = 1 WHERE ticket_id = ?", [ticketId]);

        await connection.commit();
        res.json({ success: true, message: "Cancelled Successfully", newBalance: newBalance });

    } catch (e) {
        await connection.rollback();
        res.json({ success: false, message: "Server Error" });
    } finally {
        connection.release();
    }
});

// --- 6. ACCOUNT LEDGER ---
app.post('/api/retailer/ledger', async (req, res) => {
    const { username, startDate, endDate } = req.body;
    try {
        const [users] = await pool.execute("SELECT user_id FROM users WHERE username = ?", [username]);
        if (!users.length) return res.json({ success: false });
        const userId = users[0].user_id;

        let sql = `
            SELECT DATE(t.created_at) as sale_date, t.total_amount, t.bet_details, d.winning_spot, t.is_claimed
            FROM tickets t JOIN draws d ON t.draw_id = d.draw_id
            WHERE t.user_id = ? AND t.is_cancelled = 0
        `;
        const params = [userId];
        if (startDate && endDate) {
            sql += ` AND DATE(t.created_at) BETWEEN ? AND ?`;
            params.push(startDate, endDate);
        }
        sql += ` ORDER BY t.created_at DESC`;

        const [rows] = await pool.execute(sql, params);

        // Group Data by Date
        const ledgerMap = {};
        rows.forEach(row => {
            const dateKey = new Date(row.sale_date).toISOString().split('T')[0];
            if (!ledgerMap[dateKey]) {
                ledgerMap[dateKey] = { date: dateKey, totalSale: 0, totalWinning: 0 };
            }
            ledgerMap[dateKey].totalSale += parseFloat(row.total_amount);

            // Only add winning if claimed
            if (row.winning_spot && row.winning_spot !== 'PENDING' && row.is_claimed) {
                const bets = JSON.parse(row.bet_details);
                if (bets[row.winning_spot]) {
                    ledgerMap[dateKey].totalWinning += (bets[row.winning_spot] * 90);
                }
            }
        });

        res.json({ success: true, data: Object.values(ledgerMap).sort((a, b) => new Date(b.date) - new Date(a.date)) });

    } catch (e) {
        console.error(e);
        res.json({ success: false, message: 'Server Error' });
    }
});

// ==========================================
// 2. ADMIN API
// ==========================================

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

app.post('/api/add-balance', requireAdmin, async (req, res) => {
    const { userId, amount } = req.body;
    await pool.execute('UPDATE users SET balance = balance + ? WHERE user_id = ?', [amount, userId]);
    res.json({ success: true });
});

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

app.get('/api/settings', async (req, res) => {
    const [rows] = await pool.execute('SELECT * FROM game_settings WHERE id = 1');
    res.json({ success: true, settings: rows[0] });
});

app.post('/api/settings', requireAdmin, async (req, res) => {
    const { draw_time, profit_min, profit_max, target_percent } = req.body;
    try {
        await pool.execute(
            'UPDATE game_settings SET draw_time_minutes=?, profit_min=?, profit_max=?, target_percent=? WHERE id=1',
            [draw_time, profit_min, profit_max, target_percent]
        );
        res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false }); }
});

app.get('/api/users', requireAdmin, async (req, res) => {
    try {
        const [rows] = await pool.execute(`SELECT user_id, username, balance, role, is_active, created_at FROM users WHERE role="retailer" ORDER BY user_id DESC`);
        res.json({ success: true, users: rows });
    } catch (err) { res.status(500).json({ success: false }); }
});

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
    } catch (err) { res.status(500).json({ success: false }); }
});

app.post('/api/toggle-user', requireAdmin, async (req, res) => {
    const { userId, status } = req.body;
    try {
        await pool.execute('UPDATE users SET is_active = ? WHERE user_id = ?', [status, userId]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false }); }
});

// --- SERVE PAGES ---
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/admin_dashboard', (req, res) => {
    if (req.session.isAdmin) res.sendFile(path.join(__dirname, 'views', 'admin_dashboard.html'));
    else res.redirect('/');
});

app.get('/api/check-session', (req, res) => {
    res.json({ loggedIn: !!req.session.isAdmin });
});

app.post('/api/logout', (req, res) => {
    req.session.destroy(() => {
        res.clearCookie('connect.sid');
        res.json({ success: true });
    });
});

app.listen(PORT, () => {
    console.log(`🚀 API Server running on port ${PORT}`);
});