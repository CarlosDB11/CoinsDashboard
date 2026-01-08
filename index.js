const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');
const TelegramBot = require('node-telegram-bot-api');
const input = require('input');
const axios = require('axios');
const http = require('http');
const fs = require('fs');

// Suprimir logs verbosos de librerías
process.env.NTBA_FIX_319 = 1;
process.env.NTBA_FIX_350 = 1;

// Configurar axios para logs más limpios
axios.defaults.timeout = 10000;
axios.interceptors.request.use(
    config => config,
    error => {
        log(`Request error: ${error.message}`, "ERROR");
        return Promise.reject(error);
    }
);

axios.interceptors.response.use(
    response => response,
    error => {
        if (error.code !== 'ECONNABORTED') {
            log(`Response error: ${error.message}`, "ERROR");
        }
        return Promise.reject(error);
    }
);

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
const UPDATE_INTERVAL = 10000;  
const MIN_GROWTH_SHOW = 1.30;   
const LIST_HOLD_TIME = 15 * 60 * 1000; 

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
const bot = new TelegramBot(BOT_TOKEN, { 
    polling: true,
    request: {
        agentOptions: {
            keepAlive: true,
            family: 4
        }
    }
});

// Reducir logs verbosos del bot
bot.on('polling_error', (error) => {
    log(`Polling error: ${error.message}`, "ERROR");
});

// Suprimir logs excesivos de request
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '1';

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
// 1. GESTIÓN DE BASE DE DATOS
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
        `• <code>/top recovery</code> ➔ Ver mejores ganancias en Recovery.\n` +
        `• <code>/top global</code> ➔ Ver mejores ganancias de todo el bot.\n` +
        `• <code>/dashboard</code> ➔ Fuerza el envío o actualización del Dashboard.\n\n` +

        `<b>📋 MOSTRAR LISTAS COMPLETAS</b>\n` +
        `• <code>/viral</code> ➔ Mostrar lista completa Viral (top 10).\n` +
        `• <code>/recovery</code> ➔ Mostrar lista completa Recovery (top 10).\n` +
        `• <code>/stats</code> ➔ Ver estadísticas generales del bot.\n\n` +

        `<b>📡 RECREAR MENSAJES EN VIVO</b>\n` +
        `• <code>/dashboard</code> ➔ Recrear mensaje Dashboard en vivo.\n` +
        `• <code>/live_viral</code> ➔ Recrear mensaje Viral en vivo.\n` +
        `• <code>/live_recovery</code> ➔ Recrear mensaje Recovery en vivo.\n` +
        `• <code>/live_all</code> ➔ Recrear TODOS los mensajes en vivo.\n\n` +

        `<b>🧹 LIMPIEZA VISUAL (No borra datos)</b>\n` +
        `• <code>/clean viral</code> ➔ Elimina el mensaje de lista Viral del chat.\n` +
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

// COMANDO: MOSTRAR LISTA VIRAL
bot.onText(/[\/\.]viral/, async (msg) => {
    if (msg.chat.id !== DESTINATION_ID) return;
    
    const viralTokens = Object.values(activeTokens).filter(t => t.mentions.length >= 3);
    
    if (viralTokens.length === 0) {
        return bot.sendMessage(DESTINATION_ID, "🔥 <b>Lista Viral vacía</b>\n\n<i>No hay tokens con 3+ menciones actualmente.</i>", { parse_mode: 'HTML' });
    }

    // Ordenar por ganancia
    viralTokens.sort((a, b) => {
        const statsA = a.listStats ? a.listStats['viral'] : null;
        const statsB = b.listStats ? b.listStats['viral'] : null;
        const entryFdvA = statsA ? statsA.entryFdv : a.entryFdv;
        const entryFdvB = statsB ? statsB.entryFdv : b.entryFdv;
        const growthA = (a.currentFdv / entryFdvA - 1) * 100;
        const growthB = (b.currentFdv / entryFdvB - 1) * 100;
        return growthB - growthA;
    });

    const topTokens = viralTokens.slice(0, 10);
    let text = "🔥 <b>LISTA VIRAL COMPLETA</b> 🔥\n\n";
    
    topTokens.forEach((t, i) => {
        const stats = t.listStats ? t.listStats['viral'] : null;
        const entryFdv = stats ? stats.entryFdv : t.entryFdv;
        const growth = ((t.currentFdv / entryFdv - 1) * 100).toFixed(0);
        const trendIcon = parseFloat(growth) >= 0 ? '🟢' : '🔴';
        
        text += `${i + 1}. ${trendIcon} <b>${escapeHtml(t.symbol)}</b> (+${growth}%)\n`;
        text += `   💰 ${formatCurrency(entryFdv)} ➔ ${formatCurrency(t.currentFdv)}\n`;
        text += `   🗣 ${t.mentions.length} menciones\n\n`;
    });

    await bot.sendMessage(DESTINATION_ID, text, { parse_mode: 'HTML', disable_web_page_preview: true });
});

// COMANDO: MOSTRAR LISTA RECOVERY
bot.onText(/[\/\.]recovery/, async (msg) => {
    if (msg.chat.id !== DESTINATION_ID) return;
    
    const recoveryTokens = Object.values(activeTokens).filter(t => t.lastRecoveryTime > 0);
    
    if (recoveryTokens.length === 0) {
        return bot.sendMessage(DESTINATION_ID, "♻️ <b>Lista Recovery vacía</b>\n\n<i>No hay tokens en recuperación actualmente.</i>", { parse_mode: 'HTML' });
    }

    // Ordenar por tiempo de recovery más reciente
    recoveryTokens.sort((a, b) => b.lastRecoveryTime - a.lastRecoveryTime);

    const topTokens = recoveryTokens.slice(0, 10);
    let text = "♻️ <b>LISTA RECOVERY COMPLETA</b> ♻️\n\n";
    
    topTokens.forEach((t, i) => {
        const stats = t.listStats ? t.listStats['recovery'] : null;
        const entryFdv = stats ? stats.entryFdv : t.entryFdv;
        const growth = ((t.currentFdv / entryFdv - 1) * 100).toFixed(0);
        const trendIcon = parseFloat(growth) >= 0 ? '🟢' : '🔴';
        
        text += `${i + 1}. ${trendIcon} <b>${escapeHtml(t.symbol)}</b> (+${growth}%)\n`;
        text += `   💰 ${formatCurrency(entryFdv)} ➔ ${formatCurrency(t.currentFdv)}\n`;
        text += `   ⏰ Recovery: ${getTimeOnly(t.lastRecoveryTime)}\n\n`;
    });

    await bot.sendMessage(DESTINATION_ID, text, { parse_mode: 'HTML', disable_web_page_preview: true });
});

// COMANDO: ESTADÍSTICAS DE TOKENS EN SEGUIMIENTO
bot.onText(/[\/\.]stats/, async (msg) => {
    if (msg.chat.id !== DESTINATION_ID) return;
    
    const allTokens = Object.values(activeTokens);
    const viralCount = allTokens.filter(t => t.mentions.length >= 3).length;
    const recoveryCount = allTokens.filter(t => t.lastRecoveryTime > 0).length;
    const winnersCount = allTokens.filter(t => t.currentFdv > t.entryFdv).length;
    const losersCount = allTokens.filter(t => t.currentFdv < t.entryFdv).length;
    
    // Calcular MC total
    const totalMC = allTokens.reduce((sum, t) => sum + t.currentFdv, 0);
    
    // Token con mejor performance
    let bestToken = null;
    let bestGrowth = 0;
    allTokens.forEach(t => {
        const growth = (t.currentFdv / t.entryFdv - 1) * 100;
        if (growth > bestGrowth) {
            bestGrowth = growth;
            bestToken = t;
        }
    });

    let text = "📊 <b>ESTADÍSTICAS DEL BOT</b> 📊\n\n";
    text += `🎯 <b>Tokens en Seguimiento:</b> ${allTokens.length}\n`;
    text += `🔥 <b>En Lista Viral:</b> ${viralCount}\n`;
    text += `♻️ <b>En Lista Recovery:</b> ${recoveryCount}\n\n`;
    
    text += `📈 <b>Ganadores:</b> ${winnersCount} (${((winnersCount/allTokens.length)*100).toFixed(1)}%)\n`;
    text += `📉 <b>Perdedores:</b> ${losersCount} (${((losersCount/allTokens.length)*100).toFixed(1)}%)\n\n`;
    
    text += `💰 <b>MC Total Tracked:</b> ${formatCurrency(totalMC)}\n\n`;
    
    if (bestToken) {
        text += `🏆 <b>Mejor Performance:</b>\n`;
        text += `   ${escapeHtml(bestToken.symbol)} (+${bestGrowth.toFixed(0)}%)\n`;
        text += `   ${formatCurrency(bestToken.entryFdv)} ➔ ${formatCurrency(bestToken.currentFdv)}\n\n`;
    }
    
    text += `⚡ <i>Actualizado: ${new Date().toLocaleTimeString('es-CO', { timeZone: 'America/Bogota', hour12: false })}</i>`;

    await bot.sendMessage(DESTINATION_ID, text, { parse_mode: 'HTML', disable_web_page_preview: true });
});

// COMANDO: FORZAR MENSAJE EN VIVO DASHBOARD
bot.onText(/[\/\.]dashboard/, async (msg) => {
    if (msg.chat.id !== DESTINATION_ID) return;
    
    // Forzar recreación del dashboard
    dashboardMsgId = null;
    await updateDashboardMessage();
    log("Dashboard forzado por comando /dashboard", "INFO");
});

// COMANDO: FORZAR MENSAJE EN VIVO VIRAL
bot.onText(/[\/\.]live_viral/, async (msg) => {
    if (msg.chat.id !== DESTINATION_ID) return;
    
    const viralTokens = Object.values(activeTokens).filter(t => t.mentions.length >= 3);
    
    // Forzar recreación del mensaje en vivo
    liveListIds.viral = null;
    await updateLiveListMessage('viral', viralTokens, "VIRAL / HOT 🔥 (3+ Calls)", "🔥");
    log("Lista Viral en vivo forzada por comando /live_viral", "INFO");
    
    if (viralTokens.length === 0) {
        await bot.sendMessage(DESTINATION_ID, "ℹ️ Lista Viral recreada (vacía - no hay tokens con 3+ menciones)");
    } else {
        await bot.sendMessage(DESTINATION_ID, `✅ Lista Viral en vivo recreada con ${viralTokens.length} tokens`);
    }
});

// COMANDO: FORZAR MENSAJE EN VIVO RECOVERY
bot.onText(/[\/\.]live_recovery/, async (msg) => {
    if (msg.chat.id !== DESTINATION_ID) return;
    
    const recoveryTokens = Object.values(activeTokens).filter(t => {
        const now = Date.now();
        return t.lastRecoveryTime > 0 && (
            (t.isDipping && t.currentFdv >= (t.maxFdv * 0.90) && t.currentFdv < t.maxFdv) ||
            (now - t.lastRecoveryTime) < LIST_HOLD_TIME
        );
    });
    
    // Forzar recreación del mensaje en vivo
    liveListIds.recovery = null;
    await updateLiveListMessage('recovery', recoveryTokens, "RECUPERANDO / DIP EATER ♻️", "♻️");
    log("Lista Recovery en vivo forzada por comando /live_recovery", "INFO");
    
    if (recoveryTokens.length === 0) {
        await bot.sendMessage(DESTINATION_ID, "ℹ️ Lista Recovery recreada (vacía - no hay tokens en recuperación)");
    } else {
        await bot.sendMessage(DESTINATION_ID, `✅ Lista Recovery en vivo recreada con ${recoveryTokens.length} tokens`);
    }
});

// COMANDO: RECREAR TODAS LAS LISTAS EN VIVO
bot.onText(/[\/\.]live_all/, async (msg) => {
    if (msg.chat.id !== DESTINATION_ID) return;
    
    // Resetear todos los IDs para forzar recreación
    dashboardMsgId = null;
    liveListIds.viral = null;
    liveListIds.recovery = null;
    
    // Recrear todas las listas
    const viralTokens = Object.values(activeTokens).filter(t => t.mentions.length >= 3);
    const recoveryTokens = Object.values(activeTokens).filter(t => {
        const now = Date.now();
        return t.lastRecoveryTime > 0 && (
            (t.isDipping && t.currentFdv >= (t.maxFdv * 0.90) && t.currentFdv < t.maxFdv) ||
            (now - t.lastRecoveryTime) < LIST_HOLD_TIME
        );
    });
    
    await updateLiveListMessage('viral', viralTokens, "VIRAL / HOT 🔥 (3+ Calls)", "🔥");
    await updateLiveListMessage('recovery', recoveryTokens, "RECUPERANDO / DIP EATER ♻️", "♻️");
    await updateDashboardMessage();
    
    saveDB();
    log("Todas las listas en vivo recreadas por comando /live_all", "INFO");
    await bot.sendMessage(DESTINATION_ID, "✅ Todas las listas en vivo han sido recreadas");
});

// ==========================================
// 3. API DEXSCREENER
// ==========================================
async function getBatchDexData(addressesArray) {
    try {
        const url = `https://api.dexscreener.com/latest/dex/tokens/${addressesArray.join(',')}`;
        const res = await axios.get(url, { timeout: 8000 });
        return (res.data && res.data.pairs) ? res.data.pairs.filter(p => p.chainId === 'solana') : [];
    } catch (e) { 
        if (e.code !== 'ECONNABORTED') {
            log(`Error DexScreener Batch: ${e.message}`, "ERROR");
        }
        return []; 
    }
}

async function getSingleDexData(address) {
    try {
        const res = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${address}`, { timeout: 8000 });
        if (!res.data?.pairs?.length) return null;
        const pair = res.data.pairs.find(p => p.chainId === 'solana');
        return pair ? { 
            name: pair.baseToken.name, symbol: pair.baseToken.symbol, price: parseFloat(pair.priceUsd), fdv: pair.fdv, url: pair.url 
        } : null;
    } catch (e) { 
        if (e.code !== 'ECONNABORTED') {
            log(`Error DexScreener Single: ${e.message}`, "ERROR");
        }
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
