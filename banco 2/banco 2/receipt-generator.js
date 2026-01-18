// Gerador de Comprovantes PIX em Imagem (suporte a múltiplos bots/branding)
const nodeHtmlToImage = require('node-html-to-image');
const path = require('path');
const fs = require('fs');

// Logo PayZu padrão em base64 (usado como fallback)
const DEFAULT_LOGO = 'data:image/png;base64,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';
const DEFAULT_PRIMARY_COLOR = '#14ce71';
const DEFAULT_BRAND_NAME = 'PayZu';

// Diretório para salvar comprovantes temporários
const RECEIPTS_DIR = process.env.DATA_PATH
    ? path.join(process.env.DATA_PATH, 'receipts')
    : path.join(__dirname, 'data', 'receipts');

// Garantir que o diretório existe
function ensureReceiptsDir() {
    if (!fs.existsSync(RECEIPTS_DIR)) {
        fs.mkdirSync(RECEIPTS_DIR, { recursive: true });
    }
}

/**
 * Formatar CPF/CNPJ parcialmente oculto
 */
function formatDocument(doc) {
    if (!doc) return 'N/A';
    const cleaned = doc.replace(/\D/g, '');

    if (cleaned.length === 11) {
        // CPF: ***.XXX.XXX-**
        return `***.${cleaned.substring(3, 6)}.${cleaned.substring(6, 9)}-**`;
    } else if (cleaned.length === 14) {
        // CNPJ: XX.XXX.XXX/XXXX-XX (completo para empresas)
        return `${cleaned.substring(0, 2)}.${cleaned.substring(2, 5)}.${cleaned.substring(5, 8)}/${cleaned.substring(8, 12)}-${cleaned.substring(12)}`;
    }
    return doc;
}

/**
 * Formatar valor em reais
 */
function formatMoney(value) {
    const num = typeof value === 'number' ? value : parseFloat(value);
    return num.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * Formatar data/hora - Sempre usa hora atual de São Paulo
 */
function formatDateTime() {
    return new Date().toLocaleString('pt-BR', {
        timeZone: 'America/Sao_Paulo',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
}

/**
 * Template HTML do comprovante (suporte a branding dinâmico)
 * @param {object} data - Dados da transação
 * @param {object} branding - Branding opcional {name, logoBase64, primaryColor}
 */
function getReceiptTemplate(data, branding = null) {
    const {
        type, // 'in' (recebido), 'out' (enviado) ou 'refund' (estorno)
        amount,
        dateTime,
        // Dados do pagador (quem enviou)
        payerName,
        payerDocument,
        payerBank,
        // Dados do recebedor (quem recebeu)
        receiverName,
        receiverDocument,
        receiverBank,
        pixKey,
        transactionId,
        pixCount, // Quantidade de PIX (para transferências agrupadas)
        refundReason // Motivo do estorno (apenas para type='refund')
    } = data;

    // Branding dinâmico com fallback para padrão
    const brandName = branding?.name || DEFAULT_BRAND_NAME;
    const brandLogo = branding?.logoBase64 || DEFAULT_LOGO;
    const primaryColor = branding?.primaryColor || DEFAULT_PRIMARY_COLOR;

    const isReceived = type === 'in';
    const isRefund = type === 'refund';
    const title = isRefund ? 'PIX Estornado' : (isReceived ? 'PIX Recebido' : 'PIX Enviado');
    const refundOrange = '#f5a623'; // Laranja para estornos

    return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
            background: linear-gradient(180deg, #0d0d0d 0%, #1a1a1a 100%);
            color: #ffffff;
            width: 420px;
            padding: 24px;
        }

        .container {
            background: linear-gradient(180deg, #141414 0%, #1a1a1a 100%);
            border-radius: 20px;
            padding: 28px;
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
        }

        .header {
            text-align: center;
            margin-bottom: 24px;
        }

        .logo {
            position: relative;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 8px;
            margin-bottom: 12px;
            padding: 16px 32px;
            border-radius: 18px;
            overflow: hidden;
        }

        .logo::before {
            content: '';
            position: absolute;
            inset: 0;
            background-image: url('${brandLogo}');
            background-repeat: no-repeat;
            background-size: 85%;
            background-position: center;
            opacity: 0.2;
            filter: drop-shadow(0 4px 10px rgba(0, 0, 0, 0.45));
        }

        .logo-text {
            position: relative;
            font-size: 32px;
            font-weight: 700;
            color: ${primaryColor};
            z-index: 1;
        }

        .title {
            font-size: 18px;
            font-weight: 500;
            color: #ffffff;
            margin-bottom: 4px;
        }

        .subtitle {
            font-size: 13px;
            color: #888;
        }

        .amount-section {
            text-align: center;
            padding: 24px 0;
            border-bottom: 1px solid rgba(255, 255, 255, 0.08);
            margin-bottom: 20px;
        }

        .amount-row {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 8px;
        }

        .amount-label {
            font-size: 14px;
            color: #888;
        }

        .amount-type {
            font-size: 14px;
            color: #888;
        }

        .amount {
            font-size: 42px;
            font-weight: 700;
            color: #ffffff;
            margin-top: 8px;
        }

        .amount-prefix {
            font-size: 24px;
            font-weight: 500;
        }

        .type-badge {
            display: inline-block;
            background: ${isRefund ? refundOrange : primaryColor}15;
            color: ${isRefund ? refundOrange : primaryColor};
            padding: 6px 16px;
            border-radius: 20px;
            font-size: 13px;
            font-weight: 600;
            margin-top: 16px;
        }

        .refund-reason {
            background: rgba(245, 166, 35, 0.1);
            border: 1px solid rgba(245, 166, 35, 0.2);
            border-radius: 12px;
            padding: 14px;
            margin-top: 12px;
        }

        .refund-reason-label {
            font-size: 11px;
            color: ${refundOrange};
            text-transform: uppercase;
            letter-spacing: 1px;
            margin-bottom: 6px;
        }

        .refund-reason-text {
            font-size: 13px;
            color: #ffffff;
        }

        .pix-count-row {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-top: 16px;
            padding-top: 12px;
            border-top: 1px solid rgba(255, 255, 255, 0.08);
        }

        .pix-count-label {
            font-size: 14px;
            color: #888;
        }

        .pix-count-value {
            font-size: 16px;
            font-weight: 600;
            color: #ffffff;
        }

        .info-box {
            background: rgba(255, 255, 255, 0.03);
            border: 1px solid rgba(255, 255, 255, 0.08);
            border-radius: 16px;
            padding: 20px;
            margin-bottom: 12px;
        }

        .info-header {
            font-size: 12px;
            color: #666;
            text-transform: uppercase;
            letter-spacing: 1.5px;
            margin-bottom: 14px;
            font-weight: 500;
        }

        .info-name {
            font-size: 17px;
            font-weight: 600;
            color: #ffffff;
            margin-bottom: 12px;
        }

        .info-row {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 8px 0;
        }

        .info-label {
            font-size: 13px;
            color: #666;
        }

        .info-value {
            font-size: 13px;
            color: #ffffff;
            font-weight: 500;
            text-align: right;
            max-width: 220px;
            word-break: break-all;
        }

        .divider {
            border: none;
            border-top: 1px dashed rgba(255, 255, 255, 0.1);
            margin: 0;
        }

        .footer {
            text-align: center;
            padding-top: 20px;
        }

        .transaction-id {
            font-size: 10px;
            color: #555;
            word-break: break-all;
            margin-top: 14px;
        }

        .transaction-id-label {
            color: #444;
        }

        .status-success {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            background: ${isRefund ? refundOrange : primaryColor}18;
            color: ${isRefund ? refundOrange : primaryColor};
            padding: 10px 20px;
            border-radius: 25px;
            font-size: 14px;
            font-weight: 600;
        }

        .check-icon {
            width: 18px;
            height: 18px;
            background: ${isRefund ? refundOrange : primaryColor};
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
        }

        .check-icon::after {
            content: '${isRefund ? '↩' : '✓'}';
            color: white;
            font-size: 11px;
            font-weight: bold;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div class="logo">
                <span class="logo-text">${brandName}</span>
            </div>
            <div class="title">Comprovante de pagamento</div>
            <div class="subtitle">${formatDateTime(dateTime)}</div>
        </div>

        <div class="amount-section">
            <div class="amount-row">
                <span class="amount-label">Valor ${isRefund ? 'devolvido' : ''}</span>
                <span class="amount-type">Tipo</span>
            </div>
            <div class="amount-row">
                <div class="amount">
                    <span class="amount-prefix">R$</span> ${formatMoney(amount)}
                </div>
                <span class="type-badge">${isRefund ? 'Estorno' : 'Pix'}</span>
            </div>
            ${pixCount && pixCount > 1 ? `
            <div class="pix-count-row">
                <span class="pix-count-label">Quantidade de PIX</span>
                <span class="pix-count-value">${pixCount}</span>
            </div>
            ` : ''}
            ${isRefund && refundReason ? `
            <div class="refund-reason">
                <div class="refund-reason-label">Motivo do estorno</div>
                <div class="refund-reason-text">${refundReason}</div>
            </div>
            ` : ''}
        </div>

        <div class="info-box">
            <div class="info-header">De</div>
            <div class="info-name">${payerName || 'N/A'}</div>
            <div class="info-row">
                <span class="info-label">Instituição</span>
                <span class="info-value">${payerBank || 'N/A'}</span>
            </div>
            <div class="info-row">
                <span class="info-label">Documento</span>
                <span class="info-value">${formatDocument(payerDocument)}</span>
            </div>
        </div>

        <hr class="divider">

        <div class="info-box">
            <div class="info-header">Para</div>
            <div class="info-name">${receiverName || 'N/A'}</div>
            <div class="info-row">
                <span class="info-label">Instituição</span>
                <span class="info-value">${receiverBank || 'N/A'}</span>
            </div>
            <div class="info-row">
                <span class="info-label">Documento</span>
                <span class="info-value">${formatDocument(receiverDocument)}</span>
            </div>
            ${pixKey ? `
            <div class="info-row">
                <span class="info-label">Chave</span>
                <span class="info-value">${pixKey}</span>
            </div>
            ` : ''}
        </div>

        <div class="footer">
            <div class="status-success">
                <span class="check-icon"></span>
                ${isRefund ? 'Estorno confirmado' : 'Transferência confirmada'}
            </div>
            <div class="transaction-id">
                <span class="transaction-id-label">Id da transação:</span> ${transactionId || 'N/A'}
            </div>
        </div>
    </div>
</body>
</html>
    `;
}

/**
 * Gerar imagem do comprovante
 * @param {object} data - Dados do comprovante
 * @param {object} branding - Branding opcional {name, logoBase64, primaryColor}
 * @returns {Promise<string>} - Caminho do arquivo da imagem ou base64
 */
async function generateReceipt(data, branding = null) {
    ensureReceiptsDir();

    const html = getReceiptTemplate(data, branding);
    const filename = `receipt_${Date.now()}.png`;
    const filepath = path.join(RECEIPTS_DIR, filename);

    try {
        await nodeHtmlToImage({
            output: filepath,
            html: html,
            timeout: 30000,
            puppeteerArgs: {
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-gpu',
                    '--disable-web-security',
                    '--font-render-hinting=none'
                ]
            },
            beforeScreenshot: async (page) => {
                await page.evaluateHandle('document.fonts.ready');
            }
        });

        console.log(`📄 Comprovante gerado: ${filepath}`);
        return filepath;
    } catch (error) {
        console.error('❌ Erro ao gerar comprovante:', error.message);
        throw error;
    }
}

/**
 * Gerar comprovante como base64 (para envio direto)
 * @param {object} data - Dados do comprovante
 * @param {object} branding - Branding opcional {name, logoBase64, primaryColor}
 */
async function generateReceiptBase64(data, branding = null) {
    const html = getReceiptTemplate(data, branding);

    try {
        const image = await nodeHtmlToImage({
            html: html,
            encoding: 'base64',
            timeout: 30000, // 30 segundos de timeout
            puppeteerArgs: {
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-gpu',
                    '--disable-web-security',
                    '--font-render-hinting=none'
                ]
            },
            beforeScreenshot: async (page) => {
                // Aguardar o DOM estar pronto
                await page.evaluateHandle('document.fonts.ready');
            }
        });

        console.log('📄 Comprovante gerado em base64');
        return `data:image/png;base64,${image}`;
    } catch (error) {
        console.error('❌ Erro ao gerar comprovante base64:', error.message);
        throw error;
    }
}

/**
 * Limpar comprovantes antigos (mais de 1 hora)
 */
function cleanOldReceipts() {
    ensureReceiptsDir();

    const ONE_HOUR = 60 * 60 * 1000;
    const now = Date.now();
    let cleaned = 0;

    try {
        const files = fs.readdirSync(RECEIPTS_DIR);

        for (const file of files) {
            const filepath = path.join(RECEIPTS_DIR, file);
            const stats = fs.statSync(filepath);

            if (now - stats.mtimeMs > ONE_HOUR) {
                fs.unlinkSync(filepath);
                cleaned++;
            }
        }

        if (cleaned > 0) {
            console.log(`🧹 Limpou ${cleaned} comprovantes antigos`);
        }
    } catch (error) {
        console.error('❌ Erro ao limpar comprovantes:', error.message);
    }
}

// Limpar comprovantes antigos a cada 30 minutos
setInterval(cleanOldReceipts, 30 * 60 * 1000);

module.exports = {
    generateReceipt,
    generateReceiptBase64,
    cleanOldReceipts
};
