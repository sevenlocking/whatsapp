// Serviço de Transações - Armazenar relação transação ↔ usuário
require('dotenv').config();
const fs = require('fs');
const path = require('path');

// Caminho dos dados (usar variável de ambiente para Railway Volume)
// No Railway, configure DATA_PATH=/data (onde o volume está montado)
const DATA_DIR = process.env.DATA_PATH || path.join(__dirname, 'data');
const TRANSACTIONS_FILE = path.join(DATA_DIR, 'transactions.json');

// Cache em memória para acesso rápido
let transactionsCache = {};

// Cache de grupos de transferências (para comprovante único)
let transferGroupsCache = {};

// Garantir que a pasta data existe
function ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }
}

// Carregar transações do arquivo
function loadTransactions() {
    ensureDataDir();
    try {
        if (fs.existsSync(TRANSACTIONS_FILE)) {
            const data = fs.readFileSync(TRANSACTIONS_FILE, 'utf-8');
            transactionsCache = JSON.parse(data);
        }
    } catch (error) {
        console.error('❌ Erro ao carregar transações:', error.message);
        transactionsCache = {};
    }
    return transactionsCache;
}

// Salvar transações no arquivo
function saveTransactions() {
    ensureDataDir();
    try {
        fs.writeFileSync(TRANSACTIONS_FILE, JSON.stringify(transactionsCache, null, 2));
    } catch (error) {
        console.error('❌ Erro ao salvar transações:', error.message);
    }
}

// Inicializar cache
loadTransactions();

/**
 * Registrar uma nova transação
 * @param {string} transactionId - ID da transação (PayZu)
 * @param {string} phoneNumber - Número do usuário
 * @param {string} type - Tipo: 'pix_in' (receber) ou 'pix_out' (enviar)
 * @param {number} amount - Valor em centavos
 * @param {object} details - Detalhes adicionais
 */
function registerTransaction(transactionId, phoneNumber, type, amount, details = {}) {
    transactionsCache[transactionId] = {
        phoneNumber,
        type,
        amount,
        status: 'PENDING',
        createdAt: new Date().toISOString(),
        ...details
    };
    saveTransactions();
    console.log(`📝 Transação registrada: ${transactionId} → ${phoneNumber} (${type})`);
    return transactionsCache[transactionId];
}

/**
 * Buscar transação por ID
 * @param {string} transactionId - ID da transação
 */
function getTransaction(transactionId) {
    return transactionsCache[transactionId] || null;
}

/**
 * Atualizar status de uma transação
 * @param {string} transactionId - ID da transação
 * @param {string} status - Novo status
 * @param {object} webhookData - Dados do webhook
 */
function updateTransaction(transactionId, status, webhookData = {}) {
    if (!transactionsCache[transactionId]) {
        console.log(`⚠️ Transação não encontrada: ${transactionId}`);
        return null;
    }

    transactionsCache[transactionId] = {
        ...transactionsCache[transactionId],
        status,
        updatedAt: new Date().toISOString(),
        webhookData
    };
    saveTransactions();
    console.log(`✅ Transação atualizada: ${transactionId} → ${status}`);
    return transactionsCache[transactionId];
}

/**
 * Listar transações de um usuário
 * @param {string} phoneNumber - Número do usuário
 * @param {number} limit - Limite de resultados
 */
function listUserTransactions(phoneNumber, limit = 10) {
    const userTransactions = Object.entries(transactionsCache)
        .filter(([_, tx]) => tx.phoneNumber === phoneNumber)
        .sort((a, b) => new Date(b[1].createdAt) - new Date(a[1].createdAt))
        .slice(0, limit)
        .map(([id, tx]) => ({ id, ...tx }));

    return userTransactions;
}

/**
 * Buscar PIX recebidos por valor (para estorno)
 * @param {string} phoneNumber - Número do usuário
 * @param {number} amount - Valor em centavos (opcional)
 * @param {number} limit - Limite de resultados
 * @returns {array} - Lista de transações PIX In que podem ser estornadas
 */
function findRefundableTransactions(phoneNumber, amount = null, limit = 5) {
    const refundable = Object.entries(transactionsCache)
        .filter(([_, tx]) => {
            // Deve ser do usuário
            if (tx.phoneNumber !== phoneNumber) return false;
            // Deve ser PIX recebido (depósito)
            if (tx.type !== 'pix_in') return false;
            // Deve estar COMPLETED (pago)
            if (tx.status !== 'COMPLETED') return false;
            // Se especificou valor, filtrar por valor
            if (amount !== null && tx.amount !== amount) return false;
            // Não pode já ter sido estornado
            if (tx.refunded) return false;
            return true;
        })
        .sort((a, b) => new Date(b[1].createdAt) - new Date(a[1].createdAt))
        .slice(0, limit)
        .map(([id, tx]) => ({ id, ...tx }));

    return refundable;
}

/**
 * Marcar transação como estornada
 * @param {string} transactionId - ID da transação
 */
function markAsRefunded(transactionId) {
    if (!transactionsCache[transactionId]) {
        return null;
    }
    transactionsCache[transactionId].refunded = true;
    transactionsCache[transactionId].refundedAt = new Date().toISOString();
    saveTransactions();
    console.log(`↩️ Transação marcada como estornada: ${transactionId}`);
    return transactionsCache[transactionId];
}

/**
 * Limpar transações antigas (mais de 7 dias)
 */
function cleanOldTransactions() {
    const now = Date.now();
    const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
    let cleaned = 0;

    for (const [id, tx] of Object.entries(transactionsCache)) {
        const createdAt = new Date(tx.createdAt).getTime();
        if (now - createdAt > SEVEN_DAYS) {
            delete transactionsCache[id];
            cleaned++;
        }
    }

    if (cleaned > 0) {
        saveTransactions();
        console.log(`🧹 Limpou ${cleaned} transações antigas`);
    }
}

// Limpar transações antigas a cada hora
setInterval(cleanOldTransactions, 60 * 60 * 1000);

/**
 * Gerar ID único para clientReference
 */
function generateClientReference() {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 8);
    return `WF${timestamp}${random}`.toUpperCase();
}

/**
 * Criar grupo de transferências (para comprovante único)
 * @param {string} groupId - ID único do grupo (clientReference)
 * @param {string} phoneNumber - Número do usuário
 * @param {number} totalAmount - Valor total em centavos
 * @param {number} totalTransactions - Quantidade de transações no grupo
 * @param {object} details - Detalhes adicionais (pixKey, receiverName, etc)
 */
function createTransferGroup(groupId, phoneNumber, totalAmount, totalTransactions, details = {}) {
    transferGroupsCache[groupId] = {
        phoneNumber,
        totalAmount,
        totalTransactions,
        completedTransactions: 0,
        failedTransactions: 0,
        completedAmount: 0, // Valor total das transações que deram certo (centavos)
        failedAmount: 0, // Valor total das transações que falharam (centavos)
        transactionIds: [],
        failedIds: [], // IDs das transações que falharam
        status: 'PENDING',
        createdAt: new Date().toISOString(),
        ...details
    };
    console.log(`📦 Grupo de transferências criado: ${groupId} (${totalTransactions} transações)`);
    return transferGroupsCache[groupId];
}

/**
 * Adicionar transação a um grupo
 * @param {string} groupId - ID do grupo
 * @param {string} transactionId - ID da transação individual
 */
function addTransactionToGroup(groupId, transactionId) {
    if (!transferGroupsCache[groupId]) {
        console.log(`⚠️ Grupo não encontrado: ${groupId}`);
        return null;
    }
    transferGroupsCache[groupId].transactionIds.push(transactionId);
    console.log(`   ➕ Transação ${transactionId} adicionada ao grupo ${groupId}`);
    return transferGroupsCache[groupId];
}

/**
 * Marcar transação do grupo como completa
 * @param {string} groupId - ID do grupo
 * @param {number} amount - Valor da transação em centavos (opcional, para cálculo de valor parcial)
 * @returns {object|null} - Retorna o grupo se todas transações foram resolvidas, null caso contrário
 */
function markGroupTransactionComplete(groupId, amount = 0) {
    if (!transferGroupsCache[groupId]) {
        return null;
    }

    transferGroupsCache[groupId].completedTransactions++;
    if (amount > 0) {
        transferGroupsCache[groupId].completedAmount += amount;
    }
    const group = transferGroupsCache[groupId];

    const totalResolved = group.completedTransactions + group.failedTransactions;
    console.log(`   ✅ Grupo ${groupId}: ${group.completedTransactions}/${group.totalTransactions} completas (${group.failedTransactions} falhas)`);

    // Se todas as transações foram resolvidas (sucesso OU falha), retornar o grupo
    if (totalResolved >= group.totalTransactions) {
        if (group.failedTransactions === 0) {
            group.status = 'COMPLETED';
            console.log(`   🎉 Grupo ${groupId} COMPLETO! Gerar comprovante único.`);
        } else if (group.completedTransactions === 0) {
            group.status = 'FAILED';
            console.log(`   ❌ Grupo ${groupId} FALHOU! Todas transações falharam.`);
        } else {
            group.status = 'PARTIAL';
            console.log(`   ⚠️ Grupo ${groupId} PARCIAL! ${group.completedTransactions} OK, ${group.failedTransactions} falhas. Gerar comprovante parcial.`);
        }
        group.completedAt = new Date().toISOString();
        return group;
    }

    return null;
}

/**
 * Marcar transação do grupo como falha
 * @param {string} groupId - ID do grupo
 * @param {number} amount - Valor da transação que falhou em centavos
 * @param {string} transactionId - ID da transação que falhou (opcional)
 * @returns {object|null} - Retorna o grupo se todas transações foram resolvidas, null caso contrário
 */
function markGroupTransactionFailed(groupId, amount = 0, transactionId = null) {
    if (!transferGroupsCache[groupId]) {
        return null;
    }

    transferGroupsCache[groupId].failedTransactions++;
    if (amount > 0) {
        transferGroupsCache[groupId].failedAmount += amount;
    }
    if (transactionId) {
        transferGroupsCache[groupId].failedIds.push(transactionId);
    }
    const group = transferGroupsCache[groupId];

    const totalResolved = group.completedTransactions + group.failedTransactions;
    console.log(`   ❌ Grupo ${groupId}: falha registrada. ${group.completedTransactions}/${group.totalTransactions} OK, ${group.failedTransactions} falhas`);

    // Se todas as transações foram resolvidas (sucesso OU falha), retornar o grupo
    if (totalResolved >= group.totalTransactions) {
        if (group.completedTransactions === 0) {
            group.status = 'FAILED';
            console.log(`   ❌ Grupo ${groupId} FALHOU! Todas transações falharam.`);
        } else {
            group.status = 'PARTIAL';
            console.log(`   ⚠️ Grupo ${groupId} PARCIAL! ${group.completedTransactions} OK, ${group.failedTransactions} falhas. Gerar comprovante parcial.`);
        }
        group.completedAt = new Date().toISOString();
        return group;
    }

    return null;
}

/**
 * Buscar grupo por ID
 * @param {string} groupId - ID do grupo
 */
function getTransferGroup(groupId) {
    return transferGroupsCache[groupId] || null;
}

/**
 * Buscar grupo pelo ID de uma transação
 * @param {string} transactionId - ID da transação
 */
function getGroupByTransactionId(transactionId) {
    for (const [groupId, group] of Object.entries(transferGroupsCache)) {
        if (group.transactionIds.includes(transactionId)) {
            return { groupId, ...group };
        }
    }
    return null;
}

module.exports = {
    registerTransaction,
    getTransaction,
    updateTransaction,
    listUserTransactions,
    cleanOldTransactions,
    // Estorno
    findRefundableTransactions,
    markAsRefunded,
    // Grupos de transferências
    generateClientReference,
    createTransferGroup,
    addTransactionToGroup,
    markGroupTransactionComplete,
    markGroupTransactionFailed,
    getTransferGroup,
    getGroupByTransactionId
};
