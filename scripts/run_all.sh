#!/bin/bash
cd "$(dirname "$0")/.."

if [ ! -d "node_modules" ]; then
    echo "Installing dependencies..."
    npm install || { echo "Failed to install dependencies."; exit 1; }
fi

echo "Starting AgentUserWatcher server and agent..."
echo "Server will run on port 4000"
echo "Press Ctrl+C to stop"
echo ""

# Run both in background, but keep script alive
npm run server &
SERVER_PID=$!

npm run agent &
AGENT_PID=$!

echo "Server PID: $SERVER_PID"
echo "Agent PID: $AGENT_PID"

# Wait for both
wait $SERVER_PID $AGENT_PID
