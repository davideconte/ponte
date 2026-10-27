# Ponte README demo. Regenerate from the repository root with:
#
#   vhs docs/demo.tape && gifsicle -O3 -b docs/demo.gif
#
# Needs vhs, tmux and the dev install in .venv. docs/demo.sh creates two
# isolated Ponte users in a temporary directory and opens them side by side.

Output docs/demo.gif

Require tmux

Set Shell "bash"
Set FontFamily "Menlo"
Set FontSize 13
Set Width 1240
Set Height 600
Set Padding 12
Set Framerate 20
Set TypingSpeed 18ms
Set CursorBlink false
Set Theme { "name": "Ponte", "background": "#141414", "foreground": "#e8e8e8", "cursor": "#e8e8e8", "selection": "#3a3a3a", "black": "#141414", "red": "#d0d0d0", "green": "#d0d0d0", "yellow": "#d0d0d0", "blue": "#d0d0d0", "magenta": "#d0d0d0", "cyan": "#d0d0d0", "white": "#e8e8e8", "brightBlack": "#6e6e6e", "brightRed": "#f2f2f2", "brightGreen": "#f2f2f2", "brightYellow": "#f2f2f2", "brightBlue": "#f2f2f2", "brightMagenta": "#f2f2f2", "brightCyan": "#f2f2f2", "brightWhite": "#ffffff" }

Hide
Type "exec ./docs/demo.sh" Enter
Sleep 3s
Show
Sleep 400ms

# 1. davide opens a room for carlo (the full output is a ready-to-paste prompt with the invite)
Type "ponte open video-shoot --peer carlo | head -3"
Sleep 300ms
Enter
Sleep 2s

# 2. carlo joins with the invite davide sent him ($INVITE, see docs/demo.sh)
Ctrl+B
Type "l"
Type `ponte join "$INVITE" --as davide`
Sleep 300ms
Enter
Sleep 1.5s

# 3. carlo's agent reports the first cut
Type `ponte send davide "First cut is uploaded: shared/cut-01.mp4 - check 0:04-0:06"`
Sleep 300ms
Enter
Sleep 1s

# 4. davide's inbox: the message arrives framed as untrusted peer data
Ctrl+B
Type "h"
Type "ponte inbox"
Sleep 300ms
Enter
Sleep 3.5s

# 5. davide answers
Type `ponte send video-shoot "Looks good. Trim the pan at 0:05 and export 1080p"`
Sleep 300ms
Enter
Sleep 1s

# 6. carlo reads it
Ctrl+B
Type "l"
Type "ponte inbox"
Sleep 300ms
Enter
Sleep 3s

# 7. davide checks who is online
Ctrl+B
Type "h"
Type "ponte status"
Sleep 300ms
Enter
Sleep 3s

Hide
Type "tmux kill-server" Enter
Sleep 1s
