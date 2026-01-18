// Serviço WhatsApp com Z-API (suporte a múltiplos bots)
require('dotenv').config();
const https = require('https');

// Configurações padrão do Z-API (fallback para variáveis de ambiente)
const DEFAULT_ZAPI_INSTANCE = process.env.ZAPI_INSTANCE;
const DEFAULT_ZAPI_TOKEN = process.env.ZAPI_TOKEN;
const DEFAULT_ZAPI_CLIENT_TOKEN = process.env.ZAPI_CLIENT_TOKEN;

// Validar credenciais padrão
if (!DEFAULT_ZAPI_INSTANCE || !DEFAULT_ZAPI_TOKEN) {
    console.warn('⚠️ AVISO: Credenciais Z-API padrão não configuradas no .env!');
    console.warn('   Os bots precisam ter suas próprias credenciais configuradas.');
}

/**
 * Obter credenciais Z-API (dinâmicas ou padrão)
 * @param {object} credentials - Credenciais opcionais do bot
 * @returns {object} - Credenciais a usar
 */
function getCredentials(credentials) {
    console.log(`🔐 getCredentials recebeu:`, {
        instance: credentials?.instance?.substring(0, 10) || '(vazio)',
        token: credentials?.token?.substring(0, 8) || '(vazio)',
        hasClientToken: !!credentials?.clientToken
    });

    const result = {
        instance: credentials?.instance || DEFAULT_ZAPI_INSTANCE,
        token: credentials?.token || DEFAULT_ZAPI_TOKEN,
        clientToken: credentials?.clientToken || DEFAULT_ZAPI_CLIENT_TOKEN
    };

    console.log(`🔐 getCredentials retornando:`, {
        instance: result.instance?.substring(0, 10) || '(vazio)',
        token: result.token?.substring(0, 8) || '(vazio)',
        usouFallback: !credentials?.instance || !credentials?.token
    });

    return result;
}

/**
 * Enviar mensagem de texto para WhatsApp via Z-API
 * @param {string} to - Número do destinatário
 * @param {string} message - Mensagem a enviar
 * @param {object} credentials - Credenciais Z-API opcionais {instance, token, clientToken}
 */
async function sendMessage(to, message, credentials = null) {
    const creds = getCredentials(credentials);

    if (!creds.instance || !creds.token) {
        throw new Error('Credenciais Z-API não configuradas');
    }

    return new Promise((resolve, reject) => {
        try {
            // Formatar número do destinatário (remover whatsapp: se existir)
            let phoneNumber = to.replace('whatsapp:', '').replace(/\D/g, '');

            // Se não começa com código do país, adicionar Brasil (+55)
            if (!phoneNumber.startsWith('55') && phoneNumber.length <= 11) {
                phoneNumber = '55' + phoneNumber;
            }

            console.log(`\n📤 Enviando mensagem Z-API para: ${phoneNumber}`);
            console.log(`📝 Mensagem: ${message.substring(0, 50)}...`);
            console.log(`🔗 Z-API URL: https://api.z-api.io/instances/${creds.instance}/token/${creds.token?.substring(0, 8)}***/send-text`);

            // Preparar dados
            const postData = JSON.stringify({
                phone: phoneNumber,
                message: message
            });

            // Configurar requisição
            const options = {
                hostname: 'api.z-api.io',
                port: 443,
                path: `/instances/${creds.instance}/token/${creds.token}/send-text`,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(postData)
                }
            };

            // Adicionar Client-Token se configurado
            if (creds.clientToken) {
                options.headers['Client-Token'] = creds.clientToken;
            }

            // Fazer requisição
            const req = https.request(options, (res) => {
                let data = '';

                res.on('data', (chunk) => {
                    data += chunk;
                });

                res.on('end', () => {
                    try {
                        const response = JSON.parse(data);

                        if (res.statusCode === 200) {
                            console.log('✅ Mensagem enviada com sucesso!');
                            console.log('   Z-API ID:', response.zaapId);
                            console.log('   WhatsApp ID:', response.messageId);
                            resolve(response);
                        } else {
                            console.error('❌ Erro ao enviar mensagem:', res.statusCode, data);
                            reject(new Error(`Erro ${res.statusCode}: ${data}`));
                        }
                    } catch (error) {
                        console.error('❌ Erro ao processar resposta:', error.message);
                        reject(error);
                    }
                });
            });

            req.on('error', (error) => {
                console.error('❌ Erro na requisição:', error.message);
                reject(error);
            });

            // Enviar dados
            req.write(postData);
            req.end();

        } catch (error) {
            console.error('❌ Erro ao enviar mensagem:', error.message);
            reject(error);
        }
    });
}

/**
 * Enviar imagem para WhatsApp via Z-API
 * Aceita tanto URL quanto base64 (com prefixo data:image/...)
 * @param {string} to - Número do destinatário
 * @param {string} imageUrlOrBase64 - URL da imagem ou string base64
 * @param {string} caption - Legenda da imagem
 * @param {object} credentials - Credenciais Z-API opcionais {instance, token, clientToken}
 */
async function sendImage(to, imageUrlOrBase64, caption, credentials = null) {
    const creds = getCredentials(credentials);

    if (!creds.instance || !creds.token) {
        throw new Error('Credenciais Z-API não configuradas');
    }

    return new Promise((resolve, reject) => {
        try {
            // Formatar número do destinatário
            let phoneNumber = to.replace('whatsapp:', '').replace(/\D/g, '');

            if (!phoneNumber.startsWith('55') && phoneNumber.length <= 11) {
                phoneNumber = '55' + phoneNumber;
            }

            const isBase64 = imageUrlOrBase64.startsWith('data:image');
            console.log(`\n📤 Enviando imagem Z-API para: ${phoneNumber} (${isBase64 ? 'base64' : 'URL'})`);
            console.log(`🔗 Z-API URL: https://api.z-api.io/instances/${creds.instance}/token/${creds.token?.substring(0, 8)}***/send-image`);

            // Preparar dados
            const postData = JSON.stringify({
                phone: phoneNumber,
                image: imageUrlOrBase64,
                caption: caption || ''
            });

            // Configurar requisição
            const options = {
                hostname: 'api.z-api.io',
                port: 443,
                path: `/instances/${creds.instance}/token/${creds.token}/send-image`,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(postData)
                }
            };

            // Adicionar Client-Token se configurado
            if (creds.clientToken) {
                options.headers['Client-Token'] = creds.clientToken;
            }

            // Fazer requisição
            const req = https.request(options, (res) => {
                let data = '';

                res.on('data', (chunk) => {
                    data += chunk;
                });

                res.on('end', () => {
                    try {
                        const response = JSON.parse(data);

                        if (res.statusCode === 200) {
                            console.log('✅ Imagem enviada com sucesso!');
                            resolve(response);
                        } else {
                            console.error('❌ Erro ao enviar imagem:', res.statusCode, data);
                            // Se falhar, tentar enviar apenas o texto
                            console.log('⚠️ Tentando enviar apenas o texto...');
                            sendMessage(to, caption, credentials).then(resolve).catch(reject);
                        }
                    } catch (error) {
                        console.error('❌ Erro ao processar resposta:', error.message);
                        reject(error);
                    }
                });
            });

            req.on('error', (error) => {
                console.error('❌ Erro na requisição:', error.message);
                // Se falhar, tentar enviar apenas o texto
                sendMessage(to, caption, credentials).then(resolve).catch(reject);
            });

            // Enviar dados
            req.write(postData);
            req.end();

        } catch (error) {
            console.error('❌ Erro ao enviar imagem:', error.message);
            // Se falhar, enviar apenas o texto
            sendMessage(to, caption, credentials).then(resolve).catch(reject);
        }
    });
}

/**
 * Enviar mensagem com botões para WhatsApp via Z-API
 * @param {string} to - Número do destinatário
 * @param {string} message - Mensagem de texto
 * @param {Array<{id: string, label: string}>} buttons - Lista de botões
 * @param {object} credentials - Credenciais Z-API opcionais {instance, token, clientToken}
 */
async function sendButtons(to, message, buttons, credentials = null) {
    const creds = getCredentials(credentials);

    if (!creds.instance || !creds.token) {
        throw new Error('Credenciais Z-API não configuradas');
    }

    return new Promise((resolve, reject) => {
        try {
            // Formatar número do destinatário
            let phoneNumber = to.replace('whatsapp:', '').replace(/\D/g, '');

            if (!phoneNumber.startsWith('55') && phoneNumber.length <= 11) {
                phoneNumber = '55' + phoneNumber;
            }

            console.log(`\n📤 Enviando botões Z-API para: ${phoneNumber}`);
            console.log(`📝 Mensagem: ${message.substring(0, 50)}...`);
            console.log(`🔘 Botões: ${buttons.map(b => b.label).join(', ')}`);

            // Preparar dados
            const postData = JSON.stringify({
                phone: phoneNumber,
                message: message,
                buttonList: {
                    buttons: buttons
                }
            });

            // Configurar requisição
            const options = {
                hostname: 'api.z-api.io',
                port: 443,
                path: `/instances/${creds.instance}/token/${creds.token}/send-button-list`,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(postData)
                }
            };

            // Adicionar Client-Token se configurado
            if (creds.clientToken) {
                options.headers['Client-Token'] = creds.clientToken;
            }

            // Fazer requisição
            const req = https.request(options, (res) => {
                let data = '';

                res.on('data', (chunk) => {
                    data += chunk;
                });

                res.on('end', () => {
                    try {
                        const response = JSON.parse(data);

                        if (res.statusCode === 200) {
                            console.log('✅ Botões enviados com sucesso!');
                            resolve(response);
                        } else {
                            console.error('❌ Erro ao enviar botões:', res.statusCode, data);
                            // Se falhar, tentar enviar mensagem normal
                            console.log('⚠️ Tentando enviar como mensagem normal...');
                            const fallbackMessage = `${message}\n\nResponda:\n${buttons.map(b => `• ${b.label}`).join('\n')}`;
                            sendMessage(to, fallbackMessage, credentials).then(resolve).catch(reject);
                        }
                    } catch (error) {
                        console.error('❌ Erro ao processar resposta:', error.message);
                        reject(error);
                    }
                });
            });

            req.on('error', (error) => {
                console.error('❌ Erro na requisição:', error.message);
                // Se falhar, tentar enviar mensagem normal
                const fallbackMessage = `${message}\n\nResponda:\n${buttons.map(b => `• ${b.label}`).join('\n')}`;
                sendMessage(to, fallbackMessage, credentials).then(resolve).catch(reject);
            });

            // Enviar dados
            req.write(postData);
            req.end();

        } catch (error) {
            console.error('❌ Erro ao enviar botões:', error.message);
            // Se falhar, enviar mensagem normal
            const fallbackMessage = `${message}\n\nResponda:\n${buttons.map(b => `• ${b.label}`).join('\n')}`;
            sendMessage(to, fallbackMessage, credentials).then(resolve).catch(reject);
        }
    });
}

/**
 * Formatar número de telefone para Z-API
 */
function formatPhoneNumber(phone) {
    // Remover 'whatsapp:' se já existir
    let cleaned = phone.replace('whatsapp:', '');

    // Remover caracteres não numéricos
    cleaned = cleaned.replace(/\D/g, '');

    // Se não começa com código de país, assumir Brasil (+55)
    if (!cleaned.startsWith('55') && cleaned.length <= 11) {
        cleaned = '55' + cleaned;
    }

    return cleaned;
}

module.exports = {
    sendMessage,
    sendImage,
    sendButtons,
    formatPhoneNumber
};
