// Carregar variáveis de ambiente do arquivo .env
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3001;

// Configurações - Token CREDPIX carregado do arquivo .env (modo legado)
const CREDPIX_TOKEN = process.env.CREDPIX_TOKEN;
const CREDPIX_BASE_URL = process.env.CREDPIX_BASE_URL || '';

// Números autorizados a usar o bot (separados por vírgula no .env)
const AUTHORIZED_NUMBERS = process.env.AUTHORIZED_NUMBERS
    ? process.env.AUTHORIZED_NUMBERS.split(',').map(n => n.trim())
    : [];

// IPs autorizados a acessar o painel admin (separados por vírgula no .env)
const ADMIN_ALLOWED_IPS = process.env.ADMIN_ALLOWED_IPS
    ? process.env.ADMIN_ALLOWED_IPS.split(',').map(ip => ip.trim())
    : [];

/**
 * Validar CPF brasileiro (algoritmo dos dígitos verificadores)
 * @param {string} cpf - CPF com 11 dígitos (apenas números)
 * @returns {boolean} - true se CPF válido, false se inválido
 */
function isValidCPF(cpf) {
    // Remover caracteres não numéricos
    cpf = cpf.replace(/\D/g, '');

    // Deve ter 11 dígitos
    if (cpf.length !== 11) return false;

    // CPFs com todos os dígitos iguais são inválidos
    if (/^(\d)\1{10}$/.test(cpf)) return false;

    // Validar primeiro dígito verificador
    let sum = 0;
    for (let i = 0; i < 9; i++) {
        sum += parseInt(cpf.charAt(i)) * (10 - i);
    }
    let remainder = (sum * 10) % 11;
    if (remainder === 10 || remainder === 11) remainder = 0;
    if (remainder !== parseInt(cpf.charAt(9))) return false;

    // Validar segundo dígito verificador
    sum = 0;
    for (let i = 0; i < 10; i++) {
        sum += parseInt(cpf.charAt(i)) * (11 - i);
    }
    remainder = (sum * 10) % 11;
    if (remainder === 10 || remainder === 11) remainder = 0;
    if (remainder !== parseInt(cpf.charAt(10))) return false;

    return true;
}

/**
 * Formatar valor monetário no padrão brasileiro (R$ 1.234,56)
 * @param {number} value - Valor em reais (pode ser float)
 * @returns {string} - Valor formatado
 */
function formatBRL(value) {
    return parseFloat(value).toLocaleString('pt-BR', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    });
}

async function getUserByChatId(chatid) {
    const rows = await db.query(
        `SELECT id, chatid, nome, saldo, limite_saque, reservado, user_token, platform_token, status
         FROM users
         WHERE chatid = ?
         LIMIT 1`,
        [chatid]
    );
    return rows[0] || null;
}

async function updateUserBalance(chatid, delta, reason = null) {
    const user = await getUserByChatId(chatid);
    if (!user) return null;

    const saldoAntes = parseFloat(user.saldo || 0);
    const saldoDepois = parseFloat((saldoAntes + delta).toFixed(2));

    await db.query(
        'UPDATE users SET saldo = ? WHERE chatid = ?',
        [saldoDepois, chatid]
    );

    return {
        saldoAntes,
        saldoDepois,
        reason
    };
}

/**
 * Middleware para restringir acesso ao painel admin por IP
 * Funciona com proxies (Railway, Heroku, etc) usando X-Forwarded-For
 */
function requireAdminIP(req, res, next) {
    // Se não há IPs configurados, permite acesso (desenvolvimento)
    if (ADMIN_ALLOWED_IPS.length === 0) {
        return next();
    }

    // Obter IP real do cliente (considerando proxies)
    const forwardedFor = req.headers['x-forwarded-for'];
    const realIP = forwardedFor
        ? forwardedFor.split(',')[0].trim()  // Primeiro IP da lista
        : req.connection.remoteAddress || req.socket.remoteAddress;

    // Normalizar IPv6 localhost para IPv4
    const normalizedIP = realIP === '::1' ? '127.0.0.1' : realIP;

    // Verificar se o IP está na lista permitida
    const isAllowed = ADMIN_ALLOWED_IPS.some(allowedIP => {
        // Suporte a CIDR básico ou IP exato
        if (allowedIP.includes('/')) {
            // Por simplicidade, só verifica prefixo para /24, /16, /8
            const [baseIP, mask] = allowedIP.split('/');
            const maskBits = parseInt(mask);
            const baseParts = baseIP.split('.').map(Number);
            const ipParts = normalizedIP.split('.').map(Number);

            if (maskBits === 24) return baseParts.slice(0, 3).join('.') === ipParts.slice(0, 3).join('.');
            if (maskBits === 16) return baseParts.slice(0, 2).join('.') === ipParts.slice(0, 2).join('.');
            if (maskBits === 8) return baseParts[0] === ipParts[0];
            return false;
        }
        return normalizedIP === allowedIP || realIP === allowedIP;
    });

    if (!isAllowed) {
        console.warn(`🚫 Acesso admin bloqueado - IP: ${normalizedIP} (original: ${realIP})`);
        return res.status(403).json({
            error: 'Acesso negado',
            message: 'Seu IP não está autorizado a acessar o painel admin'
        });
    }

    // IP permitido
    console.log(`Acesso admin permitido - IP: ${normalizedIP}`);
    next();
}

// Nota: MULTI_TENANT_MODE é verificado após importar tenantService (mais abaixo)

// Middlewares
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // Para webhooks
app.use(require('cookie-parser')()); // Para sessões admin
app.use(express.static(path.join(__dirname)));

// Importar serviços WhatsApp, IA, Contatos, Mídia, Transações e Comprovantes
const whatsappService = require('./whatsapp-zapi');
const aiService = require('./ai-chat');
const contactsService = require('./contacts');
const mediaService = require('./media-service');
const transactionsService = require('./transactions');
const db = require('./db');
const receiptGenerator = require('./receipt-generator');

// Importar serviços Multi-Tenant, Autenticação Admin e Bots
const tenantService = require('./tenants');
const adminAuth = require('./admin-auth');
const botService = require('./bots');

// Middleware para parsing de cookies (necessário para sessões admin)
const cookieParser = require('cookie-parser');

// Verificar modo de operação (multi-tenant ou single-tenant)
const MULTI_TENANT_MODE = tenantService.listTenants().length > 0;

if (MULTI_TENANT_MODE) {
    console.log('\n🏢 MODO MULTI-TENANT ATIVO');
    const stats = tenantService.getStats();
    console.log(`   Clientes cadastrados: ${stats.total} (${stats.active} ativos)`);
    console.log(`   Números autorizados: ${stats.totalNumbers}`);
} else {
    // Modo single-tenant (legado) - requer CREDPIX_TOKEN no .env
    if (!CREDPIX_TOKEN) {
        console.warn('\n AVISO: Nenhum cliente cadastrado e CREDPIX_TOKEN não configurado!');
        console.warn('   Acesse /admin para cadastrar clientes ou configure CREDPIX_TOKEN no .env.\n');
    } else {
        console.log('\nMODO SINGLE-TENANT (legado)');
        console.log('   Usando CREDPIX_TOKEN do .env');

        // Avisar se não há números autorizados configurados
        if (AUTHORIZED_NUMBERS.length === 0) {
            console.warn('   Nenhum número autorizado configurado!');
            console.warn('   Qualquer pessoa poderá usar o bot.');
        } else {
            console.log('   Números autorizados:', AUTHORIZED_NUMBERS.length);
        }
    }
}

// URL base para callbacks (Railway ou localhost)
const BASE_URL = process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : `http://localhost:${PORT}`;

console.log(`📡 URL de Callback: ${BASE_URL}/webhook/credpix`);

// Armazenar contexto de imagens pendentes (quando usuário manda foto e depois valor)
// Formato: { phoneNumber: { pixKey, pixKeyType, timestamp } }
const pendingImageTransfers = new Map();

// Armazenar comandos de áudio pendentes de confirmação
// Formato: { phoneNumber: { transcription, command, timestamp } }
const pendingAudioCommands = new Map();

// Armazenar transferências PIX pendentes de confirmação manual
// Formato: { phoneNumber: { command, timestamp } }
const pendingWithdrawConfirmations = new Map();

// Armazenar estornos pendentes de confirmação
// Formato: { phoneNumber: { transaction, timestamp } }
const pendingRefundConfirmations = new Map();

// Armazenar confirmações de CPF/telefone pendentes
// Formato: { phoneNumber: { command, timestamp } }
const pendingCPFConfirmations = new Map();

// Armazenar últimos códigos PIX gerados (para botão "reenviar código")
// Formato: { phoneNumber: { pixCode, timestamp } }
const lastGeneratedPixCodes = new Map();

// Limpar contextos após 5 minutos
setInterval(() => {
    const now = Date.now();
    const TIMEOUT = 5 * 60 * 1000; // 5 minutos

    for (const [phone, data] of pendingImageTransfers.entries()) {
        if (now - data.timestamp > TIMEOUT) {
            pendingImageTransfers.delete(phone);
            console.log(`🧹 Limpou contexto de imagem pendente de: ${phone}`);
        }
    }

    for (const [phone, data] of pendingAudioCommands.entries()) {
        if (now - data.timestamp > TIMEOUT) {
            pendingAudioCommands.delete(phone);
            console.log(`🧹 Limpou comando de áudio pendente de: ${phone}`);
        }
    }

    for (const [phone, data] of pendingWithdrawConfirmations.entries()) {
        if (now - data.timestamp > TIMEOUT) {
            pendingWithdrawConfirmations.delete(phone);
            console.log(`🧹 Limpou confirmação de PIX pendente de: ${phone}`);
        }
    }

    for (const [phone, data] of pendingRefundConfirmations.entries()) {
        if (now - data.timestamp > TIMEOUT) {
            pendingRefundConfirmations.delete(phone);
            console.log(`🧹 Limpou confirmação de estorno pendente de: ${phone}`);
        }
    }

    for (const [phone, data] of pendingCPFConfirmations.entries()) {
        if (now - data.timestamp > TIMEOUT) {
            pendingCPFConfirmations.delete(phone);
            console.log(`🧹 Limpou confirmação de CPF/telefone pendente de: ${phone}`);
        }
    }

    // Códigos PIX expiram em 24 horas
    const PIX_TIMEOUT = 24 * 60 * 60 * 1000;
    for (const [phone, data] of lastGeneratedPixCodes.entries()) {
        if (now - data.timestamp > PIX_TIMEOUT) {
            lastGeneratedPixCodes.delete(phone);
            console.log(`🧹 Limpou código PIX expirado de: ${phone}`);
        }
    }
}, 60 * 1000);

// ========== WEBHOOK WHATSAPP (Z-API) ==========

// Webhook para receber mensagens do WhatsApp via Z-API
app.post('/webhook/whatsapp', async (req, res) => {
    try {
        // Responder imediatamente para não deixar Z-API esperando
        res.status(200).send('OK');

        // ========== IDENTIFICAÇÃO DO BOT ==========
        // O bot é identificado via query parameter: /webhook/whatsapp?bot=credpix
        const botId = req.query.bot || 'credpix'; // Default para CREDPIX
        const currentBot = botService.getBotById(botId);

        if (!currentBot) {
            console.log(`\n🚫 Bot não encontrado: ${botId}`);
            return;
        }

        // Obter credenciais Z-API do bot e branding
        const zapiCredentials = botService.getBotZapiCredentials(botId);
        const botBranding = botService.getBotBranding(botId);

        // Helpers locais que já incluem as credenciais do bot atual
        const sendMessage = (to, msg) => whatsappService.sendMessage(to, msg, zapiCredentials);
        const sendImage = (to, img, caption) => whatsappService.sendImage(to, img, caption, zapiCredentials);
        const sendButtons = (to, msg, btns) => whatsappService.sendButtons(to, msg, btns, zapiCredentials);

        console.log(`\n🤖 BOT: ${currentBot.name} (${botId})`);
        console.log(`Z-API Instance: ${zapiCredentials.instance?.substring(0, 10)}...`);

        // Log completo do payload para debug
        console.log('🔍 DEBUG - Payload recebido:', JSON.stringify(req.body, null, 2));

        // Z-API pode enviar em diferentes formatos, vamos tratar todos
        let phoneNumber;
        let message;
        let audioUrl = null;
        let imageUrl = null;

        // Formato 1: { phone: "5511...", text: { message: "..." } }
        if (req.body.phone && req.body.text) {
            phoneNumber = req.body.phone;
            message = req.body.text.message || req.body.text;
        }
        // Formato 2: { from: "5511...", body: "..." }
        else if (req.body.from && req.body.body) {
            phoneNumber = req.body.from;
            message = req.body.body;
        }
        // Formato 3: evento de mensagem recebida
        else if (req.body.data) {
            phoneNumber = req.body.data.phone || req.body.data.from;
            message = req.body.data.text?.message || req.body.data.body || req.body.data.message;
        }
        // Formato 4: direto no root
        else if (req.body.message) {
            phoneNumber = req.body.sender || req.body.from;
            message = req.body.message;
        }

        // Formato 5: Resposta de BOTÃO - Z-API envia em vários formatos possíveis
        const buttonResponse = req.body.buttonResponseMessage ||
                               req.body.buttonsResponseMessage ||
                               req.body.data?.buttonResponseMessage ||
                               req.body.data?.buttonsResponseMessage ||
                               req.body.button ||
                               req.body.data?.button;

        if (buttonResponse) {
            phoneNumber = phoneNumber || req.body.phone || req.body.data?.phone;
            // O texto do botão clicado - Z-API usa campo "message"
            message = buttonResponse.message ||
                      buttonResponse.selectedDisplayText ||
                      buttonResponse.selectedButtonText ||
                      buttonResponse.title ||
                      buttonResponse.text ||
                      buttonResponse.buttonId ||
                      buttonResponse.selectedButtonId ||
                      buttonResponse.id;
            console.log('🔘 BOTÃO CLICADO - Texto extraído:', message);
        }

        // Formato 6: Resposta de LISTA - Z-API envia listResponseMessage
        const listResponse = req.body.listResponseMessage ||
                            req.body.data?.listResponseMessage;

        if (listResponse) {
            phoneNumber = phoneNumber || req.body.phone || req.body.data?.phone;
            message = listResponse.title ||
                      listResponse.selectedRowId ||
                      listResponse.description;
            console.log('LISTA SELECIONADA:', message);
        }

        // Formato 7: Verificar tipo de mensagem para botões
        const messageType = req.body.type || req.body.messageType || req.body.data?.type;
        if (messageType && messageType.toLowerCase().includes('button')) {
            console.log('🔘 TIPO DE MENSAGEM É BOTÃO:', messageType);
            console.log('🔘 PAYLOAD COMPLETO:', JSON.stringify(req.body, null, 2));
        }

        // Detectar ÁUDIO - Z-API envia em vários formatos
        // Verificar todos os possíveis locais onde o áudio pode estar
        const audioObject = req.body.audio || req.body.data?.audio ||
                           (req.body.message?.audio) ||
                           (req.body.messageType === 'audio' ? req.body : null);

        if (audioObject) {
            audioUrl = audioObject.audioUrl || audioObject.url || audioObject.mediaUrl;
            phoneNumber = phoneNumber || req.body.phone || req.body.data?.phone;
            console.log('🎤 ÁUDIO DETECTADO:', JSON.stringify(audioObject, null, 2));
            console.log('🔗 Audio URL extraída:', audioUrl);
        }

        // Também verificar pelo tipo da mensagem
        if (!audioUrl && (req.body.type === 'audio' || req.body.messageType === 'audio' ||
            req.body.data?.type === 'audio' || req.body.data?.messageType === 'audio')) {
            // Tentar encontrar a URL em outros lugares
            audioUrl = req.body.url || req.body.mediaUrl ||
                      req.body.data?.url || req.body.data?.mediaUrl;
            console.log('🎤 ÁUDIO por tipo, URL:', audioUrl);
        }

        // Detectar IMAGEM - Z-API envia em vários formatos
        if (req.body.image) {
            imageUrl = req.body.image.imageUrl || req.body.image.url;
            phoneNumber = phoneNumber || req.body.phone;
            // Imagem pode ter legenda
            message = req.body.image.caption || message;
        } else if (req.body.data?.image) {
            imageUrl = req.body.data.image.imageUrl || req.body.data.image.url;
            phoneNumber = phoneNumber || req.body.data.phone;
            message = req.body.data.image.caption || message;
        }

        // Validar se temos pelo menos o número
        if (!phoneNumber) {
            console.log('Número não encontrado no webhook. Ignorando...');
            return;
        }

        // Validar se temos algum conteúdo (texto, áudio ou imagem)
        if (!message && !audioUrl && !imageUrl) {
            console.log('Nenhum conteúdo (texto/áudio/imagem) no webhook. Ignorando...');
            return;
        }

        console.log(`\nMensagem recebida de: ${phoneNumber}`);
        console.log(`💬 Conteúdo: ${message}`);

        // CONTROLE DE ACESSO - Multi-tenant ou Single-tenant (legado)
        let currentTenant = null;
        let currentCredpixToken = null;
        let currentPixKey = null;

        // Tentar buscar tenant pelo número
        currentTenant = tenantService.getTenantByPhone(phoneNumber);

        if (currentTenant) {
            // Multi-tenant: usar credenciais do tenant
            if (!currentTenant.active) {
                console.log(`\n🚫 Cliente INATIVO: ${currentTenant.name}`);
                return;
            }

            // Verificar se o cliente tem permissão para usar este bot
            if (currentTenant.allowedBots && currentTenant.allowedBots.length > 0) {
                if (!currentTenant.allowedBots.includes(botId)) {
                    console.log(`\n🚫 Cliente "${currentTenant.name}" não autorizado para bot ${botId}`);
                    console.log(`   Bots permitidos: ${currentTenant.allowedBots.join(', ')}`);
                    return; // Ignora silenciosamente
                }
            }

            currentCredpixToken = currentTenant.platformToken;
            currentPixKey = currentTenant.myPixKey;
            console.log(`\n🏢 MULTI-TENANT: Cliente "${currentTenant.name}" (${currentTenant.id}) via bot ${botId}`);
        } else {
            // Modo legado: verificar AUTHORIZED_NUMBERS
            if (AUTHORIZED_NUMBERS.length > 0) {
                const cleanPhone = phoneNumber.replace(/\D/g, '');
                const isAuthorized = AUTHORIZED_NUMBERS.some(authorizedNumber => {
                    const cleanAuthorized = authorizedNumber.replace(/\D/g, '');
                    let match = cleanPhone.includes(cleanAuthorized) || cleanAuthorized.includes(cleanPhone);

                    // Verificar com/sem nono dígito
                    if (!match && cleanPhone.length >= 10 && cleanAuthorized.length >= 10) {
                        const phonePrefix = cleanPhone.substring(0, 4);
                        const authorizedPrefix = cleanAuthorized.substring(0, 4);
                        if (phonePrefix === authorizedPrefix) {
                            const phoneRest = cleanPhone.substring(4);
                            const authorizedRest = cleanAuthorized.substring(4);
                            if (phoneRest.startsWith('9') && phoneRest.substring(1) === authorizedRest) match = true;
                            else if (authorizedRest.startsWith('9') && authorizedRest.substring(1) === phoneRest) match = true;
                        }
                    }
                    return match;
                });

                if (!isAuthorized) {
                    console.log(`\n🚫 Acesso NEGADO - Número não autorizado: ${phoneNumber}`);
                    return;
                }
            } else if (!CREDPIX_TOKEN) {
                // Sem tenants, sem AUTHORIZED_NUMBERS e sem CREDPIX_TOKEN
                console.log(`\n🚫 Sem clientes cadastrados e sem CREDPIX_TOKEN configurado`);
                return;
            }

            // Modo legado: usar credenciais do .env
            currentCredpixToken = CREDPIX_TOKEN;
            currentPixKey = process.env.MY_PIX_KEY;
            console.log(`\nSINGLE-TENANT: Usando credenciais do .env`);
        }

        // ID do dono dos contatos (tenant ID ou phoneNumber para legado)
        const contactsOwnerId = currentTenant ? currentTenant.id : phoneNumber;

        // ========== VERIFICAR CONFIRMAÇÃO DE TRANSFERÊNCIA PIX PENDENTE ==========
        if (message && pendingWithdrawConfirmations.has(phoneNumber)) {
            const pending = pendingWithdrawConfirmations.get(phoneNumber);
            const msgLower = message.toLowerCase().trim();

            // Verificar se é confirmação (inclui resposta de botão)
            if (msgLower === 'sim' || msgLower === 's' || msgLower === 'y' || msgLower === 'yes' ||
                msgLower === 'confirmar' || msgLower === 'confirma' || msgLower === 'ok' ||
                msgLower === 'enviar' || msgLower === 'pode enviar' || msgLower === 'manda' || msgLower === 'envia' ||
                msgLower === 'sim, enviar' || msgLower.includes('sim, enviar')) {
                console.log(`Usuário confirmou transferência PIX`);
                pendingWithdrawConfirmations.delete(phoneNumber);

                await sendMessage(phoneNumber, 'Confirmado! Enviando PIX...');

                // Executar o comando salvo
                await executePixCommand(pending.command, phoneNumber, { contactsOwnerId, zapiCredentials, botBranding, botId });
                return;
            } else if (msgLower === 'não' || msgLower === 'nao' || msgLower === 'n' ||
                       msgLower === 'cancelar' || msgLower === 'cancela' || msgLower === 'não enviar' ||
                       msgLower === 'nao enviar' || msgLower === 'cancelar' || msgLower.includes('cancelar')) {
                console.log(`Usuário cancelou transferência PIX`);
                pendingWithdrawConfirmations.delete(phoneNumber);

                await sendMessage(phoneNumber, 'Transferência cancelada. Como posso ajudar?');
                return;
            }
            // Se não é confirmação nem cancelamento, PERGUNTAR NOVAMENTE (não cancelar!)
            console.log(`Resposta não reconhecida: "${msgLower}", perguntando novamente`);

            // Montar mensagem com detalhes da transferência pendente
            const valor = (pending.command.amount / 100).toFixed(2);
            let destino = '';
            if (pending.command.contactName) {
                destino = pending.command.contactName;
            } else if (pending.command.pixKey) {
                destino = pending.command.pixKey;
            }

            await sendButtons(phoneNumber,
                `Não entendi sua resposta.\n\n` +
                `*Transferência pendente:*\n` +
                `Valor: R$ ${valor}\n` +
                `Para: ${destino}`,
                [
                    { id: 'sim', label: '✅ Sim, enviar' },
                    { id: 'nao', label: '❌ Cancelar' }
                ]);
            return;
        }

        // ========== VERIFICAR CONFIRMAÇÃO DE ESTORNO PENDENTE ==========
        if (message && pendingRefundConfirmations.has(phoneNumber)) {
            const pending = pendingRefundConfirmations.get(phoneNumber);
            const msgLower = message.toLowerCase().trim();

            // Verificar se é seleção por número (1, 2, 3...) quando há lista de transações
            if (pending.transactionList && /^[1-9]$/.test(msgLower)) {
                const index = parseInt(msgLower) - 1;
                if (index >= 0 && index < pending.transactionList.length) {
                    const selectedTx = pending.transactionList[index];
                    const valor = (selectedTx.amount / 100).toFixed(2);
                    const data = new Date(selectedTx.createdAt).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });

                    // Atualizar pendência com a transação selecionada
                    pendingRefundConfirmations.set(phoneNumber, {
                        transaction: selectedTx,
                        refundAmount: pending.refundAmount,
                        timestamp: Date.now()
                    });

                    let confirmMsg = `🔍 *PIX selecionado para estorno:*\n\n` +
                        `Valor do PIX: *R$ ${valor}*\n`;

                    if (pending.refundAmount) {
                        confirmMsg += `Valor a estornar: *R$ ${(pending.refundAmount / 100).toFixed(2)}* _(parcial)_\n`;
                    }

                    confirmMsg += `📅 Data: ${data}\n` +
                        `ID: ${selectedTx.id}`;

                    await sendButtons(phoneNumber, confirmMsg, [
                        { id: 'sim', label: pending.refundAmount ? 'Estornar parcial' : 'Sim, estornar' },
                        { id: 'nao', label: '❌ Cancelar' }
                    ]);
                    return;
                }
            }

            // Verificar se é confirmação (inclui resposta de botão)
            if (msgLower === 'sim' || msgLower === 's' || msgLower === 'y' || msgLower === 'yes' ||
                msgLower === 'confirmar' || msgLower === 'confirma' || msgLower === 'ok' ||
                msgLower === 'estornar' || msgLower === 'devolver' ||
                msgLower === 'sim, estornar' || msgLower.includes('sim, estornar') ||
                msgLower === 'estornar parcial' || msgLower.includes('estornar parcial')) {

                // Verificar se tem transação selecionada (não apenas lista)
                if (!pending.transaction) {
                    await sendMessage(phoneNumber,
                        `Por favor, primeiro selecione o PIX digitando o número (1, 2, 3...)`);
                    return;
                }

                console.log(`Usuário confirmou estorno${pending.refundAmount ? ' parcial' : ''}`);
                pendingRefundConfirmations.delete(phoneNumber);

                await sendMessage(phoneNumber, 'Confirmado! Processando estorno...');

                // Executar o estorno com o ID da transação (e valor parcial se existir)
                const refundCommand = {
                    action: 'refund',
                    transactionId: pending.transaction.id,
                    reason: 'Devolução solicitada pelo cliente'
                };

                // Se for estorno parcial, adicionar o valor
                if (pending.refundAmount) {
                    refundCommand.refundAmount = pending.refundAmount; // em centavos
                }

                await executePixCommand(refundCommand, phoneNumber, { contactsOwnerId, zapiCredentials, botBranding, botId });
                return;
            } else if (msgLower === 'não' || msgLower === 'nao' || msgLower === 'n' ||
                       msgLower === 'cancelar' || msgLower === 'cancela' ||
                       msgLower === 'cancelar' || msgLower.includes('cancelar')) {
                console.log(`Usuário cancelou estorno`);
                pendingRefundConfirmations.delete(phoneNumber);

                await sendMessage(phoneNumber, 'Estorno cancelado. Como posso ajudar?');
                return;
            }

            // Se tem lista de transações e não escolheu número, pedir para escolher
            if (pending.transactionList) {
                let listMsg = `Por favor, responda com o número do PIX que deseja estornar (1, 2, 3...):\n\n`;
                pending.transactionList.forEach((tx, index) => {
                    const valor = (tx.amount / 100).toFixed(2);
                    listMsg += `*${index + 1}.* R$ ${valor}\n`;
                });
                await sendMessage(phoneNumber, listMsg);
                return;
            }

            // Se não é confirmação nem cancelamento, PERGUNTAR NOVAMENTE
            console.log(`Resposta não reconhecida para estorno: "${msgLower}"`);

            const valor = (pending.transaction.amount / 100).toFixed(2);
            const data = new Date(pending.transaction.createdAt).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });

            let reaskMsg = `Não entendi sua resposta.\n\n` +
                `*Estorno pendente:*\n` +
                `Valor do PIX: R$ ${valor}\n`;

            if (pending.refundAmount) {
                reaskMsg += `Valor a estornar: R$ ${(pending.refundAmount / 100).toFixed(2)} _(parcial)_\n`;
            }

            reaskMsg += `📅 Data: ${data}\n` +
                `ID: ${pending.transaction.id}`;

            await sendButtons(phoneNumber, reaskMsg, [
                { id: 'sim', label: pending.refundAmount ? 'Estornar parcial' : 'Sim, estornar' },
                { id: 'nao', label: '❌ Cancelar' }
            ]);
            return;
        }

        // ========== VERIFICAR CONFIRMAÇÃO DE CPF/TELEFONE PENDENTE ==========
        if (message && pendingCPFConfirmations.has(phoneNumber)) {
            const pending = pendingCPFConfirmations.get(phoneNumber);
            const msgLower = message.toLowerCase().trim();

            // Verificar se é CPF (inclui resposta de botão)
            if (msgLower === 'cpf' || msgLower === 'é cpf' || msgLower === 'e cpf' ||
                msgLower === 'cpf' || msgLower.includes('cpf')) {
                console.log(`Usuário confirmou que é CPF`);
                pendingCPFConfirmations.delete(phoneNumber);

                // Executar comando com tipo CPF
                const command = pending.command;
                command.pixKeyType = 'cpf';
                await executePixCommand(command, phoneNumber, { contactsOwnerId, zapiCredentials, botBranding, botId });
                return;
            } else if (msgLower === 'telefone' || msgLower === 'tel' || msgLower === 'celular' ||
                       msgLower === 'phone' || msgLower === 'fone' || msgLower === 'é telefone' ||
                       msgLower === 'e telefone' || msgLower === 'telefone' || msgLower.includes('telefone')) {
                console.log(`Usuário confirmou que é telefone`);
                pendingCPFConfirmations.delete(phoneNumber);

                // Executar comando com tipo telefone (adicionar 55)
                const command = pending.command;
                command.pixKeyType = 'phone';
                // Adicionar código do país se não tiver
                if (!command.pixKey.startsWith('55')) {
                    command.pixKey = '55' + command.pixKey;
                }
                await executePixCommand(command, phoneNumber, { contactsOwnerId, zapiCredentials, botBranding, botId });
                return;
            } else if (msgLower === 'cancelar' || msgLower === 'cancela' || msgLower === 'não' || msgLower === 'nao' ||
                       msgLower === 'cancelar' || msgLower.includes('cancelar')) {
                console.log(`Usuário cancelou transferência`);
                pendingCPFConfirmations.delete(phoneNumber);

                await sendMessage(phoneNumber, 'Transferência cancelada. Como posso ajudar?');
                return;
            }
            // Se não entendeu, perguntar novamente
            console.log(`Resposta não reconhecida para CPF/telefone: "${msgLower}"`);

            await sendButtons(phoneNumber,
                `Não entendi sua resposta.\n\n` +
                `A chave *${pending.command.pixKey}* pode ser CPF ou telefone.`,
                [
                    { id: 'cpf', label: 'CPF' },
                    { id: 'telefone', label: 'Telefone' },
                    { id: 'cancelar', label: '❌ Cancelar' }
                ]);
            return;
        }

        // ========== VERIFICAR CONFIRMAÇÃO DE ÁUDIO PENDENTE (texto) ==========
        if (message && pendingAudioCommands.has(phoneNumber)) {
            const pending = pendingAudioCommands.get(phoneNumber);
            const msgLower = message.toLowerCase().trim();

            // Verificar se é confirmação por texto (inclui resposta de botão)
            if (msgLower === 'sim' || msgLower === 's' || msgLower === 'y' || msgLower === 'yes' ||
                msgLower === 'confirmar' || msgLower === 'confirma' || msgLower === 'ok' ||
                msgLower === 'sim, executar' || msgLower.includes('sim, executar')) {
                console.log(`Usuário confirmou comando de áudio por texto`);
                pendingAudioCommands.delete(phoneNumber);

                await sendMessage(phoneNumber, 'Confirmado! Executando...');

                // Executar o comando salvo
                await executePixCommand(pending.command, phoneNumber, { contactsOwnerId, zapiCredentials, botBranding, botId });
                return;
            } else if (msgLower === 'não' || msgLower === 'nao' || msgLower === 'n' ||
                       msgLower === 'cancelar' || msgLower === 'cancela' ||
                       msgLower === 'cancelar' || msgLower.includes('cancelar')) {
                console.log(`Usuário cancelou comando de áudio por texto`);
                pendingAudioCommands.delete(phoneNumber);

                await sendMessage(phoneNumber, 'Cancelado. Como posso ajudar?');
                return;
            }
            // Se não é confirmação nem cancelamento, PERGUNTAR NOVAMENTE (não cancelar!)
            console.log(`Resposta de áudio não reconhecida: "${msgLower}", perguntando novamente`);

            // Montar mensagem com detalhes do comando pendente
            let detalhes = `🎤 _"${pending.transcription}"_\n\n`;
            if (pending.command.action === 'withdraw' || pending.command.action === 'send_to_contact') {
                const valor = (pending.command.amount / 100).toFixed(2);
                let destino = pending.command.contactName || pending.command.pixKey || '';
                detalhes += `Valor: R$ ${valor}\nPara: ${destino}`;
            } else if (pending.command.action === 'generate_pix') {
                const valor = (pending.command.amount / 100).toFixed(2);
                detalhes += `Gerar PIX de R$ ${valor}`;
            } else {
                detalhes += `Comando: ${pending.command.action}`;
            }

            await sendButtons(phoneNumber,
                `Não entendi sua resposta.\n\n` +
                `*Comando pendente:*\n${detalhes}`,
                [
                    { id: 'sim', label: 'Sim, executar' },
                    { id: 'nao', label: '❌ Cancelar' }
                ]);
            return;
        }

        // ========== PROCESSAMENTO DE ÁUDIO ==========
        if (audioUrl) {
            console.log(`\n🎤 Áudio recebido de: ${phoneNumber}`);
            console.log(`🔗 URL: ${audioUrl}`);

            try {
                await sendMessage(phoneNumber, '🎤 Processando seu áudio...');

                // Transcrever áudio com Whisper
                const transcription = await mediaService.transcribeAudio(audioUrl);

                if (!transcription || transcription.trim() === '') {
                    await sendMessage(phoneNumber,
                        'Não consegui entender o áudio. Tente novamente ou digite sua mensagem.');
                    return;
                }

                console.log(`Transcrição: ${transcription}`);

                // Processar a transcrição com IA para entender o comando
                const command = await aiService.processMessage(transcription, phoneNumber);
                console.log(`🤖 Comando interpretado:`, command);

                // Se for uma ação de pergunta, executar direto (não precisa confirmar)
                if (command.action === 'ask' || command.action === 'help' ||
                    command.action === 'error' || command.action === 'unknown') {
                    await executePixCommand(command, phoneNumber, { contactsOwnerId, zapiCredentials, botBranding, botId });
                    return;
                }

                // Montar mensagem de confirmação baseada no comando
                let confirmMsg = `🎤 *Entendi seu áudio:*\n_"${transcription}"_\n\n`;

                if (command.action === 'generate_pix') {
                    const valor = (command.amount / 100).toFixed(2);
                    confirmMsg += `*Comando:* Gerar PIX para receber\n`;
                    confirmMsg += `*Valor:* R$ ${valor}\n\n`;
                } else if (command.action === 'withdraw' || command.action === 'send_to_contact') {
                    const valor = (command.amount / 100).toFixed(2);
                    confirmMsg += `*Comando:* Enviar PIX\n`;
                    confirmMsg += `*Valor:* R$ ${valor}\n`;
                    if (command.contactName) {
                        confirmMsg += `*Para:* ${command.contactName}\n\n`;
                    } else if (command.pixKey) {
                        confirmMsg += `*Para:* ${command.pixKey}\n\n`;
                    }
                } else if (command.action === 'check_balance') {
                    confirmMsg += `*Comando:* Consultar saldo\n\n`;
                } else if (command.action === 'list_contacts') {
                    confirmMsg += `*Comando:* Listar contatos\n\n`;
                } else if (command.action === 'save_contact') {
                    confirmMsg += `*Comando:* Salvar contato "${command.name}"\n\n`;
                } else if (command.action === 'my_pix_key') {
                    confirmMsg += `*Comando:* Ver minha chave PIX\n\n`;
                } else {
                    confirmMsg += `*Comando:* ${command.action}\n\n`;
                }

                // Salvar comando pendente
                pendingAudioCommands.set(phoneNumber, {
                    transcription,
                    command,
                    timestamp: Date.now()
                });

                // Enviar confirmação com BOTÕES
                await sendButtons(phoneNumber, confirmMsg.trim(), [
                    { id: 'sim', label: 'Sim, executar' },
                    { id: 'nao', label: '❌ Cancelar' }
                ]);
                return;

            } catch (audioError) {
                console.error('Erro ao processar áudio:', audioError.message);
                await sendMessage(phoneNumber,
                    'Erro ao processar áudio. Tente novamente ou digite sua mensagem.');
                return;
            }
        }

        // ========== PROCESSAMENTO DE IMAGEM ==========
        if (imageUrl) {
            console.log(`\n🖼️ Imagem recebida de: ${phoneNumber}`);
            console.log(`🔗 URL: ${imageUrl}`);

            try {
                await sendMessage(phoneNumber, '🖼️ Analisando imagem...');

                // Analisar imagem com GPT-4 Vision
                const analysis = await mediaService.analyzeImage(imageUrl, message || '');

                if (!analysis.found) {
                    await sendMessage(phoneNumber,
                        `Não encontrei uma chave PIX nesta imagem.\n\n${analysis.description || 'Tente enviar uma foto mais clara ou digite a chave manualmente.'}`);
                    return;
                }

                // Chave encontrada! Informar usuário
                console.log(`Chave encontrada: ${analysis.pixKey} (${analysis.pixKeyType})`);

                // Se a legenda da imagem tem valor, processar diretamente
                if (message) {
                    // Verificar se a legenda menciona valor
                    const valorMatch = message.match(/(\d+(?:[.,]\d{2})?)\s*(?:reais?|R\$)?/i);
                    if (valorMatch) {
                        const valorStr = valorMatch[1].replace(',', '.');
                        const valorCentavos = Math.round(parseFloat(valorStr) * 100);

                        // Criar comando de withdraw
                        const withdrawCommand = {
                            action: 'withdraw',
                            amount: valorCentavos,
                            pixKey: analysis.pixKey,
                            pixKeyType: analysis.pixKeyType
                        };

                        // Salvar para confirmação
                        pendingWithdrawConfirmations.set(phoneNumber, {
                            command: withdrawCommand,
                            timestamp: Date.now()
                        });

                        // Pedir confirmação com BOTÕES
                        const confirmMsg = `*CONFIRMAR TRANSFERÊNCIA PIX*\n\n` +
                            `🖼️ Chave encontrada na imagem!\n\n` +
                            `Valor: *R$ ${(valorCentavos / 100).toFixed(2)}*\n` +
                            `Tipo: ${analysis.pixKeyType.toUpperCase()}\n` +
                            `Chave: ${analysis.pixKey}\n\n` +
                            `⏰ _Expira em 5 minutos_`;

                        await sendButtons(phoneNumber, confirmMsg, [
                            { id: 'sim', label: '✅ Sim, enviar' },
                            { id: 'nao', label: '❌ Cancelar' }
                        ]);
                        console.log(`⏳ Aguardando confirmação de PIX (imagem) de ${phoneNumber}`);
                        return;
                    }
                }

                // Sem valor na legenda - salvar contexto e perguntar valor
                pendingImageTransfers.set(phoneNumber, {
                    pixKey: analysis.pixKey,
                    pixKeyType: analysis.pixKeyType,
                    timestamp: Date.now()
                });

                await sendMessage(phoneNumber,
                    `*Chave PIX encontrada!*\n\n` +
                    `Tipo: *${analysis.pixKeyType.toUpperCase()}*\n` +
                    `Chave: ${analysis.pixKey}\n` +
                    `🎯 Confiança: ${analysis.confidence || 'alta'}\n\n` +
                    `Qual valor deseja enviar?`);
                return;

            } catch (imageError) {
                console.error('Erro ao processar imagem:', imageError.message);
                await sendMessage(phoneNumber,
                    'Erro ao analisar imagem. Tente novamente ou digite a chave manualmente.');
                return;
            }
        }

        // ========== VERIFICAR CONTEXTO DE IMAGEM PENDENTE ==========
        // Se usuário mandou apenas um valor e tem imagem pendente, usar a chave da imagem
        if (message && pendingImageTransfers.has(phoneNumber)) {
            const valorMatch = message.match(/^(\d+(?:[.,]\d{2})?)\s*(?:reais?|R\$)?$/i);
            if (valorMatch) {
                const pending = pendingImageTransfers.get(phoneNumber);
                const valorStr = valorMatch[1].replace(',', '.');
                const valorCentavos = Math.round(parseFloat(valorStr) * 100);

                console.log(`Valor recebido para imagem pendente: R$ ${valorStr}`);

                // Limpar contexto de imagem
                pendingImageTransfers.delete(phoneNumber);

                // Criar comando de withdraw
                const withdrawCommand = {
                    action: 'withdraw',
                    amount: valorCentavos,
                    pixKey: pending.pixKey,
                    pixKeyType: pending.pixKeyType
                };

                // Salvar para confirmação
                pendingWithdrawConfirmations.set(phoneNumber, {
                    command: withdrawCommand,
                    timestamp: Date.now()
                });

                // Pedir confirmação com BOTÕES
                const confirmMsg = `*CONFIRMAR TRANSFERÊNCIA PIX*\n\n` +
                    `Valor: *R$ ${(valorCentavos / 100).toFixed(2)}*\n` +
                    `Tipo: ${pending.pixKeyType.toUpperCase()}\n` +
                    `Chave: ${pending.pixKey}\n\n` +
                    `⏰ _Expira em 5 minutos_`;

                await sendButtons(phoneNumber, confirmMsg, [
                    { id: 'sim', label: '✅ Sim, enviar' },
                    { id: 'nao', label: '❌ Cancelar' }
                ]);
                console.log(`⏳ Aguardando confirmação de PIX (imagem+valor) de ${phoneNumber}`);
                return;
            }
        }

        // ========== ATALHO PARA "VER SALDO" (botão) ==========
        const msgLowerCheck = message.toLowerCase().trim();
        if (msgLowerCheck === 'ver saldo' || msgLowerCheck === 'ver saldo' ||
            msgLowerCheck === 'ver_saldo' || msgLowerCheck.includes('ver saldo')) {
            console.log(`🔘 Atalho: Ver saldo acionado diretamente`);
            await executePixCommand({ action: 'check_balance' }, phoneNumber, { contactsOwnerId, zapiCredentials, botBranding, botId });
            return;
        }

        // ========== ATALHO PARA REENVIAR CÓDIGO PIX ==========
        // Se o usuário pedir o código novamente por texto
        if (msgLowerCheck === 'código' || msgLowerCheck === 'codigo' ||
            msgLowerCheck === 'me envia o código' || msgLowerCheck === 'envia o codigo' ||
            msgLowerCheck.includes('código pix') || msgLowerCheck.includes('codigo pix') ||
            msgLowerCheck.includes('copia e cola')) {
            console.log(`🔘 Atalho: Reenviar código PIX acionado`);

            const savedPix = lastGeneratedPixCodes.get(phoneNumber);
            if (savedPix) {
                await sendMessage(phoneNumber,
                    `*Código Copia e Cola (R$ ${savedPix.amount.toFixed(2)}):*`);
                await sendMessage(phoneNumber, savedPix.pixCode);
                await sendMessage(phoneNumber,
                    `*Copie o código acima*\n\n⏰ _Este código expira em 24 horas._`);
            } else {
                await sendMessage(phoneNumber,
                    `Nenhum código PIX ativo encontrado.\n\n` +
                    `Os códigos expiram em 24 horas. Gere um novo PIX se necessário.`);
            }
            return;
        }

        // ========== PROCESSAMENTO NORMAL COM IA ==========
        // Processar mensagem com ChatGPT (COM MEMÓRIA DE CONVERSA)
        const command = await aiService.processMessage(message, phoneNumber);

        // ========== VALIDAÇÃO DE SANIDADE - DETECTAR ERRO 10x ==========
        // Se for withdraw ou send_to_contact, verificar se o amount faz sentido
        if ((command.action === 'withdraw' || command.action === 'send_to_contact') && command.amount) {
            // Extrair números da mensagem original (valores mencionados pelo usuário)
            const numerosNaMensagem = message.match(/\b(\d{3,})\b/g); // Números com 3+ dígitos

            if (numerosNaMensagem && numerosNaMensagem.length > 0) {
                for (const numStr of numerosNaMensagem) {
                    const numOriginal = parseInt(numStr, 10);
                    const amountEmReais = command.amount / 100;

                    // Se o amount da IA é exatamente 10x o número original, é provável erro
                    // Ex: usuário disse "5620" e IA retornou 5620000 centavos (R$ 56200)
                    if (amountEmReais === numOriginal * 10) {
                        console.log(`ERRO 10x DETECTADO! Usuário disse ${numOriginal}, IA retornou ${command.amount} centavos (R$ ${amountEmReais})`);
                        console.log(`🔧 Corrigindo automaticamente: ${command.amount} → ${numOriginal * 100} centavos`);

                        // Corrigir o valor automaticamente (numOriginal * 100 = centavos corretos)
                        command.amount = numOriginal * 100;

                        // Log da correção
                        console.log(`Valor corrigido: R$ ${(command.amount / 100).toFixed(2)}`);
                        break;
                    }

                    // Também detectar se o valor é absurdamente alto (> R$ 100.000)
                    // e parece ser 10x de um número na mensagem
                    if (amountEmReais > 100000 && numOriginal >= 1000 && numOriginal <= 99999) {
                        const razao = amountEmReais / numOriginal;
                        if (razao >= 9.5 && razao <= 10.5) {
                            console.log(`POSSÍVEL ERRO 10x! Valor muito alto R$ ${amountEmReais} pode ser 10x de ${numOriginal}`);
                            console.log(`🔧 Corrigindo automaticamente para R$ ${numOriginal}`);
                            command.amount = numOriginal * 100;
                            console.log(`Valor corrigido: R$ ${(command.amount / 100).toFixed(2)}`);
                            break;
                        }
                    }
                }
            }
        }

        // ========== CONFIRMAÇÃO MANUAL PARA TRANSFERÊNCIAS PIX ==========
        // Se for withdraw ou send_to_contact, pedir confirmação antes de executar
        if (command.action === 'withdraw' || command.action === 'send_to_contact') {
            const valor = (command.amount / 100).toFixed(2);
            let destino = '';

            if (command.action === 'send_to_contact') {
                // Buscar dados do contato para mostrar
                const contact = contactsService.getContact(contactsOwnerId, command.contactName);
                if (contact) {
                    destino = `*${contact.name}*\n${contact.pixKey} (${contact.pixKeyType})`;
                } else {
                    destino = `${command.contactName}`;
                }
            } else {
                destino = `${command.pixKey} (${command.pixKeyType})`;
            }

            // Salvar comando pendente
            pendingWithdrawConfirmations.set(phoneNumber, {
                command,
                timestamp: Date.now()
            });

            // Enviar mensagem de confirmação com BOTÕES
            const confirmMsg = `*CONFIRMAR TRANSFERÊNCIA PIX*\n\n` +
                `Valor: *R$ ${valor}*\n` +
                `Para: ${destino}\n\n` +
                `⏰ _Expira em 5 minutos_`;

            await sendButtons(phoneNumber, confirmMsg, [
                { id: 'sim', label: '✅ Sim, enviar' },
                { id: 'nao', label: '❌ Cancelar' }
            ]);
            console.log(`⏳ Aguardando confirmação de PIX de ${phoneNumber}: R$ ${valor}`);
            return;
        }

        // Executar comando PIX (para outros comandos)
        await executePixCommand(command, phoneNumber, { contactsOwnerId, zapiCredentials, botBranding, botId });

    } catch (error) {
        console.error('💥 Erro no webhook:', error.message);
        console.error('Stack:', error.stack);
    }
});

// ========== WEBHOOK CREDPIX (Confirmações de Transação) ==========

app.post('/webhook/credpix', async (req, res) => {
    // Responder imediatamente com 200 OK (requisito CREDPIX: < 10 segundos)
    res.status(200).send('OK');

    try {
        console.log('\n📥 WEBHOOK CREDPIX RECEBIDO:');
        console.log(JSON.stringify(req.body, null, 2));

        const {
            id,
            status,
            type,
            amount,
            pixKey,
            endToEndId,
            paidAt,
            createdAt,
            // Dados do pagador (PIX In) - quem pagou
            payerName,
            payerDocument,
            payerInstitutionName,
            payerInstitutionIspb,
            // Dados da conta que gerou (PIX Out) - sua conta
            generatedName,
            generatedDocument,
            generatedInstitutionName,
            generatedInstitutionIspb,
            // Dados do recebedor (PIX Out) - quem recebeu
            receiverName,
            receiverDocument,
            receiverInstitutionName,
            receiverInstitutionIspb,
            // Dados de estorno (quando status = REFUNDED)
            refundAmount,
            refundStatus,
            refundReason,
            refundEndToEndId,
            refundedAt
        } = req.body;

        if (!id) {
            console.log('Webhook sem ID de transação');
            return;
        }

        // Buscar transação registrada
        const transaction = await transactionsService.getTransaction(id);

        if (!transaction) {
            console.log(`Transação ${id} não encontrada no registro local`);
            // Mesmo assim, atualizar se existir
            return;
        }

        const phoneNumber = transaction.phoneNumber;
        const previousStatus = transaction.status;

        // Obter branding e credenciais Z-API do bot que processou esta transação
        const transactionBotId = transaction.botId || 'credpix';
        const botBranding = botService.getBotBranding(transactionBotId);
        const zapiCredentials = botService.getBotZapiCredentials(transactionBotId);
        console.log(`🎨 Bot da transação: ${transactionBotId} (${botBranding?.name || 'N/A'})`);

        // Helpers para enviar mensagens pelo bot correto
        const sendMessage = (to, msg) => whatsappService.sendMessage(to, msg, zapiCredentials);
        const sendImage = (to, img, caption) => whatsappService.sendImage(to, img, caption, zapiCredentials);
        const sendButtons = (to, msg, btns) => whatsappService.sendButtons(to, msg, btns, zapiCredentials);

        // Atualizar status da transação
        await transactionsService.updateTransaction(id, status, req.body);

        // Atualizar saldo quando transação é concluída
        if (status === 'COMPLETED') {
            const amountValue = parseFloat(amount || 0);
            const isDeposit = type === 'DEPOSIT' || transaction.type === 'pix_in';
            const delta = isDeposit ? amountValue : -amountValue;
            const balanceSnapshot = await updateUserBalance(phoneNumber, delta, 'transaction_completed');

            if (balanceSnapshot) {
                if (isDeposit) {
                    await db.query(
                        'UPDATE pagamentos SET saldo_antes = ?, saldo_depois = ? WHERE identifier = ?',
                        [balanceSnapshot.saldoAntes, balanceSnapshot.saldoDepois, id]
                    );
                } else {
                    await db.query(
                        'UPDATE saques_pix SET saldoantes = ?, saldodepois = ? WHERE txid = ?',
                        [balanceSnapshot.saldoAntes, balanceSnapshot.saldoDepois, id]
                    );
                }
            }
        }

        // Só notificar se o status mudou
        if (status === previousStatus) {
            console.log(`ℹ️ Status não mudou: ${status}`);
            return;
        }

        console.log(`Notificando ${phoneNumber} sobre transação ${id}`);

        // Formatar valor
        const valorFormatado = typeof amount === 'number'
            ? `R$ ${amount.toFixed(2)}`
            : `R$ ${parseFloat(amount).toFixed(2)}`;

        // Log completo para debug
        console.log('DEBUG - Todos os campos do webhook:', {
            // Pagador (PIX In)
            payerName, payerDocument, payerInstitutionName,
            // Gerador da transação (sua conta)
            generatedName, generatedDocument, generatedInstitutionName,
            // Recebedor (PIX Out)
            receiverName, receiverDocument, receiverInstitutionName
        });

        // Notificar usuário baseado no tipo e status
        let message = '';
        let shouldSendReceipt = false;

        if (type === 'DEPOSIT' || transaction.type === 'pix_in') {
            // PIX recebido (deposit)
            switch (status) {
                case 'COMPLETED':
                    shouldSendReceipt = true;
                    break;
                case 'EXPIRED':
                    message = `⏰ *PIX EXPIRADO*\n\n` +
                        `O PIX de ${valorFormatado} expirou.\n` +
                        `Gere um novo se ainda precisar receber.`;
                    break;
                case 'CANCELED':
                    message = `*PIX CANCELADO*\n\n` +
                        `O PIX de ${valorFormatado} foi cancelado.`;
                    break;
            }
        } else if (type === 'WITHDRAW' || transaction.type === 'pix_out') {
            // PIX enviado (withdraw)
            switch (status) {
                case 'COMPLETED':
                    shouldSendReceipt = true;
                    break;
                case 'ERROR':
                case 'CANCELED':
                    // Verificar se faz parte de um grupo de transferências
                    const failedGroupId = transaction?.groupId;
                    if (failedGroupId) {
                        // Marcar transação do grupo como falha
                        const amountCentavos = Math.round(parseFloat(amount) * 100);
                        const resolvedGroup = transactionsService.markGroupTransactionFailed(failedGroupId, amountCentavos, id);

                        if (resolvedGroup) {
                            // Grupo foi totalmente resolvido (algumas OK, algumas falhas)
                            if (resolvedGroup.status === 'PARTIAL' && resolvedGroup.completedTransactions > 0) {
                                // Gerar comprovante parcial para as que deram certo
                                shouldSendReceipt = true;
                                // Marcar para tratamento especial de grupo parcial
                                transaction._partialGroup = resolvedGroup;
                                message = null; // Não enviar mensagem de erro individual
                            } else {
                                // Todas falharam
                                message = `*TRANSFERÊNCIA FALHOU*\n\n` +
                                    `Nenhuma das ${resolvedGroup.totalTransactions} transações foi concluída.\n` +
                                    `Valor: ${valorFormatado}\n\n` +
                                    `O valor será estornado se foi debitado.`;
                            }
                        } else {
                            // Ainda há transações pendentes no grupo - não notificar ainda
                            console.log(`📦 Transação do grupo ${failedGroupId} FALHOU, mas ainda há transações pendentes...`);
                            message = null; // Não notificar falha individual ainda
                        }
                    } else {
                        // Transação individual (não faz parte de grupo)
                        message = status === 'ERROR'
                            ? `*ERRO NO PIX*\n\n` +
                              `A transferência de ${valorFormatado} falhou.\n` +
                              `O valor será estornado se foi debitado.`
                            : `*PIX CANCELADO*\n\n` +
                              `A transferência de ${valorFormatado} foi cancelada.`;
                    }
                    break;
                case 'REFUNDED':
                    // Usar refundAmount se disponível (estorno parcial), senão amount (total)
                    const refundValue = refundAmount !== undefined && refundAmount !== null
                        ? parseFloat(refundAmount)
                        : parseFloat(amount);
                    const originalValue = parseFloat(amount);
                    const isPartialRefund = refundAmount !== undefined && refundAmount !== null && refundValue < originalValue;

                    const refundValueFormatado = `R$ ${refundValue.toFixed(2)}`;

                    console.log(`ESTORNO RECEBIDO: R$ ${refundValue.toFixed(2)} (original: R$ ${originalValue.toFixed(2)}) - Parcial: ${isPartialRefund}`);

                    if (isPartialRefund) {
                        message = `*PIX ESTORNADO PARCIALMENTE*\n\n` +
                            `Valor original: ${valorFormatado}\n` +
                            `Valor estornado: *${refundValueFormatado}*\n\n` +
                            `O valor retornou ao seu saldo.`;
                    } else {
                        message = `*PIX ESTORNADO*\n\n` +
                            `O PIX de ${refundValueFormatado} foi estornado.\n` +
                            `O valor retornou ao seu saldo.`;
                    }

                    // Gerar comprovante de estorno
                    try {
                        const receiptData = {
                            type: 'refund',
                            amount: refundValue,
                            originalAmount: isPartialRefund ? originalValue : null,
                            isPartialRefund: isPartialRefund,
                            transactionId: id,
                            refundReason: refundReason || 'Estorno solicitado',
                            refundEndToEndId: refundEndToEndId,
                            // Quem fez o estorno (recebedor original do PIX)
                            payerName: receiverName || 'N/A',
                            payerDocument: receiverDocument || '',
                            payerBank: receiverInstitutionName || 'N/A',
                            // Quem recebe o estorno (você)
                            receiverName: generatedName || payerName || 'N/A',
                            receiverDocument: generatedDocument || payerDocument || '',
                            receiverBank: generatedInstitutionName || payerInstitutionName || 'CREDPIX'
                        };

                        const receiptBase64 = await receiptGenerator.generateReceiptBase64(receiptData, botBranding);

                        let caption = `↩️ *ESTORNO RECEBIDO*\n\n` +
                            `Valor: R$ ${refundValue.toFixed(2)}`;

                        if (isPartialRefund) {
                            caption += ` _(de R$ ${originalValue.toFixed(2)})_`;
                        }

                        if (refundReason) {
                            caption += `\nMotivo: ${refundReason}`;
                        }

                        await sendImage(phoneNumber, receiptBase64, caption);
                        message = null; // Não enviar mensagem de texto, só o comprovante
                        console.log('Comprovante de estorno recebido enviado');
                    } catch (receiptError) {
                        console.error('Erro ao gerar comprovante de estorno:', receiptError.message);
                        // Mantém a mensagem de texto como fallback
                    }
                    break;
            }
        }

        // Gerar e enviar comprovante visual para transações COMPLETED ou PARTIAL
        if (shouldSendReceipt && phoneNumber) {
            try {
                const isDeposit = type === 'DEPOSIT' || transaction.type === 'pix_in';

                // Verificar se é um grupo parcial (algumas transações falharam)
                const partialGroup = transaction?._partialGroup;

                // Verificar se faz parte de um grupo de transferências
                const groupId = transaction?.groupId;
                let shouldGenerateReceipt = true;
                let totalAmountForReceipt = parseFloat(amount);
                let pixCountForReceipt = null;
                let isPartialTransfer = false;
                let failedInfo = null;

                // Caso 1: Grupo PARCIAL (algumas falharam, disparado pela última falha)
                if (partialGroup) {
                    // Usar valor das transações que deram certo
                    totalAmountForReceipt = partialGroup.completedAmount / 100; // centavos para reais
                    pixCountForReceipt = partialGroup.completedTransactions;
                    isPartialTransfer = true;
                    failedInfo = {
                        count: partialGroup.failedTransactions,
                        amount: partialGroup.failedAmount / 100 // centavos para reais
                    };
                    console.log(`📦 Grupo PARCIAL! Gerando comprovante de R$ ${totalAmountForReceipt.toFixed(2)} (${pixCountForReceipt} OK, ${failedInfo.count} falhas)`);
                }
                // Caso 2: Transação COMPLETED de um grupo (normal)
                else if (groupId && !isDeposit) {
                    // Marcar transação do grupo como completa
                    const amountCentavos = Math.round(parseFloat(amount) * 100);
                    const resolvedGroup = transactionsService.markGroupTransactionComplete(groupId, amountCentavos);

                    if (resolvedGroup) {
                        if (resolvedGroup.status === 'COMPLETED') {
                            // Grupo totalmente completo!
                            totalAmountForReceipt = resolvedGroup.totalAmount / 100;
                            pixCountForReceipt = resolvedGroup.totalTransactions;
                            console.log(`📦 Grupo ${groupId} COMPLETO! Gerando comprovante de R$ ${totalAmountForReceipt.toFixed(2)} (${pixCountForReceipt} PIX)`);
                        } else if (resolvedGroup.status === 'PARTIAL') {
                            // Grupo parcialmente completo (algumas falharam antes)
                            totalAmountForReceipt = resolvedGroup.completedAmount / 100;
                            pixCountForReceipt = resolvedGroup.completedTransactions;
                            isPartialTransfer = true;
                            failedInfo = {
                                count: resolvedGroup.failedTransactions,
                                amount: resolvedGroup.failedAmount / 100
                            };
                            console.log(`📦 Grupo ${groupId} PARCIAL! Gerando comprovante de R$ ${totalAmountForReceipt.toFixed(2)} (${pixCountForReceipt} OK, ${failedInfo.count} falhas)`);
                        }
                    } else {
                        // Ainda faltam transações - não gerar comprovante ainda
                        shouldGenerateReceipt = false;
                        console.log(`📦 Transação do grupo ${groupId} confirmada. Aguardando demais transações...`);
                    }
                }

                if (shouldGenerateReceipt) {
                    // Dados para o comprovante
                    let receiptData;

                    if (isDeposit) {
                        // PIX RECEBIDO: DE = quem pagou (payer), PARA = você (receiver)
                        receiptData = {
                            type: 'in',
                            amount: totalAmountForReceipt,
                            dateTime: paidAt || new Date().toISOString(),
                            // DE: Quem pagou (payer)
                            payerName: payerName || 'Não identificado',
                            payerDocument: payerDocument || null,
                            payerBank: payerInstitutionName || null,
                            // PARA: Você (receiver)
                            receiverName: receiverName || 'Não identificado',
                            receiverDocument: receiverDocument || null,
                            receiverBank: receiverInstitutionName || null,
                            pixKey: pixKey || transaction.pixKey,
                            transactionId: endToEndId || id
                        };
                    } else {
                        // PIX ENVIADO: DE = você (payer), PARA = quem recebeu (receiver)
                        receiptData = {
                            type: 'out',
                            amount: totalAmountForReceipt,
                            dateTime: paidAt || new Date().toISOString(),
                            // DE: Você (payer)
                            payerName: payerName || 'Não identificado',
                            payerDocument: payerDocument || null,
                            payerBank: payerInstitutionName || null,
                            // PARA: Quem recebeu (receiver)
                            receiverName: receiverName || 'Não identificado',
                            receiverDocument: receiverDocument || null,
                            receiverBank: receiverInstitutionName || null,
                            pixKey: pixKey || transaction.pixKey,
                            transactionId: groupId || endToEndId || id,
                            pixCount: pixCountForReceipt // Quantidade de PIX (se grupo)
                        };
                    }

                    console.log('Gerando comprovante visual...');
                    const receiptBase64 = await receiptGenerator.generateReceiptBase64(receiptData, botBranding);

                    // Enviar imagem do comprovante
                    let caption;
                    if (isDeposit) {
                        caption = `PIX de R$ ${totalAmountForReceipt.toFixed(2)} recebido!`;
                    } else if (isPartialTransfer && failedInfo) {
                        // Transferência parcial - avisar sobre a falha
                        caption = `*PIX PARCIALMENTE ENVIADO*\n\n` +
                            `Enviado: *R$ ${totalAmountForReceipt.toFixed(2)}* (${pixCountForReceipt} PIX)\n` +
                            `Falhou: *R$ ${failedInfo.amount.toFixed(2)}* (${failedInfo.count} PIX)\n\n` +
                            `_O valor que falhou permanece na sua conta._`;
                    } else {
                        caption = `PIX de R$ ${totalAmountForReceipt.toFixed(2)} enviado!`;
                    }

                    await sendImage(phoneNumber, receiptBase64, caption);
                    console.log(`Comprovante enviado para ${phoneNumber}`);

                    // Enviar botão "Ver saldo" após o comprovante
                    await sendButtons(phoneNumber, 'Deseja ver seu saldo atualizado?', [
                        { id: 'ver_saldo', label: 'Ver saldo' }
                    ]);
                }

            } catch (receiptError) {
                console.error('Erro ao gerar comprovante:', receiptError.message);
                console.error('Stack:', receiptError.stack);
                // Fallback: enviar mensagem de texto
                const isDepositFallback = type === 'DEPOSIT' || transaction.type === 'pix_in';
                const fallbackMsg = isDepositFallback
                    ? `*PIX RECEBIDO!*\n\nValor: *${valorFormatado}*\nPagador: ${payerName || 'N/A'}\nBanco: ${payerInstitutionName || 'N/A'}\nID: ${endToEndId || id}`
                    : `*PIX ENVIADO!*\n\nValor: *${valorFormatado}*\nRecebedor: ${receiverName || 'N/A'}\nBanco: ${receiverInstitutionName || 'N/A'}\nID: ${endToEndId || id}`;
                await sendMessage(phoneNumber, fallbackMsg);

                // Enviar botão "Ver saldo" após a notificação
                await sendButtons(phoneNumber, 'Deseja ver seu saldo atualizado?', [
                    { id: 'ver_saldo', label: 'Ver saldo' }
                ]);
            }
        } else if (message && phoneNumber) {
            // Enviar mensagem de texto para outros status
            await sendMessage(phoneNumber, message);
            console.log(`Notificação enviada para ${phoneNumber}`);
        }

    } catch (error) {
        console.error('💥 Erro no webhook CREDPIX:', error.message);
    }
});

// Executar comandos PIX via WhatsApp
async function executePixCommand(command, phoneNumber, options = {}) {
    console.log('\n⚙️ Executando comando:', command.action);

    // Resolver credenciais: opções passadas > tenant > env
    let platformToken = options.platformToken;
    let myPixKey = options.myPixKey;
    let contactsOwnerId = options.contactsOwnerId; // ID para contatos (tenant ou phone)

    // Credenciais Z-API, branding e ID do bot (opcionais)
    const zapiCredentials = options.zapiCredentials || null;
    const botBranding = options.botBranding || null;
    const botId = options.botId || 'credpix'; // ID do bot para rastreamento

    // Helpers locais para envio de mensagens (com credenciais do bot se disponíveis)
    const sendMessage = (to, msg) => whatsappService.sendMessage(to, msg, zapiCredentials);
    const sendImage = (to, img, caption) => whatsappService.sendImage(to, img, caption, zapiCredentials);
    const sendButtons = (to, msg, btns) => whatsappService.sendButtons(to, msg, btns, zapiCredentials);

    if (!platformToken) {
        const tenant = tenantService.getTenantByPhone(phoneNumber);
        if (tenant && tenant.active) {
            platformToken = tenant.platformToken;
            myPixKey = tenant.myPixKey;
            contactsOwnerId = tenant.id; // Usar ID do tenant para contatos
            console.log(`   🏢 Usando token do cliente: ${tenant.name}`);
        } else {
            platformToken = CREDPIX_TOKEN;
            myPixKey = process.env.MY_PIX_KEY;
            contactsOwnerId = phoneNumber; // Modo legado: usar phone
            console.log(`   Usando token do .env`);
        }
    } else if (!contactsOwnerId) {
        // Se tem platformToken mas não tem contactsOwnerId, usar phone
        contactsOwnerId = phoneNumber;
    }

    try {
        switch (command.action) {
            case 'generate_pix':
                // Gerar PIX - CREDPIX usa valores em REAIS (não centavos)
                const amountInReais = (command.amount / 100).toFixed(2);
                const identifier = transactionsService.generateClientReference();
                const copiaECola = `CREDPIX-${identifier}`;
                const user = await getUserByChatId(phoneNumber);

                await transactionsService.registerTransaction(
                    identifier,
                    phoneNumber,
                    'pix_in',
                    command.amount,
                    {
                        brCode: copiaECola,
                        tokenuser: user?.user_token || platformToken || null,
                        botId
                    }
                );

                // Salvar código PIX para botão "copiar código"
                lastGeneratedPixCodes.set(phoneNumber, {
                    pixCode: copiaECola,
                    amount: parseFloat(amountInReais),
                    timestamp: Date.now()
                });

                // Mensagem 1: Informações do PIX
                const infoMessage = `*PIX Gerado para Receber!*\n\n` +
                    `Valor: *R$ ${parseFloat(amountInReais).toFixed(2)}*\n` +
                    `⏰ Expira em: 24 horas\n\n` +
                    `*Código Copia e Cola:*`;

                await sendMessage(phoneNumber, infoMessage);

                // Mensagem 2: Só o código copia e cola (fácil de copiar)
                await sendMessage(phoneNumber, copiaECola);

                // Mensagem 3: Instruções (sem botão - WhatsApp não tem "copiar para área de transferência")
                await sendMessage(phoneNumber,
                    `*Copie o código acima*\n\n` +
                    `Abra o app do banco de quem vai pagar\n` +
                    `Escolha "Pagar com PIX" → "Copia e Cola"\n` +
                    `Cole o código e confirme\n\n` +
                    `Você será notificado quando o pagamento for confirmado!`);
                break;

            case 'withdraw':
                // Processar saque/transferência PIX - CREDPIX usa valores em REAIS
                // LIMITE: R$ 10.000,00 por transação - dividir automaticamente
                const LIMITE_POR_TRANSACAO = 1000000; // R$ 10.000,00 em centavos
                const totalCentavos = command.amount;
                const totalReais = (totalCentavos / 100).toFixed(2);

                // Converter tipo de chave para minúsculas (CREDPIX)
                let pixKeyType = command.pixKeyType.toLowerCase();
                if (pixKeyType === 'random') pixKeyType = 'evp';

                // Tratar "cpf_or_phone" - validar CPF para decidir automaticamente
                let pixKey = command.pixKey;
                if (pixKeyType === 'cpf_or_phone') {
                    const digitsOnly = pixKey.replace(/\D/g, '');
                    if (digitsOnly.length === 11) {
                        if (isValidCPF(digitsOnly)) {
                            // CPF válido - precisa perguntar ao usuário
                            console.log(`🔍 Chave ${digitsOnly}: CPF VÁLIDO - perguntando ao usuário`);

                            // Salvar para confirmação
                            pendingCPFConfirmations.set(phoneNumber, {
                                command: { ...command, pixKey: digitsOnly },
                                timestamp: Date.now()
                            });

                            await sendButtons(phoneNumber,
                                `🔍 *Confirmação necessária*\n\n` +
                                `A chave *${digitsOnly}* pode ser CPF ou telefone.`,
                                [
                                    { id: 'cpf', label: 'CPF' },
                                    { id: 'telefone', label: 'Telefone' },
                                    { id: 'cancelar', label: '❌ Cancelar' }
                                ]);
                            break;
                        } else {
                            // CPF inválido - é telefone automaticamente
                            console.log(`🔍 Chave ${digitsOnly}: CPF INVÁLIDO - tratando como telefone`);
                            pixKeyType = 'phone';
                            pixKey = digitsOnly;
                        }
                    }
                }

                // Para telefone, garantir código do país (55)
                if (pixKeyType === 'phone' && !pixKey.startsWith('55')) {
                    pixKey = '55' + pixKey;
                }

                // Validar valor mínimo (R$ 1,00 = 100 centavos)
                if (totalCentavos < 100) {
                    await sendMessage(phoneNumber,
                        'Valor mínimo para transferência: R$ 1,00');
                    break;
                }

                // Calcular transações necessárias (múltiplos de R$ 10.000)
                const numTransacoesCompletas = Math.floor(totalCentavos / LIMITE_POR_TRANSACAO);
                const valorRestante = totalCentavos % LIMITE_POR_TRANSACAO;

                // Montar lista de transações
                const transacoes = [];
                for (let i = 0; i < numTransacoesCompletas; i++) {
                    transacoes.push(LIMITE_POR_TRANSACAO); // R$ 10.000,00
                }
                if (valorRestante > 0) {
                    transacoes.push(valorRestante);
                }

                // Gerar clientReference único para o grupo
                const clientReference = transactionsService.generateClientReference();

                // Se houver múltiplas transações, criar grupo
                let groupId = null;
                if (transacoes.length > 1) {
                    groupId = clientReference;
                    transactionsService.createTransferGroup(groupId, phoneNumber, totalCentavos, transacoes.length, {
                        pixKey,
                        pixKeyType
                    });
                }

                console.log('\nDADOS DO SAQUE (CREDPIX):');
                console.log('   Total (centavos):', totalCentavos);
                console.log('   Total (reais):', totalReais);
                console.log('   PIX Key:', pixKey);
                console.log('   PIX Key Type:', pixKeyType);
                console.log('   Transações necessárias:', transacoes.length);
                console.log('   Valores:', transacoes.map(v => `R$ ${(v/100).toFixed(2)}`).join(', '));

                // Informar usuário sobre múltiplas transações
                if (transacoes.length > 1) {
                    let resumo = `*Resumo do Envio*\n\n`;
                    resumo += `Valor total: *R$ ${totalReais}*\n`;
                    resumo += `📦 Transações: ${transacoes.length}\n\n`;

                    // Agrupar transações iguais
                    const grupos = {};
                    transacoes.forEach(v => {
                        grupos[v] = (grupos[v] || 0) + 1;
                    });

                    Object.entries(grupos).forEach(([valor, qtd]) => {
                        resumo += `• ${qtd}x de R$ ${(valor/100).toFixed(2)}\n`;
                    });

                    resumo += `\n⏳ Processando...`;
                    await sendMessage(phoneNumber, resumo);
                }

                // Executar cada transação
                let sucessos = 0;
                let falhas = 0;
                const resultados = [];
                const user = await getUserByChatId(phoneNumber);

                for (let i = 0; i < transacoes.length; i++) {
                    const valorTransacao = transacoes[i];
                    const valorReais = (valorTransacao / 100).toFixed(2);

                    console.log(`\nRegistrando transação ${i + 1}/${transacoes.length}: R$ ${valorReais}`);

                    // clientReference único: groupId + índice (ou só clientReference se transação única)
                    const txClientRef = groupId ? `${clientReference}_${i}` : clientReference;

                    try {
                        await transactionsService.registerTransaction(
                            txClientRef,
                            phoneNumber,
                            'pix_out',
                            valorTransacao,
                            {
                                pixKey,
                                pixKeyType,
                                receiverName: command.receiverName || null,
                                groupId,
                                clientReference: txClientRef,
                                tokenuser: user?.user_token || platformToken || null,
                                botId
                            }
                        );

                        sucessos++;
                        resultados.push({
                            valor: valorReais,
                            status: 'ok',
                            id: txClientRef,
                            receiverName: command.receiverName || null
                        });

                        if (groupId) {
                            transactionsService.addTransactionToGroup(groupId, txClientRef);
                        }
                    } catch (error) {
                        falhas++;
                        resultados.push({ valor: valorReais, status: 'erro', msg: error.message });
                        console.error(`   Erro de registro: ${error.message}`);
                        if (groupId) {
                            transactionsService.markGroupTransactionFailed(groupId, valorTransacao, txClientRef);
                        }
                    }

                    if (i < transacoes.length - 1) {
                        await new Promise(resolve => setTimeout(resolve, 200));
                    }
                }

                // Enviar resultado final
                let resultMessage = '';
                if (falhas === 0) {
                    resultMessage = `⏳ *PIX em Processamento*\n\n`;
                    resultMessage += `Valor total: *R$ ${totalReais}*\n`;
                    // Mostrar nome do destinatário se disponível
                    if (resultados[0]?.receiverName) {
                        resultMessage += `Destinatário: *${resultados[0].receiverName}*\n`;
                    }
                    resultMessage += `Chave: ${pixKey}\n`;
                    resultMessage += `📦 Transações: ${sucessos}\n\n`;
                    resultMessage += `Você será notificado quando for confirmado!`;
                } else if (sucessos === 0) {
                    resultMessage = `*Erro ao enviar PIX*\n\n`;
                    resultMessage += `Nenhuma transação foi processada.\n`;
                    resultMessage += `Erro: ${resultados[0]?.msg || 'Desconhecido'}`;
                } else {
                    // Calcular valor real enviado (sucesso) e valor que falhou
                    const valorEnviado = resultados
                        .filter(r => r.status === 'ok')
                        .reduce((sum, r) => sum + parseFloat(r.valor), 0);
                    const valorFalhou = resultados
                        .filter(r => r.status === 'erro')
                        .reduce((sum, r) => sum + parseFloat(r.valor), 0);

                    resultMessage = `*PIX Parcialmente Processado*\n\n`;
                    // Mostrar nome do destinatário se disponível
                    if (resultados.find(r => r.receiverName)?.receiverName) {
                        resultMessage += `Destinatário: *${resultados.find(r => r.receiverName).receiverName}*\n`;
                    }
                    resultMessage += `Em processamento: ${sucessos} PIX (R$ ${valorEnviado.toFixed(2)})\n`;
                    resultMessage += `Falhou: ${falhas} PIX (R$ ${valorFalhou.toFixed(2)})\n\n`;
                    resultMessage += `💡 _O valor que falhou permanece na sua conta._\n`;
                    resultMessage += `Você receberá o comprovante quando as transações forem confirmadas.`;
                }

                await sendMessage(phoneNumber, resultMessage);
                break;

            case 'check_balance':
                // Consultar saldo na CREDPIX (banco de dados)
                const userBalance = await getUserByChatId(phoneNumber);
                if (!userBalance) {
                    await sendMessage(phoneNumber,
                        'Não encontrei seu cadastro na CREDPIX.\n' +
                        'Peça ao administrador para cadastrar seu número.');
                    break;
                }

                const saldoDisponivel = parseFloat(userBalance.saldo || 0);
                const saldoBloqueado = parseFloat(userBalance.reservado || 0);
                const saldoSaque = parseFloat(userBalance.limite_saque || saldoDisponivel);

                const balanceMessage = `*Seu saldo:*\n\n` +
                    `Disponível: R$ ${formatBRL(saldoDisponivel)}\n` +
                    `Bloqueado: R$ ${formatBRL(saldoBloqueado)}\n` +
                    `Para saque: R$ ${formatBRL(saldoSaque)}`;

                await sendMessage(phoneNumber, balanceMessage);
                break;

            case 'my_pix_key':
                // Mostrar chave PIX do usuário - DUAS MENSAGENS SEPARADAS
                const userPixKey = myPixKey || 'Chave não configurada';

                // Mensagem 1: Só a chave
                await sendMessage(phoneNumber, userPixKey);

                // Mensagem 2: Informações extras
                await sendMessage(phoneNumber,
                    `Compartilhe para receber pagamentos!\n💡 Esta é sua chave aleatória`);
                break;

            // ========== GERENCIAMENTO DE CONTATOS ==========

            case 'save_contact':
                // Salvar novo contato
                try {
                    const savedContact = contactsService.addContact(
                        contactsOwnerId,
                        command.name,
                        command.pixKey,
                        command.pixKeyType
                    );

                    await sendMessage(phoneNumber,
                        `*Contato salvo!*\n\n` +
                        `📒 Nome: *${savedContact.name}*\n` +
                        `Chave: ${savedContact.pixKey}\n` +
                        `Tipo: ${savedContact.pixKeyType}\n\n` +
                        `Agora você pode dizer:\n_"enviar 50 para ${savedContact.name}"_`);
                } catch (saveError) {
                    console.error('Erro ao salvar contato:', saveError.message);
                    await sendMessage(phoneNumber,
                        `Erro ao salvar contato: ${saveError.message}`);
                }
                break;

            case 'list_contacts':
                // Listar todos os contatos
                const contacts = contactsService.listContacts(contactsOwnerId);

                if (contacts.length === 0) {
                    await sendMessage(phoneNumber,
                        `📒 *Seus Contatos*\n\n` +
                        `Você ainda não tem contatos salvos.\n\n` +
                        `Para adicionar, diga:\n` +
                        `_"salvar João cpf 12345678900"_\n` +
                        `_"adicionar Maria telefone 11999999999"_`);
                } else {
                    let contactList = `📒 *Seus Contatos* (${contacts.length})\n\n`;

                    contacts.forEach((contact, index) => {
                        contactList += `${index + 1}. *${contact.name}*\n`;
                        contactList += `   ${contact.pixKey}\n`;
                        contactList += `   ${contact.pixKeyType}\n\n`;
                    });

                    contactList += `💡 Diga _"enviar 50 para [nome]"_ para transferir`;

                    await sendMessage(phoneNumber, contactList);
                }
                break;

            case 'remove_contact':
                // Remover contato
                const removed = contactsService.removeContact(contactsOwnerId, command.name);

                if (removed) {
                    await sendMessage(phoneNumber,
                        `Contato *${command.name}* removido com sucesso!`);
                } else {
                    await sendMessage(phoneNumber,
                        `Contato *${command.name}* não encontrado.\n\n` +
                        `Diga _"meus contatos"_ para ver a lista.`);
                }
                break;

            case 'send_to_contact':
                // Enviar para contato salvo
                const contact = contactsService.getContact(contactsOwnerId, command.contactName);

                if (!contact) {
                    await sendMessage(phoneNumber,
                        `Contato *${command.contactName}* não encontrado.\n\n` +
                        `Diga _"meus contatos"_ para ver seus contatos salvos.\n` +
                        `Ou _"salvar ${command.contactName} cpf 12345678900"_ para criar.`);
                    break;
                }

                console.log(`📒 Contato encontrado: ${contact.name} -> ${contact.pixKey} (${contact.pixKeyType})`);

                // Redirecionar para withdraw com os dados do contato
                const contactCommand = {
                    action: 'withdraw',
                    amount: command.amount,
                    pixKey: contact.pixKey,
                    pixKeyType: contact.pixKeyType
                };

                // Informar que está enviando para o contato
                await sendMessage(phoneNumber,
                    `📒 Enviando para *${contact.name}*...\n` +
                    `${contact.pixKey}`);

                // Executar o withdraw recursivamente (passando mesmo contactsOwnerId)
                await executePixCommand(contactCommand, phoneNumber, { contactsOwnerId, zapiCredentials, botBranding, botId });
                return; // Importante: retornar para não executar o default

            case 'ask':
                // IA está fazendo uma pergunta ao usuário
                const question = aiService.generateResponse(command);
                await sendMessage(phoneNumber, question);
                break;

            // ========== ESTORNO DE PIX ==========

            case 'search_refund':
                // Buscar PIX para estorno por valor
                try {
                    const searchAmount = command.amount; // valor do PIX em centavos (ou null para buscar últimos)
                    const refundAmount = command.refundAmount; // valor a estornar em centavos (estorno parcial)

                    // Se tem refundAmount, é estorno parcial - mostrar últimos PIX
                    const effectiveSearchAmount = refundAmount && !searchAmount ? null : searchAmount;

                    // Buscar transações que podem ser estornadas
                    const refundable = await transactionsService.findRefundableTransactions(phoneNumber, effectiveSearchAmount, 5);

                    if (refundable.length === 0) {
                        let notFoundMsg = `*Nenhum PIX encontrado para estorno*\n\n`;
                        if (searchAmount) {
                            notFoundMsg += `Não encontrei nenhum PIX recebido de R$ ${(searchAmount / 100).toFixed(2)} que possa ser estornado.\n\n`;
                        } else {
                            notFoundMsg += `Não encontrei PIX recebidos que possam ser estornados.\n\n`;
                        }
                        notFoundMsg += `📌 _Lembre-se: só é possível estornar PIX recebidos (depósitos) que ainda não foram estornados._`;
                        await sendMessage(phoneNumber, notFoundMsg);
                        break;
                    }

                    // Formatar valor do estorno parcial se existir
                    const refundAmountStr = refundAmount ? `R$ ${(refundAmount / 100).toFixed(2)}` : null;

                    if (refundable.length === 1) {
                        // Encontrou exatamente 1 - pedir confirmação
                        const tx = refundable[0];
                        const valor = (tx.amount / 100).toFixed(2);
                        const data = new Date(tx.createdAt).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });

                        // Salvar para confirmação (incluindo valor parcial se existir)
                        pendingRefundConfirmations.set(phoneNumber, {
                            transaction: tx,
                            refundAmount: refundAmount || null, // valor parcial a estornar (em centavos)
                            timestamp: Date.now()
                        });

                        let confirmMsg = `🔍 *PIX encontrado para estorno:*\n\n` +
                            `Valor do PIX: *R$ ${valor}*\n`;

                        if (refundAmount) {
                            confirmMsg += `Valor a estornar: *${refundAmountStr}* _(parcial)_\n`;
                        }

                        confirmMsg += `📅 Data: ${data}\n` +
                            `ID: ${tx.id}`;

                        await sendButtons(phoneNumber, confirmMsg, [
                            { id: 'sim', label: refundAmount ? 'Estornar parcial' : 'Sim, estornar' },
                            { id: 'nao', label: '❌ Cancelar' }
                        ]);
                    } else {
                        // Encontrou múltiplos - listar e pedir para escolher
                        let listMsg = refundAmount
                            ? `🔍 *De qual PIX você quer estornar ${refundAmountStr}?*\n\n`
                            : `🔍 *Encontrei ${refundable.length} PIX que podem ser estornados:*\n\n`;

                        refundable.forEach((tx, index) => {
                            const valor = (tx.amount / 100).toFixed(2);
                            const data = new Date(tx.createdAt).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
                            listMsg += `*${index + 1}.* R$ ${valor} - ${data}\n`;
                            listMsg += `   _ID: ${tx.id.substring(0, 20)}..._\n\n`;
                        });

                        // Se só tem um valor, usar o primeiro
                        if (searchAmount && refundable.every(tx => tx.amount === searchAmount)) {
                            const tx = refundable[0];
                            pendingRefundConfirmations.set(phoneNumber, {
                                transaction: tx,
                                refundAmount: refundAmount || null,
                                timestamp: Date.now()
                            });
                            listMsg += `💡 _Selecionei o mais recente automaticamente._`;

                            // Enviar lista com botões
                            await sendButtons(phoneNumber, listMsg, [
                                { id: 'sim', label: refundAmount ? 'Estornar parcial' : 'Sim, estornar' },
                                { id: 'nao', label: '❌ Cancelar' }
                            ]);
                        } else {
                            listMsg += `💡 _Responda com o número (1, 2, 3...) do PIX que deseja estornar._`;

                            // Salvar lista para seleção
                            pendingRefundConfirmations.set(phoneNumber, {
                                transactionList: refundable,
                                refundAmount: refundAmount || null,
                                timestamp: Date.now()
                            });

                            await sendMessage(phoneNumber, listMsg);
                        }
                    }
                } catch (searchError) {
                    console.error('Erro ao buscar PIX para estorno:', searchError.message);
                    await sendMessage(phoneNumber,
                        `Erro ao buscar transações: ${searchError.message}`);
                }
                break;

            case 'refund':
                // Estornar um PIX recebido (registro na CREDPIX)
                try {
                    const transactionId = command.transactionId;
                    const reason = command.reason || 'Devolução solicitada pelo cliente';

                    if (!transactionId) {
                        await sendMessage(phoneNumber,
                            `*ID do PIX não informado*\n\n` +
                            `Para estornar um PIX, preciso do ID da transação.\n\n` +
                            `Você pode encontrar o ID no comprovante do PIX recebido.`);
                        break;
                    }

                    const partialRefundAmount = command.refundAmount;
                    if (partialRefundAmount) {
                        const partialReais = (partialRefundAmount / 100).toFixed(2);
                        await sendMessage(phoneNumber, `⏳ Registrando estorno parcial de R$ ${partialReais}...`);
                    } else {
                        await sendMessage(phoneNumber, '⏳ Registrando estorno...');
                    }

                    const transaction = await transactionsService.getTransaction(transactionId);
                    if (!transaction) {
                        await sendMessage(phoneNumber,
                            `Transação não encontrada. Verifique se o ID está correto.`);
                        break;
                    }

                    const refundAmountCents = partialRefundAmount || transaction.amount;
                    const refundAmountReais = (refundAmountCents / 100).toFixed(2);

                    await transactionsService.updateTransaction(transactionId, 'REFUND_REQUESTED', {
                        refundAmount: refundAmountReais,
                        refundReason: reason
                    });

                    await transactionsService.markAsRefunded(transactionId);

                    let successMsg = `✅ *Estorno solicitado com sucesso!*\n\n` +
                        `Valor: *R$ ${formatBRL(refundAmountReais)}*`;

                    if (partialRefundAmount) {
                        successMsg += ` _(parcial)_`;
                    }

                    successMsg += `\nMotivo: ${reason}\n` +
                        `ID: ${transactionId}\n\n` +
                        `⏳ _O estorno será processado pela CREDPIX._`;

                    await sendMessage(phoneNumber, successMsg);
                } catch (refundError) {
                    console.error('Erro no estorno:', refundError.message);
                    await sendMessage(phoneNumber,
                        `*Erro ao estornar PIX*\n\n${refundError.message}`);
                }
                break;

            case 'help':
            case 'clarification_needed':
            case 'error':
            case 'unknown':
                const helpMessage = aiService.generateResponse(command);
                await sendMessage(phoneNumber, helpMessage);
                break;

            default:
                await sendMessage(
                    phoneNumber,
                    'Desculpe, não consegui processar seu pedido. Digite "ajuda" para ver os comandos.'
                );
        }

    } catch (error) {
        console.error('Erro ao executar comando:', error.message);
        await sendMessage(
            phoneNumber,
            `Erro ao processar: ${error.message}\n\nTente novamente ou digite "ajuda".`
        );
    }
}

// ========== ROTAS PIX ==========

// Rota para PIX In (Depósito) - CREDPIX
app.post('/api/pix-in', async (req, res) => {
    try {
        const { amount, chatid, phone, postbackUrl } = req.body;
        const ownerChatId = chatid || phone;

        if (!ownerChatId || !amount) {
            return res.status(400).json({
                error: true,
                message: 'Informe chatid (ou phone) e amount.'
            });
        }

        const amountInReais = (amount / 100).toFixed(2);
        const identifier = transactionsService.generateClientReference();
        const copiaECola = `CREDPIX-${identifier}`;
        const user = await getUserByChatId(ownerChatId);

        await transactionsService.registerTransaction(identifier, ownerChatId, 'pix_in', amount, {
            brCode: copiaECola,
            tokenuser: user?.user_token || CREDPIX_TOKEN || null,
            callbackUrl: postbackUrl || null
        });

        return res.json({
            success: true,
            id: identifier,
            status: 'PENDING',
            amount,
            expirationDate: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
            pixCopiaECola: copiaECola,
            brcode: copiaECola
        });
    } catch (error) {
        console.error('💥 Erro ao processar depósito:', error.message);
        res.status(500).json({
            error: true,
            message: 'Erro ao processar depósito',
            details: error.message
        });
    }
});

// Rota para PIX Out (Saque) - CREDPIX
app.post('/api/pix-out', async (req, res) => {
    try {
        const { amount, pixKey, pixKeyType, chatid, phone } = req.body;
        const ownerChatId = chatid || phone;

        if (!ownerChatId || !amount || !pixKey || !pixKeyType) {
            return res.status(400).json({
                error: true,
                message: 'Informe chatid (ou phone), amount, pixKey e pixKeyType.'
            });
        }

        const amountInReais = (amount / 100).toFixed(2);
        const user = await getUserByChatId(ownerChatId);
        const identifier = transactionsService.generateClientReference();

        await transactionsService.registerTransaction(identifier, ownerChatId, 'pix_out', amount, {
            pixKey,
            pixKeyType,
            tokenuser: user?.user_token || CREDPIX_TOKEN || null
        });

        return res.json({
            success: true,
            id: identifier,
            status: 'PENDING',
            amount,
            amountReais: amountInReais
        });
    } catch (error) {
        console.error('💥 Erro ao processar saque:', error.message);
        res.status(500).json({
            error: true,
            message: 'Erro ao processar saque',
            details: error.message
        });
    }
});

// Rota para consultar saldo em conta - CREDPIX
app.get('/api/balance', async (req, res) => {
    try {
        const chatid = req.query.chatid || req.query.phone;
        if (!chatid) {
            return res.status(400).json({ error: true, message: 'Informe chatid ou phone.' });
        }

        const user = await getUserByChatId(chatid);
        if (!user) {
            return res.status(404).json({ error: true, message: 'Usuário não encontrado.' });
        }

        const saldoDisponivel = parseFloat(user.saldo || 0);
        const saldoBloqueado = parseFloat(user.reservado || 0);
        const saldoSaque = parseFloat(user.limite_saque || saldoDisponivel);

        return res.json({
            balance: Math.round(saldoDisponivel * 100),
            balanceAvailable: Math.round(saldoDisponivel * 100),
            balanceBlocked: Math.round(saldoBloqueado * 100),
            balanceAvailableWithdraw: Math.round(saldoSaque * 100)
        });
    } catch (error) {
        console.error('💥 Erro ao consultar saldo:', error.message);
        res.status(500).json({
            error: true,
            message: 'Erro ao consultar saldo',
            details: error.message
        });
    }
});

// Rota para consultar status de PIX In (Depósito) - CREDPIX
app.get('/api/pix-in/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const rows = await db.query(
            'SELECT identifier, status, valor, data_criacao, brCode FROM pagamentos WHERE identifier = ? LIMIT 1',
            [id]
        );

        if (rows.length === 0) {
            return res.status(404).json({
                error: true,
                message: 'PIX não encontrado'
            });
        }

        const row = rows[0];
        return res.json({
            success: true,
            id: row.identifier,
            status: row.status,
            amount: Math.round(parseFloat(row.valor) * 100),
            expirationDate: row.data_criacao,
            pixCopiaECola: row.brCode || '',
            brcode: row.brCode || ''
        });
    } catch (error) {
        console.error('💥 Erro ao consultar status:', error.message);
        res.status(500).json({
            error: true,
            message: 'Erro ao consultar status',
            details: error.message
        });
    }
});

// Rota para consultar status de PIX Out (Saque) - CREDPIX
app.get('/api/pix-out/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const rows = await db.query(
            'SELECT txid, status, value, created_at FROM saques_pix WHERE txid = ? LIMIT 1',
            [id]
        );

        if (rows.length === 0) {
            return res.status(404).json({
                error: true,
                message: 'Saque não encontrado'
            });
        }

        const row = rows[0];
        return res.json({
            id: row.txid,
            status: row.status,
            amount: Math.round(parseFloat(row.value) * 100),
            createdAt: row.created_at
        });
    } catch (error) {
        console.error('💥 Erro ao consultar status:', error.message);
        res.status(500).json({
            error: true,
            message: 'Erro ao consultar status',
            details: error.message
        });
    }
});

// Rota de status
app.get('/api/status', (req, res) => {
    res.json({
        status: 'online',
        mode: 'PRODUCTION',
        message: 'Sistema conectado à CREDPIX',
        apiStatus: 'FUNCIONANDO',
        pixIn: true,
        pixOut: true,
        timestamp: new Date().toISOString()
    });
});

// ========== ROTAS DO PAINEL ADMIN ==========
// Todas as rotas /admin e /api/admin são protegidas por IP

// Página do painel admin
app.get('/admin', requireAdminIP, (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
});

// Status da configuração admin
app.get('/api/admin/config-status', requireAdminIP, (req, res) => {
    res.json(adminAuth.getConfigStatus());
});

// Setup inicial do 2FA
app.post('/api/admin/setup-2fa', requireAdminIP, async (req, res) => {
    try {
        const { password } = req.body;

        if (!password) {
            return res.status(400).json({ error: 'Senha é obrigatória' });
        }

        const result = await adminAuth.setup2FA(password);
        res.json(result);
    } catch (error) {
        console.error('Erro no setup 2FA:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Login admin
app.post('/api/admin/login', requireAdminIP, (req, res) => {
    try {
        const { password, totpCode } = req.body;

        if (!password) {
            return res.status(400).json({ error: 'Senha é obrigatória' });
        }

        const result = adminAuth.processLogin(password, totpCode);

        if (result.success) {
            // Definir cookie de sessão
            res.cookie('admin_session', result.token, {
                httpOnly: true,
                secure: process.env.NODE_ENV === 'production',
                maxAge: 24 * 60 * 60 * 1000 // 24 horas
            });
        }

        res.json(result);
    } catch (error) {
        console.error('Erro no login:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Logout admin
app.post('/api/admin/logout', requireAdminIP, (req, res) => {
    res.clearCookie('admin_session');
    res.json({ success: true, message: 'Logout realizado' });
});

// Verificar sessão admin
app.get('/api/admin/session', requireAdminIP, adminAuth.requireAuth, (req, res) => {
    res.json({ authenticated: true, admin: req.admin });
});

// ========== ROTAS DE BOTS (PROTEGIDAS) ==========
// Requer IP permitido + autenticação admin

// Listar todos os bots
app.get('/api/bots', requireAdminIP, adminAuth.requireAuth, (req, res) => {
    try {
        const bots = botService.listBots();
        // Não expor tokens completos na listagem
        const safeBots = bots.map(b => ({
            id: b.id,
            name: b.name,
            brandName: b.brandName,
            whatsappNumber: b.whatsappNumber,
            active: b.active !== false
        }));
        res.json(safeBots);
    } catch (error) {
        console.error('Erro ao listar bots:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// ========== ROTAS DE TENANTS (PROTEGIDAS) ==========
// Requer IP permitido + autenticação admin

// Listar todos os tenants
app.get('/api/tenants', requireAdminIP, adminAuth.requireAuth, (req, res) => {
    try {
        const tenants = tenantService.listTenants();
        // Não expor tokens completos na listagem
        const safeTenants = tenants.map(t => ({
            ...t,
            platformToken: t.platformToken ? `${t.platformToken.substring(0, 10)}...` : null
        }));
        res.json(safeTenants);
    } catch (error) {
        console.error('Erro ao listar tenants:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Obter estatísticas dos tenants
app.get('/api/tenants/stats', requireAdminIP, adminAuth.requireAuth, (req, res) => {
    try {
        res.json(tenantService.getStats());
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Criar novo tenant
app.post('/api/tenants', requireAdminIP, adminAuth.requireAuth, (req, res) => {
    try {
        const { name, platformToken, myPixKey, authorizedNumbers } = req.body;

        if (!name || !platformToken) {
            return res.status(400).json({ error: 'Nome e token CREDPIX são obrigatórios' });
        }

        const tenant = tenantService.createTenant({
            name,
            platformToken,
            myPixKey,
            authorizedNumbers: authorizedNumbers || []
        });

        res.status(201).json(tenant);
    } catch (error) {
        console.error('Erro ao criar tenant:', error.message);
        res.status(400).json({ error: error.message });
    }
});

// Obter tenant específico
app.get('/api/tenants/:id', requireAdminIP, adminAuth.requireAuth, (req, res) => {
    try {
        const tenant = tenantService.getTenantById(req.params.id);
        if (!tenant) {
            return res.status(404).json({ error: 'Cliente não encontrado' });
        }
        res.json(tenant);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Atualizar tenant
app.put('/api/tenants/:id', requireAdminIP, adminAuth.requireAuth, (req, res) => {
    try {
        const tenant = tenantService.updateTenant(req.params.id, req.body);
        res.json(tenant);
    } catch (error) {
        console.error('Erro ao atualizar tenant:', error.message);
        res.status(400).json({ error: error.message });
    }
});

// Deletar tenant
app.delete('/api/tenants/:id', requireAdminIP, adminAuth.requireAuth, (req, res) => {
    try {
        tenantService.deleteTenant(req.params.id);
        res.json({ success: true, message: 'Cliente removido' });
    } catch (error) {
        console.error('Erro ao deletar tenant:', error.message);
        res.status(400).json({ error: error.message });
    }
});

// Iniciar servidor
app.listen(PORT, () => {
    console.log(`
    ╔══════════════════════════════════════════════╗
    ║   CREDPIX PIX Manager - FUNCIONANDO!     ║
    ╠══════════════════════════════════════════════╣
    ║                                              ║
    ║  🚀 Servidor rodando em:                     ║
    ║     http://localhost:${PORT}                  ║
    ║                                              ║
    ║  📁 Acesse o sistema em:                     ║
    ║     http://localhost:${PORT}/index.html       ║
    ║                                              ║
    ║  Status: CREDPIX ATIVA                       ║
    ║  PIX In: Gerando cobranças                   ║
    ║  PIX Out: Processando saques                 ║
    ║                                              ║
    ║   LEMBRE: Saques requerem validação!     ║
    ║                                              ║
    ╚══════════════════════════════════════════════╝

    💡 Esta versão usa o banco CREDPIX.
    📌 Base URL configurada: ${CREDPIX_BASE_URL || 'não definida'}
    `);
});
