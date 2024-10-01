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

async function connectToWhatsApp () {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys')
    const sock = makeWASocket({
        // can provide additional config here
        auth: state,
        printQRInTerminal: true
    })

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update
        if(connection === 'close') {
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut
            // console.log('connection closed due to ', lastDisconnect.error, ', reconnecting ', shouldReconnect)
            // reconnect if not logged out
            if(shouldReconnect) {
                connectToWhatsApp()
            }
        } else if(connection === 'open') {
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
                // This means a message was deleted
                const deletedMessageKey = message.message?.protocolMessage?.key;
            
                // Extracting information about the deleted message
                let deletedMessageDetails;
                if (isGroup) {
                    const chat = await sock.groupMetadata(message.key.remoteJid);
                    groupChatName = chat.subject;
                    deletedMessageDetails = `GC: ${groupChatName}\nPhone: ${deletedMessageKey.participant?.match(/\d+/g).join('')}`
                    + `\nMessage was deleted`;
                } else {
                    deletedMessageDetails = `Phone: ${deletedMessageKey.remoteJid?.match(/\d+/g).join('')}`
                    + `\nMessage was deleted`;
                }
            
                // Sending notification about the deleted message
                await sock.sendMessage(config.groupDumper, {
                    text: deletedMessageDetails,
                });
            
                console.log("Deleted message detected and notification sent.");
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
                            await sock.sendMessage(sender, { text: `I'm OK`});
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