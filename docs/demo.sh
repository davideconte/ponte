#!/usr/bin/env bash
# Two isolated Ponte users (davide hosts, carlo joins) side by side in tmux.
# Used by docs/demo.tape: `vhs docs/demo.tape` from the repository root.
#
# Nothing outside a temporary directory is touched: HOME and PONTE_HOME point
# there (so ~/.ponte, ~/.claude and LaunchAgents stay as they are), the relay
# listens on a free localhost port and tmux runs on its own socket.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$ROOT/.venv/bin:$PATH"
export PONTE_NO_NOTIFY=1
export BASH_SILENCE_DEPRECATION_WARNING=1

DEMO="$(mktemp -d "${TMPDIR:-/tmp}/ponte-demo.XXXXXX")"
export HOME="$DEMO/home"
mkdir -p "$HOME"
PORT="$(python -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')"
TMUX_SOCKET="ponte-demo-$$"

cleanup() {
  [ -f "$DEMO/davide/daemon.pid" ] && kill "$(cat "$DEMO/davide/daemon.pid")" 2>/dev/null || true
  tmux -L "$TMUX_SOCKET" kill-server 2>/dev/null || true
  rm -rf "$DEMO"
}
trap cleanup EXIT

PONTE_HOME="$DEMO/davide" ponte init --name davide >/dev/null
PONTE_HOME="$DEMO/carlo" ponte init --name carlo >/dev/null

# davide hosts the relay on 127.0.0.1:$PORT (same as `ponte open --port $PORT --url ...`,
# kept in the config so the recorded command stays short).
PONTE_HOME="$DEMO/davide" python - "$PORT" <<'EOF'
import sys
from ponte import store
cfg = store.config()
port = int(sys.argv[1])
cfg["host"] = {"port": port, "bind": "127.0.0.1"}
cfg["public_url"] = f"http://127.0.0.1:{port}"
store.save_config(cfg)
EOF

# davide's daemon (relay + listener), polling every second instead of five.
PONTE_HOME="$DEMO/davide" nohup python -c \
  'import ponte.daemon as d; d.POLL_SECONDS = 1; d.run()' >"$DEMO/daemon.log" 2>&1 &
for _ in $(seq 50); do
  python -c "import socket; socket.create_connection(('127.0.0.1', $PORT), 0.2)" 2>/dev/null && break
  sleep 0.1
done

for who in davide carlo; do
  cat >"$DEMO/$who.rc" <<EOF
export PATH="$PATH" HOME="$HOME" PONTE_HOME="$DEMO/$who" PONTE_NO_NOTIFY=1
PS1='\[\e[1;97m\]$who\[\e[0;90m\] \$ \[\e[0m\]'
EOF
done
# carlo "pastes" the invite davide sent him: $INVITE is filled from the clipboard
# (where `ponte open` put the guest prompt) right before his first command.
cat >>"$DEMO/carlo.rc" <<'EOF'
trap '[ -z "$INVITE" ] && INVITE=$(pbpaste 2>/dev/null | grep -o "ponte1_[A-Za-z0-9_-]*" | head -1)' DEBUG
EOF

cat >"$DEMO/tmux.conf" <<'EOF'
set -g default-terminal "xterm-256color"
set -g escape-time 0
set -g status off
set -g pane-border-status top
set -g pane-border-format "#{?pane_active,#[fg=#ffffff bold],#[fg=#6e6e6e]} #{pane_title} "
set -g pane-border-style "fg=#3c3c3c"
set -g pane-active-border-style "fg=#3c3c3c"
set -g window-style "fg=#9a9a9a"
set -g window-active-style "fg=#f2f2f2"
set -g allow-rename off
bind h select-pane -L
bind l select-pane -R
EOF

T() { tmux -L "$TMUX_SOCKET" -f "$DEMO/tmux.conf" "$@"; }
T new-session -d -s demo -x 200 -y 50 "bash --rcfile $DEMO/davide.rc -i"
T split-window -h -t demo "bash --rcfile $DEMO/carlo.rc -i"
T select-pane -t demo:0.0 -T "davide · host"
T select-pane -t demo:0.1 -T "carlo · guest"
T select-pane -t demo:0.0
T attach -t demo
