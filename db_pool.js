const mysql = require('mysql2');

const pool = mysql.createPool({
    host: 'winzone-mumbai.cjwkco8y22at.ap-south-1.rds.amazonaws.com', //
    user: 'winzone_user',                                              //
    password: 'Sumit848587',                                    //
    database: 'winzone',
    port: 3306,
    waitForConnections: true,
    connectionLimit: 10,
    connectTimeout: 20000 // 20 seconds timeout
});

// Test the connection immediately when this file loads
pool.getConnection((err, connection) => {
    if (err) {
        console.error('❌ Database Connection Failed:', err.code);
        console.error('   Error Message:', err.message);
    } else {
        console.log('✅ Successfully connected to AWS Database!');
        connection.release();
    }
});

module.exports = pool;