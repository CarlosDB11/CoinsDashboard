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
async function safeTelegramCall(asyncFunction, context = "", type = "top") {
    try {
        // CAMBIO: Si el tipo es 'urgent' (comandos), ignoramos el cooldown de 20s
        if (type !== 'urgent' && !canSendMessage(type)) return null;
        
        const result = await asyncFunction();
        
        // Solo actualizamos el reloj si NO es un comando urgente
        if (type !== 'urgent') {
            lastMessageUpdate[type] = Date.now();
        }
        return result;
    } catch (error) {
        if (handleTelegramError(error, context)) return null;

        const errMsg = error.message || "";
        // Detectar si el mensaje ya no existe para avisar a la función principal
        if (errMsg.includes("message to edit not found") || 
            errMsg.includes("message_id_invalid") || 
            errMsg.includes("chat not found")) {
            throw error; // Lanzamos el error para que updateTopPerformersMessage lo capture
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
    // Aquí SI respetamos el rate limit (sin 'urgent')
    if (!canSendMessage(type)) return;

    if (tokens.length === 0) {
        if (liveListIds.top) {
            try {
                await bot.deleteMessage(DESTINATION_ID, liveListIds.top);
            } catch (e) {}
            liveListIds.top = null;
            saveDB();
        }
        return;
    }

    // --- (LÓGICA DE ORDENAMIENTO Y TEXTO IGUAL QUE ANTES) ---
    tokens.sort((a, b) => (b.currentFdv / b.entryFdv) - (a.currentFdv / a.entryFdv));
    const displayTokens = tokens.slice(0, 20);

    let text = `📊 <b>TOP PERFORMERS (TOP 20)</b>\n`;
    text += `<i>Inversión Simulada: $${simulationAmount} | Tiempo: ${simulationTimeMinutes}m</i>\n\n`;

    displayTokens.forEach((t, index) => {
        const growth = ((t.currentFdv / t.entryFdv - 1) * 100).toFixed(0);
        let statusIcons = "";
        if (t.mentions.length >= 3) statusIcons += "🔥";
        if (t.isRecoveringNow) statusIcons += " ♻️";
        if (t.isBreakingAth) statusIcons += " ⚡";

        const stats = t.listStats ? t.listStats['top'] : null;
        let simText = `⏳ <i>Simulando...</i>`;
        if (stats && stats.price2Min !== null) {
            const currentValue = (t.currentPrice / stats.price2Min) * simulationAmount;
            const profitPct = ((currentValue - simulationAmount) / simulationAmount) * 100;
            const iconSim = profitPct >= 0 ? '📈' : '📉';
            simText = `💵 <b>Sim ($${simulationAmount}):</b> ${iconSim} $${currentValue.toFixed(2)} (${profitPct.toFixed(1)}%)\n   🛒 <b>Compra:</b> ${getTimeOnly(stats.simEntryTime)} | MC: ${formatCurrency(stats.simEntryFdv)}`;
        } else if (stats) {
            const waitTimeMs = simulationTimeMinutes * 60 * 1000; 
            const timeLeft = Math.ceil((waitTimeMs - (Date.now() - stats.entryTime)) / 1000);
            simText = `⏳ <b>Sim ($${simulationAmount}):</b> Esperando entrada (${timeLeft}s)`;
        }

        const mentionsList = t.mentions.map(m => {
            const link = m.link ? `<a href="${m.link}">${escapeHtml(m.channel)}</a>` : `<b>${escapeHtml(m.channel)}</b>`;
            return `• ${getShortDate(m.time)} - ${link}`;
        }).join('\n');

        text += `${index + 1}. ${statusIcons} <b>$${escapeHtml(t.symbol)}</b> (+${growth}%)\n   💰 Entry: ${formatCurrency(t.entryFdv)} ➔ <b>Now: ${formatCurrency(t.currentFdv)}</b>\n   ${simText}\n   🔗 <a href="https://gmgn.ai/sol/token/${t.ca}">GMGN</a> | <a href="https://mevx.io/solana/${t.ca}">MEVX</a>\n   <blockquote expandable>${mentionsList}</blockquote>\n\n`;
    });
    text += `⚡ <i>Actualizado: ${new Date().toLocaleTimeString('es-CO', { timeZone: 'America/Bogota', hour12: false })}</i>`;

    // --- AQUÍ ESTÁ EL ARREGLO DEL "LOOP ZOMBIE" ---
    
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
            }, `edit-${type}`, type);
        } catch (error) {
            // Si safeTelegramCall lanza error es porque el mensaje no existe
            const errMsg = error.message || "";
            if (errMsg.includes("not found") || errMsg.includes("invalid") || errMsg.includes("chat")) {
                log(`Mensaje perdido. Reiniciando panel...`, "INFO");
                liveListIds.top = null; // Borramos ID inválido
                saveDB();
            }
        }
    }
    
    // 2. Si no hay ID (o se acaba de borrar arriba), CREAR NUEVO
    if (!liveListIds.top) {
        const sent = await safeTelegramCall(async () => {
            return await bot.sendMessage(DESTINATION_ID, text, { 
                parse_mode: 'HTML', 
                disable_web_page_preview: true 
            });
        }, `create-${type}`, type);
        if (sent) {
            liveListIds.top = sent.message_id;
            saveDB();
        }
    }
}

async function updateTracking() {
    const allAddresses = Object.keys(activeTokens);
    if (allAddresses.length === 0) return;

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
                // Si no hay datos pero es reciente, mantener. Si es muy viejo, borrar.
                if (Date.now() - token.detectedAt > 24*60*60*1000) delete activeTokens[ca];
                continue; 
            }

            // Eliminar si cae mucho
            if (pairData.fdv < MIN_MC_KEEP) {
                delete activeTokens[ca];
                dbChanged = true;
                continue;
            }

            const currentFdv = pairData.fdv;
            const currentPrice = parseFloat(pairData.priceUsd);

            // Inicialización de campos
            if (!token.maxFdv) token.maxFdv = token.entryFdv; // Inicializar maxFdv
            if (token.isDipping === undefined) token.isDipping = false;
            
            // --- DETECCIÓN DE CONDICIONES PARA ICONOS ---

            // 1. Rayos ⚡ (Breaking ATH)
            // Verificar si rompe el máximo anterior ANTES de actualizar el máximo
            token.isBreakingAth = currentFdv > token.maxFdv;
            
            // Actualizar Max FDV siempre
            if (currentFdv > token.maxFdv) {
                token.maxFdv = currentFdv;
                token.isDipping = false; // Si rompe máximos, ya no está en dip
                dbChanged = true;
            }

            // 2. Reciclaje ♻️ (Dip Eater)
            // Entrar en modo Dip si cae al 75% del ATH
            if (currentFdv < (token.maxFdv * 0.75)) {
                if (!token.isDipping) { token.isDipping = true; dbChanged = true; }
            }
            
            // Cumpliendo condición de reciclaje: estaba en dip y recuperó al 90%
            token.isRecoveringNow = token.isDipping && currentFdv >= (token.maxFdv * 0.90) && currentFdv < token.maxFdv;

            // --- ACTUALIZACIÓN DE ESTADO ---
            
            token.currentFdv = currentFdv;
            token.currentPrice = currentPrice;
            token.lastUpdate = now;

            // Actualizar Simulador (Para todos los tokens activos)
            updateSimulationLogic(token, currentPrice, currentFdv);

            // Agregar a la lista para mostrar
            displayList.push(token);
        }
    }

    if (dbChanged) saveDB();

    // Llamar a la función única de visualización
    await updateTopPerformersMessage(displayList);
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
        try { const chat = await msg.getChat(); if (chat.username) { channelName = `@${chat.username}`; messageLink = `https://t.me/${chat.username}/${msg.id}`; } else { channelName = chat.title || msg.chatId.toString(); } } catch (e) {}

        const matches = content.match(SOLANA_ADDRESS_REGEX);
        if (matches) {
            const uniqueAddresses = [...new Set(matches)];
            for (const ca of uniqueAddresses) {
                const mentionData = { channel: channelName, link: messageLink, time: Date.now() };

                if (activeTokens[ca]) {
                    if (!activeTokens[ca].mentions.some(m => m.channel === channelName)) {
                        activeTokens[ca].mentions.push(mentionData);
                        saveDB();
                        updateTracking(); 
                    }
                    continue; 
                }

                const data = await getSingleDexData(ca);
                if (data && data.fdv >= MIN_MC_ENTRY) {
                    log(`NUEVO TOKEN: ${data.symbol} | MC: ${formatCurrency(data.fdv)}`, "CAPTURE");

                    activeTokens[ca] = {
                        name: data.name, symbol: data.symbol, ca: ca, url: data.url,
                        entryFdv: data.fdv, entryPrice: data.price, currentFdv: data.fdv,
                        maxFdv: data.fdv, // Inicializamos Max FDV
                        isDipping: false,
                        listStats: {}, 
                        mentions: [mentionData], detectedAt: Date.now()
                    };
                    // Iniciamos lógica de simulación inmediatamente
                    updateSimulationLogic(activeTokens[ca], data.price, data.fdv);
                    
                    saveDB();
                }
            }
        }
    }, new NewMessage({ chats: TARGET_CHANNELS, incoming: true }));

    setInterval(updateTracking, UPDATE_INTERVAL);
})();

process.on('uncaughtException', (error) => { log(`Uncaught Exception: ${error.message}`, "ERROR"); });
process.on('unhandledRejection', (reason, promise) => { log(`Unhandled Rejection`, "ERROR"); });
