"use strict";

/*
    public/chat-ui.js
    PART 1 OF 2

    Client-side chat interface for Lumpia Fart.

    This first half contains:
    - Chat HTML creation
    - DOM references
    - Chat state
    - Safe message rendering
    - Player avatars and names
    - System and announcement messages
    - Timestamps
    - Auto-scroll behavior
    - Unread message counter
    - Open/close behavior
    - Typing-indicator rendering

    PART 2 will contain:
    - Socket.IO listeners
    - Sending messages
    - Enter and Shift+Enter handling
    - Typing events
    - History requests
    - Reconnect handling
    - Mobile behavior
    - Cleanup and initialization
*/

(() => {
    const CHAT_CONFIG = Object.freeze({
        maxMessageLength: 300,
        typingStopDelayMs: 1200,
        typingDisplayExpiryMs: 5000,
        mobileBreakpoint: 700,
        unreadLimit: 99
    });

    const VALID_AVATARS = new Set([
        "bossbaby.png",
        "avatar1.png",
        "avatar2.png",
        "avatar3.png",
        "avatar4.png"
    ]);

    const chatState = {
        initialized: false,
        open: false,
        joinedRoom: false,
        currentRoomCode: null,

        unreadCount: 0,
        historyLoaded: false,

        currentPlayerId: null,
        currentSocketId: null,

        typingPlayers: new Map(),
        typingCleanupTimer: null,
        localTypingTimer: null,
        localTypingActive: false,

        sending: false,
        pendingMessages: new Set(),

        lastRenderedMessageIds: new Set(),
        lastRenderedTimestamp: 0
    };

    /*
        The server creates `socket` in index.html before loading
        this file. Do not create a second Socket.IO connection here.
    */
    if (
        typeof socket === "undefined" ||
        !socket
    ) {
        console.error(
            "Chat UI could not start because the shared Socket.IO connection was not found."
        );

        return;
    }

    function createChatInterface() {

        const root =
            document.getElementById("partyChatRoot");

        if (!root) {
            console.error("partyChatRoot was not found.");
            return;
        }

        root.className = "party-chat-root";
        root.hidden = true;

        root.innerHTML = `
            <button
                id="partyChatToggle"
                class="party-chat-toggle"
                type="button"
                aria-label="Open party chat"
                aria-expanded="false">

                <span class="party-chat-toggle-icon">
                    💬
                </span>

                <span class="party-chat-toggle-text">
                    Party Chat
                </span>

                <span
                    id="partyChatUnread"
                    class="party-chat-unread"
                    hidden>
                    0
                </span>

            </button>

            <section
                id="partyChatPanel"
                class="party-chat-panel"
                aria-label="Party chat"
                hidden>

                <header class="party-chat-header">

                    <div class="party-chat-header-title">

                        <span class="party-chat-header-icon">
                            💬
                        </span>

                        <div>
                            <strong>
                                Party Chat
                            </strong>

                            <span id="partyChatRoomLabel">
                                Room chat
                            </span>
                        </div>

                    </div>

                    <button
                        id="partyChatClose"
                        class="party-chat-close"
                        type="button"
                        aria-label="Close party chat">
                        ×
                    </button>

                </header>

                <div
                    id="partyChatConnection"
                    class="party-chat-connection"
                    hidden>
                </div>

                <div
                    id="partyChatMessages"
                    class="party-chat-messages"
                    role="log"
                    aria-live="polite"
                    aria-relevant="additions">
                </div>

                <button
                    id="partyChatJump"
                    class="party-chat-jump"
                    type="button"
                    hidden>
                    ↓ New messages
                </button>

                <div
                    id="partyChatTyping"
                    class="party-chat-typing"
                    aria-live="polite">
                </div>

                <form
                    id="partyChatForm"
                    class="party-chat-form">

                    <label
                        for="partyChatInput"
                        class="party-chat-input-label">
                        Send a message
                    </label>

                    <div class="party-chat-compose">

                        <textarea
                            id="partyChatInput"
                            class="party-chat-input"
                            rows="1"
                            maxlength="${CHAT_CONFIG.maxMessageLength}"
                            placeholder="Say something..."
                            autocomplete="off"
                            enterkeyhint="send">
                        </textarea>

                        <button
                            id="partyChatSend"
                            class="party-chat-send"
                            type="submit"
                            disabled>
                            Send
                        </button>

                    </div>

                    <div class="party-chat-compose-footer">

                        <span id="partyChatError"
                              class="party-chat-error"
                              aria-live="assertive">
                        </span>

                        <span
                            id="partyChatCharacterCount"
                            class="party-chat-character-count">
                            0/${CHAT_CONFIG.maxMessageLength}
                        </span>

                    </div>

                </form>

            </section>
        `;

        
    }

    createChatInterface();

    const requiredElements = {
        chatRoot: document.getElementById("partyChatRoot"),
        chatToggle: document.getElementById("partyChatToggle"),
        chatUnread: document.getElementById("partyChatUnread"),
        chatPanel: document.getElementById("partyChatPanel"),
        chatClose: document.getElementById("partyChatClose"),
        chatRoomLabel: document.getElementById("partyChatRoomLabel"),
        chatConnection: document.getElementById("partyChatConnection"),
        chatMessages: document.getElementById("partyChatMessages"),
        chatJump: document.getElementById("partyChatJump"),
        chatTyping: document.getElementById("partyChatTyping"),
        chatForm: document.getElementById("partyChatForm"),
        chatInput: document.getElementById("partyChatInput"),
        chatSend: document.getElementById("partyChatSend"),
        chatError: document.getElementById("partyChatError"),
        chatCharacterCount: document.getElementById("partyChatCharacterCount")
    };

    for (const [name, element] of Object.entries(requiredElements)) {
        if (!element) {
            console.error("Missing chat element:", name);
            return;
        }
    }

    const {
        chatRoot,
        chatToggle,
        chatUnread,
        chatPanel,
        chatClose,
        chatRoomLabel,
        chatConnection,
        chatMessages,
        chatJump,
        chatTyping,
        chatForm,
        chatInput,
        chatSend,
        chatError,
        chatCharacterCount
    } = requiredElements;


    function cleanAvatar(value) {
        const avatar =
            String(value || "").trim();

        return VALID_AVATARS.has(avatar)
            ? avatar
            : "bossbaby.png";
    }

    function avatarPath(value) {
        return (
            "/images/avatars/" +
            cleanAvatar(value)
        );
    }

    function cleanText(value) {
        return String(value ?? "")
            .replace(
                /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g,
                ""
            )
            .trim();
    }

    function cleanName(value) {
        return (
            cleanText(value)
                .replace(/\s+/g, " ")
                .slice(0, 24) ||
            "Player"
        );
    }

    function formatMessageTime(timestamp) {
        const numericTimestamp =
            Number(timestamp);

        const date =
            Number.isFinite(numericTimestamp)
                ? new Date(numericTimestamp)
                : new Date();

        return date.toLocaleTimeString(
            [],
            {
                hour: "numeric",
                minute: "2-digit"
            }
        );
    }

    function isNearChatBottom(
        tolerance = 90
    ) {
        const distance =
            chatMessages.scrollHeight -
            chatMessages.scrollTop -
            chatMessages.clientHeight;

        return distance <= tolerance;
    }

    function scrollChatToBottom(
        behavior = "smooth"
    ) {
        chatMessages.scrollTo({
            top: chatMessages.scrollHeight,
            behavior
        });

        chatJump.hidden = true;
    }

    function updateUnreadDisplay() {
        if (chatState.unreadCount <= 0) {
            chatUnread.hidden = true;
            chatUnread.textContent = "0";
            return;
        }

        chatUnread.hidden = false;

        chatUnread.textContent =
            chatState.unreadCount >
                CHAT_CONFIG.unreadLimit
                ? `${CHAT_CONFIG.unreadLimit}+`
                : String(
                    chatState.unreadCount
                );
    }

    function clearUnreadMessages() {
        chatState.unreadCount = 0;
        updateUnreadDisplay();
    }

    function incrementUnreadMessages() {
        chatState.unreadCount += 1;
        updateUnreadDisplay();
    }

    function setChatConnectionMessage(
        message = "",
        type = "info"
    ) {
        const text =
            cleanText(message);

        if (!text) {
            chatConnection.hidden = true;
            chatConnection.textContent = "";
            chatConnection.className =
                "party-chat-connection";
            return;
        }

        chatConnection.hidden = false;
        chatConnection.textContent = text;
        chatConnection.className =
            `party-chat-connection party-chat-connection-${type}`;
    }

    function showChatError(
        message = ""
    ) {
        const text =
            cleanText(message);

        chatError.textContent = text;

        if (!text) {
            chatError.classList.remove(
                "party-chat-error-visible"
            );
            return;
        }

        chatError.classList.add(
            "party-chat-error-visible"
        );

        window.clearTimeout(
            showChatError.timeoutId
        );

        showChatError.timeoutId =
            window.setTimeout(() => {
                chatError.textContent = "";
                chatError.classList.remove(
                    "party-chat-error-visible"
                );
            }, 4500);
    }

    function updateCharacterCount() {
        const length =
            Array.from(chatInput.value)
                .length;

        chatCharacterCount.textContent =
            `${length}/${CHAT_CONFIG.maxMessageLength}`;

        chatCharacterCount.classList.toggle(
            "party-chat-character-count-warning",
            length >=
            CHAT_CONFIG.maxMessageLength *
            0.85
        );

        chatSend.disabled =
            chatState.sending ||
            !cleanText(chatInput.value) ||
            !chatState.joinedRoom;
    }

    function resizeChatInput() {
        chatInput.style.height = "auto";

        const maximumHeight = 120;

        chatInput.style.height =
            `${Math.min(
                chatInput.scrollHeight,
                maximumHeight
            )}px`;

        chatInput.style.overflowY =
            chatInput.scrollHeight >
                maximumHeight
                ? "auto"
                : "hidden";
    }

    function setChatOpen(open) {

        if (window.innerWidth > 700) {

            chatState.open = true;

            chatRoot.hidden = false;

            chatPanel.hidden = false;

            chatToggle.hidden = window.innerWidth > 700;

            return;

        }

        const shouldOpen = Boolean(open);

        chatState.open = shouldOpen;

        chatPanel.hidden =
            !shouldOpen;

        chatToggle.setAttribute(
            "aria-expanded",
            String(shouldOpen)
        );

        chatToggle.classList.toggle(

            "party-chat-toggle-active",

            shouldOpen

        );

        chatRoot.classList.toggle(
            "party-chat-open",
            shouldOpen
        );

        if (shouldOpen) {
            clearUnreadMessages();

            window.requestAnimationFrame(
                () => {
                    scrollChatToBottom(
                        "auto"
                    );

                    if (
                        chatState.joinedRoom
                    ) {
                        chatInput.focus({
                            preventScroll: true
                        });
                    }
                }
            );
        }
    }

    function showChatForRoom(
        roomCode = null
    ) {
        chatState.joinedRoom = true;
        chatState.currentRoomCode =
            roomCode ||
            chatState.currentRoomCode;

        chatRoot.hidden = false;

        chatRoomLabel.textContent =
            chatState.currentRoomCode
                ? `Room ${chatState.currentRoomCode}`
                : "Party room";

        chatInput.disabled = false;

        updateCharacterCount();
    }

    function hideChatForRoom({
        clearMessages = true
    } = {}) {
        chatState.joinedRoom = false;
        chatState.currentRoomCode = null;
        chatState.historyLoaded = false;
        chatState.currentPlayerId = null;

        setChatOpen(false);

        chatRoot.hidden = true;
        chatInput.disabled = true;
        chatInput.value = "";

        resizeChatInput();
        updateCharacterCount();
        clearUnreadMessages();
        clearTypingPlayers();

        if (clearMessages) {
            clearRenderedMessages();
        }
    }

    function clearRenderedMessages() {
        chatMessages.innerHTML = "";

        chatState.lastRenderedMessageIds.clear();
        chatState.lastRenderedTimestamp = 0;
        chatState.historyLoaded = false;

        chatJump.hidden = true;
    }

    function createMessageAvatar(
        avatar,
        name
    ) {
        const image =
            document.createElement("img");

        image.className =
            "party-chat-message-avatar";

        image.src =
            avatarPath(avatar);

        image.alt =
            `${cleanName(name)} avatar`;

        image.loading = "lazy";

        image.addEventListener(
            "error",
            () => {
                image.src =
                    avatarPath(
                        "bossbaby.png"
                    );
            },
            {
                once: true
            }
        );

        return image;
    }

    function isOwnMessage(message) {
        if (
            message.playerId &&
            chatState.currentPlayerId
        ) {
            return (
                String(message.playerId) ===
                String(
                    chatState.currentPlayerId
                )
            );
        }

        if (
            message.socketId &&
            chatState.currentSocketId
        ) {
            return (
                String(message.socketId) ===
                String(
                    chatState.currentSocketId
                )
            );
        }

        return false;
    }

    function createPlayerMessageElement(
        message
    ) {
        const ownMessage =
            isOwnMessage(message);

        const wrapper =
            document.createElement("article");

        wrapper.className =
            "party-chat-message party-chat-message-player";

        if (ownMessage) {
            wrapper.classList.add(
                "party-chat-message-own"
            );
        }

        wrapper.dataset.messageId =
            String(message.id || "");

        const avatar =
            createMessageAvatar(
                message.avatar,
                message.name
            );

        const content =
            document.createElement("div");

        content.className =
            "party-chat-message-content";

        const meta =
            document.createElement("div");

        meta.className =
            "party-chat-message-meta";

        const name =
            document.createElement("strong");

        name.className =
            "party-chat-message-name";

        name.textContent =
            ownMessage
                ? "You"
                : cleanName(
                    message.name
                );

        const time =
            document.createElement("time");

        time.className =
            "party-chat-message-time";

        time.dateTime =
            new Date(
                Number(
                    message.timestamp
                ) || Date.now()
            ).toISOString();

        time.textContent =
            formatMessageTime(
                message.timestamp
            );

        const bubble =
            document.createElement("div");

        bubble.className =
            "party-chat-message-bubble";

        /*
            textContent prevents HTML injection.
            New lines will be displayed through CSS white-space.
        */
        bubble.textContent =
            cleanText(message.text);

        meta.append(
            name,
            time
        );

        content.append(
            meta,
            bubble
        );

        wrapper.append(
            avatar,
            content
        );

        return wrapper;
    }

    function createSystemMessageElement(
        message
    ) {
        const wrapper =
            document.createElement("div");

        wrapper.className =
            "party-chat-message party-chat-message-system";

        wrapper.dataset.messageId =
            String(message.id || "");

        const icon =
            document.createElement("span");

        icon.className =
            "party-chat-system-icon";

        icon.textContent =
            message.type ===
                "announcement"
                ? "📣"
                : "⭐";

        const body =
            document.createElement("div");

        body.className =
            "party-chat-system-body";

        const text =
            document.createElement("span");

        text.className =
            "party-chat-system-text";

        text.textContent =
            cleanText(message.text);

        const time =
            document.createElement("time");

        time.className =
            "party-chat-message-time";

        time.textContent =
            formatMessageTime(
                message.timestamp
            );

        body.append(
            text,
            time
        );

        wrapper.append(
            icon,
            body
        );

        if (
            message.type ===
            "announcement"
        ) {
            wrapper.classList.add(
                "party-chat-message-announcement"
            );
        }

        return wrapper;
    }

    function renderChatMessage(
        message,
        {
            fromHistory = false
        } = {}
    ) {
        if (
            !message ||
            typeof message !== "object"
        ) {
            return;
        }

        const messageId =
            String(
                message.id || ""
            );

        if (
            messageId &&
            chatState
                .lastRenderedMessageIds
                .has(messageId)
        ) {
            return;
        }

        const text =
            cleanText(message.text);

        if (!text) {
            return;
        }

        const wasNearBottom =
            isNearChatBottom();

        const element =
            message.type === "system" ||
                message.type ===
                "announcement"
                ? createSystemMessageElement(
                    message
                )
                : createPlayerMessageElement(
                    message
                );

        chatMessages.appendChild(
            element
        );

        if (messageId) {
            chatState
                .lastRenderedMessageIds
                .add(messageId);
        }

        chatState.lastRenderedTimestamp =
            Math.max(
                chatState.lastRenderedTimestamp,
                Number(
                    message.timestamp
                ) || 0
            );

        if (fromHistory) {
            return;
        }

        if (
            chatState.open &&
            wasNearBottom
        ) {
            scrollChatToBottom();
            clearUnreadMessages();
            return;
        }

        if (!chatState.open) {
            incrementUnreadMessages();
        }

        chatJump.hidden = false;
    }

    function renderChatHistory(
        messages
    ) {
        clearRenderedMessages();

        const history =
            Array.isArray(messages)
                ? messages
                : [];

        history
            .slice()
            .sort(
                (first, second) =>
                    (
                        Number(
                            first.timestamp
                        ) || 0
                    ) -
                    (
                        Number(
                            second.timestamp
                        ) || 0
                    )
            )
            .forEach(message => {
                renderChatMessage(
                    message,
                    {
                        fromHistory: true
                    }
                );
            });

        chatState.historyLoaded = true;

        window.requestAnimationFrame(
            () => {
                scrollChatToBottom(
                    "auto"
                );
            }
        );
    }

    function clearTypingPlayers() {
        for (
            const record of
            chatState.typingPlayers.values()
        ) {
            if (record.timer) {
                window.clearTimeout(
                    record.timer
                );
            }
        }

        chatState.typingPlayers.clear();

        renderTypingIndicator();
    }

    function removeTypingPlayer(
        playerKey
    ) {
        const existing =
            chatState.typingPlayers.get(
                playerKey
            );

        if (existing?.timer) {
            window.clearTimeout(
                existing.timer
            );
        }

        chatState.typingPlayers.delete(
            playerKey
        );

        renderTypingIndicator();
    }

    function setTypingPlayer({
        playerId,
        socketId,
        name,
        isTyping
    } = {}) {
        const playerKey =
            String(
                playerId ||
                socketId ||
                ""
            );

        if (!playerKey) {
            return;
        }

        if (
            chatState.currentPlayerId &&
            playerId &&
            String(playerId) ===
            String(
                chatState.currentPlayerId
            )
        ) {
            return;
        }

        if (!isTyping) {
            removeTypingPlayer(
                playerKey
            );

            return;
        }

        const existing =
            chatState.typingPlayers.get(
                playerKey
            );

        if (existing?.timer) {
            window.clearTimeout(
                existing.timer
            );
        }

        const timer =
            window.setTimeout(
                () => {
                    removeTypingPlayer(
                        playerKey
                    );
                },
                CHAT_CONFIG
                    .typingDisplayExpiryMs
            );

        chatState.typingPlayers.set(
            playerKey,
            {
                name: cleanName(name),
                timer
            }
        );

        renderTypingIndicator();
    }

    function renderTypingIndicator() {
        const typingNames =
            [...chatState.typingPlayers.values()]
                .map(record => record.name)
                .filter(Boolean);

        if (
            typingNames.length === 0
        ) {
            chatTyping.textContent = "";
            chatTyping.hidden = true;
            return;
        }

        chatTyping.hidden = false;

        if (
            typingNames.length === 1
        ) {
            chatTyping.textContent =
                `${typingNames[0]} is typing…`;

            return;
        }

        if (
            typingNames.length === 2
        ) {
            chatTyping.textContent =
                `${typingNames[0]} and ${typingNames[1]} are typing…`;

            return;
        }

        chatTyping.textContent =
            `${typingNames.length} people are typing…`;
    }

    function beginLocalTyping() {
        if (
            !chatState.joinedRoom ||
            !socket.connected
        ) {
            return;
        }

        if (!chatState.localTypingActive) {
            chatState.localTypingActive = true;

            socket.emit(
                "chat:typing:start"
            );
        }

        window.clearTimeout(
            chatState.localTypingTimer
        );

        chatState.localTypingTimer =
            window.setTimeout(
                stopLocalTyping,
                CHAT_CONFIG
                    .typingStopDelayMs
            );
    }

    function stopLocalTyping() {
        window.clearTimeout(
            chatState.localTypingTimer
        );

        chatState.localTypingTimer =
            null;

        if (
            !chatState.localTypingActive
        ) {
            return;
        }

        chatState.localTypingActive =
            false;

        if (socket.connected) {
            socket.emit(
                "chat:typing:stop"
            );
        }
    }

    function requestChatHistory() {
        if (
            !chatState.joinedRoom ||
            !socket.connected
        ) {
            return;
        }

        socket.emit(
            "chat:history:request"
        );
    }

    function resetChatInput() {
        chatInput.value = "";

        resizeChatInput();
        updateCharacterCount();

        stopLocalTyping();
    }

    function sendChatMessage() {
        const message =
            cleanText(
                chatInput.value
            );

        if (!message) {
            updateCharacterCount();
            return;
        }

        if (!chatState.joinedRoom) {
            showChatError(
                "Join a party before sending messages."
            );

            return;
        }

        if (!socket.connected) {
            showChatError(
                "Chat is reconnecting. Try again in a moment."
            );

            return;
        }

        if (chatState.sending) {
            return;
        }

        chatState.sending = true;
        chatSend.disabled = true;

        showChatError("");

        socket.emit(
            "chat:send",
            {
                message
            },
            response => {
                chatState.sending = false;

                if (
                    !response ||
                    response.ok !== true
                ) {
                    showChatError(
                        response?.error ||
                        "The message could not be sent."
                    );

                    updateCharacterCount();
                    return;
                }

                resetChatInput();

                window.requestAnimationFrame(
                    () => {
                        if (window.innerWidth > 700) {

                            chatInput.focus({

                                preventScroll: true

                            });

                        }

                        chatInput.setSelectionRange(

                            chatInput.value.length,

                            chatInput.value.length

                        );
                    }
                );
            }
        );

        window.setTimeout(
            () => {
                if (!chatState.sending) {
                    return;
                }

                chatState.sending = false;

                showChatError(
                    "The message took too long to send."
                );

                updateCharacterCount();
            },
            8000
        );
    }

    function setCurrentPlayerFromState(
        state
    ) {
        if (
            !state ||
            typeof state !== "object"
        ) {
            return;
        }

        if (state.myId) {
            chatState.currentPlayerId =
                String(state.myId);
        }

        chatState.currentSocketId =
            socket.id || null;
    }

    function roomCodeFromPage() {
        const lobbyCode =
            document.getElementById(
                "lobbyRoomCode"
            )?.textContent?.trim();

        if (
            lobbyCode &&
            lobbyCode !== "—"
        ) {
            return lobbyCode;
        }

        const roomPillCode =
            document.getElementById(
                "roomPill"
            )?.textContent?.trim();

        if (
            roomPillCode &&
            roomPillCode !== "—"
        ) {
            return roomPillCode;
        }

        return null;
    }

    function enterChatRoom(
        roomCode = null
    ) {
        const resolvedRoomCode =
            cleanText(
                roomCode ||
                roomCodeFromPage()
            ).toUpperCase();

        const roomChanged =
            chatState.currentRoomCode &&
            resolvedRoomCode &&
            chatState.currentRoomCode !==
            resolvedRoomCode;

        if (roomChanged) {
            clearRenderedMessages();
            clearTypingPlayers();
            clearUnreadMessages();
        }

        showChatForRoom(
            resolvedRoomCode || null
        );

        if (window.innerWidth > 700) {

            setChatOpen(true);

        }
        else {

            setChatOpen(false);

        }

        setChatConnectionMessage("");

        requestChatHistory();
    }

    function leaveChatRoom() {

        stopLocalTyping();

        if (window.innerWidth <= 700) {

            setChatOpen(false);

        }

        hideChatForRoom({

            clearMessages: true

        });

    }

    function handleSocketConnected() {
        chatState.currentSocketId =
            socket.id || null;

        if (!chatState.joinedRoom) {
            return;
        }

        setChatConnectionMessage(
            "Connected",
            "success"
        );

        window.setTimeout(
            () => {
                if (socket.connected) {
                    setChatConnectionMessage("");
                }
            },
            1200
        );

        requestChatHistory();

        chatInput.disabled = false;

        updateCharacterCount();


    }

    function handleSocketDisconnected() {
        if (!chatState.joinedRoom) {
            return;
        }

        chatState.sending = false;
        chatSend.disabled = true;

        chatInput.disabled = true;



        stopLocalTyping();

        setChatConnectionMessage(
            "Reconnecting to party chat…",
            "warning"
        );
    }

    function handleChatHistory(
        payload = {}
    ) {
        if (
            payload.roomCode
        ) {
            chatState.currentRoomCode =
                String(
                    payload.roomCode
                );

            chatRoomLabel.textContent =
                `Room ${chatState.currentRoomCode}`;
        }

        renderChatHistory(
            payload.messages || []
        );
    }

    function handleChatMessage(
        message
    ) {
        const ownMessage =
            isOwnMessage(message);

        renderChatMessage(message);

        if (ownMessage) {
            clearUnreadMessages();

            if (chatState.open) {
                scrollChatToBottom();
            }
        }
    }

    function handleTypingEvent(
        payload
    ) {
        setTypingPlayer(
            payload || {}
        );
    }

    function handleChatError(
        payload = {}
    ) {
        chatState.sending = false;

        showChatError(
            payload.message ||
            "The chat action could not be completed."
        );

        updateCharacterCount();
    }

    function handleChatCleared() {
        clearRenderedMessages();

        const systemMessage = {
            id:
                "local-chat-cleared-" +
                Date.now(),

            type: "system",
            text:
                "Chat history was cleared.",

            timestamp:
                Date.now()
        };

        renderChatMessage(
            systemMessage
        );
    }

    chatToggle.addEventListener(
        "click",
        () => {
            setChatOpen(
                !chatState.open
            );
        }
    );

    chatClose.addEventListener(
        "click",
        () => {

            if (window.innerWidth > 700) {
                return;
            }

            setChatOpen(false);

        }
    );

    chatJump.addEventListener(
        "click",
        () => {
            scrollChatToBottom();
            clearUnreadMessages();
        }
    );

    chatMessages.addEventListener(
        "scroll",
        () => {
            if (
                isNearChatBottom()
            ) {
                chatJump.hidden = true;

                if (chatState.open) {
                    clearUnreadMessages();
                }
            }
        },
        {
            passive: true
        }
    );

    chatForm.addEventListener(
        "submit",
        event => {
            event.preventDefault();

            sendChatMessage();
        }
    );

    chatInput.addEventListener(
        "input",
        () => {
            resizeChatInput();
            updateCharacterCount();

            const hasText =
                Boolean(
                    cleanText(
                        chatInput.value
                    )
                );

            if (hasText) {
                beginLocalTyping();
            } else {
                stopLocalTyping();
            }
        }
    );

    chatInput.addEventListener(
        "keydown",
        event => {
            event.stopPropagation();





            if (
                event.key !== "Enter"
            ) {
                return;
            }

            if (
                event.isComposing
            ) {
                return;
            }

            if (event.shiftKey) {
                return;
            }

            /*
                Desktop:
                Enter sends and Shift+Enter makes a new line.

                Mobile keyboards may submit the form through
                enterkeyhint="send" as well.
            */
            event.preventDefault();

            sendChatMessage();
        }
    );

    chatInput.addEventListener(
        "blur",
        () => {
            stopLocalTyping();
        }
    );

    document.addEventListener(
        "keydown",
        event => {

            if (

                event.target === chatInput

            ) {

                return;

            }

            if (

                event.key === "Escape"

                &&

                chatState.open

            ) {

                setChatOpen(false);

            }

        }
    );
       

    document.addEventListener(
        "visibilitychange",
        () => {
            if (document.hidden) {
                stopLocalTyping();
                return;
            }

            if (
                chatState.open &&
                isNearChatBottom()
            ) {
                clearUnreadMessages();
            }
        }
    );

    window.addEventListener(
        "resize",
        () => {

            if (window.innerWidth > 700) {

                setChatOpen(true);

            }
            else {

                setChatOpen(false);

            }

            resizeChatInput();

            if (
                chatState.open &&
                isNearChatBottom()
            ) {
                window.requestAnimationFrame(
                    () => {
                        scrollChatToBottom(
                            "auto"
                        );
                    }
                );
            }
        }
    );

    socket.on(
        "connect",
        handleSocketConnected
    );

    socket.on(
        "disconnect",
        handleSocketDisconnected
    );

    socket.on(
        "chat:history",
        handleChatHistory
    );

    socket.on(
        "chat:message",
        handleChatMessage
    );

    socket.on(
        "chat:typing",
        handleTypingEvent
    );

    socket.on(
        "chat:error",
        handleChatError
    );

    socket.on(
        "chat:cleared",
        handleChatCleared
    );

    /*
        Existing room events from your current index.html.
        These tell the chat UI when it should become available.
    */

    socket.on(
        "roomCreated",
        ({ room } = {}) => {
            enterChatRoom(room);
        }
    );

    socket.on(
        "joined",
        ({ room } = {}) => {
            enterChatRoom(room);
        }
    );

    socket.on(
        "reconnectedToRoom",
        ({ room } = {}) => {
            enterChatRoom(room);
        }
    );

    socket.on(
        "leftRoom",
        () => {
            leaveChatRoom();
        }
    );

    /*
        gameState gives us the stable room player key used by
        the existing game server. This lets the client identify
        which chat messages belong to the current player.
    */
    socket.on(
        "gameState",
        state => {
            setCurrentPlayerFromState(
                state
            );

            if (
                !chatState.joinedRoom
            ) {
                const roomCode =
                    roomCodeFromPage();

                if (roomCode) {
                    enterChatRoom(
                        roomCode
                    );
                }
            }
        }
    );

    /*
        Lobby state can arrive before gameState. Use it as a fallback
        to reveal the chat once the user is already inside a room.
    */
    socket.on(
        "lobbyState",
        () => {
            if (
                chatState.joinedRoom
            ) {
                return;
            }

            const roomCode =
                roomCodeFromPage();

            if (roomCode) {
                enterChatRoom(
                    roomCode
                );
            }
        }
    );

    /*
        If the page loaded while the user was reconnecting, the
        room indicators may already contain the room code.
    */
    function initializeChatUI() {
        if (chatState.initialized) {
            return;
        }

        chatState.initialized = true;

        chatInput.disabled = true;

        resizeChatInput();
        updateCharacterCount();
        updateUnreadDisplay();
        renderTypingIndicator();

        const existingRoomCode =
            roomCodeFromPage();

        if (existingRoomCode) {
            enterChatRoom(
                existingRoomCode
            );


            setChatOpen(window.innerWidth > 700);


        } else {
            chatRoot.hidden = true;
        }
    }

    if (
        document.readyState ===
        "loading"
    ) {
        document.addEventListener(
            "DOMContentLoaded",
            initializeChatUI,
            {
                once: true
            }
        );
    } else {
        initializeChatUI();
    }

    /*
        Optional API for the rest of your interface.

        Example:
        window.partyChat.open();
        window.partyChat.close();
    */
    window.partyChat =
        Object.freeze({
            open() {
                if (
                    chatState.joinedRoom
                ) {
                    setChatOpen(true);
                }
            },

            close() {

                if (window.innerWidth <= 700) {

                    setChatOpen(false);

                }

            },

            toggle() {
                if (
                    chatState.joinedRoom
                ) {
                    setChatOpen(
                        !chatState.open
                    );
                }
            },

            enterRoom(roomCode) {
                enterChatRoom(
                    roomCode
                );
            },

            leaveRoom() {
                leaveChatRoom();
            },

            requestHistory() {
                requestChatHistory();
            },

            clearLocalMessages() {
                clearRenderedMessages();
            }
        });

})();