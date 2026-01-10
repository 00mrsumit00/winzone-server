// admin_dashboard.js

// 🔒 SECURITY: Verify Session Immediately
fetch('/api/check-session')
    .then(res => res.json())
    .then(data => {
        if (!data.loggedIn) {
            // Force reload to trigger server redirect
            window.location.href = '/';
        }
    })
    .catch(() => { window.location.href = '/'; });

// 1. On Load: Fetch Dashboard Stats
document.addEventListener('DOMContentLoaded', () => {
    loadStats();
    loadUsers();
    loadDashHistory(true);
    loadGameSettings();

    // Start the live timer for the admin dashboard
    setInterval(updateAdminTimer, 1000);
});

async function loadStats() {
    try {
        const res = await fetch('/api/stats');
        const data = await res.json();

        if (data.success) {
            document.getElementById('total-users').innerText = data.totalUsers;
            document.getElementById('today-sale').innerText = `₹${data.todaySale.toFixed(2)}`;
            document.getElementById('today-profit').innerText = `₹${data.todayProfit.toFixed(2)}`;
            document.getElementById('next-draw-time').innerText = data.nextDraw;
        }
    } catch (err) {
        console.error('Error loading stats:', err);
    }
}

// 2. User Management Functions
async function loadUsers() {
    try {
        const res = await fetch('/api/users');
        const data = await res.json();

        const tbody = document.querySelector('#users-table tbody');
        tbody.innerHTML = '';

        if (data.success && data.users.length > 0) {
            data.users.forEach(user => {
                const statusBadge = user.is_active
                    ? '<span style="color: #1cc88a; font-weight:bold; background: #eafaf1; padding: 4px 10px; border-radius: 12px; font-size: 0.8rem;">Active</span>'
                    : '<span style="color: #e74a3b; font-weight:bold; background: #fdeceb; padding: 4px 10px; border-radius: 12px; font-size: 0.8rem;">Blocked</span>';

                const tr = document.createElement('tr');
                tr.innerHTML = `
                    <td style="font-weight: bold; color: #666;">S90${user.user_id}</td>
                    <td style="font-weight: bold;">${user.username}</td>
                    <td style="color: var(--primary-color); font-weight: bold;">₹${parseFloat(user.balance).toFixed(2)}</td>
                    <td><span style="background: #f0f0f0; padding: 3px 8px; border-radius: 4px; font-size: 0.8rem;">${user.role}</span></td>
                    <td>${statusBadge}</td>
                    <td>
                        <button class="btn btn-success" onclick="openAddBalance(${user.user_id}, '${user.username}')" title="Add Funds">
                            <i class="fa-solid fa-plus"></i>
                        </button>
                        <button class="btn btn-info" style="margin: 0 5px;" onclick="openAccountLedger(${user.user_id}, '${user.username}')" title="View Ledger">
                            <i class="fa-solid fa-file-invoice-dollar"></i> Account
                        </button>
                        <button class="btn btn-danger" onclick="toggleUser(${user.user_id}, ${user.is_active ? 0 : 1})" title="${user.is_active ? 'Block User' : 'Unblock User'}">
                            <i class="fa-solid ${user.is_active ? 'fa-ban' : 'fa-unlock'}"></i>
                        </button>
                    </td>
                `;
                tbody.appendChild(tr);
            });
        } else {
            tbody.innerHTML = '<tr><td colspan="6" style="padding: 30px; color: #888;">No retailers found. Click "Add New User" to start.</td></tr>';
        }
    } catch (err) {
        console.error('Error loading users:', err);
    }
}

// 3. Add Balance Logic
function openAddBalance(userId, username) {
    const amount = prompt(`Add Balance to ${username}:\nEnter amount (e.g. 5000):`);
    if (amount) {
        if (isNaN(amount) || amount <= 0) {
            alert("Please enter a valid positive number.");
            return;
        }
        addBalance(userId, amount);
    }
}

async function addBalance(userId, amount) {
    const res = await fetch('/api/add-balance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, amount })
    });
    const data = await res.json();
    if (data.success) {
        alert('✅ Balance added successfully!');
        loadUsers();
    } else {
        alert('Error: ' + data.message);
    }
}

// 4. Create User Logic
function openAddUserModal() {
    document.getElementById('add-user-modal').style.display = 'flex';
}

function closeAddUserModal() {
    document.getElementById('add-user-modal').style.display = 'none';
    document.getElementById('add-user-form').reset();
}

async function submitNewUser(event) {
    event.preventDefault();

    const username = document.getElementById('new-username').value;
    const password = document.getElementById('new-password').value;
    const address = document.getElementById('new-address').value;
    const contact = document.getElementById('new-contact').value;

    try {
        const res = await fetch('/api/create-user', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                username,
                password,
                store_address: address,
                contact_no: contact,
                target_percent: target,
                profit_min: min,
                profit_max: max
            })
        });

        const data = await res.json();

        if (data.success) {
            alert('✅ User created successfully!');
            closeAddUserModal();
            loadUsers();
        } else {
            alert('❌ Error: ' + data.message);
        }
    } catch (err) {
        console.error(err);
        alert('Server connection error');
    }
}

// 5. Toggle Block/Unblock
async function toggleUser(userId, status) {
    const action = status === 0 ? "BLOCK" : "UNBLOCK";
    if (!confirm(`Are you sure you want to ${action} this user?`)) return;

    await fetch('/api/toggle-user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, status })
    });
    loadUsers();
}

// 6. DASHBOARD DRAW HISTORY LOGIC
document.getElementById('dash-date-filter').addEventListener('change', (e) => {
    loadDashHistory(false, e.target.value);
});

async function loadDashHistory(isToday = false, specificDate = null) {
    const tbody = document.getElementById('dash-history-body');
    const dateInput = document.getElementById('dash-date-filter');

    let dateStr = specificDate;

    if (isToday) {
        // ✅ FIX: Use Local Time instead of ISO (UTC)
        const now = new Date();
        const today = now.getFullYear() + '-' + (now.getMonth() + 1).toString().padStart(2, '0') + '-' + now.getDate().toString().padStart(2, '0');

        dateInput.value = today;
        dateStr = today;
    } else if (!dateStr) {
        dateStr = dateInput.value;
    }

    if (!dateStr) return;

    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; padding: 20px;">Loading history...</td></tr>';

    try {
        const res = await fetch(`/api/draw-history?date=${dateStr}`);
        const data = await res.json();

        tbody.innerHTML = '';

        if (data.success && data.results.length > 0) {
            data.results.forEach(row => {
                const collection = parseFloat(row.total_collection || 0);
                const payout = parseFloat(row.total_payout || 0);
                const profit = collection - payout;

                const profitColor = profit >= 0 ? '#1cc88a' : '#e74a3b';
                const spotColor = '#4e73df';

                const tr = document.createElement('tr');
                tr.innerHTML = `
                    <td style="color: #555;">#${row.draw_id}</td>
                    <td>${new Date(row.end_time).toLocaleTimeString()}</td>
                    <td style="font-weight:bold; color: ${spotColor}; font-size: 1rem;">
                        ${row.winning_spot || '<span style="color:orange">Pending</span>'}
                    </td>
                    <td>₹${collection.toFixed(2)}</td>
                    <td>₹${payout.toFixed(2)}</td>
                    <td style="color:${profitColor}; font-weight:bold;">
                        ₹${profit.toFixed(2)}
                    </td>
                `;
                tbody.appendChild(tr);
            });
        } else {
            tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; padding: 30px; color: #888;">No draws found for this date.</td></tr>';
        }

    } catch (err) {
        console.error("Error loading history:", err);
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; color:red;">Error loading data.</td></tr>';
    }
}


// 7. ACCOUNT LEDGER LOGIC
let currentLedgerUserId = null;

function openAccountLedger(userId, username) {
    currentLedgerUserId = userId;
    document.getElementById('ledger-username').innerText = username;
    document.getElementById('ledger-modal').style.display = 'flex';
    fetchLedger(true);
}

function closeLedgerModal() {
    document.getElementById('ledger-modal').style.display = 'none';
}

async function fetchLedger(isToday = false) {
    if (!currentLedgerUserId) return;

    const fromDate = document.getElementById('ledger-from');
    const toDate = document.getElementById('ledger-to');
    const tbody = document.getElementById('ledger-table-body');
    const tfoot = document.getElementById('ledger-table-footer');

    if (isToday) {
        // ✅ FIX: Use Local Time
        const now = new Date();
        const today = now.getFullYear() + '-' +
            (now.getMonth() + 1).toString().padStart(2, '0') + '-' +
            now.getDate().toString().padStart(2, '0');

        fromDate.value = today;
        toDate.value = today;
    }

    const start = fromDate.value;
    const end = toDate.value;

    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; padding:20px; color:#fff;">Loading data...</td></tr>';
    tfoot.innerHTML = '';

    try {
        const res = await fetch(`/api/admin/ledger?userId=${currentLedgerUserId}&startDate=${start}&endDate=${end}`);
        const data = await res.json();

        if (data.success && data.ledger.length > 0) {
            tbody.innerHTML = '';

            let grandSale = 0;
            let grandWin = 0;
            let grandComm = 0;
            let grandNet = 0;

            data.ledger.forEach(row => {
                const sale = parseFloat(row.totalSale);
                const win = parseFloat(row.totalWinning);
                const comm = sale * 0.09;
                const net = sale - (win + comm);

                grandSale += sale;
                grandWin += win;
                grandComm += comm;
                grandNet += net;

                const d = new Date(row.date);
                const dateStr = d.toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric' });

                const tr = document.createElement('tr');
                tr.innerHTML = `
                    <td style="text-align: center; border-bottom: 1px solid #444;">${dateStr}</td>
                    <td style="text-align: center; color: #28a745; font-weight: bold; border-bottom: 1px solid #444;">₹${Math.round(sale)}</td>
                    <td style="text-align: center; color: #dc3545; font-weight: bold; border-bottom: 1px solid #444;">₹${Math.round(win)}</td>
                    <td style="text-align: center; color: #ffc107; font-weight: bold; border-bottom: 1px solid #444;">₹${Math.round(comm)}</td>
                    <td style="text-align: center; color: #fff; font-weight: bold; border-bottom: 1px solid #444; font-size: 1.1rem;">₹${Math.round(net)}</td>
                `;
                tbody.appendChild(tr);
            });

            tfoot.innerHTML = `
                <tr style="background: #333; font-weight: bold;">
                    <td style="text-align: right; padding-right: 15px; color: white;">TOTAL:</td>
                    <td style="text-align: center; color: #28a745;">₹${Math.round(grandSale)}</td>
                    <td style="text-align: center; color: #dc3545;">₹${Math.round(grandWin)}</td>
                    <td style="text-align: center; color: #ffc107;">₹${Math.round(grandComm)}</td>
                    <td style="text-align: center; color: white; font-size: 1.2rem;">₹${Math.round(grandNet)}</td>
                </tr>
            `;

        } else {
            tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; padding:20px; color:#aaa;">No sales data found for this period.</td></tr>';
        }

    } catch (err) {
        console.error(err);
        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; color:red;">Server Error.</td></tr>';
    }
}

// 8. SIMPLE ADMIN TIMER (Visual Only)
function updateAdminTimer() {
    const now = new Date();
    const minutes = now.getMinutes();
    const seconds = now.getSeconds();

    // Assumes 10-minute draw interval (change 10 to 15 if needed)
    const DRAW_INTERVAL = 10;

    const minutesLeft = (DRAW_INTERVAL - 1) - (minutes % DRAW_INTERVAL);
    const secondsLeft = 59 - seconds;

    const displayMin = minutesLeft.toString().padStart(2, '0');
    const displaySec = secondsLeft.toString().padStart(2, '0');

    const timerEl = document.getElementById('admin-timer');
    if (timerEl) {
        timerEl.textContent = `${displayMin}:${displaySec}`;

        // Add warning color if less than 1 minute
        if (minutesLeft === 0 && secondsLeft < 60) {
            timerEl.style.color = '#e74a3b';
        } else {
            timerEl.style.color = '#e74a3b'; // Default color
        }
    }
}

// ==========================================
// 9. GAME SETTINGS LOGIC
// ==========================================

async function loadGameSettings() {
    try {
        const res = await fetch('/api/settings');
        const data = await res.json();
        if (data.success) {
            document.getElementById('setting-target').value = data.settings.target_percent;
            document.getElementById('setting-min').value = data.settings.profit_min; // Using existing DB column for Min RTP
            document.getElementById('setting-max').value = data.settings.profit_max; // Using existing DB column for Max RTP
        }
    } catch (err) {
        console.error('Error loading settings:', err);
    }
}

async function saveSettings() {
    const target = document.getElementById('setting-target').value;
    const min = document.getElementById('setting-min').value;
    const max = document.getElementById('setting-max').value;

    if (parseInt(minProfit) > parseInt(maxProfit)) {
        alert("Error: Min Profit cannot be greater than Max Profit.");
        return;
    }

    try {
        const res = await fetch('/api/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                draw_time: drawTime,
                profit_min: minProfit,
                profit_max: maxProfit
            })
        });
        const data = await res.json();
        if (data.success) {
            alert("✅ Settings Saved! Retailers will see changes after next reload.");
        } else {
            alert("Error saving settings.");
        }
    } catch (err) {
        console.error(err);
        alert("Server Error.");
    }
}