// Serviço de autenticação do painel admin (Senha + 2FA)
require('dotenv').config();
const speakeasy = require('speakeasy');
const QRCode = require('qrcode');
const jwt = require('jsonwebtoken');

// Configurações
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const ADMIN_2FA_SECRET = process.env.ADMIN_2FA_SECRET;
const JWT_SECRET = process.env.JWT_SECRET || 'pix-whatsapp-admin-secret-key-change-in-production';
const SESSION_DURATION = '24h'; // Duração da sessão

// Nome do app para 2FA (aparece no Google Authenticator)
const APP_NAME = 'PIX WhatsApp Admin';

/**
 * Verificar se o 2FA está configurado
 */
function is2FAConfigured() {
    return !!ADMIN_2FA_SECRET;
}

/**
 * Verificar se a senha do admin está configurada
 */
function isPasswordConfigured() {
    return !!ADMIN_PASSWORD;
}

/**
 * Verificar senha do admin
 * @param {string} password - Senha fornecida
 * @returns {boolean}
 */
function verifyPassword(password) {
    if (!ADMIN_PASSWORD) {
        console.warn('⚠️ ADMIN_PASSWORD não configurado!');
        return false;
    }
    return password === ADMIN_PASSWORD;
}

/**
 * Gerar novo secret para 2FA
 * @returns {string} - Secret em base32
 */
function generateSecret() {
    const secret = speakeasy.generateSecret({
        name: APP_NAME,
        length: 20
    });
    return secret.base32;
}

/**
 * Gerar URL otpauth para QR Code
 * @param {string} secret - Secret em base32
 * @returns {string} - URL otpauth
 */
function generateOTPAuthURL(secret) {
    return speakeasy.otpauthURL({
        secret: secret,
        label: 'admin',
        issuer: APP_NAME,
        encoding: 'base32'
    });
}

/**
 * Gerar QR Code como Data URL (base64)
 * @param {string} secret - Secret em base32
 * @returns {Promise<string>} - Data URL do QR Code
 */
async function generateQRCode(secret) {
    const otpAuthURL = generateOTPAuthURL(secret);
    try {
        return await QRCode.toDataURL(otpAuthURL);
    } catch (error) {
        console.error('❌ Erro ao gerar QR Code:', error.message);
        throw error;
    }
}

/**
 * Verificar código TOTP
 * @param {string} token - Código de 6 dígitos
 * @param {string} secret - Secret do usuário (opcional, usa env se não fornecido)
 * @returns {boolean}
 */
function verifyTOTP(token, secret = null) {
    const secretToUse = secret || ADMIN_2FA_SECRET;

    if (!secretToUse) {
        console.warn('⚠️ Secret 2FA não configurado!');
        return false;
    }

    try {
        // Permite 1 janela de tempo antes e depois (30 segundos de tolerância)
        return speakeasy.totp.verify({
            secret: secretToUse,
            encoding: 'base32',
            token: token,
            window: 1
        });
    } catch (error) {
        console.error('❌ Erro ao verificar TOTP:', error.message);
        return false;
    }
}

/**
 * Gerar token JWT para sessão
 * @returns {string} - Token JWT
 */
function generateSessionToken() {
    const payload = {
        role: 'admin',
        iat: Math.floor(Date.now() / 1000)
    };

    return jwt.sign(payload, JWT_SECRET, { expiresIn: SESSION_DURATION });
}

/**
 * Verificar token JWT de sessão
 * @param {string} token - Token JWT
 * @returns {object|null} - Payload decodificado ou null se inválido
 */
function verifySessionToken(token) {
    try {
        return jwt.verify(token, JWT_SECRET);
    } catch (error) {
        return null;
    }
}

/**
 * Middleware Express para proteger rotas admin
 */
function requireAuth(req, res, next) {
    // Verificar token no header Authorization ou cookie
    let token = null;

    // Header: Authorization: Bearer <token>
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.substring(7);
    }

    // Cookie: admin_session=<token>
    if (!token && req.cookies && req.cookies.admin_session) {
        token = req.cookies.admin_session;
    }

    // Query param para facilitar testes: ?token=<token>
    if (!token && req.query.token) {
        token = req.query.token;
    }

    if (!token) {
        return res.status(401).json({
            error: 'Não autenticado',
            message: 'Token de sessão não fornecido'
        });
    }

    const payload = verifySessionToken(token);
    if (!payload) {
        return res.status(401).json({
            error: 'Sessão inválida',
            message: 'Token expirado ou inválido'
        });
    }

    // Adicionar info do admin ao request
    req.admin = payload;
    next();
}

/**
 * Processar login completo (senha + 2FA)
 * @param {string} password - Senha
 * @param {string} totpCode - Código 2FA
 * @returns {object} - Resultado do login
 */
function processLogin(password, totpCode) {
    // Verificar se está configurado
    if (!isPasswordConfigured()) {
        return {
            success: false,
            error: 'ADMIN_PASSWORD não configurado no .env'
        };
    }

    // Verificar senha
    if (!verifyPassword(password)) {
        return {
            success: false,
            error: 'Senha incorreta'
        };
    }

    // Verificar 2FA (se configurado)
    if (is2FAConfigured()) {
        if (!totpCode) {
            return {
                success: false,
                requires2FA: true,
                error: 'Código 2FA necessário'
            };
        }

        if (!verifyTOTP(totpCode)) {
            return {
                success: false,
                error: 'Código 2FA inválido'
            };
        }
    }

    // Login bem sucedido - gerar token de sessão
    const sessionToken = generateSessionToken();

    return {
        success: true,
        token: sessionToken,
        expiresIn: SESSION_DURATION
    };
}

/**
 * Configurar 2FA pela primeira vez
 * @param {string} password - Senha do admin para confirmar
 * @returns {object} - Secret e QR Code
 */
async function setup2FA(password) {
    // Verificar senha primeiro
    if (!verifyPassword(password)) {
        return {
            success: false,
            error: 'Senha incorreta'
        };
    }

    // Se já tem 2FA configurado, não permitir reconfigurar sem código atual
    if (is2FAConfigured()) {
        return {
            success: false,
            error: '2FA já está configurado. Para reconfigurar, remova ADMIN_2FA_SECRET do .env primeiro.'
        };
    }

    // Gerar novo secret
    const secret = generateSecret();
    const qrCodeDataURL = await generateQRCode(secret);

    return {
        success: true,
        secret: secret,
        qrCode: qrCodeDataURL,
        instructions: [
            '1. Escaneie o QR Code com o Google Authenticator',
            '2. Adicione a seguinte linha ao seu arquivo .env:',
            `   ADMIN_2FA_SECRET=${secret}`,
            '3. Reinicie o servidor',
            '4. Use o código do app para fazer login'
        ]
    };
}

/**
 * Verificar configuração do admin
 * @returns {object} - Status da configuração
 */
function getConfigStatus() {
    return {
        passwordConfigured: isPasswordConfigured(),
        twoFactorConfigured: is2FAConfigured(),
        ready: isPasswordConfigured() && is2FAConfigured()
    };
}

module.exports = {
    // Verificações
    is2FAConfigured,
    isPasswordConfigured,
    verifyPassword,
    verifyTOTP,
    getConfigStatus,

    // 2FA Setup
    generateSecret,
    generateQRCode,
    setup2FA,

    // Sessão
    generateSessionToken,
    verifySessionToken,

    // Login
    processLogin,

    // Middleware
    requireAuth
};
