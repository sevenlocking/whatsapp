// Serviço de Mídia - Processamento de Áudio (Whisper) e Imagem (GPT-4 Vision)
require('dotenv').config();
const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Polyfill para Node.js < 20 (Railway pode usar versão antiga)
if (typeof globalThis.File === 'undefined') {
    const { File } = require('node:buffer');
    globalThis.File = File;
    console.log('📦 Polyfill File adicionado para Node.js');
}

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

/**
 * Baixar arquivo de uma URL usando curl (mais robusto)
 * @param {string} url - URL do arquivo
 * @param {string} destPath - Caminho de destino
 * @returns {Promise<string>} Caminho do arquivo baixado
 */
async function downloadFile(url, destPath) {
    try {
        console.log('📥 Baixando arquivo com curl...');
        console.log('   URL:', url);
        console.log('   Destino:', destPath);

        // Usar curl para download (mais robusto que http/https nativos)
        // -L: seguir redirects
        // -o: salvar no arquivo
        // -s: silencioso
        // -S: mostrar erros
        // --max-time: timeout de 30 segundos
        const curlCmd = `curl -L -o "${destPath}" -s -S --max-time 30 "${url}"`;
        execSync(curlCmd, { encoding: 'utf-8' });

        // Verificar se o arquivo foi baixado
        if (!fs.existsSync(destPath)) {
            throw new Error('Arquivo não foi criado');
        }

        const stats = fs.statSync(destPath);
        console.log('   ✅ Baixado:', stats.size, 'bytes');

        if (stats.size === 0) {
            throw new Error('Arquivo baixado está vazio');
        }

        return destPath;

    } catch (error) {
        console.error('❌ Erro no download:', error.message);
        if (fs.existsSync(destPath)) {
            fs.unlinkSync(destPath);
        }
        throw error;
    }
}

/**
 * Transcrever áudio usando Whisper
 * @param {string} audioUrl - URL do áudio (do Z-API)
 * @returns {Promise<string>} Texto transcrito
 */
async function transcribeAudio(audioUrl) {
    // Detectar extensão do arquivo pela URL
    let extension = '.ogg'; // Padrão do WhatsApp
    if (audioUrl.includes('.mp3')) extension = '.mp3';
    else if (audioUrl.includes('.m4a')) extension = '.m4a';
    else if (audioUrl.includes('.wav')) extension = '.wav';
    else if (audioUrl.includes('.webm')) extension = '.webm';
    else if (audioUrl.includes('.opus')) extension = '.opus';

    const tempDir = '/tmp';
    const tempFile = path.join(tempDir, `audio_${Date.now()}${extension}`);

    try {
        console.log('\n🎤 === INICIANDO TRANSCRIÇÃO DE ÁUDIO ===');
        console.log('🔗 URL do áudio:', audioUrl);
        console.log('📁 Extensão detectada:', extension);

        // Baixar o áudio
        await downloadFile(audioUrl, tempFile);

        // Verificar se o arquivo existe e tem conteúdo
        if (!fs.existsSync(tempFile)) {
            throw new Error('Arquivo de áudio não foi criado');
        }

        const stats = fs.statSync(tempFile);
        console.log('📊 Tamanho do áudio:', stats.size, 'bytes');

        if (stats.size < 100) {
            throw new Error(`Arquivo de áudio muito pequeno: ${stats.size} bytes`);
        }

        // Enviar para Whisper
        console.log('🤖 Enviando para OpenAI Whisper...');
        const transcription = await openai.audio.transcriptions.create({
            file: fs.createReadStream(tempFile),
            model: 'whisper-1',
            language: 'pt', // Português brasileiro
            response_format: 'text'
        });

        console.log('✅ Transcrição concluída!');
        console.log('📝 Texto:', transcription);

        // Limpar arquivo temporário
        fs.unlinkSync(tempFile);
        console.log('🧹 Arquivo temporário removido');

        return transcription;

    } catch (error) {
        // Limpar arquivo temporário em caso de erro
        if (fs.existsSync(tempFile)) {
            try { fs.unlinkSync(tempFile); } catch (e) {}
        }
        console.error('❌ Erro na transcrição:', error.message);
        console.error('   Stack:', error.stack);
        throw error;
    }
}

/**
 * Analisar imagem usando GPT-4 Vision para extrair chave PIX
 * @param {string} imageUrl - URL da imagem (do Z-API)
 * @param {string} userContext - Contexto adicional do usuário (opcional)
 * @returns {Promise<object>} Objeto com informações extraídas
 */
async function analyzeImage(imageUrl, userContext = '') {
    try {
        console.log('🖼️ Analisando imagem:', imageUrl);

        const prompt = `Analise esta imagem e extraia informações de chave PIX.

PROCURE POR:
1. CPF (11 dígitos, formato: XXX.XXX.XXX-XX ou apenas números)
2. CNPJ (14 dígitos, formato: XX.XXX.XXX/XXXX-XX ou apenas números)
3. Telefone (10-13 dígitos, pode ter +55, DDD, etc)
4. Email (qualquer endereço de email)
5. Chave aleatória/EVP (formato UUID: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)
6. QR Code de PIX (se houver, tente identificar)

${userContext ? `Contexto do usuário: ${userContext}` : ''}

RESPONDA APENAS COM JSON no formato:
{
  "found": true/false,
  "pixKey": "chave encontrada (apenas números para CPF/CNPJ/telefone)",
  "pixKeyType": "cpf" | "cnpj" | "phone" | "email" | "evp",
  "confidence": "alta" | "media" | "baixa",
  "rawText": "texto original encontrado na imagem",
  "description": "breve descrição do que foi encontrado"
}

Se não encontrar nenhuma chave PIX válida, retorne:
{
  "found": false,
  "description": "descrição do que foi visto na imagem"
}`;

        const response = await openai.chat.completions.create({
            model: 'gpt-4o', // GPT-4 Vision
            messages: [
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: prompt },
                        {
                            type: 'image_url',
                            image_url: {
                                url: imageUrl,
                                detail: 'high' // Alta qualidade para melhor OCR
                            }
                        }
                    ]
                }
            ],
            max_tokens: 500,
            response_format: { type: 'json_object' }
        });

        const result = JSON.parse(response.choices[0].message.content);
        console.log('✅ Análise da imagem:', result);

        return result;

    } catch (error) {
        console.error('❌ Erro na análise da imagem:', error.message);
        throw error;
    }
}

/**
 * Processar imagem com contexto de valor (quando usuário manda imagem após pedir transferência)
 * @param {string} imageUrl - URL da imagem
 * @param {number} amount - Valor em centavos (se já informado)
 * @returns {Promise<object>} Comando de withdraw ou erro
 */
async function processImageForTransfer(imageUrl, amount = null) {
    try {
        const analysis = await analyzeImage(imageUrl);

        if (!analysis.found) {
            return {
                action: 'error',
                message: `Não encontrei uma chave PIX nesta imagem.\n\n${analysis.description || 'Tente enviar uma foto mais clara ou digite a chave manualmente.'}`
            };
        }

        // Se temos a chave mas não o valor, perguntar
        if (!amount) {
            return {
                action: 'ask_amount_for_image',
                pixKey: analysis.pixKey,
                pixKeyType: analysis.pixKeyType,
                message: `🔑 Encontrei a chave PIX!\n\n` +
                    `📝 Tipo: *${analysis.pixKeyType.toUpperCase()}*\n` +
                    `🔑 Chave: ${analysis.pixKey}\n\n` +
                    `💰 Qual o valor que deseja enviar?`
            };
        }

        // Temos tudo, retornar comando de withdraw
        return {
            action: 'withdraw',
            amount: amount,
            pixKey: analysis.pixKey,
            pixKeyType: analysis.pixKeyType,
            fromImage: true,
            confidence: analysis.confidence
        };

    } catch (error) {
        return {
            action: 'error',
            message: `Erro ao analisar imagem: ${error.message}`
        };
    }
}

module.exports = {
    transcribeAudio,
    analyzeImage,
    processImageForTransfer,
    downloadFile
};
