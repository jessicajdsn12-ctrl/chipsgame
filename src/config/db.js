const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');

const usarSSL = process.env.DB_SSL === 'true';

module.exports = mysql.createPool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 5,
  ssl: usarSSL
    ? { ca: fs.readFileSync(path.join(__dirname, 'aiven-ca.pem')) }
    : undefined,
});