#!/bin/bash
echo "============================================================"
echo "AgentUserWatcher Server"
echo "============================================================"
echo ""
echo "Starting server on http://localhost:4000"
echo "Press Ctrl+C to stop"
echo "============================================================"
echo ""

cd "$(dirname "$0")/.."

if [ ! -d "node_modules" ]; then
    echo "Installing dependencies..."
    npm install || { echo "Failed to install dependencies."; exit 1; }
fi

npm run server
echo ""
echo "Server exited."
read -p "Press Enter to close..."
