#!/bin/bash

echo "╔══════════════════════════════════════════╗"
echo "║     CartWave PIX Manager - Setup        ║"
echo "╚══════════════════════════════════════════╝"
echo ""

# Verificar se o Node.js está instalado
if ! command -v node &> /dev/null; then
    echo "❌ Node.js não está instalado!"
    echo "Por favor, instale o Node.js em: https://nodejs.org/"
    exit 1
fi

echo "✅ Node.js detectado: $(node -v)"
echo ""

# Verificar se as dependências estão instaladas
if [ ! -d "node_modules" ]; then
    echo "📦 Instalando dependências..."
    npm install
    echo ""
fi

# Atualizar index.html para usar o servidor proxy
echo "🔧 Configurando para usar servidor proxy..."
sed -i.bak 's/<script src="app.js"><\/script>/<script src="app-proxy.js"><\/script>/g' index.html

echo "🚀 Iniciando servidor..."
echo ""
echo "══════════════════════════════════════════"
echo "Acesse o sistema em:"
echo "👉 http://localhost:3001"
echo "══════════════════════════════════════════"
echo ""

# Iniciar o servidor
npm start