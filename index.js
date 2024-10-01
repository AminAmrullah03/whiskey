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

// Path to the message storage file
const messageFilePath = path.join(__dirname, 'messages.json');

// Function to get formatted date time
function formatDateTimeNow(timeZoneConfig, dateTimeFormat) {
    return format(zonedTimeToUtc(new Date(), timeZoneConfig), dateTimeFormat, { timeZone: timeZoneConfig });
}

// Function to log error to a file
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

// Function to store message in a file
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

// Function to remove messages older than 1 hour
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

// Main function to connect to WhatsApp
async function connectToWhatsApp () {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: true
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if(connection === 'close') {
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            if(shouldReconnect) {
                connectToWhatsApp();
            }
        } else if(connection === 'open') {
            console.log('opened connection');
        }
    });

    sock.ev.on('messages.upsert', async m => {
        const message = m.messages[0];
        
        try {
            let isGroup = message.key.remoteJid?.includes('@g.us') ? true : false;
            let groupChatName;
            let pushName;

            // Handle ViewOnce messages
            if (message.message?.viewOnceMessage || message.message?.viewOnceMessageV2 || message.message?.viewOnceMessageV2Extension) {
                const viewonce = message.message?.viewOnceMessage || message.message?.viewOnceMessageV2 || message.message?.viewOnceMessageV2Extension;
                const mediaBuffer = await downloadMediaMessage(message, 'buffer');
                
                let mediaContent = viewonce.message?.imageMessage 
                                    ? { image: mediaBuffer } 
                                    : viewonce.message?.videoMessage 
                                    ? { video: mediaBuffer }
                                    : viewonce.message?.audioMessage
                                    ? { audio: mediaBuffer } 
                                    : null;

                let receivedCaptionDetails = viewonce.message?.imageMessage
                                            ? viewonce.message?.imageMessage.caption
                                            : viewonce.message?.videoMessage
                                            ? viewonce.message?.videoMessage.caption
                                            : viewonce.message?.audioMessage
                                            ? viewonce.message?.audioMessage.caption 
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
                    + (receivedCaptionDetails ? `\nCaption: ${receivedCaptionDetails}` : "");
                } else {
                    if (message.key.fromMe) {
                        return;
                    }
                    sentCaptionDetails = `Phone: ${message.key.remoteJid?.match(/\d+/g).join('')}`
                    + (receivedCaptionDetails ? `\nCaption: ${receivedCaptionDetails}` : "");
                }

                if (mediaContent) {
                    await sock.sendMessage(config.groupDumper, { ...mediaContent, caption: sentCaptionDetails });
                    console.log("Viewonce is sent");
                } else {
                    console.log("Viewonce is not sent");
                    throw new Error("Media error or time out");
                }
            }

            // Handle deleted messages
            if (message.message?.protocolMessage?.type == 0) {
                const deletedMessageKey = message.message?.protocolMessage?.key;
                const messages = fs.existsSync(messageFilePath) ? JSON.parse(fs.readFileSync(messageFilePath, 'utf-8')) : [];
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

                    await sock.sendMessage(config.groupDumper, { text: deletedMessageDetails });
                    console.log("Deleted message detected and content sent.");
                } else {
                    console.log("Deleted message content not found.");
                }
            }                        
            
            // Store all incoming messages
            const messageContent = message.message?.extendedTextMessage?.text || message.message?.conversation;
            if (messageContent) {
                storeMessage(message.key, messageContent);
            }

        } catch (error) {
            console.error('Error', error);
            logErrorToFile(error, config);
        }
    });
}

connectToWhatsApp();
