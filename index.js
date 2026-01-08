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
const UPDATE_INTERVAL = 30000;  // Aumentado a 30s para evitar rate limiting
const MIN_GROWTH_SHOW = 1.30;   
const LIST_HOLD_TIME = 15 * 60 * 1000; 

// --- RATE LIMITING ---
let lastMessageUpdate = {
    viral: 0,
    recovery: 0,
    dashboard: 0
};
const MESSAGE_UPDATE_COOLDOWN = 20000; // 20 segundos entre actualizaciones de mensaje
let telegramRateLimited = false;
let rateLimitEndTime = 0; 

// Rate limiting configuration
const RATE_LIMIT_DELAY = 1000; // 1 segundo entre requests
let lastApiCall = 0; 

// --- RUTA SEGURA PARA DATOS ---
const DATA_FOLDER = './data'; // Nombre de la carpeta "caja fuerte"

// Si la carpeta no existe, la creamos (para que no de error)
if (!fs.existsSync(DATA_FOLDER)){
    fs.mkdirSync(DATA_FOLDER);
}

// Guardamos los archivos DENTRO de esa carpeta
const DB_FILE = `${DATA_FOLDER}/tokens_db.json`;
// La sesión también conviene guardarla ahí si quieres que no se pierda,
// pero como la subes desde tu PC, es opcional. El DB_FILE es el importante.
const SESSION_FILE = 'session.txt';
const SOLANA_ADDRESS_REGEX = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;

// --- ESTADO GLOBAL ---
let activeTokens = {}; 
let dashboardMsgId = null;
let simulationAmount = 7; 
let simulationTimeMinutes = 2; // <--- NUEVA VARIABLE (Minutos)
let liveListIds = {
    recovery: null,
    viral: null
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
    // CAMBIO: Forzamos hora colombiana (America/Bogota)
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

// CAMBIO: Función reescrita para usar la zona horaria correcta
function getShortDate(timestamp) {
    if (!timestamp) return "-";
    const dateStr = new Date(timestamp).toLocaleString('es-CO', {
        timeZone: 'America/Bogota',
        month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
    });
    return dateStr.toUpperCase().replace('.', '');
}

// CAMBIO: Función reescrita para usar la zona horaria correcta
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
            log(`Rate Limited! Esperando ${retryAfter}s antes de continuar. Context: ${context}`, "ERROR");
            return true;
        }
    }
    return false;
}

function canSendMessage(type) {
    const now = Date.now();
    
    // Verificar si estamos en rate limit global
    if (telegramRateLimited && now < rateLimitEndTime) {
        return false;
    } else if (telegramRateLimited && now >= rateLimitEndTime) {
        telegramRateLimited = false;
        log("Rate limit terminado, reanudando operaciones", "INFO");
    }
    
    // Verificar cooldown específico del tipo de mensaje
    if (now - lastMessageUpdate[type] < MESSAGE_UPDATE_COOLDOWN) {
        return false;
    }
    
    return true;
}

async function safeTelegramCall(asyncFunction, context = "", type = "general") {
    try {
        if (!canSendMessage(type)) {
            return null;
        }
        
        const result = await asyncFunction();
        lastMessageUpdate[type] = Date.now();
        return result;
    } catch (error) {
        if (handleTelegramError(error, context)) {
            return null;
        }
        log(`Error en ${context}: ${error.message}`, "ERROR");
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
            dashboardMsgId = data.dashboardId || null;
            liveListIds = data.liveListIds || { recovery: null, viral: null };
            simulationAmount = data.simulationAmount || 7;
            simulationTimeMinutes = data.simulationTimeMinutes || 2; // <--- CARGAR

            log(`DB Cargada: ${Object.keys(activeTokens).length} tokens.`, "INFO");
            log(`Config: Inv $${simulationAmount} | Tiempo Sim: ${simulationTimeMinutes} min`, "CONFIG");
        } catch (e) {
            log("DB nueva o corrupta.", "ERROR");
            activeTokens = {};
        }
    }
}

function saveDB() {
    const data = { 
        tokens: activeTokens, 
        dashboardId: dashboardMsgId, 
        liveListIds: liveListIds,
        simulationAmount: simulationAmount,
        simulationTimeMinutes: simulationTimeMinutes // <--- GUARDAR
    };
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// ==========================================
// 3. COMANDOS DEL BOT
// ==========================================

// COMANDO: AYUDA (LISTA DE COMANDOS)
bot.onText(/[\/\.]help/, async (msg) => {
    if (msg.chat.id !== DESTINATION_ID) return;

    const helpText = `📚 <b>PANEL DE COMANDOS</b> 📚\n\n` +

        `<b>⚙️ CONFIGURACIÓN</b>\n` +
        `• <code>/setinvest 10</code> ➔ Cambia la inversión simulada a $10 USD.\n` +
        `• <code>/settime 5</code> ➔ Cambia el tiempo de espera de la simulación a 5 min.\n\n` +

        `<b>📊 REPORTES DE RENDIMIENTO</b>\n` +
        `• <code>/top viral</code> ➔ Ver mejores ganancias en lista Viral.\n` +
        `• <code>/top recovery</code> ➔ Ver mejores ganancias en Recovery.\n` +
        `• <code>/top global</code> ➔ Ver mejores ganancias de todo el bot.\n` +
        `• <code>/dashboard</code> ➔ Fuerza el envío o actualización del Dashboard.\n\n` +

        `<b>🧹 LIMPIEZA VISUAL (No borra datos)</b>\n` +
        `• <code>/clean viral</code> ➔ Elimina el mensaje de lista Viral del chat.\n` +
        `• <code>/clean recovery</code> ➔ Elimina el mensaje de lista Recovery.\n` +
        `• <code>/clean dashboard</code> ➔ Elimina el mensaje del Dashboard.\n\n` +

        `<b>🗑️ GESTIÓN DE DATOS (Borra DB)</b>\n` +
        `• <code>/purge 3</code> ➔ Elimina de la memoria tokens con más de 3 días de antigüedad.\n` +
        `• <code>/nuke</code> ➔ ☢️ <b>PELIGRO:</b> Borra TODA la base de datos y resetea el bot.`;

    await safeTelegramCall(async () => {
        return await bot.sendMessage(DESTINATION_ID, helpText, { parse_mode: 'HTML' });
    }, 'help-command', 'general');
});

// COMANDO: CAMBIAR TIEMPO DE SIMULACIÓN
bot.onText(/[\/\.]settime (\d+)/, async (msg, match) => {
    if (msg.chat.id !== DESTINATION_ID) return;
    const minutes = parseInt(match[1]);
    if (isNaN(minutes) || minutes <= 0) return bot.sendMessage(DESTINATION_ID, "❌ Ingresa un tiempo válido (minutos).");

    simulationTimeMinutes = minutes;
    saveDB();
    log(`Configuración actualizada: Tiempo de simulación cambiado a ${minutes} min`, "CONFIG");
    await safeTelegramCall(async () => {
        return await bot.sendMessage(DESTINATION_ID, `✅ <b>Tiempo de simulación actualizado:</b> ${minutes} Minutos`, { parse_mode: 'HTML' });
    }, 'settime-command', 'general');
});

// COMANDO: CAMBIAR INVERSIÓN SIMULADA
bot.onText(/[\/\.]setinvest (\d+)/, async (msg, match) => {
    if (msg.chat.id !== DESTINATION_ID) return;
    const amount = parseInt(match[1]);
    if (isNaN(amount) || amount <= 0) return bot.sendMessage(DESTINATION_ID, "❌ Ingresa un monto válido.");

    simulationAmount = amount;
    saveDB();
    log(`Configuración actualizada: Inversión simulada cambiada a $${amount}`, "CONFIG");
    await safeTelegramCall(async () => {
        return await bot.sendMessage(DESTINATION_ID, `✅ <b>Inversión simulada actualizada:</b> $${amount} USD`, { parse_mode: 'HTML' });
    }, 'setinvest-command', 'general');
});

bot.onText(/[\/\.]nuke/, async (msg) => {
    if (msg.chat.id !== DESTINATION_ID) return;
    const idsToDelete = [dashboardMsgId, liveListIds.viral, liveListIds.recovery].filter(id => id);
    for (const id of idsToDelete) { try { await bot.deleteMessage(DESTINATION_ID, id); } catch(e) {} }

    activeTokens = {};
    dashboardMsgId = null;
    liveListIds = { recovery: null, viral: null };
    saveDB();
    log("Base de datos PURGADA TOTALMENTE por comando /nuke", "DELETE");
    await bot.sendMessage(DESTINATION_ID, "☢️ **BASE DE DATOS ELIMINADA**", { parse_mode: 'Markdown' });
});

bot.onText(/[\/\.]clean (.+)/, async (msg, match) => {
    if (msg.chat.id !== DESTINATION_ID) return;
    const type = match[1].toLowerCase().trim();
    let msgId = null;

    if (type === 'dashboard') { msgId = dashboardMsgId; dashboardMsgId = null; } 
    else if (liveListIds[type]) { msgId = liveListIds[type]; liveListIds[type] = null; }

    if (msgId) try { await bot.deleteMessage(DESTINATION_ID, msgId); } catch(e) {}
    saveDB();
    log(`Limpieza visual ejecutada para lista: ${type}`, "INFO");
    await bot.sendMessage(DESTINATION_ID, `🗑️ Lista visual <b>${type.toUpperCase()}</b> eliminada.`, { parse_mode: 'HTML' });
});

bot.onText(/[\/\.]top (.+)/, async (msg, match) => {
    if (msg.chat.id !== DESTINATION_ID) return;
    const type = match[1].toLowerCase().trim();
    const allTokens = Object.values(activeTokens);
    let tokensFilter = [];
    let title = "";

    if (type === 'viral') { tokensFilter = allTokens.filter(t => t.mentions.length >= 3); title = "🔥 TOP VIRAL"; }
    else if (type === 'recovery') { tokensFilter = allTokens.filter(t => t.lastRecoveryTime > 0); title = "♻️ TOP RECOVERY"; }
    else if (type === 'global' || type === 'dashboard') { tokensFilter = allTokens; title = "📊 TOP GLOBAL"; }
    else return bot.sendMessage(DESTINATION_ID, "❌ Tipos: viral, recovery, global");

    const winners = tokensFilter.filter(t => t.currentFdv > t.entryFdv);
    if (winners.length === 0) return bot.sendMessage(DESTINATION_ID, `📉 Sin ganancias en <b>${type}</b>.`, { parse_mode: 'HTML' });

    winners.sort((a, b) => (b.currentFdv / b.entryFdv) - (a.currentFdv / a.entryFdv));
    const topWinners = winners.slice(0, 15);

    let report = `🏆 <b>${title} (ROI)</b>\n\n`;
    topWinners.forEach((t, i) => {
        const growth = ((t.currentFdv / t.entryFdv - 1) * 100).toFixed(0);
        report += `${i + 1}. <b>$${t.symbol}</b> (+${growth}%)\n`;
        report += `   💰 Entry: ${formatCurrency(t.entryFdv)} ➔ Now: ${formatCurrency(t.currentFdv)}\n`;
        report += `   📅 ${getShortDate(t.detectedAt)}\n\n`;
    });

    log(`Reporte TOP generado para: ${type}`, "INFO");
    await bot.sendMessage(DESTINATION_ID, report, { parse_mode: 'HTML', disable_web_page_preview: true });
});

bot.onText(/[\/\.]purge (\d+)/, async (msg, match) => {
    if (msg.chat.id !== DESTINATION_ID) return;
    const days = parseInt(match[1]);
    if (isNaN(days) || days <= 0) return;
    const cutoffTime = Date.now() - (days * 24 * 60 * 60 * 1000);
    let deletedCount = 0;
    Object.keys(activeTokens).forEach(ca => {
        if (activeTokens[ca].detectedAt < cutoffTime) { delete activeTokens[ca]; deletedCount++; }
    });
    if (deletedCount > 0) { 
        saveDB(); 
        log(`PURGA AUTOMÁTICA: Eliminados ${deletedCount} tokens con más de ${days} días.`, "DELETE");
        await bot.sendMessage(DESTINATION_ID, `🗑️ Eliminados ${deletedCount} tokens antiguos.`); 
    }
    else await bot.sendMessage(DESTINATION_ID, `✅ Nada que purgar.`);
});

// ==========================================
// 3. API DEXSCREENER CON RATE LIMITING
// ==========================================

// Función para esperar y respetar rate limits
async function waitForRateLimit() {
    const now = Date.now();
    const timeSinceLastCall = now - lastApiCall;
    if (timeSinceLastCall < RATE_LIMIT_DELAY) {
        const waitTime = RATE_LIMIT_DELAY - timeSinceLastCall;
        await new Promise(resolve => setTimeout(resolve, waitTime));
    }
    lastApiCall = Date.now();
}

async function getBatchDexData(addressesArray) {
    try {
        await waitForRateLimit();
        const url = `https://api.dexscreener.com/latest/dex/tokens/${addressesArray.join(',')}`;
        const res = await axios.get(url);
        return (res.data && res.data.pairs) ? res.data.pairs.filter(p => p.chainId === 'solana') : [];
    } catch (e) { 
        log(`Error DexScreener Batch: ${e.message}`, "ERROR");
        return []; 
    }
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
    } catch (e) { 
        log(`Error DexScreener Single: ${e.message}`, "ERROR");
        return null; 
    }
}

// ==========================================
// 4. LÓGICA CENTRAL DE TRACKING
// ==========================================

// FUNCIÓN DE UTILIDAD PARA SIMULACIÓN
function updateSimulationLogic(token, type, currentPrice, currentFdv) {
    if (!token.listStats) token.listStats = {};
    if (!token.listStats[type]) {
        token.listStats[type] = {
            entryTime: Date.now(),       
            entryPrice: currentPrice,    
            entryFdv: currentFdv,
            price2Min: null,
            // Nuevos campos para guardar los datos exactos de la entrada simulada
            simEntryTime: null,
            simEntryFdv: null
        };
        log(`Nuevo ingreso a Lista [${type.toUpperCase()}]: ${token.symbol} | MC Entrada: ${formatCurrency(currentFdv)}`, "LIVE");
    }

    const stats = token.listStats[type];
    const waitTimeMs = simulationTimeMinutes * 60 * 1000; 

    if (stats.price2Min === null) {
        // Si ya pasó el tiempo establecido
        if ((Date.now() - stats.entryTime) >= waitTimeMs) {
            stats.price2Min = currentPrice;
            
            // --- NUEVO: Guardamos la hora y MC exactos de la simulación ---
            stats.simEntryTime = Date.now();
            stats.simEntryFdv = currentFdv;
            // --------------------------------------------------------------

            log(`Simulación Activada (${type}): ${token.symbol} | Precio Fijado tras ${simulationTimeMinutes} min`, "INFO");
        }
    }
}

// Función para manejar errores de Telegram con retry
async function sendTelegramMessage(text, options = {}) {
    const maxRetries = 3;
    for (let i = 0; i < maxRetries; i++) {
        try {
            return await bot.sendMessage(DESTINATION_ID, text, options);
        } catch (error) {
            if (error.message.includes('429')) {
                const retryAfter = parseInt(error.message.match(/retry after (\d+)/)?.[1] || '5');
                log(`Rate limit hit, esperando ${retryAfter} segundos...`, "INFO");
                await new Promise(resolve => setTimeout(resolve, (retryAfter + 1) * 1000));
                continue;
            }
            throw error;
        }
    }
}

async function editTelegramMessage(text, messageId, options = {}) {
    const maxRetries = 3;
    for (let i = 0; i < maxRetries; i++) {
        try {
            return await bot.editMessageText(text, {
                chat_id: DESTINATION_ID,
                message_id: messageId,
                ...options
            });
        } catch (error) {
            if (error.message.includes('429')) {
                const retryAfter = parseInt(error.message.match(/retry after (\d+)/)?.[1] || '5');
                log(`Rate limit hit, esperando ${retryAfter} segundos...`, "INFO");
                await new Promise(resolve => setTimeout(resolve, (retryAfter + 1) * 1000));
                continue;
            }
            if (error.message.includes("not found")) {
                return null; // Mensaje fue borrado
            }
            throw error;
        }
    }
}

async function updateLiveListMessage(type, tokens, title, emoji) {
    // Verificar rate limiting antes de proceder
    if (!canSendMessage(type)) {
        return;
    }

    if (tokens.length === 0) {
        if (liveListIds[type]) {
            await safeTelegramCall(async () => {
                await bot.deleteMessage(DESTINATION_ID, liveListIds[type]);
                liveListIds[type] = null;
                saveDB();
                log(`Lista [${type}] vaciada y borrada del chat.`, "DELETE");
            }, `delete-${type}`, type);
        }
        return;
    }

    // ORDENAMIENTO
    if (type === 'viral') {
        // Ordenar por ganancia (growth) en lugar de por menciones
        tokens.sort((a, b) => {
            const statsA = a.listStats ? a.listStats[type] : null;
            const statsB = b.listStats ? b.listStats[type] : null;
            const entryFdvA = statsA ? statsA.entryFdv : a.entryFdv;
            const entryFdvB = statsB ? statsB.entryFdv : b.entryFdv;
            const growthA = (a.currentFdv / entryFdvA - 1) * 100;
            const growthB = (b.currentFdv / entryFdvB - 1) * 100;
            return growthB - growthA; // Mayor ganancia primero
        });
    } else if (type === 'recovery') {
        tokens.sort((a, b) => b.lastRecoveryTime - a.lastRecoveryTime);
    }

    const displayTokens = type === 'viral' ? tokens.slice(0, 6) : tokens.slice(0, 20);

    let text = `${emoji} <b>EN VIVO: ${title}</b> ${emoji}\n`;
    text += type === 'viral' ? `<i>Top 6 por Ganancia | Inv. Sim: $${simulationAmount}</i>\n\n` : `<i>Top 20 Activos | Inv. Sim: $${simulationAmount}</i>\n\n`;

    displayTokens.forEach((t, index) => {
        // Usar el MC de entrada específico de esta lista, no el global
        const stats = t.listStats ? t.listStats[type] : null;
        const listEntryFdv = stats ? stats.entryFdv : t.entryFdv; // Fallback al global si no hay stats
        const growth = ((t.currentFdv / listEntryFdv - 1) * 100).toFixed(0);
        const trendIcon = parseFloat(growth) >= 0 ? '🟢' : '🔴';
        let extraInfo = "";

        if (type === 'recovery') extraInfo = ` | ♻️ Dip Eater`;

        // LÓGICA DE SIMULACIÓN VISUAL
        let simText = `⏳ <i>Simulando entrada...</i>`;
        const waitTimeMs = simulationTimeMinutes * 60 * 1000; 

        if (stats) {
            const entryTimeStr = getTimeOnly(stats.entryTime);

            if (stats.price2Min !== null) {
                // Cálculos de ganancia
                const currentValue = (t.currentPrice / stats.price2Min) * simulationAmount;
                const profitPct = ((currentValue - simulationAmount) / simulationAmount) * 100;
                const iconSim = profitPct >= 0 ? '📈' : '📉';
                
                // Formateamos los datos de la entrada simulada
                const simTimeStr = stats.simEntryTime ? getTimeOnly(stats.simEntryTime) : "--:--";
                const simFdvStr = stats.simEntryFdv ? formatCurrency(stats.simEntryFdv) : "N/A";

                simText = `💵 <b>Sim ($${simulationAmount}):</b> ${iconSim} $${currentValue.toFixed(2)} (${profitPct.toFixed(1)}%)\n`;
                // --- NUEVA LÍNEA CON DATOS DE ENTRADA SIMULADA ---
                simText += `   🛒 <b>Compra:</b> ${simTimeStr} | <b>MC:</b> ${simFdvStr}`;
                
            } else {
                const timeLeft = Math.ceil((waitTimeMs - (Date.now() - stats.entryTime)) / 1000);
                simText = `⏳ <b>Sim ($${simulationAmount}):</b> Esperando entrada (${timeLeft}s)`;
            }

            text += `${index + 1}. ${trendIcon} <b>$${escapeHtml(t.symbol)}</b> (+${growth}%)\n`;
            text += `   🕒 <b>Hora Entrada:</b> ${entryTimeStr}\n`;
            // Formatear menciones como en el dashboard
            const mentionsList = t.mentions.map(m => {
                const timeStr = getShortDate(m.time);
                const channelLink = m.link ? `<a href="${m.link}">${escapeHtml(m.channel)}</a>` : `<b>${escapeHtml(m.channel)}</b>`;
                return `• ${timeStr} - ${channelLink}`;
            }).join('\n');

            text += `   💰 Entry: ${formatCurrency(listEntryFdv)} ➔ <b>Now: ${formatCurrency(t.currentFdv)}</b>\n`;
            text += `   ${simText}\n`; 
            text += `   🔗 <a href="https://gmgn.ai/sol/token/${t.ca}">GMGN</a> | <a href="https://mevx.io/solana/${t.ca}">MEVX</a>${extraInfo}\n`;
            text += `   <blockquote expandable>${mentionsList}</blockquote>\n\n`;
        } else {
            text += `${index + 1}. ${trendIcon} <b>$${escapeHtml(t.symbol)}</b>\n   Recopilando datos...\n\n`;
        }
    });

    text += `⚡ <i>Actualizado: ${new Date().toLocaleTimeString('es-CO', { timeZone: 'America/Bogota', hour12: false })}</i>`;

    if (liveListIds[type]) {
        await safeTelegramCall(async () => {
            return await bot.editMessageText(text, {
                chat_id: DESTINATION_ID,
                message_id: liveListIds[type],
                parse_mode: 'HTML',
                disable_web_page_preview: true
            });
        }, `edit-${type}`, type).catch(async (e) => {
            if (e && e.message && e.message.includes("not found")) {
                const sent = await safeTelegramCall(async () => {
                    return await bot.sendMessage(DESTINATION_ID, text, { 
                        parse_mode: 'HTML', 
                        disable_web_page_preview: true 
                    });
                }, `recreate-${type}`, type);
                if (sent) {
                    liveListIds[type] = sent.message_id;
                    saveDB();
                    log(`Mensaje lista [${type}] recreado tras borrado manual.`, "LIVE");
                }
            }
        });
    } else {
        const sent = await safeTelegramCall(async () => {
            return await bot.sendMessage(DESTINATION_ID, text, { 
                parse_mode: 'HTML', 
                disable_web_page_preview: true 
            });
        }, `create-${type}`, type);
        if (sent) {
            liveListIds[type] = sent.message_id;
            saveDB();
            log(`Nuevo mensaje de lista creado: [${type}]`, "LIVE");
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

    let recoveryList = [];
    let viralList = [];

    for (const chunk of chunks) {
        const pairsData = await getBatchDexData(chunk);

        for (const ca of chunk) {
            const token = activeTokens[ca];
            const pairData = pairsData.find(p => p.baseToken.address === ca);

            if (!pairData) continue; 

            if (pairData.fdv < MIN_MC_KEEP) {
                log(`Eliminando ${token.symbol} | MC Cayó a: ${formatCurrency(pairData.fdv)}`, "DELETE");
                delete activeTokens[ca];
                dbChanged = true;
                continue;
            }

            const currentFdv = pairData.fdv;
            const currentPrice = parseFloat(pairData.priceUsd);

            // Inicialización de campos
            if (!token.maxFdv) token.maxFdv = token.entryFdv;
            if (token.isDipping === undefined) token.isDipping = false;
            if (!token.lastRecoveryTime) token.lastRecoveryTime = 0;
            if (!token.listStats) token.listStats = {}; 

            // 1. LÓGICA VIRAL
            if (token.mentions.length >= 3) {
                updateSimulationLogic(token, 'viral', currentPrice, currentFdv); 
                viralList.push(token);
            }

            // 2. LÓGICA RECOVERY
            if (currentFdv < (token.maxFdv * 0.75)) {
                if (!token.isDipping) { token.isDipping = true; dbChanged = true; }
            }
            const isRecoveringNow = token.isDipping && currentFdv >= (token.maxFdv * 0.90) && currentFdv < token.maxFdv;

            if (isRecoveringNow) {
                token.lastRecoveryTime = now;
                updateSimulationLogic(token, 'recovery', currentPrice, currentFdv); 
                recoveryList.push(token);
                dbChanged = true;
            } else if ((now - token.lastRecoveryTime) < LIST_HOLD_TIME) {
                if(token.listStats['recovery']) updateSimulationLogic(token, 'recovery', currentPrice, currentFdv);
                recoveryList.push(token);
            }

            // Actualizar maxFdv para recovery logic
            if (currentFdv > token.maxFdv) {
                token.maxFdv = currentFdv;
                token.isDipping = false;
                dbChanged = true;
            }

            token.currentFdv = currentFdv;
            token.currentPrice = currentPrice;
            token.lastUpdate = now;
        }
    }

    if (dbChanged) saveDB();

    await updateLiveListMessage('viral', viralList, "VIRAL / HOT 🔥 (3+ Calls)", "🔥");
    await updateLiveListMessage('recovery', recoveryList, "RECUPERANDO / DIP EATER ♻️", "♻️");
    await updateDashboardMessage();
}

async function updateDashboardMessage() {
    // Verificar rate limiting antes de proceder
    if (!canSendMessage('dashboard')) {
        return;
    }

    const sortedTokens = Object.values(activeTokens)
        .filter(t => (t.currentFdv / t.entryFdv) >= MIN_GROWTH_SHOW)
        .sort((a, b) => (b.currentFdv / b.entryFdv) - (a.currentFdv / a.entryFdv))
        .slice(0, 5);

    if (sortedTokens.length === 0 && !dashboardMsgId) return;

    let text = "<b>📊 DASHBOARD GLOBAL - TOP 5</b>\n\n";

    if (sortedTokens.length === 0) {
        text += "<i>💤 Esperando movimientos (+30%)...</i>";
    } else {
        sortedTokens.forEach((t, i) => {
            const growth = ((t.currentFdv / t.entryFdv - 1) * 100).toFixed(0);
            const mentionsList = t.mentions.map(m => {
                const timeStr = getShortDate(m.time);
                const channelLink = m.link ? `<a href="${m.link}">${escapeHtml(m.channel)}</a>` : `<b>${escapeHtml(m.channel)}</b>`;
                return `• ${timeStr} - ${channelLink}`;
            }).join('\n');

            text += `${i + 1}. <b>$${escapeHtml(t.symbol)}</b> | +${growth}%\n`;
            text += `   💰 Entry: ${formatCurrency(t.entryFdv)} ➔ <b>Now: ${formatCurrency(t.currentFdv)}</b>\n`;
            text += `   🔗 <a href="https://gmgn.ai/sol/token/${t.ca}">GMGN</a> | <a href="https://mevx.io/solana/${t.ca}">MEVX</a>\n`;
            text += `   <blockquote expandable>${mentionsList}</blockquote>\n\n`;
        });
    }
    text += `\n⚡ Actualizado: ${new Date().toLocaleTimeString('es-CO', { timeZone: 'America/Bogota', hour12: false })}`;

    if (!dashboardMsgId) {
        const sent = await safeTelegramCall(async () => {
            return await bot.sendMessage(DESTINATION_ID, text, { 
                parse_mode: 'HTML', 
                disable_web_page_preview: true 
            });
        }, 'create-dashboard', 'dashboard');
        if (sent) {
            dashboardMsgId = sent.message_id;
            saveDB();
        }
    } else {
        await safeTelegramCall(async () => {
            return await bot.editMessageText(text, { 
                chat_id: DESTINATION_ID, 
                message_id: dashboardMsgId, 
                parse_mode: 'HTML', 
                disable_web_page_preview: true 
            });
        }, 'edit-dashboard', 'dashboard');
    }
}

// ==========================================
// 5. CLIENTE USERBOT
// ==========================================
(async () => {
    log("Iniciando Bot Híbrido...", "INFO");
    loadDB();
    let stringSession = new StringSession("");
    
    // Check if session file exists and handle Railway environment
    if (fs.existsSync(SESSION_FILE)) {
        try {
            const sessionData = fs.readFileSync(SESSION_FILE, 'utf8');
            stringSession = new StringSession(sessionData);
            log("Sesión cargada desde archivo", "INFO");
        } catch (error) {
            log(`Error leyendo sesión: ${error.message}`, "ERROR");
        }
    } else {
        log("No se encontró archivo de sesión, iniciando nueva sesión", "INFO");
    }
    const client = new TelegramClient(stringSession, API_ID, API_HASH, { 
        connectionRetries: 5,
        retryDelay: 1000,
        timeout: 10000,
        useWSS: false
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
        // Try to reconnect after delay
        setTimeout(() => {
            log("Attempting to reconnect...", "INFO");
            process.exit(1); // Let Railway restart the process
        }, 5000);
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
                        log(`Nueva mención para ${activeTokens[ca].symbol} en ${channelName}`, "INFO");
                        updateTracking(); 
                    }
                    continue; 
                }

                const data = await getSingleDexData(ca);
                if (data && data.fdv >= MIN_MC_ENTRY) {

                    // LOG DETALLADO DE CAPTURA
                    log(`NUEVO TOKEN DETECTADO\n   👉 Symbol: ${data.symbol}\n   👉 Canal: ${channelName}\n   👉 MC Entry: ${formatCurrency(data.fdv)}\n   👉 CA: ${ca}`, "CAPTURE");

                    activeTokens[ca] = {
                        name: data.name, symbol: data.symbol, ca: ca, url: data.url,
                        entryFdv: data.fdv, entryPrice: data.price, currentFdv: data.fdv,
                        maxFdv: data.fdv, isDipping: false,
                        lastRecoveryTime: 0,
                        listStats: {}, 
                        mentions: [mentionData], detectedAt: Date.now()
                    };
                    saveDB();
                } else if (data) {
                    log(`Ignorado ${data.symbol} (${channelName}) | MC muy bajo: ${formatCurrency(data.fdv)}`, "IGNORE");
                }
            }
        }
    }, new NewMessage({ chats: TARGET_CHANNELS, incoming: true }));

    setInterval(updateTracking, UPDATE_INTERVAL);
})();

// Global error handlers
process.on('uncaughtException', (error) => {
    log(`Uncaught Exception: ${error.message}`, "ERROR");
    console.error(error.stack);
});

process.on('unhandledRejection', (reason, promise) => {
    log(`Unhandled Rejection at: ${promise}, reason: ${reason}`, "ERROR");
});

process.on('SIGTERM', () => {
    log('SIGTERM received, shutting down gracefully', "INFO");
    process.exit(0);
});

process.on('SIGINT', () => {
    log('SIGINT received, shutting down gracefully', "INFO");
    process.exit(0);
});