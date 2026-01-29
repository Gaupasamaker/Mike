const { makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const qrcodeTerminal = require('qrcode-terminal');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');
const pino = require('pino');
require('dotenv').config();
const { GoogleGenerativeAI } = require("@google/generative-ai");

// Artifacts directory for saving the QR image and sessions
const artifactsDir = path.join(__dirname, 'artifacts');

// --- Tool Definitions ---

const tools = [
    {
        functionDeclarations: [
            {
                name: "list_files",
                description: "List files and directories in the current project. Use this to see the project structure.",
                parameters: {
                    type: "OBJECT",
                    properties: {
                        path: {
                            type: "STRING",
                            description: "The directory path to list. Defaults to current directory if not specified.",
                        },
                    },
                },
            },
            {
                name: "read_file",
                description: "Read the content of a file.",
                parameters: {
                    type: "OBJECT",
                    properties: {
                        path: {
                            type: "STRING",
                            description: "The path of the file to read.",
                        },
                    },
                    required: ["path"],
                },
            },
            {
                name: "write_file",
                description: "Write content to a file. CAUTION: This will overwrite existing files.",
                parameters: {
                    type: "OBJECT",
                    properties: {
                        path: {
                            type: "STRING",
                            description: "The path of the file to write to.",
                        },
                        content: {
                            type: "STRING",
                            description: "The text content to write.",
                        },
                    },
                    required: ["path", "content"],
                },
            },
            {
                name: "run_terminal_command",
                description: "Run a terminal command. Use meant only for non-interactive commands. The output will be returned. Dangerous! Use with caution.",
                parameters: {
                    type: "OBJECT",
                    properties: {
                        command: {
                            type: "STRING",
                            description: "The shell command to execute.",
                        },
                        override_safety: {
                            type: "BOOLEAN",
                            description: "Set to TRUE only if the user has explicitly confirmed a destructive action.",
                        },
                    },
                    required: ["command"],
                },
            },
            {
                name: "search_files",
                description: "Search for a text pattern in files (Grep). Use to find code definitions.",
                parameters: {
                    type: "OBJECT",
                    properties: {
                        pattern: { type: "STRING", description: "The regex or text to search for." },
                        path: { type: "STRING", description: "Directory to search. Defaults to root." },
                    },
                    required: ["pattern"]
                }
            },
            {
                name: "generate_image",
                description: "Generate an image using AI (Imagen 3). Call this when user asks to draw or visualize something.",
                parameters: {
                    type: "OBJECT",
                    properties: {
                        prompt: {
                            type: "STRING",
                            description: "The detailed visual description for the image.",
                        },
                    },
                    required: ["prompt"],
                },
            }
        ],
    },
];

// --- Local Tool Implementations ---

// Define the Global Root (Scope of access)
// Defaults to the parent directory of this project, can be overridden by .env
const PROJECT_ROOT = process.env.PROJECT_ROOT || path.resolve(__dirname, '..');
console.log(`🔒 Security Root set to: ${PROJECT_ROOT}`);

const functions = {
    list_files: async ({ path: dirPath = '.' }) => {
        try {
            // Resolve path relative to CWD if relative, but check against PROJECT_ROOT
            // Actually, user might want to access other projects like '../East High Stories'.
            // So we should resolve relative to CWD, but allow it if it's inside PROJECT_ROOT.
            const resolvedPath = path.resolve(process.cwd(), dirPath);

            // Security check: Must be within PROJECT_ROOT
            if (!resolvedPath.startsWith(PROJECT_ROOT)) {
                return `Error: Access denied. You can only access files within ${PROJECT_ROOT}`;
            }
            const files = fs.readdirSync(resolvedPath);
            return JSON.stringify(files);
        } catch (error) {
            return `Error listing files: ${error.message}`;
        }
    },
    read_file: async ({ path: filePath }) => {
        try {
            const resolvedPath = path.resolve(process.cwd(), filePath);
            // Security check
            if (!resolvedPath.startsWith(PROJECT_ROOT)) {
                return `Error: Access denied. You can only access files within ${PROJECT_ROOT}`;
            }
            if (!fs.existsSync(resolvedPath)) {
                return "Error: File not found.";
            }
            const content = fs.readFileSync(resolvedPath, 'utf8');
            return content;
        } catch (error) {
            return `Error reading file: ${error.message}`;
        }
    },
    write_file: async ({ path: filePath, content }) => {
        try {
            const resolvedPath = path.resolve(process.cwd(), filePath);
            // Security check
            if (!resolvedPath.startsWith(PROJECT_ROOT)) {
                return `Error: Access denied. You can only write files within ${PROJECT_ROOT}`;
            }
            fs.writeFileSync(resolvedPath, content, 'utf8');
            return `Success: File written to ${filePath}`;
        } catch (error) {
            return `Error writing file: ${error.message}`;
        }
    },
    run_terminal_command: async ({ command, override_safety = false }) => {
        // HARD GUARDRAILS implemented in code
        const dangerousPatterns = [
            /\brm\b/i,       // remove
            /\brmdir\b/i,    // remove dir
            /\bmv\b/i,       // move/rename (can overwrite)
            />\s*[^\/]/,     // redirection overwrite (naive check)
            /\bsudo\b/i      // superuser
        ];

        const isDangerous = dangerousPatterns.some(pattern => pattern.test(command));

        if (isDangerous && !override_safety) {
            return "⚠️ SAFETY BLOCK: This command contains destructive keywords. Ask for confirmation.";
        }

        try {
            const { execSync } = require('child_process');
            // Basic timeout to prevent hangs
            const output = execSync(command, { encoding: 'utf8', timeout: 10000, cwd: process.cwd() });
            return output;
        } catch (error) {
            return `Error executing command: ${error.message}\nOutput: ${error.stdout ? error.stdout.toString() : ''}\nStdErr: ${error.stderr ? error.stderr.toString() : ''}`;
        }
    },
    search_files: async ({ pattern, path: searchPath = '.' }) => {
        try {
            const resolvedPath = path.resolve(process.cwd(), searchPath);
            // Note: PROJECT_ROOT is defined in outer scope
            if (!resolvedPath.startsWith(PROJECT_ROOT)) return `Error: Access denied.`;
            const { execSync } = require('child_process');
            const cmd = `grep -r -n -i "${pattern.replace(/"/g, '\\"')}" "${resolvedPath}" --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=.gemini`;
            try {
                const output = execSync(cmd, { encoding: 'utf8', timeout: 5000 });
                if (output.length > 5000) return output.substring(0, 5000) + "\n...[Truncated]";
                return output;
            } catch (e) { return "No matches found."; }
        } catch (error) { return `Error: ${error.message}`; }
    },
    generate_image: async ({ prompt }) => {
        try {
            console.log(`🎨 Generating image for: "${prompt}"...`);
            // Verified model: Nano Banana (Gemini 2.5 Flash Image)
            const imagenModel = genAI.getGenerativeModel({ model: "gemini-2.5-flash-image" });

            const result = await imagenModel.generateContent(prompt);
            const response = result.response;

            // Extract image data
            if (!response.candidates || !response.candidates[0].content.parts) {
                console.warn("Image generation response missing candidates or content parts. Falling back to error.");
                throw new Error("No image data in response");
            }

            // Find the part with inlineData (sometimes index 0 is text)
            const part = response.candidates[0].content.parts.find(p => p.inlineData);

            if (!part || !part.inlineData || !part.inlineData.data) {
                throw new Error("Invalid image format received (No inlineData found in parts)");
            }

            const base64Data = part.inlineData.data;
            const buffer = Buffer.from(base64Data, 'base64');

            // Save locally
            const timestamp = Date.now();
            const filename = `generated_${timestamp}.png`;
            const filepath = path.join(artifactsDir, filename);

            if (!fs.existsSync(artifactsDir)) fs.mkdirSync(artifactsDir, { recursive: true });
            fs.writeFileSync(filepath, buffer);
            console.log(`Image saved to ${filepath}`);

            // Return special string for handler
            return `IMAGE_GENERATED: ${filepath}`;
        } catch (error) {
            console.error("Image Gen Error:", error);
            return `Error generating image: ${error.message}`;
        }
    }
};

// Gemini Setup
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
    tools: tools
});

// Global Error Handlers to prevent crash
process.on('uncaughtException', (err) => {
    console.error('Caught exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Session Storage
const sessions = new Map();
// Cache for Bot's own message IDs to avoid loops
const botMessageIds = new Set();
// Cache for processed message IDs to avoid duplicate processing
const processedMessageIds = new Set();

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info');

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: true,
        logger: pino({ level: 'silent' }), // Hide internal logs for cleaner output
        browser: ["Antigravity", "Chrome", "1.0.0"] // Custom browser signature
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('QR RECEIVED (Scan with WhatsApp):');
            qrcodeTerminal.generate(qr, { small: true });

            // Save as image for the user UI
            try {
                // Ensure artifactsDir exists
                if (!fs.existsSync(artifactsDir)) {
                    fs.mkdirSync(artifactsDir, { recursive: true });
                }
                const qrPath = path.join(artifactsDir, 'whatsapp_qr.png');
                await qrcode.toFile(qrPath, qr);
                console.log(`QR Code saved to ${qrPath}`);
            } catch (err) {
                console.error('Failed to save QR image:', err);
            }
        }

        if (connection === 'close') {
            const statusCode = (lastDisconnect.error?.output?.statusCode);
            const shouldReconnect = (statusCode !== DisconnectReason.loggedOut);
            console.log('Connection closed. Reconnecting:', shouldReconnect, 'Status Code:', statusCode);

            if (shouldReconnect) {
                // Add a small delay to prevent rapid loops and allow network to stabilize
                setTimeout(() => connectToWhatsApp(), 5000);
            }
        } else if (connection === 'open') {
            console.log('CONNECTED TO WHATSAPP!');
        }
    });

    // Wrapper to send message and track ID
    const sendMessage = async (jid, content, options = {}) => {
        const sent = await sock.sendMessage(jid, content, options);
        if (sent && sent.key && sent.key.id) {
            botMessageIds.add(sent.key.id);
        }
        return sent;
    };

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        console.log(`Upsert received: ${type} count: ${messages.length}`);
        if (type !== 'notify') return;

        for (const msg of messages) {
            if (!msg.message) continue;

            const isFromMe = msg.key.fromMe;
            // ALLOW self-messages for testing
            const sender = msg.key.remoteJid;

            // Extract content types
            const imageMessage = msg.message.imageMessage;
            const audioMessage = msg.message.audioMessage || msg.message.voiceMessage;
            const textMessage = msg.message.conversation || msg.message.extendedTextMessage?.text || imageMessage?.caption || "";

            console.log(`Msg from ${sender} (Me: ${isFromMe}) ID: ${msg.key.id} Type: ${imageMessage ? 'IMAGE' : audioMessage ? 'AUDIO' : 'TEXT'}`);

            // Filter:
            // 1. MUST NOT be a status update (broadcast)
            if (sender === 'status@broadcast') continue;

            // 2. Logic:
            //    - If !ai detected -> Always process
            //    - If it's a DM (not group) -> Always process (Natural conversation)
            //    - If Group -> NOW ALWAYS PROCESS (User requested it for dedicated room)

            // OLD LOGIC: const isGroup = sender.endsWith('@g.us');
            // OLD LOGIC: const hasPrefix = textMessage.toLowerCase().startsWith('!ai');
            // OLD LOGIC: if (isGroup && !hasPrefix) continue;

            // Skip empty text messages if no media
            if (!textMessage && !imageMessage && !audioMessage) continue;

            // Prepare prompt (remove prefix if strictly used, optional now)
            const userPrompt = textMessage.replace(/^!ai/i, '').trim();

            try {
                // Indicate "typing" or "recording"
                await sock.sendPresenceUpdate(audioMessage ? 'recording' : 'composing', sender);

                // Prepare Multimodal Input
                const userParts = [];

                // 1. Add Text (if any)
                if (userPrompt) {
                    userParts.push({ text: userPrompt });
                } else if (audioMessage) {
                    // If audio only, give a hint to the model
                    userParts.push({ text: "Audio transcription/instruction:" });
                }

                // 2. Add Media (Image)
                if (imageMessage) {
                    console.log('Downloading image...');
                    const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }) });
                    userParts.push({
                        inlineData: {
                            mimeType: "image/jpeg",
                            data: buffer.toString('base64')
                        }
                    });
                }

                // 3. Add Media (Audio)
                if (audioMessage) {
                    console.log('Downloading audio...');
                    const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }) });
                    // WhatsApp usually uses audio/ogg; codecs=opus. Gemini supports this.
                    userParts.push({
                        inlineData: {
                            mimeType: audioMessage.mimetype || "audio/ogg",
                            data: buffer.toString('base64')
                        }
                    });
                }

                // --- SESSION MANAGEMENT ---

                // Load persisted sessions (naive implementation: read every time or cache?)
                // Let's cache in memory but init from file.
                // Note: We need to define SESSIONS_FILE and load it ONCE at startup to avoid race conditions?
                // Or just read/write. For simplicity: Read/Write on every turn (low traffic).

                const SESSIONS_FILE = path.join(artifactsDir, 'sessions.json');
                let storedHistory = [];

                if (fs.existsSync(SESSIONS_FILE)) {
                    try {
                        const allSessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
                        if (allSessions[sender]) {
                            storedHistory = allSessions[sender];
                            console.log(`Loaded ${storedHistory.length} messages from history for ${sender}`);
                        }
                    } catch (e) {
                        console.error("Error reading sessions file:", e);
                    }
                }

                let chat;
                if (!sessions.has(sender)) {
                    console.log(`Creating new session for ${sender}`);

                    // If we have stored history, use it. Otherwise, use System Prompt.
                    let initialHistory = storedHistory;

                    if (initialHistory.length === 0) {
                        initialHistory = [
                            {
                                role: "user",
                                parts: [{
                                    text: `
You are Mike (aka Antigravity), an Elite Senior Tech Lead & DevOps Engineer. 
You communicate via WhatsApp. 

**YOUR SCOPE:**
You have access to the entire user workspace: \`${PROJECT_ROOT}\`.
This contains multiple projects. Use \`search_files\` to find things efficiently.

**CAPABILITIES:**
1. **Coding**: Read/Write files across all projects.
2. **System Control**: Execute ANY terminal command.
3. **Vision**: Analyze screenshots.
4. **Listening**: Understand voice notes.
5. **Memory**: You remember past conversations (persisted).
6. **Painting**: You can GENERATE images using \`generate_image\`.

**🛡️ SAFETY PROTOCOL:**
- Ask for CONFIRMATION before DESTRUCTIVE actions (delete, overwrite).

**Guidelines:**
- **path 'Antigravity' or 'Root'** = \`../../\`.
- **ALWAYS** use \`list_files\` or \`search_files\` first.
- If asked to **draw**, **paint**, or **generate an image**, command the \`generate_image\` tool immediately. DO NOT REFUSE.
- **ALWAYS** reply in Spanish.
                                ` }],
                            },
                            {
                                role: "model",
                                parts: [{ text: "Entendido. Soy Mike, Tech Lead Global. Memoria y Búsqueda activas. ¿En qué trabajamos?" }],
                            }
                        ];
                    } else {
                        // INJECT UPDATE FOR EXISTING SESSIONS
                        // This ensures the model knows about the new tool even if the session is restored from disk.
                        initialHistory.push({
                            role: "user",
                            parts: [{ text: "[SYSTEM UPDATE]: Your capabilities have been upgraded by the Admin. You now have access to a 'generate_image' tool (Imagen 3). If the user asks you to draw, visualize, or create an image, you MUST use this tool. Do not refuse." }]
                        });
                        initialHistory.push({
                            role: "model",
                            parts: [{ text: "Understood. I received the upgrade. I am now capable of generating images and will use the tool when requested." }]
                        });
                    }

                    chat = model.startChat({
                        history: initialHistory,
                    });
                    sessions.set(sender, chat);
                } else {
                    console.log(`Resuming session for ${sender}`);
                    chat = sessions.get(sender);
                }

                // Send Message to Gemini
                let result = await chat.sendMessage(userParts);
                let response = result.response;

                // --- SAVE SESSION ---
                try {
                    const currentHistory = await chat.getHistory();
                    let allSessions = {};
                    if (fs.existsSync(SESSIONS_FILE)) {
                        allSessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
                    }
                    allSessions[sender] = currentHistory;
                    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(allSessions, null, 2));
                } catch (e) {
                    console.error("Error saving session:", e);
                }

                let functionCalls = response.functionCalls();

                // Multi-turn loop for function calls
                while (functionCalls && functionCalls.length > 0) {
                    const call = functionCalls[0];
                    const { name, args } = call;

                    console.log(`Executing tool: ${name} with args:`, args);
                    await sendMessage(sender, { text: `⚡ ${name}...` }, { quoted: msg }); // Shorter status

                    // Execute Local Function
                    let functionResponse = "Error: Function not found";
                    if (functions[name]) {
                        functionResponse = await functions[name](args);
                    }

                    console.log(`Tool Output (truncated):`, functionResponse.substring(0, 100));

                    // --- SPECIAL HANDLERS ---
                    // If image was generated, send it immediately
                    if (typeof functionResponse === 'string' && functionResponse.startsWith("IMAGE_GENERATED: ")) {
                        const imagePath = functionResponse.replace("IMAGE_GENERATED: ", "").trim();
                        try {
                            if (fs.existsSync(imagePath)) {
                                console.log(`Sending generated image: ${imagePath}`);
                                await sendMessage(sender, {
                                    image: { url: imagePath },
                                    caption: "🎨 Dibujado por Mike"
                                }, { quoted: msg });
                            }
                        } catch (err) {
                            console.error("Failed to send image:", err);
                            functionResponse += "\n(Note: Image generation successful but failed to upload to chat)";
                        }
                    }

                    // Send Tool Output back to Model
                    result = await chat.sendMessage([{
                        functionResponse: {
                            name: name,
                            response: {
                                name: name,
                                content: functionResponse
                            }
                        }
                    }]);

                    response = result.response;
                    functionCalls = response.functionCalls();
                }

                // Final Text Response
                const text = response.text();
                // Check if text is empty (sometimes happens with tool calls if prompt not clear)
                if (text) {
                    console.log('Gemini Final Response:', text);
                    await sendMessage(sender, { text: text }, { quoted: msg });
                }

            } catch (error) {
                console.error('AI Error Full Stack:', error);
                await sendMessage(sender, { text: '⚠️ Error: ' + error.message });
            }
        }
    });
}

connectToWhatsApp();
