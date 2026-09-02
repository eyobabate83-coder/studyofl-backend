// db.js
const { Pool } = require('pg');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env'), override: true });

console.log("Loading DATABASE_URL:", process.env.DATABASE_URL ? "Found!" : "NOT FOUND!");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

pool.connect()
  .then(() => console.log('Connected to Supabase PostgreSQL successfully!'))
  .catch(err => console.error('Database connection error:', err.stack));

module.exports = pool;