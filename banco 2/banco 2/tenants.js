// Serviço de gerenciamento de tenants (clientes multi-tenant)
require('dotenv').config();
const fs = require('fs');
const path = require('path');

// Caminho para o arquivo de tenants
const DATA_PATH = process.env.DATA_PATH || path.join(__dirname, 'data');
const TENANTS_FILE = path.join(DATA_PATH, 'tenants.json');

// Cache em memória para performance
let tenantsCache = null;
let phoneToTenantCache = new Map(); // Cache de número -> tenant para busca rápida

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
 * Carregar tenants do arquivo
 */
function loadTenants() {
    ensureDataDir();

    if (!fs.existsSync(TENANTS_FILE)) {
        // Criar arquivo vazio se não existe
        fs.writeFileSync(TENANTS_FILE, JSON.stringify({}, null, 2));
        console.log(`📁 Arquivo de tenants criado: ${TENANTS_FILE}`);
        tenantsCache = {};
        return {};
    }

    try {
        const data = fs.readFileSync(TENANTS_FILE, 'utf8');
        tenantsCache = JSON.parse(data);
        rebuildPhoneCache();
        return tenantsCache;
    } catch (error) {
        console.error('❌ Erro ao carregar tenants:', error.message);
        tenantsCache = {};
        return {};
    }
}

/**
 * Salvar tenants no arquivo
 */
function saveTenants() {
    ensureDataDir();

    try {
        fs.writeFileSync(TENANTS_FILE, JSON.stringify(tenantsCache, null, 2));
        rebuildPhoneCache();
        return true;
    } catch (error) {
        console.error('❌ Erro ao salvar tenants:', error.message);
        return false;
    }
}

/**
 * Reconstruir cache de número -> tenant
 */
function rebuildPhoneCache() {
    phoneToTenantCache.clear();

    if (!tenantsCache) return;

    for (const [tenantId, tenant] of Object.entries(tenantsCache)) {
        if (tenant.active && tenant.authorizedNumbers) {
            for (const phone of tenant.authorizedNumbers) {
                // Normalizar número (remover caracteres não numéricos)
                const cleanPhone = phone.replace(/\D/g, '');
                phoneToTenantCache.set(cleanPhone, { ...tenant, id: tenantId });
            }
        }
    }
}

/**
 * Normalizar número de telefone para comparação
 */
function normalizePhone(phone) {
    if (!phone) return '';
    return phone.replace(/\D/g, '');
}

/**
 * Buscar tenant pelo número de telefone
 * @param {string} phoneNumber - Número de telefone
 * @returns {object|null} - Tenant encontrado ou null
 */
function getTenantByPhone(phoneNumber) {
    if (!tenantsCache) loadTenants();

    const cleanPhone = normalizePhone(phoneNumber);

    // Busca no cache rápido
    if (phoneToTenantCache.has(cleanPhone)) {
        return phoneToTenantCache.get(cleanPhone);
    }

    // Busca com lógica de nono dígito (como em AUTHORIZED_NUMBERS)
    for (const [cachedPhone, tenant] of phoneToTenantCache.entries()) {
        // Comparação direta
        if (cachedPhone === cleanPhone) {
            return tenant;
        }

        // Comparação com nono dígito (55119 vs 5511)
        if (cleanPhone.length === 13 && cachedPhone.length === 12) {
            // Número com nono dígito vs sem
            const withoutNinthDigit = cleanPhone.slice(0, 4) + cleanPhone.slice(5);
            if (withoutNinthDigit === cachedPhone) {
                return tenant;
            }
        }

        if (cleanPhone.length === 12 && cachedPhone.length === 13) {
            // Número sem nono dígito vs com
            const withNinthDigit = cachedPhone.slice(0, 4) + cachedPhone.slice(5);
            if (withNinthDigit === cleanPhone) {
                return tenant;
            }
        }
    }

    return null;
}

/**
 * Buscar tenant pelo ID
 * @param {string} tenantId - ID do tenant
 * @returns {object|null} - Tenant encontrado ou null
 */
function getTenantById(tenantId) {
    if (!tenantsCache) loadTenants();

    const tenant = tenantsCache[tenantId];
    if (tenant) {
        return { ...tenant, id: tenantId };
    }
    return null;
}

/**
 * Listar todos os tenants
 * @returns {array} - Lista de tenants
 */
function listTenants() {
    if (!tenantsCache) loadTenants();

    return Object.entries(tenantsCache).map(([id, tenant]) => ({
        id,
        ...tenant
    }));
}

/**
 * Gerar ID único para tenant
 */
function generateTenantId() {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 8);
    return `tenant_${timestamp}${random}`;
}

/**
 * Criar novo tenant
 * @param {object} data - Dados do tenant
 * @returns {object} - Tenant criado
 */
function createTenant(data) {
    if (!tenantsCache) loadTenants();

    const { name, payzuToken, myPixKey, authorizedNumbers, allowedBots } = data;

    // Validações
    if (!name || !payzuToken) {
        throw new Error('Nome e token PayZu são obrigatórios');
    }

    // Verificar se algum número já está em uso por outro tenant
    if (authorizedNumbers && authorizedNumbers.length > 0) {
        for (const phone of authorizedNumbers) {
            const existingTenant = getTenantByPhone(phone);
            if (existingTenant) {
                throw new Error(`Número ${phone} já está em uso pelo cliente "${existingTenant.name}"`);
            }
        }
    }

    const tenantId = generateTenantId();
    const now = new Date().toISOString();

    const newTenant = {
        name: name.trim(),
        payzuToken: payzuToken.trim(),
        myPixKey: myPixKey ? myPixKey.trim() : null,
        authorizedNumbers: authorizedNumbers || [],
        allowedBots: allowedBots || [], // Bots permitidos (vazio = todos)
        active: true,
        createdAt: now,
        updatedAt: now
    };

    tenantsCache[tenantId] = newTenant;
    saveTenants();

    console.log(`✅ Tenant criado: ${name} (${tenantId})`);

    return { id: tenantId, ...newTenant };
}

/**
 * Atualizar tenant existente
 * @param {string} tenantId - ID do tenant
 * @param {object} data - Dados para atualizar
 * @returns {object} - Tenant atualizado
 */
function updateTenant(tenantId, data) {
    if (!tenantsCache) loadTenants();

    if (!tenantsCache[tenantId]) {
        throw new Error('Tenant não encontrado');
    }

    const { name, payzuToken, myPixKey, authorizedNumbers, allowedBots, active } = data;

    // Verificar se algum número novo já está em uso por outro tenant
    if (authorizedNumbers && authorizedNumbers.length > 0) {
        for (const phone of authorizedNumbers) {
            const existingTenant = getTenantByPhone(phone);
            if (existingTenant && existingTenant.id !== tenantId) {
                throw new Error(`Número ${phone} já está em uso pelo cliente "${existingTenant.name}"`);
            }
        }
    }

    // Atualizar apenas campos fornecidos
    if (name !== undefined) tenantsCache[tenantId].name = name.trim();
    if (payzuToken !== undefined) tenantsCache[tenantId].payzuToken = payzuToken.trim();
    if (myPixKey !== undefined) tenantsCache[tenantId].myPixKey = myPixKey ? myPixKey.trim() : null;
    if (authorizedNumbers !== undefined) tenantsCache[tenantId].authorizedNumbers = authorizedNumbers;
    if (allowedBots !== undefined) tenantsCache[tenantId].allowedBots = allowedBots;
    if (active !== undefined) tenantsCache[tenantId].active = active;

    tenantsCache[tenantId].updatedAt = new Date().toISOString();

    saveTenants();

    console.log(`✅ Tenant atualizado: ${tenantsCache[tenantId].name} (${tenantId})`);

    return { id: tenantId, ...tenantsCache[tenantId] };
}

/**
 * Deletar tenant
 * @param {string} tenantId - ID do tenant
 * @returns {boolean} - Sucesso
 */
function deleteTenant(tenantId) {
    if (!tenantsCache) loadTenants();

    if (!tenantsCache[tenantId]) {
        throw new Error('Tenant não encontrado');
    }

    const name = tenantsCache[tenantId].name;
    delete tenantsCache[tenantId];

    saveTenants();

    console.log(`🗑️ Tenant removido: ${name} (${tenantId})`);

    return true;
}

/**
 * Verificar se um número está autorizado (para qualquer tenant ativo)
 * @param {string} phoneNumber - Número de telefone
 * @returns {boolean}
 */
function isPhoneAuthorized(phoneNumber) {
    return getTenantByPhone(phoneNumber) !== null;
}

/**
 * Obter estatísticas dos tenants
 * @returns {object} - Estatísticas
 */
function getStats() {
    if (!tenantsCache) loadTenants();

    const tenants = Object.values(tenantsCache);
    const active = tenants.filter(t => t.active).length;
    const inactive = tenants.filter(t => !t.active).length;
    const totalNumbers = tenants.reduce((sum, t) => sum + (t.authorizedNumbers?.length || 0), 0);

    return {
        total: tenants.length,
        active,
        inactive,
        totalNumbers
    };
}

// Carregar tenants na inicialização
loadTenants();

module.exports = {
    getTenantByPhone,
    getTenantById,
    listTenants,
    createTenant,
    updateTenant,
    deleteTenant,
    isPhoneAuthorized,
    getStats,
    loadTenants,
    rebuildPhoneCache
};
