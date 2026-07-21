"use strict";

/*
    auth-ui.js

    Handles:
    - Login
    - Account registration
    - Saved login token
    - Automatic token authentication
    - Logout
    - Showing/hiding authentication UI

    IMPORTANT:
    `socket` must be created before this file loads.
*/

// These use `var` intentionally so the rest of your existing
// client code can access them as global variables.
var ACCOUNT_TOKEN_KEY =
    "pitchPartyAccountToken";

var accountAuthenticated = false;
var authMode = "login";

// ---------------------------------------------------------
// ELEMENTS
// ---------------------------------------------------------

const authScreen =
    document.getElementById("authScreen");

const authForm =
    document.getElementById("accountForm");

const accountUsername =
    document.getElementById("accountUsername");

const accountPassword =
    document.getElementById("accountPassword");

const confirmPassword =
    document.getElementById("confirmPassword");

const confirmPasswordField =
    document.getElementById(
        "confirmPasswordField"
    );

const authSubmit =
    document.getElementById("authSubmit");

const authMessage =
    document.getElementById("authMessage");

const loginTab =
    document.getElementById("loginTab");

const registerTab =
    document.getElementById("registerTab");

// These elements are optional.
// The script will still work if they do not exist yet.
const accountBar =
    document.getElementById("accountBar");

const accountBarUsername =
    document.getElementById(
        "accountBarUsername"
    );

const logoutAccountButton =
    document.getElementById("logoutAccount");

// These are your existing game panels.
const authPanel =
    document.getElementById("auth");

const directoryPanel =
    document.getElementById("directory");

const lobbyPanel =
    document.getElementById("lobby");

const gamePanel =
    document.getElementById("game");

// ---------------------------------------------------------
// SAFETY CHECKS
// ---------------------------------------------------------

if (typeof socket === "undefined") {
    throw new Error(
        "Socket.IO must be initialized before auth-ui.js."
    );
}

if (
    !authScreen ||
    !authForm ||
    !accountUsername ||
    !accountPassword ||
    !confirmPassword ||
    !confirmPasswordField ||
    !authSubmit ||
    !authMessage ||
    !loginTab ||
    !registerTab
) {
    throw new Error(
        "One or more authentication HTML elements are missing."
    );
}

// ---------------------------------------------------------
// PANEL HELPERS
// ---------------------------------------------------------

function showAuthPanel(element) {
    if (!element) {
        return;
    }

    element.classList.add("show");
    element.style.display = "block";
}

function hideAuthPanel(element) {
    if (!element) {
        return;
    }

    element.classList.remove("show");
    element.style.display = "none";
}

function showLoggedOutScreen() {
    authScreen.style.display = "grid";

    hideAuthPanel(authPanel);
    hideAuthPanel(directoryPanel);
    hideAuthPanel(lobbyPanel);
    hideAuthPanel(gamePanel);

    if (accountBar) {
        accountBar.style.display = "none";
    }
}

function showRoomDirectory() {
    authScreen.style.display = "none";

    showAuthPanel(authPanel);
    showAuthPanel(directoryPanel);

    hideAuthPanel(lobbyPanel);
    hideAuthPanel(gamePanel);
}

// ---------------------------------------------------------
// AUTH UI HELPERS
// ---------------------------------------------------------

function setAuthMode(mode) {
    authMode =
        mode === "register"
            ? "register"
            : "login";

    const registering =
        authMode === "register";

    loginTab.classList.toggle(
        "active",
        !registering
    );

    registerTab.classList.toggle(
        "active",
        registering
    );

    confirmPasswordField.style.display =
        registering
            ? "block"
            : "none";

    confirmPassword.required =
        registering;

    accountPassword.autocomplete =
        registering
            ? "new-password"
            : "current-password";

    authSubmit.textContent =
        registering
            ? "Create Account"
            : "Log In";

    authMessage.textContent = "";
    authMessage.className =
        "auth-message";
}

function setAuthLoading(loading) {
    authForm.classList.toggle(
        "auth-loading",
        loading
    );

    authSubmit.disabled = loading;
    loginTab.disabled = loading;
    registerTab.disabled = loading;
    accountUsername.disabled = loading;
    accountPassword.disabled = loading;
    confirmPassword.disabled = loading;

    if (loading) {
        authSubmit.textContent =
            authMode === "register"
                ? "Creating account..."
                : "Logging in...";
    } else {
        authSubmit.textContent =
            authMode === "register"
                ? "Create Account"
                : "Log In";
    }
}

function showAuthMessage(
    message,
    type = ""
) {
    authMessage.textContent =
        String(message || "");

    authMessage.className =
        `auth-message ${type}`.trim();
}

function clearPasswordFields() {
    accountPassword.value = "";
    confirmPassword.value = "";
}

function getStoredAccountToken() {
    return localStorage.getItem(
        ACCOUNT_TOKEN_KEY
    );
}

function storeAccountToken(token) {
    if (
        typeof token !== "string" ||
        !token
    ) {
        return;
    }

    localStorage.setItem(
        ACCOUNT_TOKEN_KEY,
        token
    );
}

function removeStoredAccountToken() {
    localStorage.removeItem(
        ACCOUNT_TOKEN_KEY
    );
}

// ---------------------------------------------------------
// TAB BUTTONS
// ---------------------------------------------------------

loginTab.addEventListener(
    "click",
    () => {
        setAuthMode("login");
    }
);

registerTab.addEventListener(
    "click",
    () => {
        setAuthMode("register");
    }
);

// ---------------------------------------------------------
// LOGIN / REGISTER FORM
// ---------------------------------------------------------

authForm.addEventListener(
    "submit",
    (event) => {
        event.preventDefault();

        if (authSubmit.disabled) {
            return;
        }

        const username =
            accountUsername.value.trim();

        const password =
            accountPassword.value;

        const confirmedPassword =
            confirmPassword.value;

        if (!username) {
            showAuthMessage(
                "Enter your username.",
                "error"
            );

            accountUsername.focus();
            return;
        }

        if (username.length > 20) {
            showAuthMessage(
                "Your username must be 20 characters or fewer.",
                "error"
            );

            accountUsername.focus();
            return;
        }

        if (!password) {
            showAuthMessage(
                "Enter your password.",
                "error"
            );

            accountPassword.focus();
            return;
        }

        if (
            authMode === "register" &&
            password !== confirmedPassword
        ) {
            showAuthMessage(
                "The passwords do not match.",
                "error"
            );

            confirmPassword.focus();
            return;
        }

        setAuthLoading(true);

        showAuthMessage(
            authMode === "register"
                ? "Creating your account…"
                : "Logging you in…"
        );

        socket.emit(
            authMode === "register"
                ? "registerAccount"
                : "loginAccount",
            {
                username,
                password
            }
        );
    }
);

// ---------------------------------------------------------
// AUTOMATIC TOKEN LOGIN
// ---------------------------------------------------------

socket.on("connect", () => {
    const token =
        getStoredAccountToken();

    if (!token) {
        accountAuthenticated = false;
        showLoggedOutScreen();
        return;
    }

    setAuthLoading(true);

    showAuthMessage(
        "Restoring your login…"
    );

    socket.emit(
        "authenticateToken",
        { token }
    );
});

// ---------------------------------------------------------
// AUTHENTICATION SUCCESS
// ---------------------------------------------------------

socket.on(
    "accountAuthenticated",
    ({ username, token } = {}) => {
        accountAuthenticated = true;

        storeAccountToken(token);

        setAuthLoading(false);

        showAuthMessage(
            `Welcome, ${username || "player"}!`,
            "success"
        );

        if (accountBarUsername) {
            accountBarUsername.textContent =
                username || "Player";
        }

        if (accountBar) {
            accountBar.style.display =
                "flex";
        }

        clearPasswordFields();

        /*
            A very short delay lets the success
            message appear before changing screens.
        */
        window.setTimeout(() => {
            /*
                The server may send reconnectedToRoom
                immediately after authentication.

                Do not force the directory open if the
                player has already been restored to a room.
            */
            const alreadyInRoom =
                (
                    lobbyPanel &&
                    lobbyPanel.classList.contains(
                        "show"
                    )
                ) ||
                (
                    gamePanel &&
                    gamePanel.classList.contains(
                        "show"
                    )
                );

            authScreen.style.display = "none";

            if (!alreadyInRoom) {
                showAuthPanel(authPanel);
                showAuthPanel(directoryPanel);
            }

            socket.emit("listRooms");
        }, 250);
    }
);

// ---------------------------------------------------------
// AUTHENTICATION ERROR
// ---------------------------------------------------------

socket.on(
    "accountError",
    (message) => {
        accountAuthenticated = false;

        setAuthLoading(false);

        showAuthMessage(
            message ||
            "Authentication failed.",
            "error"
        );
    }
);

// ---------------------------------------------------------
// INVALID / EXPIRED TOKEN
// ---------------------------------------------------------

socket.on(
    "accountTokenInvalid",
    () => {
        removeStoredAccountToken();

        accountAuthenticated = false;

        setAuthLoading(false);

        clearPasswordFields();

        setAuthMode("login");

        showLoggedOutScreen();

        showAuthMessage(
            "Your login expired. Please log in again.",
            "error"
        );
    }
);

// ---------------------------------------------------------
// LOGOUT
// ---------------------------------------------------------



socket.on(
    "accountLoggedOut",
    () => {
        removeStoredAccountToken();

        accountAuthenticated = false;

        clearPasswordFields();

        setAuthLoading(false);
        setAuthMode("login");

        if (logoutAccountButton) {
            logoutAccountButton.disabled =
                false;
        }

        showLoggedOutScreen();

        showAuthMessage(
            "You have been logged out."
        );
    }
);

// ---------------------------------------------------------
// INITIAL STATE
// ---------------------------------------------------------

setAuthMode("login");

if (!getStoredAccountToken()) {
    showLoggedOutScreen();
}