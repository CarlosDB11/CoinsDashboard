const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');
const TelegramBot = require('node-telegram-bot-api');
const input = require('input');
const axios = require('axios');
const http = require('http');
const fs = require('fs');

// Add TLS configuration for better connection handling
const tls = require('tls');
tls.DEFAULT_MIN_VERSION = 'TLSv1.2';

// --- CONFIGURACIÓN Y SECRETOS ---
const API_ID = Number(process.env.API_ID);
const API_HASH = process.env.API_HASH;
const BOT_TOKEN = process.env.BOT_TOKEN; 
const DESTINATION_ID = Number(process.env.DESTINATION_ID); 


// --- CANALES A ESPIAR ---
const TARGET_CHANNELS = ["kolsignal", "degen_smartmoney", "bing_community_monitor", "solhousesignal", "nevadielegends", "PFsafeLaunch", "ReVoX_Academy", "dacostest", "pfultimate", "GemDynasty", "Bot_NovaX", "CCMFreeSignal", "KropClub", "ciphercallsfree", "solanagemsradar", "solana_whales_signal", "pingcalls", "gem_tools_calls", "SAVANNAHCALLS", "athenadefai", "Bigbabywhale", "SavannahSOL", "A3CallChan", "PEPE_Calls28", "gems_calls100x", "ai_dip_caller", "KingdomOfDegenCalls", "fttrenches_volsm", "loganpump", "bananaTrendingBot"];

// --- CONFIGURACIÓN DE TRACKING ---
const MIN_MC_ENTRY = 10000;     
const MIN_MC_KEEP = 10000;      
const BATCH_SIZE = 30;          
const UPDATE_INTERVAL = 15000;  
const MIN_GROWTH_SHOW = 1.00; // Mostrar todos para filtrar después en el TOP 10
const LIST_HOLD_TIME = 15 * 60 * 1000; 

// --- RATE LIMITING ---
let lastMessageUpdate = {
    top: 0 // Cambiado para solo usar 'top'
};
const MESSAGE_UPDATE_COOLDOWN = 15000; 
let telegramRateLimited = false;
let rateLimitEndTime = 0; 
let isTrackingUpdates = false; // <--- EL SEMÁFORO IMPRESCINDIBLE
let lastSentText = ""; // <--- Para evitar editar si el texto no cambió

// Rate limiting configuration
const RATE_LIMIT_DELAY = 1000; 
let lastApiCall = 0; 

// --- RUTA SEGURA PARA DATOS ---
const DATA_FOLDER = './data'; 

if (!fs.existsSync(DATA_FOLDER)){
    fs.mkdirSync(DATA_FOLDER);
}

const DB_FILE = `${DATA_FOLDER}/tokens_db.json`;
const SESSION_FILE = 'session.txt';
const SOLANA_ADDRESS_REGEX = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;

// --- ESTADO GLOBAL ---
let activeTokens = {}; 
let dashboardMsgId = null; // Mantenemos variable aunque ahora será el Top Performers
let simulationAmount = 7; 
let simulationTimeMinutes = 2; 
let liveListIds = {
    top: null // Solo usaremos este ID
};

// --- INICIALIZAR BOT ---
const railwayConfig = require('./railway.config.js');
const bot = new TelegramBot(BOT_TOKEN, { 
    polling: railwayConfig.bot.polling
});

// --- SERVIDOR WEB ---
http.createServer((req, res) => { res.writeHead(200); res.end('Tracker Bot OK'); }).listen(3000);

// ==========================================
// 0. SISTEMA DE LOGS DETALLADOS (COLOMBIA)
// ==========================================
function log(message, type = "INFO") {
    const now = new Date();
    const timestamp = now.toLocaleString('es-CO', { 
        timeZone: 'America/Bogota',
        day: '2-digit', month: '2-digit', year: 'numeric', 
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false 
    });

    const icons = {
        "INFO": "ℹ️", "CAPTURE": "🎯", "ALERT": "🚨", "LIVE": "📡",
        "IGNORE": "🚫", "ERROR": "❌", "DELETE": "🗑️", "CONFIG": "⚙️"
    };
    const icon = icons[type] || "";
    console.log(`[${timestamp}] ${icon} [${type}] ${message}`);
}

function formatCurrency(num) {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(num);
}

function getShortDate(timestamp) {
    if (!timestamp) return "-";
    const dateStr = new Date(timestamp).toLocaleString('es-CO', {
        timeZone: 'America/Bogota',
        month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
    });
    return dateStr.toUpperCase().replace('.', '');
}

function getTimeOnly(timestamp) {
    if (!timestamp) return "--:--";
    return new Date(timestamp).toLocaleTimeString('es-CO', { 
        timeZone: 'America/Bogota', 
        hour12: false 
    });
}

function escapeHtml(text) {
    if (!text) return text;
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

// ==========================================
// 1. GESTIÓN DE RATE LIMITING (Sin cambios mayores)
// ==========================================
function handleTelegramError(error, context = "") {
    if (error.message && error.message.includes('429')) {
        const retryAfterMatch = error.message.match(/retry after (\d+)/);
        if (retryAfterMatch) {
            const retryAfter = parseInt(retryAfterMatch[1]);
            telegramRateLimited = true;
            rateLimitEndTime = Date.now() + (retryAfter * 1000);
            log(`Rate Limited! Esperando ${retryAfter}s. Context: ${context}`, "ERROR");
            return true;
        }
    }
    return false;
}

function canSendMessage(type) {
    const now = Date.now();
    if (telegramRateLimited && now < rateLimitEndTime) return false;
    else if (telegramRateLimited && now >= rateLimitEndTime) telegramRateLimited = false;
    
    if (lastMessageUpdate[type] && now - lastMessageUpdate[type] < MESSAGE_UPDATE_COOLDOWN) return false;
    
    return true;
}

// ==========================================
// CORRECCIÓN 1: Manejo de errores mejorado
// ==========================================

async function safeTelegramCall(asyncFunction, context = "", type = "top", newText = null) {
    try {
        // 1. Si vamos a editar el TOP, revisamos si el texto es idéntico al anterior
        if (type === 'top' && newText && newText === lastSentText) {
            // Si el texto es igual, NO hacemos nada y ahorramos la petición
            return null; 
        }

        // 2. Rate Limiting temporal
        if (type !== 'urgent' && !canSendMessage(type)) return null;
        
        // 3. ACTUALIZAR RELOJ ANTES (Para evitar condiciones de carrera)
        if (type !== 'urgent') {
            lastMessageUpdate[type] = Date.now();
        }
        
        const result = await asyncFunction();
        
        // 4. Si se envió correctamente, guardamos el texto como "último enviado"
        if (type === 'top' && newText) {
            lastSentText = newText;
        }

        return result;
    } catch (error) {
        if (handleTelegramError(error, context)) return null;

        const errMsg = error.message || "";
        // Ignorar error si Telegram dice que el mensaje no ha cambiado
        if (errMsg.includes("message is not modified")) return null;

        if (errMsg.includes("message to edit not found") || 
            errMsg.includes("message_id_invalid") || 
            errMsg.includes("chat not found")) {
            throw error; 
        }

        log(`Error en ${context}: ${errMsg}`, "ERROR");
        return null;
    }
}
// ==========================================
// 2. GESTIÓN DE BASE DE DATOS
// ==========================================
function loadDB() {
    if (fs.existsSync(DB_FILE)) {
        try {
            const data = JSON.parse(fs.readFileSync(DB_FILE));
            activeTokens = data.tokens || {};
            // Adaptación para cargar solo el ID del Top Performers
            liveListIds = data.liveListIds || { top: null };
            simulationAmount = data.simulationAmount || 7;
            simulationTimeMinutes = data.simulationTimeMinutes || 2; 

            log(`DB Cargada: ${Object.keys(activeTokens).length} tokens.`, "INFO");
        } catch (e) {
            log("DB nueva o corrupta.", "ERROR");
            activeTokens = {};
        }
    }
}

function saveDB() {
    const data = { 
        tokens: activeTokens, 
        liveListIds: liveListIds,
        simulationAmount: simulationAmount,
        simulationTimeMinutes: simulationTimeMinutes 
    };
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// ==========================================
// 3. COMANDOS DEL BOT
// ==========================================

// COMANDO: AYUDA (Actualizado ligeramente)
bot.onText(/[\/\.]help/, async (msg) => {
    if (msg.chat.id !== DESTINATION_ID) return;

    const helpText = `📚 <b>PANEL DE COMANDOS</b> 📚\n\n` +
        `<b>⚙️ CONFIGURACIÓN</b>\n` +
        `• <code>/setinvest 10</code> ➔ Cambia inversión simulada.\n` +
        `• <code>/settime 5</code> ➔ Cambia tiempo simulación (min).\n\n` +
        `<b>🧹 LIMPIEZA</b>\n` +
        `• <code>/clean</code> ➔ Elimina el mensaje de Top Performers.\n` +
        `• <code>/nuke</code> ➔ ☢️ Borra TODA la DB.`;

    // AGREGADO: 'urgent' como tercer parámetro
    await safeTelegramCall(async () => {
        return await bot.sendMessage(DESTINATION_ID, helpText, { parse_mode: 'HTML' });
    }, 'help-command', 'urgent');
});

bot.onText(/[\/\.]settime (\d+)/, async (msg, match) => {
    if (msg.chat.id !== DESTINATION_ID) return;
    const minutes = parseInt(match[1]);
    if (isNaN(minutes) || minutes <= 0) return;
    simulationTimeMinutes = minutes;
    saveDB();
    await bot.sendMessage(DESTINATION_ID, `✅ Tiempo simulación: ${minutes} min`);
});

bot.onText(/[\/\.]setinvest (\d+)/, async (msg, match) => {
    if (msg.chat.id !== DESTINATION_ID) return;
    const amount = parseInt(match[1]);
    if (isNaN(amount) || amount <= 0) return;
    simulationAmount = amount;
    saveDB();
    await bot.sendMessage(DESTINATION_ID, `✅ Inversión simulada: $${amount}`);
});

// COMANDO: DASHBOARD (Invocar panel manualmente)
bot.onText(/[\/\.]dashboard/, async (msg) => {
    if (msg.chat.id !== DESTINATION_ID) return;

    // 1. Limpieza preventiva: Si el bot cree que hay un mensaje activo, bórralo de la memoria
    // para forzar que el próximo sea uno nuevo al final del chat.
    if (liveListIds.top) {
        try { 
            await bot.deleteMessage(DESTINATION_ID, liveListIds.top); 
        } catch (e) {
            // Si falla (ej. el mensaje ya no existía), no importa, seguimos.
        }
        liveListIds.top = null;
        saveDB();
    }

    const tokensList = Object.values(activeTokens);

    // 2. Escenario: NO hay tokens
    if (tokensList.length === 0) {
        await safeTelegramCall(async () => {
            return await bot.sendMessage(DESTINATION_ID, 
                `📡 <b>MONITOR ACTIVO</b>\n\n` +
                `Actualmente no hay tokens en seguimiento.\n` +
                `El panel <b>Top Performers</b> aparecerá automáticamente cuando llegue la primera señal válida.`, 
                { parse_mode: 'HTML' }
            );
        }, 'dashboard-empty', 'urgent'); // Usamos 'urgent' para que responda rápido
    } 
    // 3. Escenario: HAY tokens
    else {
        // Enviamos un mensaje temporal de "Cargando"
        const loadingMsg = await safeTelegramCall(async () => {
            return await bot.sendMessage(DESTINATION_ID, "🔄 <b>Actualizando precios y generando panel...</b>", { parse_mode: 'HTML' });
        }, 'dashboard-loading', 'urgent');

        // Ejecutamos la actualización completa (busca precios en API y genera el panel)
        // Esto creará el nuevo panel Top Performers automáticamente.
        await updateTracking();

        // Borramos el mensaje de "Cargando" para que quede limpio
        if (loadingMsg) {
            try { await bot.deleteMessage(DESTINATION_ID, loadingMsg.message_id); } catch(e){}
        }
    }
});

// COMANDO: ELIMINAR UN TOKEN ESPECÍFICO
bot.onText(/[\/\.](remove|del) (.+)/, async (msg, match) => {
    if (msg.chat.id !== DESTINATION_ID) return;
    const input = match[2].trim();
    let foundCa = null;

    // 1. Buscar por CA directa
    if (activeTokens[input]) {
        foundCa = input;
    } 
    // 2. Si no es CA, buscar por Símbolo
    else {
        foundCa = Object.keys(activeTokens).find(ca => 
            activeTokens[ca].symbol.toUpperCase() === input.toUpperCase()
        );
    }

    if (foundCa) {
        const symbol = activeTokens[foundCa].symbol;
        delete activeTokens[foundCa];
        saveDB();
        
        log(`Token eliminado manualmente: ${symbol} (${foundCa})`, "DELETE");
        await bot.sendMessage(DESTINATION_ID, `🗑️ <b>${symbol}</b> ha sido eliminado de la lista.`, { parse_mode: 'HTML' });
        
        // Actualizar el panel inmediatamente
        await updateTracking();
    } else {
        await bot.sendMessage(DESTINATION_ID, `❌ No se encontró el token: <b>${input}</b>`, { parse_mode: 'HTML' });
    }
});

// COMANDO: NUKE
bot.onText(/[\/\.]nuke/, async (msg) => {
    if (msg.chat.id !== DESTINATION_ID) return;
    if (liveListIds.top) try { await bot.deleteMessage(DESTINATION_ID, liveListIds.top); } catch(e) {}
    activeTokens = {};
    liveListIds = { top: null };
    saveDB();
    // AGREGADO: 'urgent'
    await safeTelegramCall(async () => {
        await bot.sendMessage(DESTINATION_ID, "☢️ **BASE DE DATOS ELIMINADA**", { parse_mode: 'Markdown' });
    }, 'nuke-command', 'urgent');
});

// COMANDO: CLEAN
bot.onText(/[\/\.]clean/, async (msg) => {
    if (msg.chat.id !== DESTINATION_ID) return;
    if (liveListIds.top) try { await bot.deleteMessage(DESTINATION_ID, liveListIds.top); } catch(e) {}
    liveListIds.top = null;
    saveDB();
    // AGREGADO: 'urgent'
    await safeTelegramCall(async () => {
        await bot.sendMessage(DESTINATION_ID, `🗑️ Lista visual eliminada.`);
    }, 'clean-command', 'urgent');
});

// ==========================================
// 3. API DEXSCREENER
// ==========================================
async function waitForRateLimit() {
    const now = Date.now();
    const timeSinceLastCall = now - lastApiCall;
    if (timeSinceLastCall < RATE_LIMIT_DELAY) {
        await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_DELAY - timeSinceLastCall));
    }
    lastApiCall = Date.now();
}

async function getBatchDexData(addressesArray) {
    try {
        await waitForRateLimit();
        const url = `https://api.dexscreener.com/latest/dex/tokens/${addressesArray.join(',')}`;
        const res = await axios.get(url);
        return (res.data && res.data.pairs) ? res.data.pairs.filter(p => p.chainId === 'solana') : [];
    } catch (e) { return []; }
}

async function getSingleDexData(address) {
    try {
        await waitForRateLimit();
        const res = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${address}`);
        if (!res.data?.pairs?.length) return null;
        const pair = res.data.pairs.find(p => p.chainId === 'solana');
        return pair ? { 
            name: pair.baseToken.name, symbol: pair.baseToken.symbol, price: parseFloat(pair.priceUsd), fdv: pair.fdv, url: pair.url 
        } : null;
    } catch (e) { return null; }
}

// ==========================================
// 4. LÓGICA CENTRAL DE TRACKING Y DISPLAY
// ==========================================

// Función para manejar la simulación en la lista única 'top'
function updateSimulationLogic(token, currentPrice, currentFdv) {
    // Usamos 'top' como clave estándar para todos
    if (!token.listStats) token.listStats = {};
    if (!token.listStats['top']) {
        token.listStats['top'] = {
            entryTime: Date.now(),       
            entryPrice: currentPrice,    
            entryFdv: currentFdv,
            price2Min: null,
            simEntryTime: null,
            simEntryFdv: null
        };
    }

    const stats = token.listStats['top'];
    const waitTimeMs = simulationTimeMinutes * 60 * 1000; 

    if (stats.price2Min === null) {
        if ((Date.now() - stats.entryTime) >= waitTimeMs) {
            stats.price2Min = currentPrice;
            stats.simEntryTime = Date.now();
            stats.simEntryFdv = currentFdv;
        }
    }
}

async function updateTopPerformersMessage(tokens) {
    const type = 'top';
    
    // Si no hay tokens, borrar mensaje y salir
    if (tokens.length === 0) {
        if (liveListIds.top) {
            try { await bot.deleteMessage(DESTINATION_ID, liveListIds.top); } catch (e) {}
            liveListIds.top = null;
            lastSentText = ""; // Resetear
            saveDB();
        }
        return;
    }

    // Ordenar tokens (Misma lógica tuya)
    tokens.sort((a, b) => (b.currentFdv / b.entryFdv) - (a.currentFdv / a.entryFdv));
    const displayTokens = tokens.slice(0, 20);

    // --- CONSTRUCCIÓN DEL TEXTO ---
    let text = `📊 <b>TOP PERFORMERS (TOP 20)</b>\n`;
    text += `<i>Inversión Simulada: $${simulationAmount} | Tiempo: ${simulationTimeMinutes}m</i>\n\n`;

    displayTokens.forEach((t, index) => {
        const growth = ((t.currentFdv / t.entryFdv - 1) * 100).toFixed(0);
        let statusIcons = "";
        if (t.mentions.length >= 3) statusIcons += "🔥";
        if (t.isRecoveringNow) statusIcons += " ♻️";
        if (t.isBreakingAth) statusIcons += " ⚡";

        // Simulacion text logic...
        const stats = t.listStats ? t.listStats['top'] : null;
        let simText = `⏳ <i>Simulando...</i>`;
        
        if (stats && stats.price2Min !== null) {
             const currentValue = (t.currentPrice / stats.price2Min) * simulationAmount;
             const profitPct = ((currentValue - simulationAmount) / simulationAmount) * 100;
             const iconSim = profitPct >= 0 ? '📈' : '📉';
             simText = `💵 <b>Sim ($${simulationAmount}):</b> ${iconSim} $${currentValue.toFixed(2)} (${profitPct.toFixed(1)}%)`; // Tu linea completa
        } else if (stats) {
             const waitTimeMs = simulationTimeMinutes * 60 * 1000; 
             const timeLeft = Math.ceil((waitTimeMs - (Date.now() - stats.entryTime)) / 1000);
             simText = `⏳ <b>Sim ($${simulationAmount}):</b> Esperando entrada (${timeLeft}s)`;
        }

        const mentionsList = t.mentions.map(m => `• ${getShortDate(m.time)} - ${escapeHtml(m.channel)}`).join('\n'); // Tu map completo

        text += `${index + 1}. ${statusIcons} <b>$${escapeHtml(t.symbol)}</b> (+${growth}%)\n   💰 Entry: ${formatCurrency(t.entryFdv)} ➔ <b>Now: ${formatCurrency(t.currentFdv)}</b>\n   ${simText}\n   🔗 <a href="https://gmgn.ai/sol/token/${t.ca}">GMGN</a>\n   <blockquote expandable>${mentionsList}</blockquote>\n\n`;
    });
    
    text += `⚡ <i>Actualizado: ${new Date().toLocaleTimeString('es-CO', { timeZone: 'America/Bogota', hour12: false })}</i>`;

    // --- AQUÍ ESTÁ EL CAMBIO IMPORTANTE: PASAR 'text' AL FINAL ---

    // 1. Intentar EDITAR
    if (liveListIds.top) {
        try {
            await safeTelegramCall(async () => {
                return await bot.editMessageText(text, {
                    chat_id: DESTINATION_ID,
                    message_id: liveListIds.top,
                    parse_mode: 'HTML',
                    disable_web_page_preview: true
                });
            }, `edit-${type}`, type, text); // <--- AÑADIR 'text' AQUÍ
        } catch (error) {
            // Manejo de error si se borró el mensaje manual
            liveListIds.top = null;
            lastSentText = "";
            saveDB();
        }
    }
    
    // 2. Si no hay ID, CREAR
    if (!liveListIds.top) {
        const sent = await safeTelegramCall(async () => {
            return await bot.sendMessage(DESTINATION_ID, text, { 
                parse_mode: 'HTML', 
                disable_web_page_preview: true 
            });
        }, `create-${type}`, type, text); // <--- AÑADIR 'text' AQUÍ
        if (sent) {
            liveListIds.top = sent.message_id;
            saveDB();
        }
    }
}

async function updateTracking() {
    // 1. SEMÁFORO: Si ya se está ejecutando, NO iniciar otra vez
    if (isTrackingUpdates) {
        return; 
    }
    isTrackingUpdates = true; // Bloqueamos la entrada

    try {
        const allAddresses = Object.keys(activeTokens);
        
        // Si no hay tokens, liberamos y salimos
        if (allAddresses.length === 0) {
            // Opcional: Si quieres borrar el mensaje cuando no hay tokens
            if (liveListIds.top) await updateTopPerformersMessage([]); 
            return;
        }

        const chunks = [];
        for (let i = 0; i < allAddresses.length; i += BATCH_SIZE) chunks.push(allAddresses.slice(i, i + BATCH_SIZE));

        let dbChanged = false;
        const now = Date.now();
        let displayList = [];

        for (const chunk of chunks) {
            const pairsData = await getBatchDexData(chunk);

            for (const ca of chunk) {
                const token = activeTokens[ca];
                const pairData = pairsData.find(p => p.baseToken.address === ca);

                if (!pairData) {
                    // Limpieza de tokens viejos sin datos
                    if (Date.now() - token.detectedAt > 24*60*60*1000) {
                        delete activeTokens[ca];
                        dbChanged = true;
                    }
                    continue; 
                }

                // Eliminar si cae por debajo del MC mínimo
                if (pairData.fdv < MIN_MC_KEEP) {
                    delete activeTokens[ca];
                    dbChanged = true;
                    continue;
                }

                const currentFdv = pairData.fdv;
                const currentPrice = parseFloat(pairData.priceUsd);

                // Inicialización de campos si faltan
                if (!token.maxFdv) token.maxFdv = token.entryFdv;
                if (token.isDipping === undefined) token.isDipping = false;
                
                // --- LÓGICA DE ESTADO ---

                // Breaking ATH
                token.isBreakingAth = currentFdv > token.maxFdv;
                
                if (currentFdv > token.maxFdv) {
                    token.maxFdv = currentFdv;
                    token.isDipping = false; 
                    dbChanged = true;
                }

                // Dips
                if (currentFdv < (token.maxFdv * 0.75)) {
                    if (!token.isDipping) { token.isDipping = true; dbChanged = true; }
                }
                
                // Recuperación
                token.isRecoveringNow = token.isDipping && currentFdv >= (token.maxFdv * 0.90) && currentFdv < token.maxFdv;

                // Actualizar valores
                token.currentFdv = currentFdv;
                token.currentPrice = currentPrice;
                token.lastUpdate = now;

                // Actualizar Simulador
                updateSimulationLogic(token, currentPrice, currentFdv);

                displayList.push(token);
            }
        }

        if (dbChanged) saveDB();

        // Llamar a la visualización
        // NOTA: Asegúrate de pasar 'displayList' a tu updateTopPerformersMessage
        await updateTopPerformersMessage(displayList);

    } catch (e) {
        log(`Error CRÍTICO en updateTracking: ${e.message}`, "ERROR");
    } finally {
        // IMPORTANTE: Liberar el semáforo pase lo que pase
        isTrackingUpdates = false; 
    }
}

// ==========================================
// 5. CLIENTE USERBOT
// ==========================================
(async () => {
    log("Iniciando Bot Híbrido...", "INFO");
    loadDB();
    let stringSession = new StringSession("");
    
    if (fs.existsSync(SESSION_FILE)) {
        try {
            const sessionData = fs.readFileSync(SESSION_FILE, 'utf8');
            stringSession = new StringSession(sessionData);
            log("Sesión cargada desde archivo", "INFO");
        } catch (error) {
            log(`Error leyendo sesión: ${error.message}`, "ERROR");
        }
    } 

    const client = new TelegramClient(stringSession, API_ID, API_HASH, { 
        connectionRetries: 5, retryDelay: 1000, timeout: 10000, useWSS: false
    });

    try {
        await client.start({
            phoneNumber: async () => await input.text("Número: "),
            password: async () => await input.text("2FA: "),
            phoneCode: async () => await input.text("Código: "),
            onError: (err) => log(`Auth Error: ${err.message}`, "ERROR"),
        });
    } catch (error) {
        log(`Client Start Error: ${error.message}`, "ERROR");
        setTimeout(() => process.exit(1), 5000);
        return;
    }

    if (!fs.existsSync(SESSION_FILE)) fs.writeFileSync(SESSION_FILE, client.session.save());
    log("Userbot Conectado. Escuchando canales...", "INFO");

    client.addEventHandler(async (event) => {
        const msg = event.message;
        if (msg.isReply) return;
        const content = msg.text || msg.message || "";
        if (!content) return;

        let channelName = "Desconocido";
        let messageLink = null;
        try { 
            const chat = await msg.getChat(); 
            if (chat.username) { 
                channelName = `@${chat.username}`; 
                messageLink = `https://t.me/${chat.username}/${msg.id}`; 
            } else { 
                channelName = chat.title || msg.chatId.toString(); 
            } 
        } catch (e) {}

        const matches = content.match(SOLANA_ADDRESS_REGEX);
        if (matches) {
            const uniqueAddresses = [...new Set(matches)];
            for (const ca of uniqueAddresses) {
                const mentionData = { channel: channelName, link: messageLink, time: Date.now() };

                // CASO A: Token ya existe
                if (activeTokens[ca]) {
                    if (!activeTokens[ca].mentions.some(m => m.channel === channelName)) {
                        activeTokens[ca].mentions.push(mentionData);
                        saveDB();
                        // ❌ AQUÍ QUITAMOS updateTracking()
                        // El setInterval lo recogerá en máximo 20 segundos
                        log(`Nueva mención para ${activeTokens[ca].symbol}`, "INFO");
                    }
                    continue; 
                }

                // CASO B: Token Nuevo
                // Verificamos DexScreener una sola vez
                const data = await getSingleDexData(ca);
                if (data && data.fdv >= MIN_MC_ENTRY) {
                    log(`NUEVO TOKEN DETECTADO: ${data.symbol}`, "CAPTURE");

                    activeTokens[ca] = {
                        name: data.name, symbol: data.symbol, ca: ca, url: data.url,
                        entryFdv: data.fdv, entryPrice: data.price, currentFdv: data.fdv,
                        maxFdv: data.fdv,
                        isDipping: false,
                        listStats: {}, 
                        mentions: [mentionData], detectedAt: Date.now()
                    };
                    
                    updateSimulationLogic(activeTokens[ca], data.price, data.fdv);
                    
                    saveDB();
                    // ❌ AQUÍ TAMBIÉN QUITAMOS updateTracking()
                    // Esto evita el "Flood" cuando llegan 5 señales seguidas.
                }
            }
        }
    }, new NewMessage({ chats: TARGET_CHANNELS, incoming: true }));

    setInterval(updateTracking, UPDATE_INTERVAL);
})();

process.on('uncaughtException', (error) => { log(`Uncaught Exception: ${error.message}`, "ERROR"); });
process.on('unhandledRejection', (reason, promise) => { log(`Unhandled Rejection`, "ERROR"); });
