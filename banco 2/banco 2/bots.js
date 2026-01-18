// Serviço de gerenciamento de bots (múltiplos WhatsApp/marcas)
require('dotenv').config();
const fs = require('fs');
const path = require('path');

// Caminho para o arquivo de bots
const DATA_PATH = process.env.DATA_PATH || path.join(__dirname, 'data');
const BOTS_FILE = path.join(DATA_PATH, 'bots.json');

// Logos dos bots em base64
const PAYZU_LOGO = 'data:image/png;base64,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';
// Logo do PaySamba otimizada (~9KB) - moeda dourada com $
const PAYSAMBA_LOGO = require('./paysamba-logo');
const DEFAULT_LOGO = PAYZU_LOGO;

// Cache em memória
let botsCache = null;

/**
 * Garantir que o diretório de dados existe
 */
function ensureDataDir() {
    if (!fs.existsSync(DATA_PATH)) {
        fs.mkdirSync(DATA_PATH, { recursive: true });
        console.log(`📁 Diretório de dados criado: ${DATA_PATH}`);
    }
}

/**
 * Carregar bots do arquivo
 */
function loadBots() {
    ensureDataDir();

    if (!fs.existsSync(BOTS_FILE)) {
        // Criar com bots padrão se não existe
        const defaultBots = {
            payzu: {
                name: 'PayZu',
                whatsappNumber: 'SEU_NUMERO_AQUI',
                brandLogoBase64: DEFAULT_LOGO,
                brandPrimaryColor: '#14ce71',
                brandName: 'PayZu',
                zapiInstance: process.env.ZAPI_INSTANCE || '',
                zapiToken: process.env.ZAPI_TOKEN || '',
                zapiClientToken: process.env.ZAPI_CLIENT_TOKEN || '',
                active: true,
                createdAt: new Date().toISOString()
            },
            paysamba: {
                name: 'PaySamba',
                whatsappNumber: 'SEU_NUMERO_AQUI',
                brandLogoBase64: PAYSAMBA_LOGO,
                brandPrimaryColor: '#FF6B00',
                brandName: 'PaySamba',
                zapiInstance: process.env.ZAPI_INSTANCE_PAYSAMBA || '',
                zapiToken: process.env.ZAPI_TOKEN_PAYSAMBA || '',
                zapiClientToken: process.env.ZAPI_CLIENT_TOKEN_PAYSAMBA || '',
                active: true,
                createdAt: new Date().toISOString()
            }
        };

        fs.writeFileSync(BOTS_FILE, JSON.stringify(defaultBots, null, 2));
        console.log(`📁 Arquivo de bots criado: ${BOTS_FILE}`);
        botsCache = defaultBots;
        return defaultBots;
    }

    try {
        const data = fs.readFileSync(BOTS_FILE, 'utf8');
        botsCache = JSON.parse(data);

        // Migração: adicionar PaySamba se não existir
        if (!botsCache.paysamba) {
            console.log('🔄 Migrando: adicionando bot PaySamba...');
            botsCache.paysamba = {
                name: 'PaySamba',
                whatsappNumber: 'SEU_NUMERO_AQUI',
                brandLogoBase64: PAYSAMBA_LOGO,
                brandPrimaryColor: '#FF6B00',
                brandName: 'PaySamba',
                zapiInstance: process.env.ZAPI_INSTANCE_PAYSAMBA || '',
                zapiToken: process.env.ZAPI_TOKEN_PAYSAMBA || '',
                zapiClientToken: process.env.ZAPI_CLIENT_TOKEN_PAYSAMBA || '',
                active: true,
                createdAt: new Date().toISOString()
            };
            fs.writeFileSync(BOTS_FILE, JSON.stringify(botsCache, null, 2));
            console.log('✅ Bot PaySamba adicionado com sucesso!');
        }

        // Migração: garantir que PaySamba usa a logo dourada (não a verde do PayZu)
        if (botsCache.paysamba && botsCache.paysamba.brandLogoBase64 !== PAYSAMBA_LOGO) {
            console.log('🔄 Migrando: atualizando logo do PaySamba para moeda dourada...');
            botsCache.paysamba.brandLogoBase64 = PAYSAMBA_LOGO;
            fs.writeFileSync(BOTS_FILE, JSON.stringify(botsCache, null, 2));
            console.log('✅ Logo do PaySamba atualizada (moeda dourada ~9KB)');
        }

        return botsCache;
    } catch (error) {
        console.error('❌ Erro ao carregar bots:', error.message);
        botsCache = {};
        return {};
    }
}

/**
 * Salvar bots no arquivo
 */
function saveBots() {
    ensureDataDir();

    try {
        fs.writeFileSync(BOTS_FILE, JSON.stringify(botsCache, null, 2));
        return true;
    } catch (error) {
        console.error('❌ Erro ao salvar bots:', error.message);
        return false;
    }
}

/**
 * Buscar bot pelo ID
 * @param {string} botId - ID do bot (ex: 'payzu', 'paysamba')
 * @returns {object|null} - Bot encontrado ou null
 */
function getBotById(botId) {
    if (!botsCache) loadBots();

    // Normalizar ID para lowercase
    const normalizedId = (botId || 'payzu').toLowerCase();

    const bot = botsCache[normalizedId];
    if (bot && bot.active !== false) {
        return { ...bot, id: normalizedId };
    }

    // Fallback para PayZu se bot não encontrado
    if (normalizedId !== 'payzu' && botsCache['payzu']) {
        console.log(`⚠️ Bot "${botId}" não encontrado, usando PayZu como fallback`);
        return { ...botsCache['payzu'], id: 'payzu' };
    }

    return null;
}

/**
 * Listar todos os bots
 * @returns {array} - Lista de bots
 */
function listBots() {
    if (!botsCache) loadBots();

    return Object.entries(botsCache).map(([id, bot]) => ({
        id,
        ...bot
    }));
}

/**
 * Criar novo bot
 * @param {string} botId - ID único do bot
 * @param {object} data - Dados do bot
 * @returns {object} - Bot criado
 */
function createBot(botId, data) {
    if (!botsCache) loadBots();

    const normalizedId = botId.toLowerCase().replace(/[^a-z0-9]/g, '');

    if (botsCache[normalizedId]) {
        throw new Error(`Bot "${normalizedId}" já existe`);
    }

    const {
        name,
        whatsappNumber,
        brandLogoBase64,
        brandPrimaryColor,
        brandName,
        zapiInstance,
        zapiToken,
        zapiClientToken
    } = data;

    if (!name) {
        throw new Error('Nome do bot é obrigatório');
    }

    const newBot = {
        name: name.trim(),
        whatsappNumber: whatsappNumber || '',
        brandLogoBase64: brandLogoBase64 || DEFAULT_LOGO,
        brandPrimaryColor: brandPrimaryColor || '#14ce71',
        brandName: brandName || name.trim(),
        zapiInstance: zapiInstance || '',
        zapiToken: zapiToken || '',
        zapiClientToken: zapiClientToken || '',
        active: true,
        createdAt: new Date().toISOString()
    };

    botsCache[normalizedId] = newBot;
    saveBots();

    console.log(`✅ Bot criado: ${name} (${normalizedId})`);

    return { id: normalizedId, ...newBot };
}

/**
 * Atualizar bot existente
 * @param {string} botId - ID do bot
 * @param {object} data - Dados para atualizar
 * @returns {object} - Bot atualizado
 */
function updateBot(botId, data) {
    if (!botsCache) loadBots();

    const normalizedId = botId.toLowerCase();

    if (!botsCache[normalizedId]) {
        throw new Error('Bot não encontrado');
    }

    const {
        name,
        whatsappNumber,
        brandLogoBase64,
        brandPrimaryColor,
        brandName,
        zapiInstance,
        zapiToken,
        zapiClientToken,
        active
    } = data;

    // Atualizar apenas campos fornecidos
    if (name !== undefined) botsCache[normalizedId].name = name.trim();
    if (whatsappNumber !== undefined) botsCache[normalizedId].whatsappNumber = whatsappNumber;
    if (brandLogoBase64 !== undefined) botsCache[normalizedId].brandLogoBase64 = brandLogoBase64;
    if (brandPrimaryColor !== undefined) botsCache[normalizedId].brandPrimaryColor = brandPrimaryColor;
    if (brandName !== undefined) botsCache[normalizedId].brandName = brandName;
    if (zapiInstance !== undefined) botsCache[normalizedId].zapiInstance = zapiInstance;
    if (zapiToken !== undefined) botsCache[normalizedId].zapiToken = zapiToken;
    if (zapiClientToken !== undefined) botsCache[normalizedId].zapiClientToken = zapiClientToken;
    if (active !== undefined) botsCache[normalizedId].active = active;

    botsCache[normalizedId].updatedAt = new Date().toISOString();

    saveBots();

    console.log(`✅ Bot atualizado: ${botsCache[normalizedId].name} (${normalizedId})`);

    return { id: normalizedId, ...botsCache[normalizedId] };
}

/**
 * Deletar bot
 * @param {string} botId - ID do bot
 * @returns {boolean} - Sucesso
 */
function deleteBot(botId) {
    if (!botsCache) loadBots();

    const normalizedId = botId.toLowerCase();

    if (!botsCache[normalizedId]) {
        throw new Error('Bot não encontrado');
    }

    if (normalizedId === 'payzu') {
        throw new Error('Não é possível deletar o bot PayZu padrão');
    }

    const name = botsCache[normalizedId].name;
    delete botsCache[normalizedId];

    saveBots();

    console.log(`🗑️ Bot removido: ${name} (${normalizedId})`);

    return true;
}

/**
 * Obter branding do bot para comprovantes
 * @param {string} botId - ID do bot
 * @returns {object} - Dados de branding
 */
function getBotBranding(botId) {
    const bot = getBotById(botId);

    if (!bot) {
        return {
            name: 'PayZu',
            logoBase64: DEFAULT_LOGO,
            primaryColor: '#14ce71'
        };
    }

    return {
        name: bot.brandName || bot.name,
        logoBase64: bot.brandLogoBase64 || DEFAULT_LOGO,
        primaryColor: bot.brandPrimaryColor || '#14ce71'
    };
}

/**
 * Obter credenciais Z-API do bot
 * @param {string} botId - ID do bot
 * @returns {object} - Credenciais Z-API
 */
function getBotZapiCredentials(botId) {
    const bot = getBotById(botId);
    const normalizedId = (botId || 'payzu').toLowerCase();

    // Determinar variáveis de ambiente baseado no bot
    let envInstance, envToken, envClientToken;

    if (normalizedId === 'paysamba') {
        envInstance = process.env.ZAPI_INSTANCE_PAYSAMBA;
        envToken = process.env.ZAPI_TOKEN_PAYSAMBA;
        envClientToken = process.env.ZAPI_CLIENT_TOKEN_PAYSAMBA;
        console.log(`🔧 PaySamba ENV - Instance: ${envInstance?.substring(0, 10)}..., Token: ${envToken?.substring(0, 10)}...`);
    } else {
        envInstance = process.env.ZAPI_INSTANCE;
        envToken = process.env.ZAPI_TOKEN;
        envClientToken = process.env.ZAPI_CLIENT_TOKEN;
    }

    const result = {
        instance: envInstance || '',
        token: envToken || '',
        clientToken: envClientToken || ''
    };

    // Se o bot existe no JSON e tem valores, usar eles
    if (bot) {
        if (bot.zapiInstance) result.instance = bot.zapiInstance;
        if (bot.zapiToken) result.token = bot.zapiToken;
        if (bot.zapiClientToken) result.clientToken = bot.zapiClientToken;
    }

    console.log(`🔧 ${normalizedId} FINAL - Instance: ${result.instance?.substring(0, 10)}...`);

    return result;
}

// Carregar bots na inicialização
loadBots();

module.exports = {
    getBotById,
    listBots,
    createBot,
    updateBot,
    deleteBot,
    getBotBranding,
    getBotZapiCredentials,
    loadBots,
    DEFAULT_LOGO
};
