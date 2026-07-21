"use strict";

const accountHeader =
    document.getElementById("accountHeader");

const accountMenuButton =
    document.getElementById("accountMenuButton");

const accountDropdown =
    document.getElementById("accountDropdown");

const headerUsername =
    document.getElementById("headerUsername");

const dropdownUsername =
    document.getElementById("dropdownUsername");

const accountAvatar =
    document.getElementById("accountAvatar");

const dropdownAvatar =
    document.getElementById("dropdownAvatar");

const logoutButton =
    document.getElementById("logoutButton");

let accountTokenForHeader = null;

function showAccountHeader(username, token) {
    const cleanUsername =
        String(username || "Player").trim() || "Player";

    accountTokenForHeader = token || null;

    setAccountMenuOpen(false);

    if (token) {

        localStorage.setItem(
            "pitchPartyAccountToken",
            token
        );

    }

    headerUsername.textContent =
        cleanUsername;

    dropdownUsername.textContent =
        cleanUsername;

    const parts =
        cleanUsername
            .split(/\s+/)
            .filter(Boolean);

    let initials = "";

    if (parts.length >= 1) {
        initials += parts[0][0];
    }

    if (parts.length >= 2) {
        initials += parts[1][0];
    }

    if (!initials) {
        initials = "?";
    }


    initials =
        initials.toUpperCase();

    accountAvatar.textContent =
        initials;

    dropdownAvatar.textContent =
        initials;

    const headerWasHidden =
        accountHeader.hidden;

    accountHeader.hidden = false;

    if (headerWasHidden) {
        accountHeader.classList.add(
            "account-header-enter"
        );
    }
}

function hideAccountHeader() {
    accountHeader.hidden = true;
    accountDropdown.hidden = true;

    accountMenuButton.classList.remove("open");
    accountMenuButton.setAttribute(
        "aria-expanded",
        "false"
    );

    accountTokenForHeader = null;

    localStorage.removeItem(
        "pitchPartyAccountToken"
    );
}

function setAccountMenuOpen(open) {
    accountDropdown.hidden = !open;

    accountMenuButton.classList.toggle(
        "open",
        open
    );

    accountMenuButton.setAttribute(
        "aria-expanded",
        String(open)
    );
}

accountMenuButton.addEventListener(
    "click",
    (event) => {
        event.stopPropagation();

        setAccountMenuOpen(
            accountDropdown.hidden
        );
    }
);

accountDropdown.addEventListener(
    "click",
    (event) => {
        event.stopPropagation();
    }
);

document.addEventListener(
    "click",
    (event) => {

        if (
            accountHeader.hidden
        ) {
            return;
        }

        if (
            accountHeader.contains(event.target)
        ) {
            return;
        }

        setAccountMenuOpen(false);

    }
);

document.addEventListener(
    "keydown",
    (event) => {
        if (event.key === "Escape") {
            setAccountMenuOpen(false);
        }
    }
);

socket.on(
    "accountAuthenticated",
    ({ username, token } = {}) => {

        console.log(
            "Account authenticated:",
            username
        );

        showAccountHeader(
            username,
            token
        );

        logoutButton.disabled = false;

    }
);
logoutButton.addEventListener(
    "click",
    () => {

        if (logoutButton.disabled) {
            return;
        }

        logoutButton.disabled = true;

        setAccountMenuOpen(false);

        socket.emit(
            "logoutAccount",
            {
                token: accountTokenForHeader
            }
        );

    }
);

socket.on(
    "accountLoggedOut",
    () => {
        logoutButton.disabled = false;

        hideAccountHeader();

        const authScreen =
            document.getElementById("authScreen");

        if (authScreen) {
            authScreen.style.display = "grid";
        }

        accountTokenForHeader = null;


    }


);

socket.on(
    "disconnect",
    () => {

        setAccountMenuOpen(false);

    }
);


