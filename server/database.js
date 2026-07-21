"use strict";

require("dotenv").config();

const { Pool } = require("pg");

if (!process.env.DATABASE_URL) {
    throw new Error(
        "DATABASE_URL is missing. Add it to your .env file."
    );
}

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl:
        process.env.DATABASE_SSL === "true"
            ? { rejectUnauthorized: false }
            : false,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000
});

pool.on("error", (error) => {
    console.error("Unexpected PostgreSQL pool error:", error);
});

async function initializeDatabase() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS accounts (
            id TEXT PRIMARY KEY,
            username TEXT NOT NULL,
            username_key TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            password_salt TEXT NOT NULL,
            created_at BIGINT NOT NULL
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS login_tokens (
            token_hash TEXT PRIMARY KEY,
            account_id TEXT NOT NULL
                REFERENCES accounts(id)
                ON DELETE CASCADE,
            expires_at BIGINT NOT NULL
        )
    `);

    await pool.query(`
        CREATE INDEX IF NOT EXISTS
        login_tokens_account_id_index
        ON login_tokens(account_id)
    `);
}

module.exports = {
    pool,
    initializeDatabase
};