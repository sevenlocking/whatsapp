// Serviço de Contatos - Armazenamento persistente em JSON
// MULTI-TENANT: Contatos são isolados por tenant (cliente)
require('dotenv').config();
const fs = require('fs');
const path = require('path');

// Caminho dos dados (usar variável de ambiente para Railway Volume)
// No Railway, configure DATA_PATH=/data (onde o volume está montado)
const DATA_DIR = process.env.DATA_PATH || path.join(__dirname, 'data');
const CONTACTS_FILE = path.join(DATA_DIR, 'contacts.json');

console.log(`📁 Diretório de dados (contatos): ${DATA_DIR}`);

// Garantir que a pasta data existe
function ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        console.log('📁 Pasta data criada:', DATA_DIR);
    }
}

// Carregar contatos do arquivo
function loadContacts() {
    ensureDataDir();
    try {
        if (fs.existsSync(CONTACTS_FILE)) {
            const data = fs.readFileSync(CONTACTS_FILE, 'utf-8');
            return JSON.parse(data);
        }
    } catch (error) {
        console.error('❌ Erro ao carregar contatos:', error.message);
    }
    return {};
}

// Salvar contatos no arquivo
function saveContacts(contacts) {
    ensureDataDir();
    try {
        fs.writeFileSync(CONTACTS_FILE, JSON.stringify(contacts, null, 2));
        console.log('💾 Contatos salvos');
    } catch (error) {
        console.error('❌ Erro ao salvar contatos:', error.message);
    }
}

/**
 * Adicionar ou atualizar contato
 * @param {string} ownerId - ID do tenant ou número do usuário (modo legado)
 * @param {string} name - Nome/apelido do contato
 * @param {string} pixKey - Chave PIX do contato
 * @param {string} pixKeyType - Tipo da chave (cpf, phone, email, cnpj, evp)
 */
function addContact(ownerId, name, pixKey, pixKeyType) {
    const contacts = loadContacts();

    // Normalizar nome para lowercase (para busca case-insensitive)
    const normalizedName = name.toLowerCase().trim();

    // Criar estrutura para owner se não existir
    if (!contacts[ownerId]) {
        contacts[ownerId] = {};
    }

    // Salvar contato
    contacts[ownerId][normalizedName] = {
        name: name.trim(), // Nome original (com capitalização)
        pixKey: pixKey,
        pixKeyType: pixKeyType.toLowerCase(),
        createdAt: new Date().toISOString()
    };

    saveContacts(contacts);

    console.log(`✅ Contato salvo [${ownerId}]: ${name} -> ${pixKey} (${pixKeyType})`);
    return contacts[ownerId][normalizedName];
}

/**
 * Buscar contato por nome
 * @param {string} ownerId - ID do tenant ou número do usuário (modo legado)
 * @param {string} name - Nome/apelido a buscar
 * @returns {object|null} Contato encontrado ou null
 */
function getContact(ownerId, name) {
    const contacts = loadContacts();

    if (!contacts[ownerId]) {
        return null;
    }

    // Busca case-insensitive
    const normalizedName = name.toLowerCase().trim();

    // Busca exata primeiro
    if (contacts[ownerId][normalizedName]) {
        return contacts[ownerId][normalizedName];
    }

    // Busca parcial (se o nome contém o termo)
    for (const [key, contact] of Object.entries(contacts[ownerId])) {
        if (key.includes(normalizedName) || contact.name.toLowerCase().includes(normalizedName)) {
            return contact;
        }
    }

    return null;
}

/**
 * Listar todos os contatos de um owner
 * @param {string} ownerId - ID do tenant ou número do usuário (modo legado)
 * @returns {array} Lista de contatos
 */
function listContacts(ownerId) {
    const contacts = loadContacts();

    if (!contacts[ownerId]) {
        return [];
    }

    // Converter objeto para array
    return Object.values(contacts[ownerId]);
}

/**
 * Remover contato
 * @param {string} ownerId - ID do tenant ou número do usuário (modo legado)
 * @param {string} name - Nome do contato a remover
 * @returns {boolean} Se removeu com sucesso
 */
function removeContact(ownerId, name) {
    const contacts = loadContacts();

    if (!contacts[ownerId]) {
        return false;
    }

    const normalizedName = name.toLowerCase().trim();

    if (contacts[ownerId][normalizedName]) {
        delete contacts[ownerId][normalizedName];
        saveContacts(contacts);
        console.log(`🗑️ Contato removido [${ownerId}]: ${name}`);
        return true;
    }

    return false;
}

/**
 * Verificar se um nome é um contato salvo
 * @param {string} ownerId - ID do tenant ou número do usuário (modo legado)
 * @param {string} text - Texto a verificar
 * @returns {object|null} Contato se encontrado
 */
function findContactInText(ownerId, text) {
    const contacts = loadContacts();

    if (!contacts[ownerId]) {
        return null;
    }

    const textLower = text.toLowerCase();

    // Procurar qualquer nome de contato no texto
    for (const [key, contact] of Object.entries(contacts[ownerId])) {
        // Verificar se o nome do contato aparece no texto
        if (textLower.includes(key) || textLower.includes(contact.name.toLowerCase())) {
            return contact;
        }
    }

    return null;
}

/**
 * Migrar contatos de um número de telefone para um tenant
 * Útil quando um usuário legado é convertido para tenant
 * @param {string} phoneNumber - Número de telefone antigo
 * @param {string} tenantId - ID do novo tenant
 */
function migrateContactsToTenant(phoneNumber, tenantId) {
    const contacts = loadContacts();

    if (!contacts[phoneNumber]) {
        console.log(`ℹ️ Nenhum contato para migrar de ${phoneNumber}`);
        return 0;
    }

    // Criar estrutura do tenant se não existir
    if (!contacts[tenantId]) {
        contacts[tenantId] = {};
    }

    // Copiar contatos (merge, não sobrescreve existentes)
    let migrated = 0;
    for (const [name, contact] of Object.entries(contacts[phoneNumber])) {
        if (!contacts[tenantId][name]) {
            contacts[tenantId][name] = contact;
            migrated++;
        }
    }

    // Remover contatos antigos do número
    delete contacts[phoneNumber];

    saveContacts(contacts);
    console.log(`📦 Migrados ${migrated} contatos de ${phoneNumber} para tenant ${tenantId}`);
    return migrated;
}

module.exports = {
    addContact,
    getContact,
    listContacts,
    removeContact,
    findContactInText,
    migrateContactsToTenant
};
