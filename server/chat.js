"use strict";

const crypto = require("crypto");

/*
    server/chat.js

    Server-side room chat system for Lumpia Fart.

    Features:
    - Room-only live messages
    - Names and avatars taken from the server room state
    - Message history
    - Typing indicators
    - Message validation
    - Spam and flood protection
    - Duplicate-message protection
    - System messages
    - Reconnection-friendly history requests
    - No trust in usernames/avatars sent by clients
*/

const DEFAULTS = Object.freeze({
    maxMessageLength: 180,
    maxHistoryLength: 100,

    messageCooldownMs: 700,
    duplicateWindowMs: 8_000,

    burstWindowMs: 10_000,
    burstMessageLimit: 8,

    typingCooldownMs: 350,
    typingExpiryMs: 4_000
});

const VALID_AVATARS = new Set([
    "bossbaby.png",
    "avatar1.png",
    "avatar2.png",
    "avatar3.png",
    "avatar4.png"
]);

function createChatSystem(options = {}) {
    const {
        io,
        rooms,
        touchRoom,
        config = {}
    } = options;

    if (!io) {
        throw new Error(
            "createChatSystem requires a Socket.IO server."
        );
    }

    if (!(rooms instanceof Map)) {
        throw new Error(
            "createChatSystem requires the rooms Map."
        );
    }

    const settings = {
        ...DEFAULTS,
        ...config
    };

    /*
        These maps only contain temporary rate-limit state.

        They are intentionally not stored in room objects because they
        are associated with the current socket connection.
    */
    const messageRateState = new Map();
    const typingRateState = new Map();
    const typingExpiryTimers = new Map();

    function now() {
        return Date.now();
    }

    function getRoomCodeForSocket(socket) {
        for (const roomCode of socket.rooms) {
            if (rooms.has(roomCode)) {
                return roomCode;
            }
        }

        return null;
    }

    function getRoomAndPlayer(socket) {
        const roomCode =
            getRoomCodeForSocket(socket);

        if (!roomCode) {
            return null;
        }

        const room =
            rooms.get(roomCode);

        if (!room) {
            return null;
        }

        /*
            Your existing room state is currently keyed by socket ID.

            The reconnect code migrates the old key to the new socket ID,
            so this remains compatible with your existing system.
        */
        const player =
            room.players?.[socket.id];

        if (!player) {
            return null;
        }

        return {
            roomCode,
            room,
            player
        };
    }

    function cleanAvatar(value) {
        const avatar =
            String(value || "").trim();

        return VALID_AVATARS.has(avatar)
            ? avatar
            : "bossbaby.png";
    }

    function cleanName(value) {
        const name =
            String(value || "Player")
                .replace(/[\u0000-\u001F\u007F]/g, "")
                .replace(/\s+/g, " ")
                .trim()
                .slice(0, 24);

        return name || "Player";
    }

    function cleanMessage(value) {
        if (typeof value !== "string") {
            return "";
        }

        /*
            Keep normal emoji and Unicode characters while removing
            control characters that can interfere with the interface.
        */
        let message =
            value
                .replace(/\r\n?/g, "\n")
                .replace(
                    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g,
                    ""
                )
                .replace(/[ \t]+\n/g, "\n")
                .replace(/\n[ \t]+/g, "\n")
                .replace(/[ \t]{3,}/g, "  ")
                .replace(/\n{4,}/g, "\n\n\n")
                .trim();

        /*
            Array.from counts Unicode code points more accurately than
            String.slice for many emoji characters.
        */
        message =
            Array.from(message)
                .slice(0, settings.maxMessageLength)
                .join("");

        return message.trim();
    }

    function ensureChatHistory(room) {
        if (!Array.isArray(room.chatMessages)) {
            room.chatMessages = [];
        }

        return room.chatMessages;
    }

    function saveMessage(room, message) {
        let history = ensureChatHistory(room);

        history.push(message);

        const cutoff =
            Date.now() - 24 * 60 * 60 * 1000;

        history = history.filter(
            m => m.timestamp >= cutoff
        );

        room.chatMessages = history;

        if (
            history.length >
            settings.maxHistoryLength
        ) {
            history.splice(
                0,
                history.length -
                settings.maxHistoryLength
            );
        }
    }

    function makeMessage({
        type = "player",
        playerId = null,
        socketId = null,
        name = "Player",
        avatar = "bossbaby.png",
        text = "",
        metadata = null
    }) {
        return {
            id: crypto.randomUUID(),
            type,
            playerId,
            socketId,
            name: cleanName(name),
            avatar: cleanAvatar(avatar),
            text,
            timestamp: now(),
            metadata:
                metadata &&
                    typeof metadata === "object"
                    ? metadata
                    : null
        };
    }

    function emitChatError(socket, message) {
        socket.emit("chat:error", {
            message: String(
                message ||
                "The chat message could not be sent."
            )
        });
    }

    function getMessageRateRecord(socketId) {
        let record =
            messageRateState.get(socketId);

        if (!record) {
            record = {
                lastMessageAt: 0,
                recentMessageTimes: [],
                lastNormalizedMessage: "",
                lastNormalizedMessageAt: 0
            };

            messageRateState.set(
                socketId,
                record
            );
        }

        return record;
    }

    function normalizeForDuplicateCheck(message) {

        return message
            .toLocaleLowerCase()
            .replace(/[^a-z0-9]/gi, "")
            .trim();

    }

    function checkMessageRateLimit(
        socket,
        message
    ) {
        const currentTime = now();

        const record =
            getMessageRateRecord(socket.id);

        if (
            currentTime -
            record.lastMessageAt <
            settings.messageCooldownMs
        ) {
            return {
                allowed: false,
                message:
                    "You're sending messages too quickly."
            };
        }

        record.recentMessageTimes =
            record.recentMessageTimes.filter(
                timestamp =>
                    currentTime - timestamp <
                    settings.burstWindowMs
            );

        if (
            record.recentMessageTimes.length >=
            settings.burstMessageLimit
        ) {
            return {
                allowed: false,
                message:
                    "Slow down for a few seconds."
            };
        }

        const normalized =
            normalizeForDuplicateCheck(message);

        if (
            normalized &&
            normalized ===
            record.lastNormalizedMessage &&
            currentTime -
            record.lastNormalizedMessageAt <
            settings.duplicateWindowMs
        ) {
            return {
                allowed: false,
                message:
                    "Please don't repeat the same message."
            };
        }

        record.lastMessageAt =
            currentTime;

        record.recentMessageTimes.push(
            currentTime
        );

        record.lastNormalizedMessage =
            normalized;

        record.lastNormalizedMessageAt =
            currentTime;

        return {
            allowed: true
        };
    }

    function emitHistory(socket) {
        const context =
            getRoomAndPlayer(socket);

        if (!context) {
            socket.emit("chat:history", {
                messages: []
            });

            return;
        }

        const history = [...ensureChatHistory(context.room)];

        socket.emit("chat:history", {
            roomCode: context.roomCode,
            messages: history
        });
    }

    function sendPlayerMessage(
        socket,
        rawMessage,
        acknowledgement
    ) {
        const context =
            getRoomAndPlayer(socket);

        if (!context) {
            const errorMessage =
                "You must be inside a party to chat.";

            emitChatError(
                socket,
                errorMessage
            );

            if (
                typeof acknowledgement ===
                "function"
            ) {
                acknowledgement({
                    ok: false,
                    error: errorMessage
                });
            }

            return;
        }

        const message =
            cleanMessage(rawMessage);

        if (!message) {
            const errorMessage =
                "Enter a message before sending.";

            emitChatError(
                socket,
                errorMessage
            );

            if (
                typeof acknowledgement ===
                "function"
            ) {
                acknowledgement({
                    ok: false,
                    error: errorMessage
                });
            }

            return;
        }

        const rateResult =
            checkMessageRateLimit(
                socket,
                message
            );

        if (!rateResult.allowed) {
            emitChatError(
                socket,
                rateResult.message
            );

            if (
                typeof acknowledgement ===
                "function"
            ) {
                acknowledgement({
                    ok: false,
                    error: rateResult.message
                });
            }

            return;
        }

        const {
            roomCode,
            room,
            player
        } = context;

        const chatMessage =
            makeMessage({
                type: "player",

                /*
                    account/player ID is stable across reconnects.
                    Fall back to socket ID only when needed.
                */
                playerId:
                    player.playerId ||
                    socket.data.playerId ||
                    socket.id,

                socketId: socket.id,

                name:
                    player.name ||
                    socket.data.gameName ||
                    "Player",

                avatar:
                    player.avatar ||
                    "bossbaby.png",

                text: message
            });

        saveMessage(
            room,
            chatMessage
        );

        if (
            typeof touchRoom === "function"
        ) {
            touchRoom(room);
        }

        /*
            Sending a message automatically clears this player's
            typing indicator.
        */
        stopTyping(socket, false);

        io.to(roomCode).emit(
            "chat:message",
            chatMessage
        );

        if (
            typeof acknowledgement ===
            "function"
        ) {
            acknowledgement({
                ok: true,
                messageId: chatMessage.id
            });
        }
    }

    function canSendTypingEvent(socketId) {
        const currentTime = now();

        const lastTypingAt =
            typingRateState.get(socketId) || 0;

        if (
            currentTime - lastTypingAt <
            settings.typingCooldownMs
        ) {
            return false;
        }

        typingRateState.set(
            socketId,
            currentTime
        );

        return true;
    }

    function clearTypingTimer(socketId) {
        const timer =
            typingExpiryTimers.get(socketId);

        if (timer) {
            clearTimeout(timer);
            typingExpiryTimers.delete(
                socketId
            );
        }
    }

    function startTyping(socket) {
        const context =
            getRoomAndPlayer(socket);

      

        if (!context) {
            return;
        }

        if (
            !canSendTypingEvent(socket.id)
        ) {
            return;
        }

        const {
            roomCode,
            player
        } = context;

        socket
            .to(roomCode)
            .emit("chat:typing", {
                playerId:
                    player.playerId ||
                    socket.data.playerId ||
                    socket.id,

                socketId: socket.id,

                name: cleanName(
                    player.name ||
                    socket.data.gameName ||
                    "Player"
                ),

                isTyping: true
            });

        clearTypingTimer(socket.id);

       

        const timer =
            setTimeout(() => {
                stopTyping(socket, true);
            }, settings.typingExpiryMs);

        typingExpiryTimers.set(
            socket.id,
            timer
        );
    }

    function stopTyping(
        socket,
        broadcast = true
    ) {
        clearTypingTimer(socket.id);

        typingRateState.delete(socket.id);

        const context =
            getRoomAndPlayer(socket);

        if (!context) {
            return;
        }

        if (!broadcast) {
            /*
                A sent chat message will reach everyone immediately,
                so a separate stop event is still useful for other
                clients but should not be rate limited.
            */
        }

        const {
            roomCode,
            player
        } = context;

        socket
            .to(roomCode)
            .emit("chat:typing", {
                playerId:
                    player.playerId ||
                    socket.data.playerId ||
                    socket.id,

                socketId: socket.id,

                name: cleanName(
                    player.name ||
                    socket.data.gameName ||
                    "Player"
                ),

                isTyping: false
            });
    }

    function registerSocket(socket) {
        if (!socket) {
            throw new Error(
                "registerSocket requires a Socket.IO socket."
            );
        }

        socket.on(
            "chat:send",
            (
                payload = {},
                acknowledgement
            ) => {
                const rawMessage =
                    typeof payload === "string"
                        ? payload
                        : payload.message;

                sendPlayerMessage(
                    socket,
                    rawMessage,
                    acknowledgement
                );
            }
        );

        socket.on(
            "chat:history:request",
            () => {
                emitHistory(socket);
            }
        );

        socket.on(
            "chat:typing:start",
            () => {
                startTyping(socket);
            }
        );

        socket.on(
            "chat:typing:stop",
            () => {
                stopTyping(socket);
            }
        );

        /*
            This listener only cleans chat-specific connection state.
            Your existing server.js disconnect listener can remain.
        */
        socket.on(
            "disconnect",
            () => {
                clearTypingTimer(socket.id);

                messageRateState.delete(
                    socket.id
                );

                typingRateState.delete(
                    socket.id
                );
            }
        );
    }

    function emitSystemMessage(
        roomCode,
        text,
        metadata = null
    ) {
        const room =
            rooms.get(roomCode);

        if (!room) {
            return null;
        }

        const cleanText =
            cleanMessage(text);

        if (!cleanText) {
            return null;
        }

        const message =
            makeMessage({
                type: "system",
                name: "System",
                avatar: "bossbaby.png",
                text: cleanText,
                metadata
            });

        saveMessage(
            room,
            message
        );

        if (
            typeof touchRoom === "function"
        ) {
            touchRoom(room);
        }

        io.to(roomCode).emit(
            "chat:message",
            message
        );

        return message;
    }

    function emitAnnouncement(
        roomCode,
        text,
        metadata = null
    ) {
        const room =
            rooms.get(roomCode);

        if (!room) {
            return null;
        }

        const cleanText =
            cleanMessage(text);

        if (!cleanText) {
            return null;
        }

        const message =
            makeMessage({
                type: "announcement",
                name: "Lumpia Fart",
                avatar: "bossbaby.png",
                text: cleanText,
                metadata
            });

        saveMessage(
            room,
            message
        );

        if (typeof touchRoom === "function") {
            touchRoom(room);
        }



        io.to(roomCode).emit(
            "chat:message",
            message
        );

        return message;
    }

    function clearRoomHistory(roomCode) {
        const room =
            rooms.get(roomCode); 
        if (!room) {
            return false;
        }

        room.chatMessages = [];

        io.to(roomCode).emit(
            "chat:cleared"
        );

        return true;
    }

    function deleteRoomChat(roomCode) {
        const room =
            rooms.get(roomCode);

        if (!room) {
            return;
        }

        delete room.chatMessages;
    }

    return {
        registerSocket,
        emitSystemMessage,
        emitAnnouncement,
        emitHistory,
        clearRoomHistory,
        deleteRoomChat
    };
}

module.exports = {
    createChatSystem
};