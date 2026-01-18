const db = require('./db');

const transactionsMeta = new Map();
const transferGroupsCache = {};

function normalizeAmountToDecimal(amountInCents) {
    return parseFloat((amountInCents / 100).toFixed(2));
}

function generateClientReference() {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 8);
    return `CPX${timestamp}${random}`.toUpperCase();
}

async function registerTransaction(transactionId, phoneNumber, type, amount, details = {}) {
    const createdAt = new Date();
    const amountDecimal = normalizeAmountToDecimal(amount);

    transactionsMeta.set(transactionId, {
        phoneNumber,
        type,
        amount,
        status: 'PENDING',
        createdAt: createdAt.toISOString(),
        ...details
    });

    if (type === 'pix_in') {
        await db.query(
            `INSERT INTO pagamentos (
                chatid,
                idpagador,
                valor,
                tokenuser,
                identifier,
                paymentLinkID,
                brCode,
                status,
                nome_cliente,
                email_cliente,
                Doc,
                data_criacao,
                data_atualizacao,
                resgatado,
                endtoend,
                saldo_antes,
                saldo_depois
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                phoneNumber,
                details.idpagador || null,
                amountDecimal,
                details.tokenuser || null,
                transactionId,
                details.paymentLinkID || null,
                details.brCode || details.qrCodeText || null,
                'PENDING',
                details.payerName || null,
                details.payerEmail || null,
                details.payerDocument || null,
                createdAt,
                createdAt,
                0,
                details.endToEndId || null,
                details.saldoAntes || null,
                details.saldoDepois || null
            ]
        );
    } else if (type === 'pix_out') {
        await db.query(
            `INSERT INTO saques_pix (
                chatid,
                tokenuser,
                value,
                valorbruto,
                taxa,
                name,
                pixKey,
                bank,
                saldoantes,
                saldodepois,
                created_at,
                resgatado,
                cpf_cnpj,
                status,
                txid,
                end_to_end_id,
                agencia,
                conta,
                data_pagamento,
                cancel_reason
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                phoneNumber,
                details.tokenuser || null,
                amountDecimal,
                amountDecimal,
                details.taxa || null,
                details.receiverName || null,
                details.pixKey || null,
                details.bank || null,
                details.saldoAntes || null,
                details.saldoDepois || null,
                createdAt,
                0,
                details.cpfCnpj || null,
                'PENDING',
                transactionId,
                details.endToEndId || null,
                details.agencia || null,
                details.conta || null,
                null,
                null
            ]
        );
    }

    return transactionsMeta.get(transactionId);
}

async function getTransaction(transactionId) {
    if (transactionsMeta.has(transactionId)) {
        return transactionsMeta.get(transactionId);
    }

    const pagamentoRows = await db.query(
        'SELECT chatid, status, valor, identifier FROM pagamentos WHERE identifier = ? LIMIT 1',
        [transactionId]
    );

    if (pagamentoRows.length > 0) {
        const row = pagamentoRows[0];
        const transaction = {
            phoneNumber: row.chatid,
            type: 'pix_in',
            amount: Math.round(parseFloat(row.valor) * 100),
            status: row.status || 'PENDING'
        };
        transactionsMeta.set(transactionId, transaction);
        return transaction;
    }

    const saqueRows = await db.query(
        'SELECT chatid, status, value, txid FROM saques_pix WHERE txid = ? LIMIT 1',
        [transactionId]
    );

    if (saqueRows.length > 0) {
        const row = saqueRows[0];
        const transaction = {
            phoneNumber: row.chatid,
            type: 'pix_out',
            amount: Math.round(parseFloat(row.value) * 100),
            status: row.status || 'PENDING'
        };
        transactionsMeta.set(transactionId, transaction);
        return transaction;
    }

    return null;
}

async function updateTransaction(transactionId, status, webhookData = {}) {
    const updatedAt = new Date();
    const endToEndId = webhookData.endToEndId || webhookData.end_to_end_id || null;

    const pagamentoRows = await db.query(
        'SELECT id FROM pagamentos WHERE identifier = ? LIMIT 1',
        [transactionId]
    );

    if (pagamentoRows.length > 0) {
        await db.query(
            `UPDATE pagamentos
             SET status = ?, data_atualizacao = ?, endtoend = COALESCE(?, endtoend)
             WHERE identifier = ?`,
            [status, updatedAt, endToEndId, transactionId]
        );
    } else {
        await db.query(
            `UPDATE saques_pix
             SET status = ?, data_pagamento = CASE WHEN ? = 'COMPLETED' THEN ? ELSE data_pagamento END,
                 end_to_end_id = COALESCE(?, end_to_end_id)
             WHERE txid = ?`,
            [status, status, updatedAt, endToEndId, transactionId]
        );
    }

    const existing = transactionsMeta.get(transactionId) || {};
    const updated = {
        ...existing,
        status,
        updatedAt: updatedAt.toISOString(),
        webhookData
    };
    transactionsMeta.set(transactionId, updated);
    return updated;
}

async function listUserTransactions(phoneNumber, limit = 10) {
    const pagamentos = await db.query(
        `SELECT identifier AS id, status, valor, data_criacao AS createdAt, 'pix_in' AS type
         FROM pagamentos
         WHERE chatid = ?
         ORDER BY data_criacao DESC
         LIMIT ?`,
        [phoneNumber, limit]
    );

    const saques = await db.query(
        `SELECT txid AS id, status, value AS valor, created_at AS createdAt, 'pix_out' AS type
         FROM saques_pix
         WHERE chatid = ?
         ORDER BY created_at DESC
         LIMIT ?`,
        [phoneNumber, limit]
    );

    const combined = [...pagamentos, ...saques]
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .slice(0, limit)
        .map(entry => ({
            id: entry.id,
            type: entry.type,
            amount: Math.round(parseFloat(entry.valor) * 100),
            status: entry.status,
            createdAt: entry.createdAt
        }));

    return combined;
}

async function findRefundableTransactions(phoneNumber, amount = null, limit = 5) {
    const params = [phoneNumber];
    let amountFilter = '';
    if (amount !== null) {
        amountFilter = 'AND valor = ?';
        params.push(normalizeAmountToDecimal(amount));
    }
    params.push(limit);

    const rows = await db.query(
        `SELECT identifier AS id, valor, status, data_criacao AS createdAt, resgatado
         FROM pagamentos
         WHERE chatid = ?
           AND status = 'COMPLETED'
           AND resgatado = 0
           ${amountFilter}
         ORDER BY data_criacao DESC
         LIMIT ?`,
        params
    );

    return rows.map(row => ({
        id: row.id,
        phoneNumber,
        type: 'pix_in',
        amount: Math.round(parseFloat(row.valor) * 100),
        status: row.status,
        createdAt: row.createdAt,
        refunded: row.resgatado === 1
    }));
}

async function markAsRefunded(transactionId) {
    await db.query(
        'UPDATE pagamentos SET resgatado = 1 WHERE identifier = ?',
        [transactionId]
    );
    const existing = transactionsMeta.get(transactionId);
    if (existing) {
        existing.refunded = true;
        existing.refundedAt = new Date().toISOString();
        transactionsMeta.set(transactionId, existing);
        return existing;
    }
    return null;
}

function createTransferGroup(groupId, phoneNumber, totalAmount, totalTransactions, details = {}) {
    transferGroupsCache[groupId] = {
        phoneNumber,
        totalAmount,
        totalTransactions,
        completedTransactions: 0,
        failedTransactions: 0,
        completedAmount: 0,
        failedAmount: 0,
        transactionIds: [],
        failedIds: [],
        status: 'PENDING',
        createdAt: new Date().toISOString(),
        ...details
    };
    console.log(`📦 Grupo de transferências criado: ${groupId} (${totalTransactions} transações)`);
    return transferGroupsCache[groupId];
}

function addTransactionToGroup(groupId, transactionId) {
    if (!transferGroupsCache[groupId]) {
        console.log(`⚠️ Grupo não encontrado: ${groupId}`);
        return null;
    }
    transferGroupsCache[groupId].transactionIds.push(transactionId);
    console.log(`   ➕ Transação ${transactionId} adicionada ao grupo ${groupId}`);
    return transferGroupsCache[groupId];
}

function markGroupTransactionComplete(groupId, amount) {
    const group = transferGroupsCache[groupId];
    if (!group) return null;

    group.completedTransactions += 1;
    group.completedAmount += amount;

    if (group.completedTransactions + group.failedTransactions >= group.totalTransactions) {
        group.status = group.failedTransactions > 0 ? 'PARTIAL' : 'COMPLETED';
        return group;
    }
    return null;
}

function markGroupTransactionFailed(groupId, amount, transactionId) {
    const group = transferGroupsCache[groupId];
    if (!group) return null;

    group.failedTransactions += 1;
    group.failedAmount += amount;
    if (transactionId) {
        group.failedIds.push(transactionId);
    }

    if (group.completedTransactions + group.failedTransactions >= group.totalTransactions) {
        group.status = group.completedTransactions > 0 ? 'PARTIAL' : 'FAILED';
        return group;
    }
    return null;
}

module.exports = {
    registerTransaction,
    getTransaction,
    updateTransaction,
    listUserTransactions,
    findRefundableTransactions,
    markAsRefunded,
    generateClientReference,
    createTransferGroup,
    addTransactionToGroup,
    markGroupTransactionComplete,
    markGroupTransactionFailed
};
