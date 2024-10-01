const {
    makeWASocket,
    DisconnectReason,
    useMultiFileAuthState,
    downloadMediaMessage,
} = require('@whiskeysockets/baileys');
const fs = require("fs");
const config = require('./config.json');
const path = require('path');
const { format } = require('date-fns');
const { zonedTimeToUtc } = require('date-fns-tz');

function formatDateTimeNow(timeZoneConfig, dateTimeFormat) {
    return format(zonedTimeToUtc(new Date(), timeZoneConfig), dateTimeFormat, { timeZone: timeZoneConfig });
}

function logErrorToFile(errorMsg, config) {
    const logDirectory = 'errorlog';
    const timestamp = formatDateTimeNow(config.timezone, 'dd-MM-yyyy-HH-mm-ss');
    const logFilePath = path.join(logDirectory, `${timestamp}.log`);
    if (!fs.existsSync(logDirectory)) {
        fs.mkdirSync(logDirectory);
    }
    fs.appendFile(logFilePath, errorMsg + '\n', (err) => {
        if (err) {
            console.error('Error writing to log file:', err);
        }
    });
}

const fs = require('fs');
const path = require('path');

// Path to the message storage file
const messageFilePath = path.join(__dirname, 'messages.json');

// Function to store message in file
function storeMessage(messageKey, content) {
    const messageData = {
        key: messageKey,
        content: content,
        timestamp: Date.now() // Store the current timestamp
    };

    // Read the existing messages from the file
    let messages = [];
    if (fs.existsSync(messageFilePath)) {
        messages = JSON.parse(fs.readFileSync(messageFilePath, 'utf-8'));
    }

    // Add the new message to the list
    messages.push(messageData);

    // Save the updated message list to the file
    fs.writeFileSync(messageFilePath, JSON.stringify(messages, null, 2), 'utf-8');
}

// Function to remove messages older than 1 hour (3600000 ms)
function cleanUpOldMessages() {
    if (fs.existsSync(messageFilePath)) {
        let messages = JSON.parse(fs.readFileSync(messageFilePath, 'utf-8'));
        const oneHourAgo = Date.now() - 3600000;

        // Keep only messages that are newer than 1 hour
        messages = messages.filter(msg => msg.timestamp > oneHourAgo);

        // Write the cleaned message list back to the file
        fs.writeFileSync(messageFilePath, JSON.stringify(messages, null, 2), 'utf-8');
    }
}

// Periodically clean up old messages every 10 minutes
setInterval(cleanUpOldMessages, 600000); // 600000 ms = 10 minutes


async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys')
    const sock = makeWASocket({
        // can provide additional config here
        auth: state,
        printQRInTerminal: true
    })

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut
            // console.log('connection closed due to ', lastDisconnect.error, ', reconnecting ', shouldReconnect)
            // reconnect if not logged out
            if (shouldReconnect) {
                connectToWhatsApp()
            }
        } else if (connection === 'open') {
            console.log('opened connection')
        }
    });

    sock.ev.on('messages.upsert', async m => {
        const message = m.messages[0];

        try {
            let isGroup = message.key.remoteJid?.includes('@g.us')
                ? true
                : false;

            let groupChatName;
            let pushName;



            if (message.message?.viewOnceMessage || message.message?.viewOnceMessageV2 || message.message?.viewOnceMessageV2Extension) {
                // Checking different versions of ViewOnce messages
                const viewonce = message.message?.viewOnceMessage
                    || message.message?.viewOnceMessageV2
                    || message.message?.viewOnceMessageV2Extension;

                const mediaBuffer = await downloadMediaMessage(message, 'buffer');

                // Obtain media
                let mediaContent = viewonce.message?.imageMessage
                    ? { image: mediaBuffer }
                    : viewonce.message?.videoMessage
                        ? { video: mediaBuffer }
                        : viewonce.message?.audioMessage
                            ? { audio: mediaBuffer } // Added audio/voice message support
                            : null;

                let receivedCaptionDetails = viewonce.message?.imageMessage
                    ? viewonce.message?.imageMessage.caption
                    : viewonce.message?.videoMessage
                        ? viewonce.message?.videoMessage.caption
                        : viewonce.message?.audioMessage
                            ? viewonce.message?.audioMessage.caption // Get caption for audio if exists
                            : null;

                let sentCaptionDetails;

                pushName = message.pushName;
                if (isGroup) {
                    if (message.key.fromMe) {
                        return;
                    }
                    const chat = await sock.groupMetadata(message.key.remoteJid);
                    groupChatName = chat.subject;
                    sentCaptionDetails = `GC: ${groupChatName}\nPhone: ${message.key.participant?.match(/\d+/g).join('')}`
                        +
                        (receivedCaptionDetails == "" || receivedCaptionDetails == undefined
                            ? ""
                            : `\nCaption: ${receivedCaptionDetails}`);
                }
                else {
                    if (message.key.fromMe) {
                        return;
                    }
                    sentCaptionDetails = `Phone: ${message.key.remoteJid?.match(/\d+/g).join('')}`
                        +
                        (receivedCaptionDetails == "" || receivedCaptionDetails == undefined
                            ? ""
                            : `\nCaption: ${receivedCaptionDetails}`);
                }

                if (mediaContent) {
                    await sock.sendMessage(config.groupDumper, {
                        ...mediaContent, // image, video or audio
                        caption: sentCaptionDetails,
                    });
                    console.log("Viewonce is sent");
                }
                else {
                    console.log("Viewonce is not sent");
                    throw new Error("Media error or time out");
                }
            }
            // Detect deleted messages
            if (message.message?.protocolMessage?.type == 0) {
                const deletedMessageKey = message.message?.protocolMessage?.key;

                // Read the message store file
                if (fs.existsSync(messageFilePath)) {
                    const messages = JSON.parse(fs.readFileSync(messageFilePath, 'utf-8'));

                    // Find the deleted message by its key
                    const deletedMessage = messages.find(msg => msg.key.id === deletedMessageKey.id);

                    if (deletedMessage) {
                        let deletedMessageDetails;
                        if (isGroup) {
                            const chat = await sock.groupMetadata(message.key.remoteJid);
                            groupChatName = chat.subject;
                            deletedMessageDetails = `GC: ${groupChatName}\nPhone: ${deletedMessageKey.participant?.match(/\d+/g).join('')}`
                                + `\nDeleted Message Content: ${deletedMessage.content}`;
                        } else {
                            deletedMessageDetails = `Phone: ${deletedMessageKey.remoteJid?.match(/\d+/g).join('')}`
                                + `\nDeleted Message Content: ${deletedMessage.content}`;
                        }

                        // Send the deleted message content
                        await sock.sendMessage(config.groupDumper, {
                            text: deletedMessageDetails,
                        });

                        console.log("Deleted message content sent.");

                        // Optionally remove the message from the file after use
                        const updatedMessages = messages.filter(msg => msg.key.id !== deletedMessageKey.id);
                        fs.writeFileSync(messageFilePath, JSON.stringify(updatedMessages, null, 2), 'utf-8');
                    } else {
                        console.log("Deleted message content not found.");
                    }
                }
            }
            else {
                const repliedMessages = new Set();
                const messageId = message.key.id;
                const sender = message.key.remoteJid;
                const isMe = message.key.fromMe;  // Check if the message is from the bot itself
                console.log("TOUCHING HERE!");
                if (messageId && !repliedMessages.has(messageId)) {
                    const receivedMessage = message.message?.extendedTextMessage?.text || message.message?.conversation;

                    if (isMe || repliedMessages.has(messageId)) {
                        return;
                    }

                    repliedMessages.add(messageId);

                    if (receivedMessage.includes(".status")) {
                        if (isGroup) {
                            await sock.sendMessage(sender, { text: `I'm OK` }, {
                                quoted: {
                                    key: {
                                        remoteJid: sender,
                                        id: messageId,
                                        participant: message.key.participant
                                    },
                                    message: {
                                        conversation: ''
                                    }
                                }
                            }
                            );
                        }
                        else {
                            await sock.sendMessage(sender, { text: `I'm OK` });
                        }
                    }
                }
            }

        }
        catch (error) {
            console.error('Error', error);
            logErrorToFile(error, config);
        }
    })
}
// run in main file
connectToWhatsApp()