#!/bin/bash
# Restart the running Pi Pocket server with the same command line. Only with the owner's permission.
# Usage: bin/restart-server.sh [port]   (default 8787). Returns at once; the restart happens 3 seconds later, in the
# background, so the tool call that started it is not cut off. Log: /tmp/pocket-restart.log
port="${1:-8787}"
server=$(lsof -t -iTCP:"$port" -sTCP:LISTEN | head -1)
[ -n "$server" ] || { echo "No server listens on port $port." >&2; exit 1; }
launcher=$(ps -o ppid= -p "$server" | tr -d ' ')
args=$(ps -o args= -p "$launcher")
case "$args" in *pi-pocket.js*) ;; *) echo "Parent of $server is not the launcher: $args" >&2; exit 1;; esac
cwd=$(lsof -a -p "$launcher" -d cwd -Fn | sed -n 's/^n//p')
nohup bash -c "sleep 3; kill $launcher $server 2>/dev/null; sleep 4; cd '$cwd' && exec nohup $args" > /tmp/pocket-restart.log 2>&1 &
echo "Restarting server $server (launcher $launcher) in 3 seconds: $args"
