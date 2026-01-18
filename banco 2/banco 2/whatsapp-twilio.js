// Serviço WhatsApp com Twilio
require('dotenv').config();
const twilio = require('twilio');

// Configurações do Twilio
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const whatsappNumber = process.env.TWILIO_WHATSAPP_NUMBER;

// Cliente Twilio
const client = twilio(accountSid, authToken);

/**
 * Enviar mensagem de texto para WhatsApp
 */
async function sendMessage(to, message) {
    try {
        // Formatar número do destinatário
        const toNumber = to.startsWith('whatsapp:') ? to : `whatsapp:${to}`;

        console.log(`\n📤 Enviando mensagem para: ${toNumber}`);

        const result = await client.messages.create({
            body: message,
            from: whatsappNumber,
            to: toNumber
        });

        console.log('✅ Mensagem enviada:', result.sid);
        return result;

    } catch (error) {
        console.error('❌ Erro ao enviar mensagem:', error.message);
        throw error;
    }
}

/**
 * Enviar imagem (QR Code PIX) para WhatsApp
 */
async function sendImage(to, imageBase64, caption) {
    try {
        const toNumber = to.startsWith('whatsapp:') ? to : `whatsapp:${to}`;

        console.log(`\n📤 Enviando imagem para: ${toNumber}`);

        // Twilio espera uma URL pública para a imagem
        // Vamos incluir a imagem base64 inline na mensagem
        const result = await client.messages.create({
            body: caption || 'QR Code PIX',
            from: whatsappNumber,
            to: toNumber,
            mediaUrl: [imageBase64] // Twilio aceita URLs públicas
        });

        console.log('✅ Imagem enviada:', result.sid);
        return result;

    } catch (error) {
        console.error('❌ Erro ao enviar imagem:', error.message);
        // Se falhar, enviar apenas o texto
        return await sendMessage(to, caption);
    }
}

/**
 * Formatar número de telefone para Twilio
 */
function formatPhoneNumber(phone) {
    // Remover 'whatsapp:' se já existir
    let cleaned = phone.replace('whatsapp:', '');

    // Remover caracteres não numéricos
    cleaned = cleaned.replace(/\D/g, '');

    // Se não começa com +, adicionar + e código do país
    if (!cleaned.startsWith('+')) {
        // Se não tem código de país, assumir Brasil (+55)
        if (cleaned.length <= 11) {
            cleaned = '+55' + cleaned;
        } else {
            cleaned = '+' + cleaned;
        }
    }

    return `whatsapp:${cleaned}`;
}

module.exports = {
    sendMessage,
    sendImage,
    formatPhoneNumber
};
