#!/bin/bash
echo "============================================================"
echo "AgentUserWatcher Agent"
echo "============================================================"
echo ""
echo "Starting VNC monitoring agent..."
echo "Press Ctrl+C to stop"
echo "============================================================"
echo ""

cd "$(dirname "$0")/.."

if [ ! -d "node_modules" ]; then
    echo "Installing dependencies..."
    npm install || { echo "Failed to install dependencies."; exit 1; }
fi

npm run agent
