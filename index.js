const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');
const TelegramBot = require('node-telegram-bot-api');
const input = require('input');
const axios = require('axios');
const http = require('http');
const fs = require('fs');

// --- CONFIGURACIÓN Y SECRETOS ---
const API_ID = Number(process.env.API_ID);
const API_HASH = process.env.API_HASH;
const BOT_TOKEN = process.env.BOT_TOKEN; 
const DESTINATION_ID = Number(process.env.DESTINATION_ID); 

// --- CANALES A ESPIAR ---
const TARGET_CHANNELS = ["kolsignal", "degen_smartmoney", "bing_community_monitor", "solhousesignal", "nevadielegends", "PFsafeLaunch", "ReVoX_Academy", "dacostest", "pfultimate", "GemDynasty", "Bot_NovaX", "CCMFreeSignal", "KropClub", "ciphercallsfree", "solanagemsradar", "solana_whales_signal", "pingcalls", "gem_tools_calls", "SAVANNAHCALLS", "athenadefai", "Bigbabywhale", "SavannahSOL", "A3CallChan", "PEPE_Calls28", "gems_calls100x", "ai_dip_caller", "KingdomOfDegenCalls", "fttrenches_volsm", "loganpump", "bananaTrendingBot"];

// --- CONFIGURACIÓN DE TRACKING ---
const MIN_MC_ENTRY = 20000;     
const MIN_MC_KEEP = 10000;      
const BATCH_SIZE = 30;          
const UPDATE_INTERVAL = 10000;  
const MIN_GROWTH_SHOW = 1.30;   
const LIST_HOLD_TIME = 15 * 60 * 1000; 

// --- RUTA SEGURA PARA DATOS ---
const fs = require('fs');
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
    breakout: null,
    viral: null
};

// --- INICIALIZAR BOT ---
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// --- SERVIDOR WEB ---
http.createServer((req, res) => { res.writeHead(200); res.end('Tracker Bot OK'); }).listen(3000);

// ==========================================
// 0. SISTEMA DE LOGS DETALLADOS (RESTAURADO)
// ==========================================
function log(message, type = "INFO") {
    const now = new Date();
    // Formato: [DD/MM/YYYY HH:mm:ss]
    const timestamp = now.toLocaleString('es-ES', { 
        day: '2-digit', month: '2-digit', year: 'numeric', 
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false 
    });

    const icons = {
        "INFO": "ℹ️",
        "CAPTURE": "🎯",
        "ALERT": "🚨",
        "LIVE": "📡",
        "IGNORE": "🚫",
        "ERROR": "❌",
        "DELETE": "🗑️",
        "CONFIG": "⚙️"
    };

    const icon = icons[type] || "";
    console.log(`[${timestamp}] ${icon} [${type}] ${message}`);
}

function formatCurrency(num) {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(num);
}

// Fecha corta: OCT 21 14:30
function getShortDate(timestamp) {
    if (!timestamp) return "-";
    const date = new Date(timestamp);
    const months = ["ENE", "FEB", "MAR", "ABR", "MAY", "JUN", "JUL", "AGO", "SEP", "OCT", "NOV", "DIC"];
    const month = months[date.getMonth()];
    const day = date.getDate().toString().padStart(2, '0');
    const hours = date.getHours().toString().padStart(2, '0');
    const mins = date.getMinutes().toString().padStart(2, '0');
    return `${month} ${day} ${hours}:${mins}`;
}

// Solo Hora: 14:30:05
function getTimeOnly(timestamp) {
    if (!timestamp) return "--:--";
    return new Date(timestamp).toLocaleTimeString('es-ES');
}

function escapeHtml(text) {
    if (!text) return text;
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

// ==========================================
// 1. GESTIÓN DE BASE DE DATOS
// ==========================================
function loadDB() {
    if (fs.existsSync(DB_FILE)) {
        try {
            const data = JSON.parse(fs.readFileSync(DB_FILE));
            activeTokens = data.tokens || {};
            dashboardMsgId = data.dashboardId || null;
            liveListIds = data.liveListIds || { recovery: null, breakout: null, viral: null };
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
// 2. COMANDOS DEL BOT
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
        `• <code>/top breakout</code> ➔ Ver mejores ganancias en Breakout.\n` +
        `• <code>/top recovery</code> ➔ Ver mejores ganancias en Recovery.\n` +
        `• <code>/top global</code> ➔ Ver mejores ganancias de todo el bot.\n` +
        `• <code>/dashboard</code> ➔ Fuerza el envío o actualización del Dashboard.\n\n` +

        `<b>🧹 LIMPIEZA VISUAL (No borra datos)</b>\n` +
        `• <code>/clean viral</code> ➔ Elimina el mensaje de lista Viral del chat.\n` +
        `• <code>/clean breakout</code> ➔ Elimina el mensaje de lista Breakout.\n` +
        `• <code>/clean recovery</code> ➔ Elimina el mensaje de lista Recovery.\n` +
        `• <code>/clean dashboard</code> ➔ Elimina el mensaje del Dashboard.\n\n` +

        `<b>🗑️ GESTIÓN DE DATOS (Borra DB)</b>\n` +
        `• <code>/purge 3</code> ➔ Elimina de la memoria tokens con más de 3 días de antigüedad.\n` +
        `• <code>/nuke</code> ➔ ☢️ <b>PELIGRO:</b> Borra TODA la base de datos y resetea el bot.`;

    await bot.sendMessage(DESTINATION_ID, helpText, { parse_mode: 'HTML' });
});

// COMANDO: CAMBIAR TIEMPO DE SIMULACIÓN
bot.onText(/[\/\.]settime (\d+)/, async (msg, match) => {
    if (msg.chat.id !== DESTINATION_ID) return;
    const minutes = parseInt(match[1]);
    if (isNaN(minutes) || minutes <= 0) return bot.sendMessage(DESTINATION_ID, "❌ Ingresa un tiempo válido (minutos).");

    simulationTimeMinutes = minutes;
    saveDB();
    log(`Configuración actualizada: Tiempo de simulación cambiado a ${minutes} min`, "CONFIG");
    await bot.sendMessage(DESTINATION_ID, `✅ <b>Tiempo de simulación actualizado:</b> ${minutes} Minutos`, { parse_mode: 'HTML' });
});

// COMANDO: CAMBIAR INVERSIÓN SIMULADA
bot.onText(/[\/\.]setinvest (\d+)/, async (msg, match) => {
    if (msg.chat.id !== DESTINATION_ID) return;
    const amount = parseInt(match[1]);
    if (isNaN(amount) || amount <= 0) return bot.sendMessage(DESTINATION_ID, "❌ Ingresa un monto válido.");

    simulationAmount = amount;
    saveDB();
    log(`Configuración actualizada: Inversión simulada cambiada a $${amount}`, "CONFIG");
    await bot.sendMessage(DESTINATION_ID, `✅ <b>Inversión simulada actualizada:</b> $${amount} USD`, { parse_mode: 'HTML' });
});

bot.onText(/[\/\.]nuke/, async (msg) => {
    if (msg.chat.id !== DESTINATION_ID) return;
    const idsToDelete = [dashboardMsgId, liveListIds.viral, liveListIds.breakout, liveListIds.recovery].filter(id => id);
    for (const id of idsToDelete) { try { await bot.deleteMessage(DESTINATION_ID, id); } catch(e) {} }

    activeTokens = {};
    dashboardMsgId = null;
    liveListIds = { recovery: null, breakout: null, viral: null };
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
    else if (type === 'breakout') { tokensFilter = allTokens.filter(t => t.breakoutCount >= 2); title = "🚀 TOP BREAKOUT"; }
    else if (type === 'recovery') { tokensFilter = allTokens.filter(t => t.lastRecoveryTime > 0); title = "♻️ TOP RECOVERY"; }
    else if (type === 'global' || type === 'dashboard') { tokensFilter = allTokens; title = "📊 TOP GLOBAL"; }
    else return bot.sendMessage(DESTINATION_ID, "❌ Tipos: viral, breakout, recovery, global");

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
// 3. API DEXSCREENER
// ==========================================
async function getBatchDexData(addressesArray) {
    try {
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

// FUNCIÓN DE UTILIDAD PARA SIMULACIÓN (2 MINUTOS)
function updateSimulationLogic(token, type, currentPrice, currentFdv) {
    if (!token.listStats) token.listStats = {};
    if (!token.listStats[type]) {
        token.listStats[type] = {
            entryTime: Date.now(),       
            entryPrice: currentPrice,    
            entryFdv: currentFdv,
            price2Min: null              
        };
        log(`Nuevo ingreso a Lista [${type.toUpperCase()}]: ${token.symbol} | Precio: $${currentPrice}`, "LIVE");
    }

    const stats = token.listStats[type];
    const waitTimeMs = simulationTimeMinutes * 60 * 1000; // <--- CÁLCULO DINÁMICO

    if (stats.price2Min === null) {
        // Usar waitTimeMs en lugar de 120000
        if ((Date.now() - stats.entryTime) >= waitTimeMs) {
            stats.price2Min = currentPrice; 
            log(`Simulación Activada (${type}): ${token.symbol} | Precio Fijado tras ${simulationTimeMinutes} min`, "INFO");
        }
    }
}

async function updateLiveListMessage(type, tokens, title, emoji) {
    if (tokens.length === 0) {
        if (liveListIds[type]) {
            try { 
                await bot.deleteMessage(DESTINATION_ID, liveListIds[type]); 
                liveListIds[type] = null; 
                saveDB(); 
                log(`Lista [${type}] vaciada y borrada del chat.`, "DELETE");
            } catch (e) { liveListIds[type] = null; }
        }
        return;
    }

    // ORDENAMIENTO
    if (type === 'viral') {
        tokens.sort((a, b) => b.mentions.length - a.mentions.length);
    } else if (type === 'breakout') {
        tokens.sort((a, b) => b.lastBreakoutTime - a.lastBreakoutTime);
    } else if (type === 'recovery') {
        tokens.sort((a, b) => b.lastRecoveryTime - a.lastRecoveryTime);
    }

    const displayTokens = tokens.slice(0, 20);

    let text = `${emoji} <b>EN VIVO: ${title}</b> ${emoji}\n`;
    text += `<i>Top 20 Activos | Inv. Sim: $${simulationAmount}</i>\n\n`;

    displayTokens.forEach((t, index) => {
        const growth = ((t.currentFdv / t.entryFdv - 1) * 100).toFixed(0);
        const trendIcon = parseFloat(growth) >= 0 ? '🟢' : '🔴';
        let extraInfo = "";

        if (type === 'breakout') extraInfo = ` | ⚡ Hits: ${t.breakoutCount || 1}`;
        if (type === 'recovery') extraInfo = ` | ♻️ Dip Eater`;

        // LÓGICA DE SIMULACIÓN VISUAL
        let simText = `⏳ <i>Simulando entrada...</i>`;
        const stats = t.listStats ? t.listStats[type] : null;
        const waitTimeMs = simulationTimeMinutes * 60 * 1000; // <--- CÁLCULO DINÁMICO

        if (stats) {
            const entryTimeStr = getTimeOnly(stats.entryTime);

            if (stats.price2Min !== null) {
                // Ya pasó el tiempo
                const currentValue = (t.currentPrice / stats.price2Min) * simulationAmount;
                const profitPct = ((currentValue - simulationAmount) / simulationAmount) * 100;
                const iconSim = profitPct >= 0 ? '📈' : '📉';

                simText = `💵 <b>Sim ($${simulationAmount}):</b> ${iconSim} $${currentValue.toFixed(2)} (${profitPct.toFixed(1)}%)`;
            } else {
                // Aún contando: Usar waitTimeMs para calcular el restante
                const timeLeft = Math.ceil((waitTimeMs - (Date.now() - stats.entryTime)) / 1000);
                simText = `⏳ <b>Sim ($${simulationAmount}):</b> Esperando entrada (${timeLeft}s)`;
            }

            text += `${index + 1}. ${trendIcon} <b>$${escapeHtml(t.symbol)}</b> (+${growth}%)\n`;
            text += `   ⏱ <b>Listado:</b> ${entryTimeStr}\n`;
            text += `   💰 Entry: ${formatCurrency(t.entryFdv)} ➔ <b>Now: ${formatCurrency(t.currentFdv)}</b>\n`;
            text += `   ${simText}\n`; 
            text += `   🗣 <b>${t.mentions.length} Calls</b>${extraInfo} | 🔗 <a href="https://gmgn.ai/sol/token/${t.ca}">GMGN</a> • <a href="https://mevx.io/solana/${t.ca}">MEVX</a>\n\n`;
        } else {
            text += `${index + 1}. ${trendIcon} <b>$${escapeHtml(t.symbol)}</b>\n   Recopilando datos...\n\n`;
        }
    });

    text += `⚡ <i>Actualizado: ${new Date().toLocaleTimeString('es-ES')}</i>`;

    if (liveListIds[type]) {
        try {
            await bot.editMessageText(text, {
                chat_id: DESTINATION_ID,
                message_id: liveListIds[type],
                parse_mode: 'HTML',
                disable_web_page_preview: true
            });
        } catch (e) {
            if (e.message.includes("not found")) {
                const sent = await bot.sendMessage(DESTINATION_ID, text, { parse_mode: 'HTML', disable_web_page_preview: true });
                liveListIds[type] = sent.message_id;
                saveDB();
                log(`Mensaje lista [${type}] recreado tras borrado manual.`, "LIVE");
            }
        }
    } else {
        const sent = await bot.sendMessage(DESTINATION_ID, text, { parse_mode: 'HTML', disable_web_page_preview: true });
        liveListIds[type] = sent.message_id;
        saveDB();
        log(`Nuevo mensaje de lista creado: [${type}]`, "LIVE");
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
    let breakoutList = [];
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
            if (!token.lastBreakoutTime) token.lastBreakoutTime = 0;
            if (!token.lastRecoveryTime) token.lastRecoveryTime = 0;
            if (!token.breakoutCount) token.breakoutCount = 0; 
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

            // 3. LÓGICA BREAKOUT
            const isBreakingOutNow = currentFdv > token.maxFdv;
            if (isBreakingOutNow) {
                token.maxFdv = currentFdv;
                token.isDipping = false;
                token.lastBreakoutTime = now;
                token.breakoutCount += 1; 
                dbChanged = true;
            }

            if (token.breakoutCount >= 2) {
                 if (isBreakingOutNow || (now - token.lastBreakoutTime) < LIST_HOLD_TIME) {
                     updateSimulationLogic(token, 'breakout', currentPrice, currentFdv);
                     breakoutList.push(token);
                 }
            }

            token.currentFdv = currentFdv;
            token.currentPrice = currentPrice;
            token.lastUpdate = now;
        }
    }

    if (dbChanged) saveDB();

    await updateLiveListMessage('viral', viralList, "VIRAL / HOT 🔥 (3+ Calls)", "🔥");
    await updateLiveListMessage('breakout', breakoutList, "NUEVOS MÁXIMOS 🚀 (Min 2 Hits)", "🚀");
    await updateLiveListMessage('recovery', recoveryList, "RECUPERANDO / DIP EATER ♻️", "♻️");
    await updateDashboardMessage();
}

async function updateDashboardMessage() {
    const sortedTokens = Object.values(activeTokens)
        .filter(t => (t.currentFdv / t.entryFdv) >= MIN_GROWTH_SHOW)
        .sort((a, b) => (b.currentFdv / b.entryFdv) - (a.currentFdv / a.entryFdv))
        .slice(0, 15);

    if (sortedTokens.length === 0 && !dashboardMsgId) return;

    let text = "<b>📊 DASHBOARD GLOBAL</b>\n\n";

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
    text += `\n⚡ Actualizado: ${new Date().toLocaleTimeString('es-ES')}`;

    if (!dashboardMsgId) {
        try { 
            const sent = await bot.sendMessage(DESTINATION_ID, text, { parse_mode: 'HTML', disable_web_page_preview: true }); 
            dashboardMsgId = sent.message_id; 
            saveDB(); 
        } catch (e) { log(`Error creando Dashboard: ${e.message}`, "ERROR"); }
    } else {
        try { await bot.editMessageText(text, { chat_id: DESTINATION_ID, message_id: dashboardMsgId, parse_mode: 'HTML', disable_web_page_preview: true }); } catch (e) {}
    }
}

// ==========================================
// 5. CLIENTE USERBOT
// ==========================================
(async () => {
    log("Iniciando Bot Híbrido...", "INFO");
    loadDB();
    let stringSession = new StringSession("");
    if (fs.existsSync(SESSION_FILE)) stringSession = new StringSession(fs.readFileSync(SESSION_FILE, 'utf8'));
    const client = new TelegramClient(stringSession, API_ID, API_HASH, { connectionRetries: 5 });

    await client.start({
        phoneNumber: async () => await input.text("Número: "),
        password: async () => await input.text("2FA: "),
        phoneCode: async () => await input.text("Código: "),
        onError: (err) => log(err, "ERROR"),
    });

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
                        maxFdv: data.fdv, isDipping: false, breakoutCount: 0,
                        lastBreakoutTime: 0, lastRecoveryTime: 0,
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
