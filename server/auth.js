"use strict";

const crypto = require("crypto");
const { pool } = require("./database");

function cleanUsername(value) {
    return String(value ?? "").trim();
}

function normalizeUsername(value) {
    return cleanUsername(value).toLowerCase();
}

function isValidUsername(value) {
    return /^[a-zA-Z0-9_]{3,20}$/.test(
        cleanUsername(value)
    );
}

function isValidPassword(value) {
    return (
        typeof value === "string" &&
        value.length >= 6 &&
        value.length <= 128
    );
}

function derivePasswordKey(password, salt) {
    return new Promise((resolve, reject) => {
        crypto.scrypt(
            password,
            salt,
            64,
            (error, derivedKey) => {
                if (error) {
                    reject(error);
                    return;
                }

                resolve(derivedKey);
            }
        );
    });
}

async function createPasswordRecord(password) {
    const salt = crypto.randomBytes(16).toString("hex");
    const key = await derivePasswordKey(password, salt);

    return {
        salt,
        hash: key.toString("hex")
    };
}

async function passwordMatches(
    password,
    savedSalt,
    savedHash
) {
    const derivedKey = await derivePasswordKey(
        password,
        savedSalt
    );

    const savedBuffer = Buffer.from(savedHash, "hex");

    if (derivedKey.length !== savedBuffer.length) {
        return false;
    }

    return crypto.timingSafeEqual(
        derivedKey,
        savedBuffer
    );
}

function hashToken(token) {
    return crypto
        .createHash("sha256")
        .update(token)
        .digest("hex");
}

async function createLoginToken(accountId) {
    const token = crypto.randomBytes(32).toString("hex");
    const tokenHash = hashToken(token);

    const expiresAt =
        Date.now() + 7 * 24 * 60 * 60 * 1000;

    await pool.query(
        `
DELETE FROM login_tokens
WHERE account_id = $1
`,
        [accountId]
    );

    await pool.query(
        `
        INSERT INTO login_tokens (
            token_hash,
            account_id,
            expires_at
        )
        VALUES ($1, $2, $3)
        `,
        [tokenHash, accountId, expiresAt]
    );

    return token;
}

async function registerAccount(username, password) {
    const displayUsername = cleanUsername(username);
    const usernameKey = normalizeUsername(username);

    if (!isValidUsername(displayUsername)) {
        throw new Error(
            "Username must be 3–20 characters and use only letters, numbers, or underscores."
        );
    }

    if (!isValidPassword(password)) {
        throw new Error(
            "Password must be between 6 and 128 characters."
        );
    }

    const existing = await pool.query(
        `
        SELECT id
        FROM accounts
        WHERE username_key = $1
        `,
        [usernameKey]
    );

    if (existing.rows.length > 0) {
        throw new Error("That username is already taken.");
    }

    const accountId = crypto.randomUUID();
    const passwordRecord =
        await createPasswordRecord(password);

    try {
        await pool.query(
            `
        INSERT INTO accounts (
            id,
            username,
            username_key,
            password_hash,
            password_salt,
            created_at
        )
        VALUES ($1,$2,$3,$4,$5,$6)
        `,
            [
                accountId,
                displayUsername,
                usernameKey,
                passwordRecord.hash,
                passwordRecord.salt,
                Date.now()
            ]
        );
    }
    catch (err) {
        if (err.code === "23505") {
            throw new Error("That username is already taken.");
        }

        throw err;
    }

    return {
        id: accountId,
        username: displayUsername
    };
}

async function loginAccount(username, password) {
    const result = await pool.query(
        `
        SELECT
            id,
            username,
            password_hash,
            password_salt
        FROM accounts
        WHERE username_key = $1
        `,
        [normalizeUsername(username)]
    );

    const account = result.rows[0];

    if (!account) {
        throw new Error("Incorrect username or password.");
    }

    const valid = await passwordMatches(
        password,
        account.password_salt,
        account.password_hash
    );

    if (!valid) {
        throw new Error("Incorrect username or password.");
    }

    return {
        id: account.id,
        username: account.username
    };
}

async function accountFromToken(token) {
    if (typeof token !== "string" || token.length < 32) {
        return null;
    }

    const tokenHash = hashToken(token);

    const result = await pool.query(
        `
        SELECT
            accounts.id,
            accounts.username,
            login_tokens.expires_at
        FROM login_tokens
        JOIN accounts
            ON accounts.id = login_tokens.account_id
        WHERE login_tokens.token_hash = $1
        `,
        [tokenHash]
    );

    const account = result.rows[0];

    if (!account) {
        return null;
    }

    if (Number(account.expires_at) <= Date.now()) {
        await pool.query(
            `
            DELETE FROM login_tokens
            WHERE token_hash = $1
            `,
            [tokenHash]
        );

        return null;
    }

    return {
        id: account.id,
        username: account.username
    };
}

async function deleteLoginToken(token) {
    if (!token) return;

    await pool.query(
        `
        DELETE FROM login_tokens
        WHERE token_hash = $1
        `,
        [hashToken(token)]
    );
}

module.exports = {
    registerAccount,
    loginAccount,
    accountFromToken,
    createLoginToken,
    deleteLoginToken
};