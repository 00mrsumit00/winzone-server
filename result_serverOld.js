// result_server.js
const mysql = require('mysql2/promise');
const cron = require('node-cron');
const crypto = require('crypto');

// --- 1. CONFIGURATION ---
const DRAW_DURATION_MINUTES = 10;
const OWNER_PERCENTAGE = 0.05; // 15% profit (Corrected to 0.15)
const PAYOUT_RATE = 9.0;       // 9x payout

// --- 2. DATABASE CONNECTION ---
const pool = mysql.createPool({
    host: '127.0.0.1',
    user: 'root',
    password: '',
    database: 'winzone',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// const pool = mysql.createPool({
//     host: 'winzone.c9iuy0owubes.eu-north-1.rds.amazonaws.com',
//     user: 'winzone_user',
//     password: 'Sumit848587',
//     database: 'winzone',
//     port: 3306,
//     waitForConnections: true,
//     connectionLimit: 10,
//     connectTimeout: 20000,
//     timezone: '+05:30' // Important for India Time
// });

console.log('✅ Result Server Started.');
console.log('Waiting for the next draw...');

// Helper to get the correct draw time for "just finished" draw
function getPreviousDrawTime() {
    const now = new Date();
    // Round down to nearest 10 minutes
    const minutes = Math.floor(now.getMinutes() / DRAW_DURATION_MINUTES) * DRAW_DURATION_MINUTES;
    const drawTime = new Date(now);
    drawTime.setMinutes(minutes, 0, 0);
    return drawTime;
}

// --- 3. THE MAIN DRAW LOGIC ---
async function declareWinner() {
    let connection;
    try {
        const drawEndTime = getPreviousDrawTime();
        console.log(`\n===== RUNNING DRAW FOR: ${drawEndTime.toLocaleTimeString()} =====`);

        connection = await pool.getConnection();
        await connection.beginTransaction();

        // Step A: Check if this draw exists
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

        // Step B: Get tickets
        const [tickets] = await connection.execute(
            `SELECT * FROM tickets WHERE draw_id = ?`,
            [drawId]
        );

        // --- EMPTY DRAW LOGIC ---
        if (tickets.length === 0) {
            console.log("-> No tickets found. Declaring random result.");
            const spotNames = ['A0', 'B1', 'C2', 'D3', 'E4', 'F5', 'G6', 'H7', 'I8', 'J9'];
            const winnerIndex = crypto.randomInt(0, spotNames.length);
            const winningSpot = spotNames[winnerIndex];

            await connection.execute(
                `UPDATE draws SET winning_spot = ?, total_collection = 0, total_payout = 0, is_processed = 1 WHERE draw_id = ?`,
                [winningSpot, drawId]
            );
            await connection.commit();
            console.log(`✅ Draw ${drawId} Finalized (Empty). Winner: ${winningSpot}`);
            connection.release();
            return;
        }

        console.log(`-> Processing ${tickets.length} tickets...`);

        // Step C: Calculate totals
        let totalCollection = 0;
        const totalBetsBySpot = { 'A0': 0, 'B1': 0, 'C2': 0, 'D3': 0, 'E4': 0, 'F5': 0, 'G6': 0, 'H7': 0, 'I8': 0, 'J9': 0 };

        for (const ticket of tickets) {
            totalCollection += parseFloat(ticket.total_amount);
            const betDetails = JSON.parse(ticket.bet_details);
            for (const spot in betDetails) {
                totalBetsBySpot[spot] += (parseFloat(betDetails[spot]) * 10);
            }
        }

        console.log(`Total Collection: ₹${totalCollection.toFixed(2)}`);

        // Step D: Profit Logic
        const payoutLimit = totalCollection * (1 - OWNER_PERCENTAGE);
        console.log(`Payout Limit (${OWNER_PERCENTAGE * 100}% profit): ₹${payoutLimit.toFixed(2)}`);

        const safeList = [];      // Spots where we make profit
        const allBetSpots = [];   // Spots where users actually bet money

        for (const spot in totalBetsBySpot) {
            const betAmount = totalBetsBySpot[spot];
            const potentialPayout = betAmount * PAYOUT_RATE;

            if (potentialPayout > 0) {
                allBetSpots.push({ spot: spot, payout: potentialPayout });
            }

            if (potentialPayout <= payoutLimit) {
                safeList.push({ spot: spot, payout: potentialPayout });
            }
        }

        let winningSpot;

        // --- NEW SMART LOGIC START ---

        // 1. Filter safeList to find spots that actually pay money (> 0)
        const safeWinners = safeList.filter(item => item.payout > 0);

        if (safeWinners.length > 0) {
            // SCENARIO 1: We have SAFE winners. Pick the best one (Highest Payout) to make users happy.
            safeWinners.sort((a, b) => b.payout - a.payout); // Descending
            const highestSafePayout = safeWinners[0].payout;
            const bestOptions = safeWinners.filter(item => item.payout === highestSafePayout);

            const winnerIndex = crypto.randomInt(0, bestOptions.length);
            winningSpot = bestOptions[winnerIndex].spot;

            console.log(`-> Mode: Maximizing Payout (Safe). Selected: ${winningSpot}`);

        } else if (allBetSpots.length > 0) {
            // SCENARIO 2: No SAFE winners found. All bet spots are UNSAFE.
            // We must "bear minimum loss" rather than defaulting to 0 payout.
            console.log('⚠️ CRITICAL: No safe profitable spots! Switching to MINIMUM LOSS mode.');

            // Sort all bet spots by payout ASCENDING (Lowest payout/loss first)
            allBetSpots.sort((a, b) => a.payout - b.payout);

            const lowestPayout = allBetSpots[0].payout;
            // Get all spots that match this lowest payout (in case of ties)
            const lowestLossOptions = allBetSpots.filter(item => item.payout === lowestPayout);

            const winnerIndex = crypto.randomInt(0, lowestLossOptions.length);
            winningSpot = lowestLossOptions[winnerIndex].spot;

            console.log(`-> Mode: Minimum Loss. Selected: ${winningSpot} (Payout: ₹${lowestPayout.toFixed(2)})`);

        } else {
            // SCENARIO 3: No bets placed on any spot (or collection was 0).
            // Just pick a random safe spot (which will have 0 payout)
            const spotNames = ['A0', 'B1', 'C2', 'D3', 'E4', 'F5', 'G6', 'H7', 'I8', 'J9'];
            const winnerIndex = crypto.randomInt(0, spotNames.length);
            winningSpot = spotNames[winnerIndex];
            console.log(`-> Mode: Random Zero Payout. Selected: ${winningSpot}`);
        }
        // --- NEW SMART LOGIC END ---

        console.log(`🏆 WINNER PICKED: ${winningSpot}`);

        // Step E: Process Payouts
        let totalPayoutAmount = 0;
        for (const ticket of tickets) {
            const betDetails = JSON.parse(ticket.bet_details);

            // Get the QUANTITY bet on the winning spot
            const winningBetQuantity = parseFloat(betDetails[winningSpot] || 0);

            if (winningBetQuantity > 0) {
                // FIX: Multiply Quantity * 10 (Price) * Rate (9.0)
                const winnings = winningBetQuantity * 10 * PAYOUT_RATE;

                totalPayoutAmount += winnings;

                await connection.execute(
                    `UPDATE users SET balance = balance + ? WHERE user_id = ?`,
                    [winnings, ticket.user_id]
                );
                console.log(`-> User ${ticket.user_id} won ₹${winnings.toFixed(2)}`);
            }
        }

        // Step F: Finalize Draw
        await connection.execute(
            `UPDATE draws SET 
                winning_spot = ?, 
                total_collection = ?, 
                total_payout = ?, 
                is_processed = 1 
             WHERE draw_id = ?`,
            [winningSpot, totalCollection, totalPayoutAmount, drawId]
        );

        await connection.commit();
        console.log(`✅ Draw ${drawId} Finalized. Paid: ₹${totalPayoutAmount.toFixed(2)}`);

    } catch (err) {
        console.error('CRITICAL ERROR:', err);
        if (connection) await connection.rollback();
    } finally {
        if (connection) connection.release();
    }
}

// --- 4. THE SCHEDULER ---
cron.schedule(`5 */${DRAW_DURATION_MINUTES} * * * *`, () => {
    declareWinner();
}, {
    scheduled: true,
    timezone: "Asia/Kolkata"
});