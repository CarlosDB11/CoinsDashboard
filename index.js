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

// --- TIEMPOS Y FILTROS ---
const NEW_TAG_MS = 15 * 60 * 1000;        // 15 Minutos (Etiqueta NUEVO)
const TIME_SPLIT_MS = 2 * 60 * 60 * 1000; // 2 Horas (División Fresh/Mature)
const MAX_AGE_MS = 7 * 60 * 60 * 1000;    // 7 Horas (Eliminar tracking)

// --- ESTADO GLOBAL (UNIFICADO) ---
let activeTokens = {}; 
let simulationAmount = 7; 
let simulationTimeMinutes = 2; 

// ID de mensajes: Paginación
let liveListIds = {
    top1: null, // Fresh Gems (< 2h)
    top2: null  // Mature Gems (> 2h y < 7h)
};

// Rate limiting: Control de texto para no editar si es igual
let lastSentText = {
    p1: "",
    p2: ""
};

// Rate limiting API & Telegram
const MESSAGE_UPDATE_COOLDOWN = 15000; 
let lastMessageUpdate = { top: 0 };
let telegramRateLimited = false;
let rateLimitEndTime = 0; 
let isTrackingUpdates = false; 

// Rate limiting DexScreener
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

// --- INICIALIZAR BOT ---
const railwayConfig = require('./railway.config.js');
const bot = new TelegramBot(BOT_TOKEN, { 
    polling: railwayConfig.bot.polling
});

// --- SERVIDOR WEB ---
http.createServer((req, res) => { res.writeHead(200); res.end('Tracker Bot OK'); }).listen(3000);

// ==========================================
// 0. SISTEMA DE LOGS Y FORMATOS
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

// Formato compacto (ej: $120K, $1.5M)
function formatCompactNumber(num) {
    return new Intl.NumberFormat('en-US', {
        notation: "compact",
        compactDisplay: "short",
        maximumFractionDigits: 1,
        style: 'currency',
        currency: 'USD'
    }).format(num);
}

// Formato fecha compacto (ej: ENE 8 - 14:30)
function getShortDate(timestamp) {
    if (!timestamp) return "-";
    const d = new Date(timestamp);
    const month = d.toLocaleString('es-CO', { timeZone: 'America/Bogota', month: 'short' }).toUpperCase().replace('.', '');
    const day = d.getDate();
    const time = d.toLocaleTimeString('es-CO', { timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit', hour12: false });
    return `${month} ${day} - ${time}`;
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
// 1. GESTIÓN DE RATE LIMITING
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

async function safeTelegramCall(asyncFunction, context = "", type = "top") {
    try {
        if (type !== 'urgent' && !canSendMessage(type)) return null;
        
        if (type !== 'urgent') {
            lastMessageUpdate[type] = Date.now();
        }
        
        return await asyncFunction();
    } catch (error) {
        if (handleTelegramError(error, context)) return null;

        const errMsg = error.message || "";
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
            liveListIds = data.liveListIds || { top1: null, top2: null };
            simulationAmount = data.simulationAmount || 7;
            simulationTimeMinutes = data.simulationTimeMinutes || 2; 

            // Limpieza inicial al cargar por si el bot estuvo apagado
            const now = Date.now();
            let cleaned = false;
            for (const ca in activeTokens) {
                if ((now - activeTokens[ca].detectedAt) > MAX_AGE_MS) {
                    delete activeTokens[ca];
                    cleaned = true;
                }
            }
            if(cleaned) saveDB();

            log(`DB Cargada: ${Object.keys(activeTokens).length} tokens activos.`, "INFO");
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
bot.onText(/[\/\.]help/, async (msg) => {
    if (msg.chat.id !== DESTINATION_ID) return;

    const helpText = `📚 <b>PANEL DE COMANDOS</b> 📚\n\n` +
        `<b>⚙️ CONFIGURACIÓN</b>\n` +
        `• <code>/setinvest 10</code> ➔ Cambia inversión simulada.\n` +
        `• <code>/settime 5</code> ➔ Cambia tiempo simulación (min).\n\n` +
        `<b>🧹 LIMPIEZA</b>\n` +
        `• <code>/clean</code> ➔ Elimina los mensajes del Top.\n` +
        `• <code>/nuke</code> ➔ ☢️ Borra TODA la DB.`;

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

bot.onText(/[\/\.]dashboard/, async (msg) => {
    if (msg.chat.id !== DESTINATION_ID) return;

    // 1. Borrar mensajes viejos visualmente para forzar refresco
    if (liveListIds.top1) try { await bot.deleteMessage(DESTINATION_ID, liveListIds.top1); } catch (e) {}
    if (liveListIds.top2) try { await bot.deleteMessage(DESTINATION_ID, liveListIds.top2); } catch (e) {}
    
    // Reseteamos IDs en memoria
    liveListIds.top1 = null;
    liveListIds.top2 = null;
    lastSentText = { p1: "", p2: "" };
    saveDB();

    // 2. Enviamos mensaje de carga
    const loadingMsg = await safeTelegramCall(async () => {
        return await bot.sendMessage(DESTINATION_ID, "🔄 <b>Analizando mercado y limpiando DB...</b>", { parse_mode: 'HTML' });
    }, 'dashboard-loading', 'urgent');

    // 3. Ejecutamos el tracking (esto limpia tokens > 7h y actualiza precios)
    await updateTracking();

    // 4. Borramos el mensaje de carga
    if (loadingMsg) {
        try { await bot.deleteMessage(DESTINATION_ID, loadingMsg.message_id); } catch(e){}
    }

    // 5. VERIFICACIÓN FINAL
    // Si después de actualizar NO se generó ni el panel 1 ni el 2, avisar al usuario.
    if (!liveListIds.top1 && !liveListIds.top2) {
        await safeTelegramCall(async () => {
            return await bot.sendMessage(DESTINATION_ID, 
                `📡 <b>MONITOR ACTIVO</b>\n\n` +
                `🧹 La base de datos se ha limpiado.\n` +
                `📉 No hay tokens activos (todos > 7h o < MC mínimo).`, 
                { parse_mode: 'HTML' }
            );
        }, 'dashboard-empty', 'urgent');
    }
});

bot.onText(/[\/\.](remove|del) (.+)/, async (msg, match) => {
    if (msg.chat.id !== DESTINATION_ID) return;
    const input = match[2].trim();
    let foundCa = null;

    if (activeTokens[input]) {
        foundCa = input;
    } else {
        foundCa = Object.keys(activeTokens).find(ca => 
            activeTokens[ca].symbol.toUpperCase() === input.toUpperCase()
        );
    }

    if (foundCa) {
        const symbol = activeTokens[foundCa].symbol;
        delete activeTokens[foundCa];
        saveDB();
        log(`Token eliminado manualmente: ${symbol} (${foundCa})`, "DELETE");
        await bot.sendMessage(DESTINATION_ID, `🗑️ <b>${symbol}</b> ha sido eliminado.`, { parse_mode: 'HTML' });
        await updateTracking();
    } else {
        await bot.sendMessage(DESTINATION_ID, `❌ No se encontró el token: <b>${input}</b>`, { parse_mode: 'HTML' });
    }
});

bot.onText(/[\/\.]nuke/, async (msg) => {
    if (msg.chat.id !== DESTINATION_ID) return;
    if (liveListIds.top1) try { await bot.deleteMessage(DESTINATION_ID, liveListIds.top1); } catch(e) {}
    if (liveListIds.top2) try { await bot.deleteMessage(DESTINATION_ID, liveListIds.top2); } catch(e) {}
    
    activeTokens = {};
    liveListIds = { top1: null, top2: null };
    saveDB();
    
    await safeTelegramCall(async () => {
        await bot.sendMessage(DESTINATION_ID, "☢️ **BASE DE DATOS ELIMINADA**", { parse_mode: 'Markdown' });
    }, 'nuke-command', 'urgent');
});

bot.onText(/[\/\.]clean/, async (msg) => {
    if (msg.chat.id !== DESTINATION_ID) return;
    if (liveListIds.top1) try { await bot.deleteMessage(DESTINATION_ID, liveListIds.top1); } catch(e) {}
    if (liveListIds.top2) try { await bot.deleteMessage(DESTINATION_ID, liveListIds.top2); } catch(e) {}
    
    liveListIds = { top1: null, top2: null };
    saveDB();

    await safeTelegramCall(async () => {
        await bot.sendMessage(DESTINATION_ID, `🗑️ Paneles visuales eliminados.`);
    }, 'clean-command', 'urgent');
});

// ==========================================
// 4. API DEXSCREENER
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
// 5. LÓGICA CENTRAL DE TRACKING Y DISPLAY
// ==========================================

function updateSimulationLogic(token, currentPrice, currentFdv) {
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

// Función auxiliar para generar el HTML de un solo token
function formatTokenBlock(t, index) {
    const now = Date.now();
    const growth = ((t.currentFdv / t.entryFdv - 1) * 100).toFixed(0);
    
    // --- LÓGICA ETIQUETAS ---
    let statusIcons = "";
    
    // Etiqueta de NUEVO (< 15 min)
    if ((now - t.detectedAt) < NEW_TAG_MS) {
        statusIcons += "🆕 <b>NUEVO</b> ";
    }

    if (t.mentions.length >= 3) statusIcons += "🔥";
    if (t.isRecoveringNow) statusIcons += " ♻️";
    if (t.isBreakingAth) statusIcons += " ⚡";

    const stats = t.listStats ? t.listStats['top'] : null;
    let simText = `⏳ <i>Simulando...</i>`;
    
    if (stats && stats.price2Min !== null) {
         const currentValue = (t.currentPrice / stats.price2Min) * simulationAmount;
         const profitPct = ((currentValue - simulationAmount) / simulationAmount) * 100;
         const iconSim = profitPct >= 0 ? '🟢' : '🔴';
         simText = `💵 <b>Sim ($${simulationAmount}):</b> ${iconSim} $${currentValue.toFixed(2)} (${profitPct.toFixed(1)}%)\n   🛒 <b>Compra:</b> ${getTimeOnly(stats.simEntryTime)} | MC: ${formatCompactNumber(stats.simEntryFdv)}`; 
    } else if (stats) {
         const waitTimeMs = simulationTimeMinutes * 60 * 1000; 
         const timeLeft = Math.ceil((waitTimeMs - (Date.now() - stats.entryTime)) / 1000);
         simText = `⏳ <b>Sim ($${simulationAmount}):</b> Esperando entrada (${timeLeft}s)`;
    }

    // 5 menciones máximo
    const recentMentions = t.mentions.slice(-5); 
    const mentionsList = recentMentions.map(m => `• ${getShortDate(m.time)} - ${escapeHtml(m.channel)}`).join('\n');
    
    const hiddenMentions = t.mentions.length - recentMentions.length;
    const moreText = hiddenMentions > 0 ? `\n<i>...y ${hiddenMentions} más.</i>` : "";

    return `${index}. ${statusIcons} <b>$${escapeHtml(t.symbol)}</b> (+${growth}%)\n` +
           `   💰 Entry: ${formatCompactNumber(t.entryFdv)} ➔ <b>Now: ${formatCompactNumber(t.currentFdv)}</b>\n` + 
           `   ${simText}\n` + 
           `   🔗 <a href="https://gmgn.ai/sol/token/${t.ca}">GMGN</a> | <a href="https://dexscreener.com/solana/${t.ca}">DEX</a>\n` + 
           `   <blockquote expandable>${mentionsList}${moreText}</blockquote>\n\n`;
}

// Función Principal Modificada (Doble Dashboard)
async function updateTopPerformersMessage(tokens) {
    const now = Date.now();

    if (tokens.length === 0) {
        if (liveListIds.top1) try { await bot.deleteMessage(DESTINATION_ID, liveListIds.top1); } catch (e) {}
        if (liveListIds.top2) try { await bot.deleteMessage(DESTINATION_ID, liveListIds.top2); } catch (e) {}
        liveListIds.top1 = null;
        liveListIds.top2 = null;
        lastSentText = { p1: "", p2: "" };
        saveDB();
        return;
    }

    // 1. Separar tokens en FRESH (< 2h) y MATURE (> 2h y < 7h)
    const freshTokens = tokens.filter(t => (now - t.detectedAt) < TIME_SPLIT_MS);
    const matureTokens = tokens.filter(t => (now - t.detectedAt) >= TIME_SPLIT_MS);

    // 2. Ordenar ambos por mejor rendimiento
    freshTokens.sort((a, b) => (b.currentFdv / b.entryFdv) - (a.currentFdv / a.entryFdv));
    matureTokens.sort((a, b) => (b.currentFdv / b.entryFdv) - (a.currentFdv / a.entryFdv));

    // 3. Tomar solo TOP 5 de cada grupo
    const topFresh = freshTokens.slice(0, 5);
    const topMature = matureTokens.slice(0, 5);

    // --- MENSAJE 1: FRESH GEMS (< 2 HORAS) ---
    if (topFresh.length > 0) {
    // CAMBIO: (< 2 Horas)  --->  (&lt; 2 Horas)
    let text1 = `🚀 <b>FRESH GEMS (&lt; 2 Horas)</b>\n`; 
    text1 += `<i>Inversión Simulada: $${simulationAmount} | Tiempo: ${simulationTimeMinutes}m</i>\n\n`;
    
    for (const [i, t] of topFresh.entries()) {
        text1 += formatTokenBlock(t, i + 1);
    }
    text1 += `⚡ <i>Updated: ${getTimeOnly(Date.now())}</i>`;
    await handleMessageSend(text1, 'top1', 'p1');
} else {
        if (liveListIds.top1) {
            try { await bot.deleteMessage(DESTINATION_ID, liveListIds.top1); } catch(e){}
            liveListIds.top1 = null;
            lastSentText.p1 = "";
            saveDB();
        }
    }

    // --- MENSAJE 2: HOLDING STRONG (> 2 HORAS) ---
    if (topMature.length > 0) {
    // CAMBIO: (> 2 Horas)  --->  (&gt; 2 Horas)
    let text2 = `🛡️ <b>HOLDING STRONG (&gt; 2 Horas)</b>\n`;
    text2 += `<i>Top performers estables</i>\n\n`;
    
    for (const [i, t] of topMature.entries()) {
        text2 += formatTokenBlock(t, i + 1);
    }
    text2 += `⚡ <i>Updated: ${getTimeOnly(Date.now())}</i>`;
    await handleMessageSend(text2, 'top2', 'p2');
} else {
        if (liveListIds.top2) {
            try { await bot.deleteMessage(DESTINATION_ID, liveListIds.top2); } catch(e){}
            liveListIds.top2 = null;
            lastSentText.p2 = "";
            saveDB();
        }
    }
}

async function handleMessageSend(text, idKey, textKey) {
    if (text === lastSentText[textKey]) return;

    if (liveListIds[idKey]) {
        try {
            await safeTelegramCall(async () => {
                return await bot.editMessageText(text, {
                    chat_id: DESTINATION_ID,
                    message_id: liveListIds[idKey],
                    parse_mode: 'HTML',
                    disable_web_page_preview: true
                });
            }, `edit-${idKey}`, 'top');
            lastSentText[textKey] = text;
        } catch (error) {
            liveListIds[idKey] = null;
        }
    }

    if (!liveListIds[idKey]) {
        const sent = await safeTelegramCall(async () => {
            return await bot.sendMessage(DESTINATION_ID, text, { 
                parse_mode: 'HTML', 
                disable_web_page_preview: true 
            });
        }, `create-${idKey}`, 'top');
        
        if (sent) {
            liveListIds[idKey] = sent.message_id;
            lastSentText[textKey] = text;
            saveDB();
        }
    }
}

async function updateTracking() {
    if (isTrackingUpdates) return; 
    isTrackingUpdates = true; 

    try {
        const allAddresses = Object.keys(activeTokens);
        const now = Date.now();
        let dbChanged = false;

        // Limpieza previa de tokens expirados (> 7 horas)
        const validAddresses = [];
        for (const ca of allAddresses) {
            if ((now - activeTokens[ca].detectedAt) > MAX_AGE_MS) {
                delete activeTokens[ca];
                dbChanged = true;
                log(`Token eliminado por antigüedad (>7h): ${ca}`, "DELETE");
            } else {
                validAddresses.push(ca);
            }
        }

        if (validAddresses.length === 0) {
            if (dbChanged) saveDB();
            if (liveListIds.top1 || liveListIds.top2) await updateTopPerformersMessage([]); 
            return;
        }

        const chunks = [];
        for (let i = 0; i < validAddresses.length; i += BATCH_SIZE) chunks.push(validAddresses.slice(i, i + BATCH_SIZE));

        let displayList = [];

        for (const chunk of chunks) {
            const pairsData = await getBatchDexData(chunk);

            for (const ca of chunk) {
                const token = activeTokens[ca];
                const pairData = pairsData.find(p => p.baseToken.address === ca);

                if (!pairData) {
                    if (Date.now() - token.detectedAt > 24*60*60*1000) {
                        delete activeTokens[ca];
                        dbChanged = true;
                    }
                    continue; 
                }

                if (pairData.fdv < MIN_MC_KEEP) {
                    delete activeTokens[ca];
                    dbChanged = true;
                    continue;
                }

                const currentFdv = pairData.fdv;
                const currentPrice = parseFloat(pairData.priceUsd);

                if (!token.maxFdv) token.maxFdv = token.entryFdv;
                if (token.isDipping === undefined) token.isDipping = false;
                
                token.isBreakingAth = currentFdv > token.maxFdv;
                
                if (currentFdv > token.maxFdv) {
                    token.maxFdv = currentFdv;
                    token.isDipping = false; 
                    dbChanged = true;
                }

                if (currentFdv < (token.maxFdv * 0.75)) {
                    if (!token.isDipping) { token.isDipping = true; dbChanged = true; }
                }
                
                token.isRecoveringNow = token.isDipping && currentFdv >= (token.maxFdv * 0.90) && currentFdv < token.maxFdv;

                token.currentFdv = currentFdv;
                token.currentPrice = currentPrice;
                token.lastUpdate = now;

                updateSimulationLogic(token, currentPrice, currentFdv);

                displayList.push(token);
            }
        }

        if (dbChanged) saveDB();
        await updateTopPerformersMessage(displayList);

    } catch (e) {
        log(`Error CRÍTICO en updateTracking: ${e.message}`, "ERROR");
    } finally {
        isTrackingUpdates = false; 
    }
}

// ==========================================
// 6. CLIENTE USERBOT
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

                if (activeTokens[ca]) {
                    if (!activeTokens[ca].mentions.some(m => m.channel === channelName)) {
                        activeTokens[ca].mentions.push(mentionData);
                        saveDB();
                        log(`Nueva mención para ${activeTokens[ca].symbol}`, "INFO");
                    }
                    continue; 
                }

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
                }
            }
        }
    }, new NewMessage({ chats: TARGET_CHANNELS, incoming: true }));

    setInterval(updateTracking, UPDATE_INTERVAL);
})();

process.on('uncaughtException', (error) => { log(`Uncaught Exception: ${error.message}`, "ERROR"); });
process.on('unhandledRejection', (reason, promise) => { log(`Unhandled Rejection`, "ERROR"); });
