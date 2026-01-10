const mysql = require('mysql2/promise');
const cron = require('node-cron');
const crypto = require('crypto');
const pool = require('./db_pool');

// --- 1. CONFIGURATION ---
const DRAW_DURATION_MINUTES = 10;
const OWNER_PERCENTAGE = 0.05; // 5% profit margin
const PAYOUT_RATE = 9.0;       // 9x payout

// // --- 2. DATABASE CONNECTION (AWS) ---
// const pool = mysql.createPool({
//     host: 'winzone-mumbai.cjwkco8y22at.ap-south-1.rds.amazonaws.com',
//     user: 'winzone_user',
//     password: 'Sumit848587',
//     database: 'winzone',
//     port: 3306,
//     waitForConnections: true,
//     connectionLimit: 10,
//     connectTimeout: 20000,
//     timezone: '+05:30'
// });

console.log('✅ Result Server Started.');
console.log('Waiting for the next draw...');

// Helper to get the correct draw time as a STRING (IST)
function getPreviousDrawTime() {
    // 1. Get Current India Time
    const now = new Date();
    const istString = now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" });
    const istDate = new Date(istString);

    // 2. Round down to nearest 10 minutes
    const minutes = Math.floor(istDate.getMinutes() / DRAW_DURATION_MINUTES) * DRAW_DURATION_MINUTES;
    istDate.setMinutes(minutes, 0, 0);

    // 3. Format manually as 'YYYY-MM-DD HH:MM:SS'
    const year = istDate.getFullYear();
    const month = String(istDate.getMonth() + 1).padStart(2, '0');
    const day = String(istDate.getDate()).padStart(2, '0');
    const hours = String(istDate.getHours()).padStart(2, '0');
    const min = String(istDate.getMinutes()).padStart(2, '0');
    const sec = String(istDate.getSeconds()).padStart(2, '0');

    return `${year}-${month}-${day} ${hours}:${min}:${sec}`;
}

// --- 3. THE MAIN DRAW LOGIC (HYBRID: ENGAGEMENT + PID) ---
async function declareWinner() {
    let connection;
    try {
        // 1. Identify the Draw Time
        const drawEndTime = getPreviousDrawTime();
        console.log(`\n===== RUNNING DRAW FOR: ${drawEndTime} (IST) =====`);

        connection = await pool.getConnection();
        await connection.beginTransaction();

        // 2. Find or Create the Draw ID
        const [existingDraws] = await connection.execute(
            `SELECT * FROM draws WHERE end_time = ?`,
            [drawEndTime]
        );

        let drawId;

        if (existingDraws.length === 0) {
            console.log("-> Draw row not found. Creating Empty Draw...");
            const [insertResult] = await connection.execute(
                `INSERT INTO draws (end_time, winning_spot, total_collection, total_payout, is_processed) 
                 VALUES (?, 'PENDING', 0, 0, 0)`,
                [drawEndTime]
            );
            drawId = insertResult.insertId;
        } else {
            const draw = existingDraws[0];
            if (draw.is_processed) {
                console.log("-> Draw already processed. Skipping.");
                await connection.rollback();
                connection.release();
                return;
            }
            drawId = draw.draw_id;
        }

        // 3. Fetch Tickets
        const [tickets] = await connection.execute(
            `SELECT * FROM tickets WHERE draw_id = ?`,
            [drawId]
        );

        // --- EMPTY DRAW LOGIC ---
        if (tickets.length === 0) {
            console.log("-> No tickets found. Declaring random result.");
            const spotNames = ['A0', 'B1', 'C2', 'D3', 'E4', 'F5', 'G6', 'H7', 'I8', 'J9'];
            const winningSpot = spotNames[crypto.randomInt(0, spotNames.length)];

            await connection.execute(
                `UPDATE draws SET winning_spot = ?, total_collection = 0, total_payout = 0, is_processed = 1 WHERE draw_id = ?`,
                [winningSpot, drawId]
            );
            await connection.commit();
            console.log(`✅ Draw ${drawId} Finalized (Empty). Winner: ${winningSpot}`);
            connection.release();
            return;
        }

        // --- CALCULATE BETS ---
        let spotBets = { 'A0': 0, 'B1': 0, 'C2': 0, 'D3': 0, 'E4': 0, 'F5': 0, 'G6': 0, 'H7': 0, 'I8': 0, 'J9': 0 };
        let drawCollection = 0;

        for (const ticket of tickets) {
            drawCollection += parseFloat(ticket.total_amount);
            const betDetails = JSON.parse(ticket.bet_details);
            for (const [spot, qty] of Object.entries(betDetails)) {
                if (spotBets[spot] !== undefined) {
                    spotBets[spot] += (qty * 10);
                }
            }
        }

        console.log(`-> Processing ${tickets.length} tickets | Collection: ₹${drawCollection}`);

        // ============================================================
        // 🧠 HYBRID BRAIN START
        // ============================================================

        // Define Thresholds
        const SMALL_DRAW_LIMIT = 200; // If collection is less than ₹200, use Engagement Logic
        const WIN_RATIO = 60;         // 60% Chance to Win (3 out of 5)

        let bestSpot = '';
        let chosenPayout = 0;

        // --- LOGIC A: SMALL PLAYER ENGAGEMENT (Fluctuating Pattern) ---
        if (drawCollection <= SMALL_DRAW_LIMIT) {
            console.log(`🔹 SMALL DRAW DETECTED (< ₹${SMALL_DRAW_LIMIT}). Engaging Player...`);

            // 1. Identify "Winning Spots" (Spots that pay money to player)
            // 2. Identify "Losing Spots" (Spots that take money)
            let winningSpots = [];
            let losingSpots = [];

            for (const spot of Object.keys(spotBets)) {
                if (spotBets[spot] > 0) winningSpots.push(spot);
                else losingSpots.push(spot);
            }

            // 3. Roll the Dice (0 to 100)
            const luck = crypto.randomInt(0, 100);

            if (luck < WIN_RATIO && winningSpots.length > 0) {
                // --- CASE: GIVE WIN (60% Chance) ---
                console.log(`✨ Engagement Mode: GIVING A WIN (Luck: ${luck} < ${WIN_RATIO})`);
                // Pick a random spot where the player BET money
                bestSpot = winningSpots[crypto.randomInt(0, winningSpots.length)];
            } else {
                // --- CASE: GIVE LOSS (40% Chance) ---
                console.log(`🔻 Engagement Mode: GIVING A LOSS (Luck: ${luck} >= ${WIN_RATIO})`);
                // Pick a random spot where the player did NOT bet
                // If they bet on everything, we fall back to finding the lowest payout
                if (losingSpots.length > 0) {
                    bestSpot = losingSpots[crypto.randomInt(0, losingSpots.length)];
                } else {
                    // They covered all spots, find lowest payout
                    // (Reuse logic below or simple sort)
                    let minPay = Infinity;
                    for (const spot of Object.keys(spotBets)) {
                        if (spotBets[spot] < minPay) {
                            minPay = spotBets[spot];
                            bestSpot = spot;
                        }
                    }
                }
            }
            chosenPayout = spotBets[bestSpot] * 9;
        }

        // --- LOGIC B: BIG DRAW (SMART PID / PROFIT PROTECTION) ---
        else {
            console.log(`🔸 BIG DRAW DETECTED. Using Smart PID Math to balance ledger.`);

            // 1. Get Settings & Daily Stats
            const [settings] = await connection.execute("SELECT * FROM game_settings WHERE id = 1");
            const TARGET_RTP = settings[0]?.target_percent || 90;
            const MIN_DRAW_RTP = settings[0]?.profit_min || 80;
            const MAX_DRAW_RTP = settings[0]?.profit_max || 100;
            const CONTROL_FACTOR = 0.3;

            const [dailyStats] = await connection.execute(`
                SELECT 
                    IFNULL(SUM(t.total_amount), 0) as day_sales,
                    IFNULL(SUM(CASE WHEN d.winning_spot != 'PENDING' THEN d.total_payout ELSE 0 END), 0) as day_payout
                FROM tickets t
                JOIN draws d ON t.draw_id = d.draw_id
                WHERE DATE(t.created_at) = CURDATE() AND t.is_cancelled = 0
            `);

            const daySales = parseFloat(dailyStats[0].day_sales);
            const dayPayout = parseFloat(dailyStats[0].day_payout);

            // 2. Calculate Drift
            let currentRTP = daySales > 0 ? (dayPayout / daySales) * 100 : TARGET_RTP;
            const rtpGap = TARGET_RTP - currentRTP;
            let allowedDrawRTP = TARGET_RTP + (rtpGap * CONTROL_FACTOR);
            allowedDrawRTP = Math.max(MIN_DRAW_RTP, Math.min(allowedDrawRTP, MAX_DRAW_RTP));

            console.log(`🎯 Daily RTP: ${currentRTP.toFixed(2)}% | Target for this draw: ${allowedDrawRTP.toFixed(2)}%`);

            // 3. Find Best Spot
            let lowestDiff = Infinity;
            const shuffledSpots = Object.keys(spotBets).sort(() => Math.random() - 0.5);

            for (const spot of shuffledSpots) {
                const potentialPayout = spotBets[spot] * 9;
                const potentialRTP = (potentialPayout / drawCollection) * 100;
                const diff = Math.abs(potentialRTP - allowedDrawRTP);

                if (diff < lowestDiff) {
                    lowestDiff = diff;
                    bestSpot = spot;
                    chosenPayout = potentialPayout;
                }
            }
        }

        // ============================================================
        // 🏁 FINALIZE
        // ============================================================

        // Payout Users
        for (const ticket of tickets) {
            const betDetails = JSON.parse(ticket.bet_details);
            const winningQty = parseFloat(betDetails[bestSpot] || 0);

            if (winningQty > 0) {
                const winAmount = winningQty * 90;
                await connection.execute(
                    `UPDATE users SET balance = balance + ? WHERE user_id = ?`,
                    [winAmount, ticket.user_id]
                );
            }
        }

        // Update Draw Record
        await connection.execute(
            `UPDATE draws SET winning_spot = ?, total_collection = ?, total_payout = ?, is_processed = 1 WHERE draw_id = ?`,
            [bestSpot, drawCollection, chosenPayout, drawId]
        );

        await connection.commit();
        console.log(`✅ Draw ${drawId} Finalized. Winner: ${bestSpot} | Payout: ₹${chosenPayout}`);

    } catch (err) {
        console.error('CRITICAL ERROR:', err);
        if (connection) await connection.rollback();
    } finally {
        if (connection) connection.release();
    }
}

// --- 4. THE SCHEDULER (Run 5 seconds after every 10th minute) ---
cron.schedule(`5 */${DRAW_DURATION_MINUTES} * * * *`, () => {
    declareWinner();
}, {
    scheduled: true,
    timezone: "Asia/Kolkata"
});